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
  checkoutIdempotencyBucket,
  checkoutIdempotencyKey,
  IDEMPOTENCY_BUCKET_MS,
} from "@/lib/checkoutIdempotency";
import { PRO_RESERVATION_REF } from "@/lib/promoClaimRef";
import {
  markReservationSession,
  reclaimCheckoutReservation,
} from "@/lib/checkoutReservation";
import {
  checkoutCadence,
  subscriptionCheckoutData,
} from "@/lib/checkoutSubscriptionData";
import { setFlash } from "@/lib/flash";
import { trialDecision, RISK_BLOCK_MESSAGE } from "@/lib/risk/decision";
import { recordRequestSignals } from "@/lib/risk/signals";
import { trackServerEvent } from "@/lib/trackServer";
import { variantForUser } from "@/lib/paywallExperiment";

const siteUrl = () =>
  process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

// The promo_claims reservation key AND ref for the Pro FREE TRIAL (HIGH-31),
// the twin of PLUS_RESERVATION_REF/'plus_trial'. Distinct from
// PRO_RESERVATION_REF, which is the retired intro-coupon reservation. This
// literal MUST match the identical one in src/app/api/stripe/webhook/route.ts,
// which releases and converts the same rows; promoClaimRef.ts (home of the
// other reservation refs) is outside the surface this change touches.
const PRO_TRIAL_PROMO_KEY = "pro_trial";
const PRO_TRIAL_RESERVATION_REF = "pro_trial_checkout_reservation";

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

  // First double-checkout guard, on OUR OWN row, before Stripe is consulted at
  // all. The Stripe-side check below only runs when a customer id already
  // exists, and that id comes from a subscriptions row - so an account whose
  // Pro row somehow carries no stripe_customer_id (an older row, a manual fix,
  // a webhook that landed the plan before the customer) skipped the guard
  // entirely and could open a second live membership. A live row here is
  // already proof of one. Mirrors startPlusCheckoutAction on the homeowner
  // side.
  const liveExisting =
    existing &&
    (existing.status === "active" || existing.status === "trialing");
  if (liveExisting) {
    await setFlash(
      "You already have a Hearth Pro membership. No need to buy it twice.",
      "info"
    );
    redirect("/pro/plus");
  }

  // Second double-checkout guard, mirroring startPlusCheckoutAction: our
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
      // WHICH LIVE SUBSCRIPTION COUNTS AS "already a Pro member" (HIGH-33).
      //
      // This used to be "any live subscription on the customer whose id is not
      // the homeowner row's stripe_subscription_id", and that identity exclusion
      // has the same hole the homeowner side already fixed: the homeowner Plus
      // row can carry a NULL stripe_subscription_id (an older row, a manual fix,
      // a webhook that landed the row before the subscription id). `s.id !== null`
      // is true of everything, so the pro's OWN live Plus membership was read as
      // a live Pro one and a homeowner who is also a contractor was told they
      // already had Pro and could never buy it.
      //
      // So match on the PRO prices when we know them: a Plus subscription is on
      // Plus's prices and can never be mistaken for one of these, whether or not
      // its id is on file. When no Pro price is configured (the inline
      // price_data fallback path, where there is nothing to match on), this falls
      // back to the old behaviour, with the homeowner subscription excluded by id
      // whenever the id is actually known. Mirrors startPlusCheckoutAction.
      const proPriceIds = [
        process.env.STRIPE_PRO_MONTHLY_PRICE_ID,
        process.env.STRIPE_PRO_YEARLY_PRICE_ID,
      ].filter((id): id is string => Boolean(id));
      const homeownerSubId = homeownerSub?.stripe_subscription_id ?? null;
      alreadyMember = stripeSubs.data.some((s) => {
        if (s.status !== "active" && s.status !== "trialing") return false;
        if (homeownerSubId && s.id === homeownerSubId) return false;
        if (!proPriceIds.length) return true;
        return s.items.data.some(
          (i) => i.price?.id && proPriceIds.includes(i.price.id)
        );
      });
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
  //
  // Trial-abuse check (src/lib/risk). This is the moment the account is about to
  // be handed 3 free days, so it is the moment to ask whether we have met this
  // person before under another email.
  //
  // THE ORDER MATTERS, and it is decide-then-record. The /pro/plus page computes the
  // SAME decision with persist:false to choose which auto-renewal disclosure to
  // render, and it records nothing. If this action recorded first, it would be
  // deciding over a strictly larger set of stored signals than the page saw, and
  // the two could disagree about the same checkout: somebody who signed up on
  // their phone and bought on the household iPad would read "free for 3 days" on
  // the page and be charged today by the action, because the action had just
  // written the device signal the page never saw. The disclosure they consented
  // to would be the wrong one, in the direction ROSCA and California's Automatic
  // Renewal Law actually care about.
  //
  // So: decide over exactly the state the page decided over, then record the
  // signals for NEXT time. Both calls are best-effort and neither can throw.
  //
  // risk.allowTrial is ANDed onto the same `freeTrial` so every surface reading
  // it stays in agreement: the Stripe trial below, the consent record, the
  // acknowledgment email, and the copy on /pro/plus. A medium-risk pro can still
  // buy - they are simply charged from day one, and billingTerms() then quotes
  // the immediate charge instead of the free days.
  const risk = await trialDecision(user.id, {
    accountCreatedAt: user.created_at ?? null,
  });
  await recordRequestSignals(user.id, "pro_checkout");
  if (!risk.allowCheckout) {
    // Reachable only from a hand-written 'manual' abuse flag today: the score
    // itself never refuses a sale (see src/lib/risk/decision.ts).
    await setFlash(RISK_BLOCK_MESSAGE, "error");
    redirect("/pro/plus");
  }
  // ONE TRIAL PER ACCOUNT, ENFORCED SYNCHRONOUSLY, HERE (HIGH-31).
  //
  // Every guard above reads state the Stripe WEBHOOK writes only AFTER a
  // checkout completes, so none of them can see a checkout still in flight. A
  // first-ever pro could open /pro/plus in two tabs - the monthly trial
  // shortcut in one, the yearly card in the other - and start both: both read
  // "eligible", both got trial_period_days, and the account minted two Pro
  // subscriptions on two different Stripe customers. The webhook's
  // upsert-by-(user_id, side) keeps ONE subscriptions row; the other survived
  // as an orphan with no row, no in-app cancel button, and - because Checkout
  // with customer:undefined mints a fresh customer per session - no customer
  // anyone had on file, so even the billing portal could not reach it. It
  // billed at trial end forever.
  //
  // The fix is the exact one the Plus side uses (startPlusCheckoutAction) and
  // the one the Pro intro coupon already uses below: atomically claim a
  // promo_claims row before the Stripe session is created. Its PK is
  // (user_id, promo_key), so claim_promo's "on conflict do nothing ... return
  // found" lets exactly ONE of N racing requests win; every other one falls
  // through to a charged-today checkout with the disclosure and consent record
  // built from the same `freeTrial` value, so nothing on screen promises free
  // days that are not coming. claim_promo is service_role-only, hence the admin
  // client. The webhook releases an abandoned reservation (expired session, or
  // a subscription landing canceled/incomplete_expired without going live) and
  // stamps a completed one converted, so a legit pro who bails keeps their one
  // trial. `trial_reserved` in the session metadata is how the webhook knows
  // which attempt holds it.
  //
  // A FAILED RPC MEANS NO TRIAL. Free days are the thing being farmed, so an
  // unreadable counter must never be a way to get a second one. And when the
  // claim is LOST, reclaimCheckoutReservation answers what a bare row cannot:
  // resume the open session, take over a dead one, or stand down (fail closed).
  // The paywall experiment (src/lib/paywallExperiment.ts) is one more AND in
  // the same place, enforced server-side: a "hard"-variant pro gets no trial
  // even from a hand-crafted request, because the variant is a pure hash of
  // the verified user id and this line is what feeds the Stripe trial.
  // Eligibility, risk, and the reservation flow are untouched; "hard" is
  // simply one more reason the trial does not apply, and /pro/plus gates its
  // copy on the same variant so screen and charge agree.
  const paywallVariant = variantForUser(user.id);
  const wantsTrial = (await isProTrialEligible()) && risk.allowTrial && paywallVariant === "soft";
  let freeTrial = false;
  let claimedTrial = false;
  // An open Stripe Checkout to send the pro back to. Acted on after the block
  // (redirect() throws, and a try/catch would swallow it).
  let trialResumeUrl: string | null = null;
  if (wantsTrial) {
    const admin = createAdminClient();
    try {
      const { data, error } = await admin.rpc("claim_promo", {
        p_user: user.id,
        p_key: PRO_TRIAL_PROMO_KEY,
        p_ref: PRO_TRIAL_RESERVATION_REF,
      });
      if (error) {
        console.error(
          "claim_promo(pro_trial) reservation failed - no free days:",
          error.message ?? error
        );
      } else if (data === true) {
        claimedTrial = true;
        freeTrial = true;
      } else {
        const outcome = await reclaimCheckoutReservation(admin, {
          userId: user.id,
          promoKey: PRO_TRIAL_PROMO_KEY,
          reservationRef: PRO_TRIAL_RESERVATION_REF,
          plan,
        });
        if (outcome.kind === "resume") {
          trialResumeUrl = outcome.url;
        } else if (outcome.kind === "reclaimed") {
          claimedTrial = true;
          freeTrial = true;
        }
        // "held": another tab is mid-checkout, or the trial is already spent.
        // Charge today instead.
      }
    } catch (err) {
      console.error("claim_promo(pro_trial) reservation threw:", err);
    }
  }
  // Back to the checkout they already opened: same trial, same terms.
  if (trialResumeUrl) redirect(trialResumeUrl);

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
  //
  // A ROW THAT ALREADY EXISTS IS NOT ALWAYS A SPENT OFFER, which is the
  // homeowner side's live bug in the same shape (see startPlusCheckoutAction
  // and checkoutReservation.ts). A reservation held by a checkout the pro
  // opened and backed out of sits in the ledger until Stripe expires the
  // session, up to 24 hours later - and until then every retry both loses the
  // offer AND changes the request body under an unchanged idempotency key,
  // which Stripe refuses outright. So a lost claim now asks Stripe what became
  // of the session that holds it: resume it, take it over if it is dead, or
  // stand down. Standing down is the fail-closed answer, so two tabs at once
  // still produce exactly one intro.
  let discounts: Array<{ coupon: string }> | undefined;
  let claimedIntro = false;
  // An open Stripe Checkout to send the pro back to. Acted on after the
  // try/catch: redirect() throws, and the catch would swallow it.
  let resumeUrl: string | null = null;
  // `!wantsTrial`, not `!freeTrial`: a buyer who was ELIGIBLE for the trial but
  // lost the concurrent-tab reservation race (freeTrial went back to false) is
  // charged today at full price, never handed the intro coupon instead. Today
  // the trial is always on for eligible buyers, so this stays equal to the old
  // `!freeTrial` for every non-racing checkout.
  //
  // The paywall experiment's "soft" check sits here too, on purpose. Without
  // it, putting an account on the "hard" arm would flip !wantsTrial true and
  // WAKE the dormant intro coupon for every brand-new monthly pro on that arm,
  // handing them a $9.99 first month. The hard arm is "full price from day
  // one, no offer of any kind" - both because that is the thing being measured
  // against the trial, and because the consent record above the coupon path
  // still quotes trial copy the buyer would not be getting.
  const introOffered = !wantsTrial && paywallVariant === "soft" && plan === "pro_monthly" && !existing;
  // Still the cheap ledger pre-check, just no longer a hard skip: when it says
  // a claim exists, the row may still be a reservation this pro can have back,
  // so the reclaim path runs and only the RPC is skipped.
  const alreadyClaimed = introOffered
    ? await hasClaimedPromo("pro_intro_monthly")
    : true;
  if (introOffered) {
    const coupon = await proIntroCouponId();
    if (coupon) {
      const admin = createAdminClient();
      try {
        const { data, error } = alreadyClaimed
          ? { data: false as boolean | null, error: null }
          : await admin.rpc("claim_promo", {
              p_user: user.id,
              p_key: "pro_intro_monthly",
              p_ref: PRO_RESERVATION_REF,
            });
        if (error) {
          console.error(
            "claim_promo reservation failed - no intro discount:",
            error.message ?? error
          );
        } else if (data === true) {
          claimedIntro = true;
          discounts = [{ coupon }];
        } else {
          // A concurrent checkout, an abandoned one, or a spent claim: only the
          // first two can be given back, and only reclaimCheckoutReservation
          // can tell them apart.
          const outcome = await reclaimCheckoutReservation(admin, {
            userId: user.id,
            promoKey: "pro_intro_monthly",
            reservationRef: PRO_RESERVATION_REF,
            plan,
          });
          if (outcome.kind === "resume") {
            resumeUrl = outcome.url;
          } else if (outcome.kind === "reclaimed") {
            claimedIntro = true;
            discounts = [{ coupon }];
          }
        }
      } catch (err) {
        console.error(
          "claim_promo reservation threw - no intro discount:",
          err
        );
      }
    }
  }
  // Back to the checkout they already opened: same offer, same terms, and
  // nothing new for Stripe to object to.
  if (resumeUrl) redirect(resumeUrl);

  // A REACHABLE Stripe customer, always (HIGH-31). When we already know one
  // (an existing Pro or homeowner row), use it. Otherwise - the brand-new pro,
  // the exact case the double-checkout guards above cannot cover - create one
  // NOW and hand it to Checkout, instead of letting Checkout mint an anonymous
  // customer per session. Two things follow: two concurrent sessions land on
  // the SAME customer (the idempotency key on the create is stable per user, so
  // both tabs resolve to one customer), and any subscription this checkout
  // produces - including an orphan from a second tab that the reservation above
  // did not manage to stop - is reachable by manageProBillingAction's billing
  // portal and by cancel. Before this, a customer:undefined orphan billed at
  // trial end with no row and no customer anyone had on file, so nothing in the
  // app could ever reach it. Best-effort: if the create fails we fall back to
  // Checkout's own customer creation, exactly as before.
  let checkoutCustomerId: string | null = customerId;
  if (!checkoutCustomerId) {
    try {
      const customer = await stripe.customers.create(
        {
          email: user.email ?? undefined,
          metadata: { user_id: user.id, side: "pro" },
        },
        // Stable per user: two tabs opening checkout at once both resolve to
        // this one customer rather than creating two. (Stripe retains an
        // idempotency key for 24h, which is far longer than the concurrent-tab
        // window; by the next day a subscriptions row exists and customerId is
        // populated, so this branch is not even reached.)
        { idempotencyKey: `pro-customer:${user.id}` }
      );
      checkoutCustomerId = customer.id;
    } catch (err) {
      console.error(
        "pro checkout customer create failed, letting Checkout create one:",
        err
      );
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
  const idempotencyBucket = checkoutIdempotencyBucket();

  // consent_at has to come from the bucket start, not a fresh Date: Stripe
  // treats a replayed idempotency key carrying a DIFFERENT body as a conflict
  // error, and a freshly-computed timestamp would differ between two submits
  // landing in the same bucket. This lands within 5 minutes of "now", which is
  // all the billing-terms acknowledgment it records needs.
  //
  // The rest of the body used to be excused on the grounds that it is stable
  // while the trial is on: `discounts` always undefined, `intro_reserved`
  // always "false". That excuse is what cost the homeowner side a working
  // checkout - the moment the offer could differ between two clicks, Stripe
  // started refusing the replayed key instead of creating a session. So the
  // varying inputs go into the key here too, before the coupon is ever
  // switched back on.
  const consentAt = new Date(
    idempotencyBucket * IDEMPOTENCY_BUCKET_MS
  ).toISOString();
  const idempotencyKey = checkoutIdempotencyKey({
    prefix: "pro-checkout",
    userId: user.id,
    plan,
    bucket: idempotencyBucket,
    varying: {
      freeTrial,
      coupon: discounts?.[0]?.coupon ?? "none",
      customer: checkoutCustomerId ?? "new",
      price: priceId ?? "inline",
      consentTerms,
      consentAt,
    },
  });

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
        customer: checkoutCustomerId ?? undefined,
        customer_email: checkoutCustomerId ? undefined : user.email ?? undefined,
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
          // The FREE TRIAL half of the same signal (HIGH-31): which attempt
          // holds the 'pro_trial' reservation, so checkout.session.expired can
          // release an abandoned one. "false" on a session that lost the race.
          trial_reserved: claimedTrial ? "true" : "false",
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
    // Same inline release for a reserved FREE TRIAL (HIGH-31): a session Stripe
    // never created fires no expired event, so the webhook cannot roll this back.
    if (claimedTrial) {
      const admin = createAdminClient();
      const { error } = await admin
        .from("promo_claims")
        .delete()
        .eq("user_id", user.id)
        .eq("promo_key", PRO_TRIAL_PROMO_KEY);
      if (error) {
        console.error(
          "promo_claims(pro_trial) release after failed session create failed:",
          error.message ?? error
        );
      }
    }

    // Then behave the way the homeowner side already does
    // (startPlusCheckoutAction): tell the pro in plain language and put them
    // back on /pro/plus. Rethrowing here surfaced as a 500 and the generic
    // error boundary, which reads as "the whole site is broken" for what is
    // usually a transient Stripe hiccup or a misconfigured price id.
    //
    // The real Stripe message is logged first, deliberately: this catch now
    // swallows the exception, so without this line a genuinely broken
    // configuration would be invisible in the Vercel logs. It is logged, never
    // shown - a Stripe error string is not copy for a buyer.
    console.error("Pro checkout session create failed:", err);
    await setFlash("We couldn't start checkout. Please try again.", "error");
    redirect("/pro/plus");
  }

  // Record which session holds the reservation, so a pro who backs out of this
  // checkout can be given the offer back on their next click instead of losing
  // it (and the checkout) to their own dead reservation.
  if (claimedIntro) {
    await markReservationSession(createAdminClient(), {
      userId: user.id,
      promoKey: "pro_intro_monthly",
      reservationRef: PRO_RESERVATION_REF,
      sessionId: session.id,
    });
  }
  // The same, for the FREE TRIAL reservation (HIGH-31): record which session
  // holds it so a second click can resume this exact checkout rather than lose
  // the trial to its own bare marker.
  if (claimedTrial) {
    await markReservationSession(createAdminClient(), {
      userId: user.id,
      promoKey: PRO_TRIAL_PROMO_KEY,
      reservationRef: PRO_TRIAL_RESERVATION_REF,
      sessionId: session.id,
    });
  }

  // Funnel analytics (docs/ANALYTICS.md), right before handing off to Stripe:
  // the session exists at this point, so this only fires for a checkout that
  // actually reached Stripe, not one refused by an earlier guard above. The
  // paywall-experiment variant rides along so soft and hard conversion can be
  // compared later.
  await trackServerEvent(user.id, "pro_checkout_started", {
    plan,
    variant: paywallVariant,
  });

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
