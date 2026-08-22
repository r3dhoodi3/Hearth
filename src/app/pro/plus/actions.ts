"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { stripe } from "@/lib/stripe";
import { createClient } from "@/lib/supabase/server";
import { getUser } from "@/lib/auth";
import { getCurrentContractor } from "@/lib/contractor";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  getSubscription,
  getProSubscription,
  isProTrialEligible,
  hasClaimedPromo,
} from "@/lib/subscription";
import { PRO_PLAN } from "@/lib/constants";
import { billingTermsText } from "@/lib/billingTerms";
import {
  checkoutCadence,
  subscriptionCheckoutData,
} from "@/lib/checkoutSubscriptionData";
import { setFlash } from "@/lib/flash";

const siteUrl = () =>
  process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

// One-time $20-off coupon that makes a first monthly bill $9.99 instead of
// $29.99. DORMANT while the free trial is on (see PRO_PLAN.introFirstMonth and
// the trial block in startProCheckoutAction): a duration:"once" coupon is
// consumed by the $0 invoice a trial start finalizes, so pairing the two would
// quietly bill full price after promising the intro price. Kept intact so the
// offer can be switched back on deliberately rather than rebuilt.
// Prefers the pre-configured coupon id from the env; otherwise looks
// up (and on first use, creates) a well-known fallback coupon so the intro
// offer works before anything is set up in Stripe. Returns null on any
// failure so checkout degrades to plain full price rather than blocking a
// subscription.
async function proIntroCouponId(): Promise<string | null> {
  const envId = process.env.STRIPE_PRO_INTRO_COUPON_ID;
  if (envId) return envId;

  const fallbackId = "hearth-pro-intro";
  try {
    await stripe.coupons.retrieve(fallbackId);
    return fallbackId;
  } catch {
    // Not there yet: create it. If a concurrent checkout won the race (or
    // Stripe is unhappy), fall through to full price.
    try {
      const coupon = await stripe.coupons.create({
        id: fallbackId,
        name: "Pro intro: first month $9.99",
        amount_off: 2000,
        currency: "usd",
        duration: "once",
      });
      return coupon.id;
    } catch {
      return null;
    }
  }
}

// Start a Hearth Pro checkout (monthly or yearly). Uses the pre-created
// Stripe Price if one is configured, otherwise falls back to inline
// price_data so the flow works before Products/Prices are set up in Stripe.
export async function startProCheckoutAction(formData: FormData) {
  // Yearly is the default cadence (see checkoutCadence): it is what the
  // pricing card preselects, so a form arriving without a readable "plan"
  // field lands on the plan the pro was looking at. Every downstream quote
  // (the Stripe line item, the consent record, the acknowledgment) derives
  // from this one value, so they can never disagree about what is charged.
  const plan =
    checkoutCadence(formData.get("plan")) === "monthly"
      ? "pro_monthly"
      : "pro_yearly";

  // Deliberately NOT src/lib/auth.ts's getUser(): that helper trusts
  // getSession(), which reads the user id straight off the (unverified)
  // cookie. user.id below feeds an admin-client claim_promo call (burns a
  // one-per-user intro reservation) and the Stripe session's
  // metadata.user_id (which the webhook trusts via the admin client to
  // attribute the resulting subscription), so a cookie-edited id would let
  // an attacker burn a victim's intro claim or misattribute a subscription.
  // supabase.auth.getUser() re-checks the id against Supabase's auth server.
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/signin");

  // Membership is a contractor perk bundle, so only a set-up company can buy
  // it. It never changes which leads anyone can see or apply to.
  const contractor = await getCurrentContractor();
  if (!contractor) redirect("/pro/onboarding");

  const priceId =
    plan === "pro_yearly"
      ? process.env.STRIPE_PRO_YEARLY_PRICE_ID
      : process.env.STRIPE_PRO_MONTHLY_PRICE_ID;

  const lineItem = priceId
    ? { price: priceId, quantity: 1 }
    : {
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: Math.round(
            (plan === "pro_yearly" ? PRO_PLAN.yearly : PRO_PLAN.monthly) * 100
          ),
          recurring: {
            interval: plan === "pro_yearly" ? ("year" as const) : ("month" as const),
          },
          product_data: { name: "Hearth Pro" },
        },
      };

  // getProSubscription is contractor-side only; the same user may also carry
  // a homeowner Plus row (a pro who is also a homeowner) on the same Stripe
  // customer.
  const existing = await getProSubscription();
  const homeownerSub = await getSubscription();
  const customerId =
    existing?.stripe_customer_id ?? homeownerSub?.stripe_customer_id ?? null;

  // Double-checkout guard, mirroring startPlusCheckoutAction: our
  // subscriptions row only appears after the Stripe webhook fires, so two
  // checkouts opened back-to-back could each mint a live Stripe
  // subscription. When we already know the Stripe customer, ask Stripe
  // directly whether a live Pro membership exists before creating another
  // one. A live homeowner Plus subscription doesn't count (that sub is a
  // different membership), so the homeowner-side row's subscription id is
  // excluded from the check. If no customer id exists yet, the webhook's
  // upsert-by-(user_id, side), fed by the metadata below, keeps our side to
  // one row.
  if (customerId) {
    let alreadyMember = false;
    try {
      const stripeSubs = await stripe.subscriptions.list({
        customer: customerId,
        status: "all",
        limit: 10,
      });
      alreadyMember = stripeSubs.data.some(
        (s) =>
          (s.status === "active" || s.status === "trialing") &&
          s.id !== homeownerSub?.stripe_subscription_id
      );
    } catch {
      // If Stripe is unreachable, fall through to checkout as before.
    }
    if (alreadyMember) {
      await setFlash(
        "You already have a Hearth Pro membership. No need to buy it twice.",
        "info"
      );
      redirect("/pro/plus");
    }
  }

  // Every brand-new Pro subscriber gets a free trial (PRO_PLAN.trialDays), on
  // either cadence, and there is no trial-less way to buy: the trial is the
  // only purchase path, so a pro who is ready to pay today still starts on it.
  // The card is collected at checkout (payment_method_collection below), the
  // subscription converts to paid on its own when the trial ends, and
  // cancelling before then costs nothing.
  //
  // Scoped to the Pro-side subscriptions row for the same reason
  // startPlusCheckoutAction scopes its trial: that row survives cancellation
  // (it lands on status "canceled", it is not deleted), so a subscriber who
  // churns and comes back pays from day one instead of farming a fresh free
  // trial on every resubscribe. Uses isProTrialEligible rather than `!existing`
  // so it fails CLOSED: if the subscriptions read errored (transient/RLS),
  // `existing` would be null and `!existing` would wrongly grant a repeat
  // trial. isProTrialEligible returns false on an errored read.
  const freeTrial = await isProTrialEligible();

  // Brand-new Pro subscribers on the monthly plan get an intro month: $9.99
  // for the first month via a one-time coupon, then full price. Yearly is
  // already discounted, so no intro offer there. A coupon hiccup quietly
  // falls back to full price rather than blocking the checkout.
  //
  // RESERVE the promo before Stripe ever sees a discount - don't just check
  // it. The old code here read `!existing && !hasClaimedPromo(...)`, but both
  // of those only reflect state the webhook writes AFTER a checkout
  // completes. Two checkouts opened back-to-back (two tabs, a replay script)
  // both read "not claimed yet", both got the coupon, and both eventually
  // triggered the wallet credit (idempotent per INVOICE, but N concurrent
  // subscriptions mint N distinct invoice ids) - net: pay $9.99xN, collect
  // $10xN in spendable credit.
  //
  // The fix: atomically claim the promo_claims row (user_id, promo_key) HERE,
  // synchronously, before the Stripe session is created. promo_claims' PK is
  // (user_id, promo_key) (migration 0071), so claim_promo()'s
  // "on conflict do nothing ... return found" makes a second concurrent call
  // for the same user return false - only ONE of N racing requests can ever
  // win the reservation; every other one falls straight through to full
  // price, no coupon attached. claim_promo is service_role-only (revoked
  // from authenticated/anon in 0071 on purpose), hence the admin client.
  //
  // A reservation that's never spent - checkout abandoned, tab closed,
  // payment declined - is released by the webhook (checkout.session.expired
  // for an abandoned session; customer.subscription.{updated,deleted}
  // landing on canceled/incomplete_expired for a subscription that never
  // actually went live) so a legit user who bails on checkout keeps their one
  // intro to spend on a later, real attempt. `intro_reserved` in the session
  // metadata below is how the webhook recognizes which specific attempt
  // holds the reservation.
  //
  // The two original guards still run first, as cheap pre-checks that skip
  // the Stripe coupon lookup + RPC entirely when we already know the answer:
  // `!existing` off the current subscriptions row, and
  // `!hasClaimedPromo(...)`, the lifecycle-independent ledger check that
  // still holds if a canceled row is ever pruned. Neither is what actually
  // enforces one-per-user anymore - claim_promo's primary key is - but
  // keeping both avoids regressing anyone the 0071 backfill missed.
  //
  // `!freeTrial` is the new first gate, and today it is never satisfied: the
  // trial and the intro coupon are mutually exclusive. Stripe treats a
  // duration:"once" coupon as used once the first invoice FINALIZES, and a
  // trial start finalizes a $0 invoice, so attaching both would burn the $20
  // off on nothing and bill full price at trial end - more than the buyer was
  // shown, which is exactly what ROSCA and the California Automatic Renewal
  // Law forbid. Everything below stays in place (and stays correct) for the
  // day the trial is switched off; it is not dead-lettered.
  let discounts: Array<{ coupon: string }> | undefined;
  let claimedIntro = false;
  if (
    !freeTrial &&
    plan === "pro_monthly" &&
    !existing &&
    !(await hasClaimedPromo("pro_intro_monthly"))
  ) {
    const coupon = await proIntroCouponId();
    if (coupon) {
      const admin = createAdminClient();
      try {
        const { data, error } = await admin.rpc("claim_promo", {
          p_user: user.id,
          p_key: "pro_intro_monthly",
          p_ref: "pro_checkout_reservation",
        });
        if (error) {
          console.error(
            "claim_promo reservation failed - no intro discount:",
            error.message ?? error
          );
        } else if (data === true) {
          claimedIntro = true;
          discounts = [{ coupon }];
        }
        // data === false: a concurrent checkout already won the reservation
        // for this user. Fall through to full price - do NOT attach the
        // coupon, and do NOT touch promo_claims (it's the other attempt's).
      } catch (err) {
        console.error(
          "claim_promo reservation threw - no intro discount:",
          err
        );
      }
    }
  }

  // Consent record, mirroring startPlusCheckoutAction: the exact disclosure
  // text the buyer saw, stored on the Stripe session so California's
  // record-keeping requirement (Bus. & Prof. Code 17602(b)(2)) is satisfied
  // without a new table. Metadata values cap at 500 characters.
  //
  // The signal is `freeTrial` OR `discounts`, the two step-up offers, which are
  // mutually exclusive by construction above. The trial can't silently fail the
  // way the coupon can (Stripe errors the whole session rather than dropping
  // trial_period_days), so it is trusted directly; the coupon is still read off
  // `discounts` rather than intent, so one that quietly failed to apply is
  // never papered over with step-up copy the invoice won't match.
  const consentTerms = billingTermsText(
    plan,
    freeTrial || Boolean(discounts)
  ).slice(0, 500);

  // Idempotency key, mirroring startPlusCheckoutAction: stable per user + plan
  // + a 5-minute time bucket, so a double-submit (two tabs, a double-click)
  // replays the SAME Stripe session instead of minting two, but a genuine
  // later retry (new bucket) still creates a fresh one.
  //
  // This matters more on the Pro side than the wording above suggests. The
  // double-checkout guard higher up can only run when we already know a Stripe
  // customer id, so a brand-new pro - who has none yet - is exactly the case it
  // cannot cover. Two completed sessions would mint two subscriptions, and the
  // webhook's upsert-by-(user_id, side) keeps only one row: the other becomes
  // an orphan that still bills at trial end with no row, and therefore no
  // in-app cancel button, pointing at it. The trial makes that worse than it
  // used to be, since the charge lands three days later rather than visibly at
  // checkout.
  const idempotencyBucket = Math.floor(Date.now() / (5 * 60 * 1000));
  const idempotencyKey = `pro-checkout:${user.id}:${plan}:${idempotencyBucket}`;

  // consent_at has to come from the bucket start, not a fresh Date: Stripe
  // treats a replayed idempotency key carrying a DIFFERENT body as a conflict
  // error, and a freshly-computed timestamp would differ between two submits
  // landing in the same bucket. This lands within 5 minutes of "now", which is
  // all the billing-terms acknowledgment it records needs.
  //
  // Everything else in the body below is already stable across a replay while
  // the trial is on: `discounts` is always undefined and `intro_reserved`
  // always "false" (see the intro-coupon gate above). If that coupon is ever
  // switched back on, two racing submits would differ on both fields - only
  // one can win claim_promo - and the loser would get a Stripe idempotency
  // error instead of a session. That is the correct outcome for a duplicate
  // attempt, and the catch below already declines to release a reservation the
  // loser never held, but it surfaces as an error rather than a redirect.
  const consentAt = new Date(idempotencyBucket * 5 * 60 * 1000).toISOString();

  let session: Awaited<ReturnType<typeof stripe.checkout.sessions.create>>;
  try {
    session = await stripe.checkout.sessions.create(
      {
        mode: "subscription",
        line_items: [lineItem],
        discounts,
        // The free trial, plus the step-up flag stamped on the SUBSCRIPTION
        // rather than just the session. A duration:"once" coupon is consumed by
        // the first invoice and Stripe detaches it, so by the time the
        // renewal-reminders cron looks the discount may already be gone and the
        // step-up would be invisible. The flag is the durable record that the
        // next charge is higher than this one, and the cron reads it. It also
        // doubles as the webhook's signal (on customer.subscription.updated /
        // deleted) that THIS subscription is the one holding the promo
        // reservation, for the abandoned-payment rollback.
        subscription_data: subscriptionCheckoutData({
          trialDays: freeTrial ? PRO_PLAN.trialDays : null,
          introStepUp: freeTrial || Boolean(discounts),
        }),
        // Explicit, not left to the default: the card has to be on file BEFORE
        // the trial starts, so the membership can convert on its own at trial
        // end and the buyer has given billing information against the
        // disclosure they were shown.
        payment_method_collection: "always",
        customer: customerId ?? undefined,
        customer_email: customerId ? undefined : user.email ?? undefined,
        metadata: {
          type: "pro_subscription",
          user_id: user.id,
          plan,
          consent_terms: consentTerms,
          consent_at: consentAt,
          // Session-level twin of intro_step_up above, for the OTHER half of
          // the rollback: checkout.session.expired. An abandoned checkout never
          // produces a subscription at all, so the webhook has nothing but this
          // session's own metadata to check when deciding whether to release
          // the reservation.
          intro_reserved: claimedIntro ? "true" : "false",
        },
        success_url: `${siteUrl()}/pro/plus?welcome=1`,
        cancel_url: `${siteUrl()}/pro/plus`,
      },
      { idempotencyKey }
    );
  } catch (err) {
    // The reservation above already wrote to promo_claims. If Stripe itself
    // failed to create the session, no checkout.session.expired event will
    // EVER fire for it - there's no session to expire - so the webhook's
    // rollback path can't reach this case. Release the reservation here,
    // inline, so a Stripe hiccup doesn't cost the user their one intro price.
    if (claimedIntro) {
      const admin = createAdminClient();
      const { error } = await admin
        .from("promo_claims")
        .delete()
        .eq("user_id", user.id)
        .eq("promo_key", "pro_intro_monthly");
      if (error) {
        console.error(
          "promo_claims release after failed session create failed:",
          error.message ?? error
        );
      }
    }
    throw err;
  }

  if (session.url) redirect(session.url);
  redirect("/pro/plus");
}

// Shared body for cancel/resume: both flip cancel_at_period_end on the
// Pro-side subscription and differ only in the flag and the flash copy.
async function setProRenewal(opts: {
  cancelAtPeriodEnd: boolean;
  missingFlash: string;
  doneFlash: string;
}) {
  const user = await getUser();
  if (!user) redirect("/signin");

  // Pro-side row only: the homeowner Plus subscription is a different
  // membership and must never be canceled or resumed from here.
  const sub = await getProSubscription();
  if (!sub?.stripe_subscription_id) {
    await setFlash(opts.missingFlash, "error");
    redirect("/pro/plus");
  }

  try {
    await stripe.subscriptions.update(sub.stripe_subscription_id, {
      cancel_at_period_end: opts.cancelAtPeriodEnd,
    });
  } catch {
    await setFlash(
      "Something went sideways talking to Stripe. Try Manage billing instead.",
      "error"
    );
    redirect("/pro/plus");
  }

  await setFlash(opts.doneFlash);
  revalidatePath("/pro/plus");
}

// Cancel the membership at period end. Nothing changes today: they keep every
// Pro perk through the time they already paid for, and it simply doesn't
// renew. Lead access is unaffected either way.
export async function cancelProMembershipAction() {
  await setProRenewal({
    cancelAtPeriodEnd: true,
    missingFlash: "No active membership to cancel.",
    doneFlash: "Your membership won't renew. You keep every perk until it ends.",
  });
}

// Undo a pending cancellation: the membership keeps renewing as before.
export async function resumeProMembershipAction() {
  await setProRenewal({
    cancelAtPeriodEnd: false,
    missingFlash: "No membership to resume.",
    doneFlash: "Welcome back. Your membership will keep renewing.",
  });
}

// Send the pro to Stripe's billing portal to manage or cancel their plan.
// The portal is customer-scoped, so fall back to the homeowner-side row's
// customer id when no Pro-side row exists yet (same Stripe customer).
export async function manageProBillingAction() {
  const sub = (await getProSubscription()) ?? (await getSubscription());
  if (!sub?.stripe_customer_id) redirect("/pro/plus");

  const portal = await stripe.billingPortal.sessions.create({
    customer: sub.stripe_customer_id,
    return_url: `${siteUrl()}/pro/plus`,
  });

  redirect(portal.url);
}
