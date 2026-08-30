"use server";

import type Stripe from "stripe";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { stripe } from "@/lib/stripe";
import { getUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  getSubscription,
  getProSubscription,
  isPlusTrialEligible,
} from "@/lib/subscription";
import {
  billingTermsText,
  trialApplies,
  TRIAL_PLAN_SWITCH_MESSAGE,
} from "@/lib/billingTerms";
import {
  checkoutCadence,
  subscriptionCheckoutData,
} from "@/lib/checkoutSubscriptionData";
import { PLUS_PLAN, EXTRA_HOME } from "@/lib/constants";
import { plusPriceId, homeSlotPriceId } from "@/lib/stripePlanPrice";
import {
  checkoutIdempotencyBucket,
  checkoutIdempotencyKey,
  IDEMPOTENCY_BUCKET_MS,
} from "@/lib/checkoutIdempotency";
import { PLUS_RESERVATION_REF } from "@/lib/promoClaimRef";
import {
  markReservationSession,
  reclaimCheckoutReservation,
} from "@/lib/checkoutReservation";
import { setFlash } from "@/lib/flash";
import { trialDecision, RISK_BLOCK_MESSAGE } from "@/lib/risk/decision";
import { recordRequestSignals } from "@/lib/risk/signals";
import { trackServerEvent } from "@/lib/trackServer";

const siteUrl = () =>
  process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

// Identify the extra-home add-on subscription item vs the base plan item, the
// same way the Stripe webhook's isHomeSlotItem/baseItem do (route.ts). A plan
// switch (monthly<->yearly) has to carry the add-on along at the matching
// interval instead of dropping it or leaving a mixed-interval subscription
// Stripe would reject. Matched by our metadata tag or the configured price id.
function homeSlotPriceIds(): string[] {
  return [
    process.env.STRIPE_PRICE_HOME_SLOT_MONTHLY,
    process.env.STRIPE_PRICE_HOME_SLOT_YEARLY,
  ].filter((id): id is string => Boolean(id));
}

function isHomeSlotItem(item: Stripe.SubscriptionItem): boolean {
  if (!item) return false;
  if ((item.metadata as Record<string, string> | null)?.hearth_addon === "home_slots") {
    return true;
  }
  const priceId = item.price?.id;
  return priceId ? homeSlotPriceIds().includes(priceId) : false;
}

// The BASE plan item on a subscription: the one that is NOT the extra-home
// add-on. Falls back to the first item when nothing matches (a subscription
// with no add-on).
function baseSubItem(sub: Stripe.Subscription): Stripe.SubscriptionItem {
  return sub.items.data.find((i) => !isHomeSlotItem(i)) ?? sub.items.data[0];
}

// NOTE ON PRICES BELOW. The plan-switch paths used to build inline `price_data`
// pointing at the product the subscription item already carried. That is what
// broke "Switch to yearly" live: the "Hearth Plus" product on the connected
// account had been archived, and Stripe will not attach a new price to an
// inactive product. Every price on an existing subscription now comes from
// src/lib/stripePlanPrice.ts, which returns the configured STRIPE_PRICE_* id
// when there is one and otherwise find-or-creates an ACTIVE product and price.

// Start a Hearth Plus checkout on any of the three sold cadences: weekly,
// monthly, or yearly. Uses the pre-created Stripe Price if one is configured,
// otherwise falls back to inline price_data so the flow works before
// Products/Prices are set up in Stripe.
export async function startPlusCheckoutAction(formData: FormData) {
  // Monthly is the fallback cadence (see checkoutCadence): it is what the
  // pricing card preselects, so a form arriving without a readable "plan"
  // field lands on the plan the buyer was looking at. Every cadence now
  // carries the same free days for an eligible account, so this choice decides
  // the PRICE only. The line item, the consent record, and the idempotency key
  // below all derive from this one value, so they can never quote different
  // plans.
  const plan = checkoutCadence(formData.get("plan"), "monthly");

  // Deliberately NOT src/lib/auth.ts's getUser(): that helper trusts
  // getSession(), which reads the user id straight off the (unverified)
  // cookie. user.id below is written into the Stripe session's
  // metadata.user_id, which the webhook trusts via the admin client to
  // attribute the resulting subscription, so a cookie-edited id would let an
  // attacker misattribute a subscription to a victim. supabase.auth.getUser()
  // re-checks the id against Supabase's auth server.
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/signin");

  // One pre-created Stripe Price per cadence, each optional: an unset env var
  // falls through to the inline price_data below, so a cadence works before
  // its Price exists in Stripe. STRIPE_PRICE_PLUS_WEEKLY is the newest of the
  // three and the likeliest to be missing.
  const priceId =
    plan === "weekly"
      ? process.env.STRIPE_PRICE_PLUS_WEEKLY
      : plan === "yearly"
        ? process.env.STRIPE_PRICE_PLUS_YEARLY
        : process.env.STRIPE_PRICE_PLUS_MONTHLY;

  const planAmount =
    plan === "weekly"
      ? PLUS_PLAN.weekly
      : plan === "yearly"
        ? PLUS_PLAN.yearly
        : PLUS_PLAN.monthly;
  const planInterval =
    plan === "weekly"
      ? ("week" as const)
      : plan === "yearly"
        ? ("year" as const)
        : ("month" as const);

  const lineItem = priceId
    ? { price: priceId, quantity: 1 }
    : {
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: Math.round(planAmount * 100),
          recurring: { interval: planInterval },
          product_data: { name: "Hearth Plus" },
        },
      };

  // getSubscription is homeowner-side only; the same user may also carry a
  // Pro-side row (a contractor who is also a homeowner) on the same Stripe
  // customer.
  const existing = await getSubscription();
  const proSub = await getProSubscription();
  const customerId =
    existing?.stripe_customer_id ?? proSub?.stripe_customer_id ?? null;

  // First double-checkout guard, on OUR OWN row, before Stripe is consulted at
  // all. The Stripe-side check below only runs when a customer id already
  // exists, and the customer id comes from a subscriptions row - so an account
  // whose row somehow carries no stripe_customer_id (an older row, a manual
  // fix, a webhook that landed the plan before the customer) skipped the guard
  // entirely and could open a second live membership. A live row here is
  // already proof of a membership, and it is the cheapest possible check.
  const liveExisting =
    existing &&
    (existing.status === "active" || existing.status === "trialing");
  if (liveExisting) {
    await setFlash("You already have a membership.", "info");
    redirect("/plus");
  }

  // Second double-checkout guard: our subscriptions row only appears after the
  // Stripe webhook fires, so two checkouts opened back-to-back could each
  // mint a live Stripe subscription (and a trial). When we already know the
  // Stripe customer, ask Stripe directly whether they have a live Plus
  // subscription before creating another one. A live Hearth Pro membership
  // doesn't count (that sub is a different membership), so the pro-side
  // row's subscription id is excluded from the check. If no customer id
  // exists yet, the webhook's upsert-by-(user_id, side), fed by the metadata
  // below, keeps our side to one row.
  if (customerId) {
    let alreadySubscribed = false;
    try {
      const stripeSubs = await stripe.subscriptions.list({
        customer: customerId,
        status: "all",
        limit: 10,
      });
      // WHICH LIVE SUBSCRIPTION COUNTS AS "already has Plus".
      //
      // This used to be "any live subscription on the customer whose id is not
      // the pro row's stripe_subscription_id", and that identity exclusion has
      // a hole: a Pro-side row can exist with a NULL stripe_subscription_id (an
      // older row, a manual fix, a webhook that landed the row before the
      // subscription id). `s.id !== null` is true of everything, so the pro's
      // own live membership was read as a live Plus one and a contractor who is
      // also a homeowner was told they already had Plus and could never buy it.
      //
      // So match on the PLUS prices when we know them: a Pro subscription is on
      // Pro's prices and can never be mistaken for one of these, whether or not
      // its id is on file. When no Plus price is configured (the inline
      // price_data fallback path, where there is nothing to match on), this
      // falls back to the old behaviour, with the pro subscription excluded by
      // id whenever the id is actually known.
      const plusPriceIds = [
        process.env.STRIPE_PRICE_PLUS_WEEKLY,
        process.env.STRIPE_PRICE_PLUS_MONTHLY,
        process.env.STRIPE_PRICE_PLUS_YEARLY,
      ].filter((id): id is string => Boolean(id));
      const proSubId = proSub?.stripe_subscription_id ?? null;
      alreadySubscribed = stripeSubs.data.some((s) => {
        if (s.status !== "active" && s.status !== "trialing") return false;
        if (proSubId && s.id === proSubId) return false;
        if (!plusPriceIds.length) return true;
        return s.items.data.some(
          (i) => i.price?.id && plusPriceIds.includes(i.price.id)
        );
      });
    } catch {
      // If Stripe is unreachable, fall through to checkout as before.
    }
    if (alreadySubscribed) {
      await setFlash(
        "You already have a Hearth Plus membership. No need to buy it twice.",
        "info"
      );
      redirect("/plus");
    }
  }

  // Trial-abuse check (src/lib/risk). This is the moment the account is about to
  // be handed 3 free days, so it is the moment to ask whether we have met this
  // person before under another email.
  //
  // THE ORDER MATTERS, and it is decide-then-record. The /plus page computes the
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
  const risk = await trialDecision(user.id, {
    accountCreatedAt: user.created_at ?? null,
  });
  await recordRequestSignals(user.id, "plus_checkout");
  if (!risk.allowCheckout) {
    // Reachable only from a hand-written 'manual' abuse flag today: the score
    // itself never refuses a sale (see the decision table in
    // src/lib/risk/decision.ts). Deliberately vague, and deliberately routed to
    // a human - naming the signal both teaches a farmer how to route around it
    // and states a judgement call as if it were a fact.
    await setFlash(RISK_BLOCK_MESSAGE, "error");
    redirect("/plus");
  }

  // The free trial (PLUS_PLAN.trialDays) rides on WHICHEVER cadence was picked:
  // weekly, monthly, or annual all start with the same free days for an
  // eligible account and then renew at their own price, which is what the /plus
  // cards and the disclosure both say. trialApplies() is the one predicate all
  // of that reads, so the Stripe trial below, the disclosure the buyer saw, and
  // the consent record stored two blocks down cannot disagree. It used to be
  // weekly-only, which forced anyone who wanted to try the annual plan to buy
  // weekly first and switch afterwards.
  //
  // isPlusTrialEligible(), not `!existing`: both mean "no homeowner-side row",
  // but `existing` is getSubscription()'s null, which also means "the read
  // failed". Gating free days on that failed OPEN - a churned subscriber whose
  // subscriptions read errored was handed the trial again, and could retry
  // until it did. isPlusTrialEligible returns false on an errored read, the
  // same fix the Pro side already carries (isProTrialEligible).
  //
  // risk.allowTrial is ANDed into the same `introEligible` input rather than
  // bolted on afterwards, so the removal flows through every surface that reads
  // it at once: the Stripe trial_period_days below, the consent record, and the
  // acknowledgment email. A medium-risk buyer is charged today and the terms
  // they consent to say exactly that - billingTerms() takes the "charged today"
  // branch, so nothing on screen or in the record promises free days that are
  // not coming. /plus's own copy is gated on the same decision (page.tsx).
  const wantsTrial = trialApplies(plan, (await isPlusTrialEligible()) && risk.allowTrial);

  // ONE TRIAL PER ACCOUNT, ENFORCED SYNCHRONOUSLY, HERE.
  //
  // Every guard above this line reads state the Stripe WEBHOOK writes after a
  // checkout completes: isPlusTrialEligible() is "no homeowner subscriptions
  // row", and the two double-checkout guards read the same row or Stripe's own
  // subscription list. None of them can see a checkout that is still in
  // flight. So a first-ever buyer could open /plus in two tabs and tap Start
  // free days in both: both read "no row yet", both got trial_period_days, and
  // one account minted two free trials (the second surviving as an orphan
  // subscription with no row and therefore no in-app cancel button pointing at
  // it, which then bills at trial end).
  //
  // The fix is the one the Pro side already uses for its intro price:
  // atomically claim a promo_claims row before the Stripe session is created.
  // promo_claims' primary key is (user_id, promo_key) (migration 0073), so
  // claim_promo()'s "on conflict do nothing ... return found" lets exactly ONE
  // of N racing requests win; every other one falls straight through to a
  // charged-today checkout, with the disclosure and the consent record built
  // from the same `freeTrial` value, so nothing on screen promises free days
  // that are not coming. claim_promo is service_role-only, hence the admin
  // client.
  //
  // It doubles as a lifecycle-independent ledger: the row is never pruned by a
  // cancellation, so a churned member whose subscriptions row is ever deleted
  // still cannot farm a second trial.
  //
  // A reservation that is never spent - the buyer closes the Stripe tab, the
  // card is declined, Stripe fails to create the session at all - is released
  // again: by the webhook on checkout.session.expired and on a subscription
  // that lands canceled/incomplete_expired without ever going live, and inline
  // in the catch below for a session that was never created. `trial_reserved`
  // in the session metadata is how the webhook recognizes which attempt holds
  // it.
  //
  // A FAILED RPC MEANS NO TRIAL. Unlike the Pro intro (which fails through to
  // full price for the same reason), free days are the thing being farmed here,
  // and "the counter was unreadable" must never be a way to get a second one.
  //
  // WHEN THE CLAIM IS LOST, ASK WHO HOLDS IT. This is the live bug: the webhook
  // only releases an abandoned reservation when Stripe expires the session, up
  // to 24 hours later, so a buyer who opened Stripe Checkout and pressed back
  // lost the race against their own dead reservation on every click after that.
  // The old code read that as "no trial" and built a different request body
  // under the same idempotency key, which Stripe refused outright
  // (StripeIdempotencyError) - so the button simply stopped working. And once
  // the key's time bucket rolled over it got worse than an error: a session
  // with no trial, sold under a button that says free 3 day trial.
  //
  // reclaimCheckoutReservation answers the question the bare row could not:
  // resume the open session, take over a dead one, or stand down. It fails
  // closed, so the two-tabs-at-once case this block was written for still ends
  // in exactly one trial.
  let freeTrial = false;
  let claimedTrial = false;
  // An open Stripe Checkout we should send the buyer back to. Collected here
  // and acted on after the try/catch, because redirect() works by throwing and
  // the catch below would swallow it.
  let resumeUrl: string | null = null;
  if (wantsTrial) {
    const admin = createAdminClient();
    try {
      const { data, error } = await admin.rpc("claim_promo", {
        p_user: user.id,
        p_key: "plus_trial",
        p_ref: PLUS_RESERVATION_REF,
      });
      if (error) {
        console.error(
          "claim_promo(plus_trial) reservation failed - no free days:",
          error.message ?? error
        );
      } else if (data === true) {
        claimedTrial = true;
        freeTrial = true;
      } else {
        const outcome = await reclaimCheckoutReservation(admin, {
          userId: user.id,
          promoKey: "plus_trial",
          reservationRef: PLUS_RESERVATION_REF,
          plan,
        });
        if (outcome.kind === "resume") {
          resumeUrl = outcome.url;
        } else if (outcome.kind === "reclaimed") {
          claimedTrial = true;
          freeTrial = true;
        }
        // "held": another tab is mid-checkout, or the trial is already spent.
        // Charge today instead.
      }
    } catch (err) {
      console.error("claim_promo(plus_trial) reservation threw:", err);
    }
  }
  // Back to the checkout they already opened. Same session, same trial, same
  // terms, and nothing new is created for Stripe to object to.
  if (resumeUrl) redirect(resumeUrl);

  // HOW THE TWO ONE-TRIAL CHECKS COMBINE. isPlusTrialEligible() (see
  // src/lib/subscription.ts) is the fast one: any homeowner-side subscriptions
  // row at all, live or canceled, means the trial is gone, and it fails closed
  // on a read error. The promo_claims ledger above is the durable one: it
  // survives even if that row is ever pruned, and the webhook stamps it
  // converted:<subscription id> the moment a checkout completes, so a reclaim
  // can never hand a second trial to somebody who already converted. Both have
  // to say yes.

  // Consent record. California's Automatic Renewal Law requires keeping proof
  // of what the subscriber agreed to (Bus. & Prof. Code 17602(b)(2): at least
  // three years, or one year after termination, whichever is longer). Stripe
  // retains session metadata for the life of the account, so writing the
  // exact disclosure text the buyer saw - built from the same billingTerms
  // source the pre-checkout block renders - makes the record retrievable
  // without a new table. `introEligible` here is the SAME signal that decides
  // the trial two lines up, so the stored terms always match what was billed.
  // Metadata values cap at 500 characters; the slice keeps a long disclosure
  // from failing the whole checkout.
  const consentTerms = billingTermsText(plan, freeTrial).slice(0, 500);

  // Idempotency key: stable per user + plan + a 5-minute time bucket, so a
  // double-click (two form submits landing on the server milliseconds apart)
  // replays the same Stripe session instead of minting two, but a genuine
  // later retry (new bucket) still creates a fresh one.
  const idempotencyBucket = checkoutIdempotencyBucket();

  // consent_at has to be derived from the bucket start, not a fresh Date: the
  // idempotency key above is stable across two submits landing in the same
  // bucket, but a freshly-computed timestamp would make the request body
  // differ between those submits, and Stripe treats a replayed key with a
  // different body as a conflict error. This lands within 5 minutes of "now",
  // which is fine for what it records - the billing-terms acknowledgment
  // above, not a precise click time.
  const consentAt = new Date(
    idempotencyBucket * IDEMPOTENCY_BUCKET_MS
  ).toISOString();

  // ...and the bucket alone is NOT enough, which is what broke checkout live.
  // The body changes between clicks whenever the trial does, and Stripe rejects
  // a replayed key carrying a different body instead of creating the session
  // (see checkoutIdempotency.ts). So every input that can vary goes into the
  // key as well.
  const idempotencyKey = checkoutIdempotencyKey({
    prefix: "plus-checkout",
    userId: user.id,
    plan,
    bucket: idempotencyBucket,
    varying: {
      freeTrial,
      customer: customerId ?? "new",
      price: priceId ?? "inline",
      consentTerms,
      consentAt,
    },
  });

  let session: Stripe.Checkout.Session;
  try {
    session = await stripe.checkout.sessions.create(
      {
        mode: "subscription",
        line_items: [lineItem],
        // The step-up flag mirrors the Pro side so the renewal-reminders cron has
        // one signal to read for both memberships. Plus's free trial is a Stripe
        // trial, which stays visible on the subscription, but the flag costs
        // nothing and keeps the two flows from diverging.
        subscription_data: subscriptionCheckoutData({
          trialDays: freeTrial ? PLUS_PLAN.trialDays : null,
          introStepUp: freeTrial,
        }),
        customer: customerId ?? undefined,
        customer_email: customerId ? undefined : user.email ?? undefined,
        metadata: {
          type: "plus_subscription",
          user_id: user.id,
          plan,
          consent_terms: consentTerms,
          consent_at: consentAt,
          // Which attempt holds the one-trial reservation above, for the
          // webhook's rollback on checkout.session.expired. An abandoned
          // checkout never produces a subscription, so the session's own
          // metadata is all the webhook has to go on.
          trial_reserved: claimedTrial ? "true" : "false",
        },
        success_url: `${siteUrl()}/plus?welcome=1`,
        cancel_url: `${siteUrl()}/plus`,
      },
      { idempotencyKey }
    );
  } catch (err) {
    // The reservation above already wrote to promo_claims, and Stripe never
    // created a session, so no checkout.session.expired will ever fire for it
    // and the webhook's rollback cannot reach this case. Release it inline, so
    // a Stripe hiccup does not cost the buyer their one free trial. Mirrors
    // startProCheckoutAction's identical catch.
    if (claimedTrial) {
      const admin = createAdminClient();
      const { error } = await admin
        .from("promo_claims")
        .delete()
        .eq("user_id", user.id)
        .eq("promo_key", "plus_trial");
      if (error) {
        console.error(
          "promo_claims(plus_trial) release after failed session create failed:",
          error.message ?? error
        );
      }
    }
    // Logged, never shown: a Stripe error string is not copy for a buyer.
    console.error("Plus checkout session create failed:", err);
    await setFlash("We couldn't start checkout. Please try again.", "error");
    redirect("/plus");
  }

  // Write the session id onto the reservation now that there is one. This is
  // what lets the NEXT click tell "they backed out of this checkout" apart from
  // "another tab is opening one right now", instead of failing every retry.
  if (claimedTrial) {
    await markReservationSession(createAdminClient(), {
      userId: user.id,
      promoKey: "plus_trial",
      reservationRef: PLUS_RESERVATION_REF,
      sessionId: session.id,
    });
  }

  // Funnel analytics (docs/ANALYTICS.md), right before handing off to Stripe:
  // the session exists at this point, so this only fires for a checkout that
  // actually reached Stripe, not one refused by an earlier guard above.
  await trackServerEvent(user.id, "checkout_started", { plan });

  if (session.url) redirect(session.url);
  redirect("/plus");
}

// Set the number of paid extra homes on a live Plus subscription (0 to
// EXTRA_HOME.maxExtra). Extra homes are a Plus-only add-on: only a monthly or
// yearly Plus member can buy them, because the add-on Prices exist at those two
// intervals and Stripe requires every item on a subscription to share one
// interval. A weekly subscriber is told to switch cadence first. If Plus
// lapses, the slots lapse with it (the webhook zeroes the column on
// cancellation).
//
// Implemented as a SECOND subscription item alongside the base Plus item.
// Prefers the pre-created tiered volume Price (STRIPE_PRICE_HOME_SLOT_MONTHLY /
// _YEARLY) when configured; otherwise falls back to inline price_data with the
// correct volume-discounted unit price computed from EXTRA_HOME - the same
// env-then-inline shape startPlusCheckoutAction uses. The item is tagged with
// metadata hearth_addon="home_slots" so the webhook identifies it as the
// add-on (not the base plan) regardless of which price path created it.
//
// Proration uses Stripe's default. The webhook (customer.subscription.updated)
// is the source of truth for extra_home_slots; the optimistic DB write here
// just makes the new count visible before the webhook lands.
export async function setExtraHomesAction(formData: FormData) {
  const user = await getUser();
  if (!user) redirect("/signin");

  const sub = await getSubscription();
  if (!sub?.stripe_subscription_id) {
    await setFlash("Start Hearth Plus first, then you can add extra homes.", "error");
    redirect("/plus");
  }

  // Liveness guard: a past_due / unpaid / incomplete row still has a
  // subscription id, but hasPlus() won't honor it and the DB cap trigger won't
  // count its slots, so charging for an add-on here would add capacity the app
  // never grants. Reject before any Stripe call, mirroring the same
  // active/trialing + period check hasPlus()/isLive use elsewhere.
  const subLive =
    (sub.status === "active" || sub.status === "trialing") &&
    (!sub.current_period_end || new Date(sub.current_period_end) > new Date());
  if (!subLive) {
    await setFlash(
      "Fix your payment method first, then you can add extra homes.",
      "error"
    );
    redirect("/plus");
  }

  // Weekly rows can't buy the add-on: the volume Prices are monthly/yearly
  // only, and the interval has to match the base plan. Tell them to switch
  // cadence first.
  if (sub.plan !== "monthly" && sub.plan !== "yearly") {
    await setFlash(
      "Extra homes come with the monthly and yearly plans. Switch your plan first, then add homes.",
      "error"
    );
    redirect("/plus");
  }
  const interval: "monthly" | "yearly" =
    sub.plan === "yearly" ? "yearly" : "monthly";

  // Clamp to the allowed range and to a whole number of homes.
  const raw = Number(formData.get("quantity"));
  const quantity = Math.max(
    0,
    Math.min(EXTRA_HOME.maxExtra, Math.floor(Number.isFinite(raw) ? raw : 0))
  );

  let stripeSub: Stripe.Subscription;
  try {
    stripeSub = await stripe.subscriptions.retrieve(sub.stripe_subscription_id);
  } catch {
    await setFlash(
      "Something went sideways talking to Stripe. Try Manage billing instead.",
      "error"
    );
    redirect("/plus");
  }

  // Only the CONFIGURED price id is usable for recognizing an existing add-on
  // item, since that is the id a subscription created before today carries.
  const configuredSlotPriceId =
    interval === "yearly"
      ? process.env.STRIPE_PRICE_HOME_SLOT_YEARLY
      : process.env.STRIPE_PRICE_HOME_SLOT_MONTHLY;

  // The existing add-on item, if any: matched by our metadata tag or the
  // configured price id. Everything else on the subscription is the base plan.
  const addonItem = stripeSub.items.data.find(
    (i) =>
      (i as any).metadata?.hearth_addon === "home_slots" ||
      (configuredSlotPriceId && i.price.id === configuredSlotPriceId)
  );

  try {
    if (quantity <= 0) {
      // Remove the add-on entirely. Nothing to do if it was never added.
      if (addonItem) {
        await stripe.subscriptions.update(sub.stripe_subscription_id, {
          items: [{ id: addonItem.id, deleted: true }],
        });
      }
    } else {
      // One resolved Price id, never inline price_data: the fallback charges a
      // flat per-slot amount from the volume tier for THIS quantity (every slot
      // at the crossed-tier price), which matches how the pre-created Stripe
      // volume Price would bill, and it is found-or-created on an ACTIVE
      // product instead of minting a throwaway product per update.
      const itemPayload = {
        ...(addonItem ? { id: addonItem.id } : {}),
        price: await homeSlotPriceId(interval, quantity),
        quantity,
        metadata: { hearth_addon: "home_slots" },
      };
      await stripe.subscriptions.update(sub.stripe_subscription_id, {
        items: [itemPayload as any],
      });
    }
  } catch {
    await setFlash(
      "We couldn't update your homes. Please try again, or use Manage billing.",
      "error"
    );
    redirect("/plus");
  }

  // Optimistic write so the new count shows immediately; the webhook
  // reconciles it as source of truth. Best-effort: if the column isn't there
  // yet (0108 not applied) or the write fails, the webhook still corrects it.
  try {
    const admin = createAdminClient();
    await (admin as any)
      .from("subscriptions")
      .update({ extra_home_slots: quantity })
      .eq("stripe_subscription_id", sub.stripe_subscription_id);
  } catch {
    // Ignore: the webhook is the source of truth.
  }

  await setFlash(
    quantity > 0
      ? `Done. You can now track up to ${5 + quantity} homes.`
      : "Done. Your extra homes were removed."
  );
  revalidatePath("/plus");
}

// Switch a monthly subscriber to yearly, effective immediately. Stripe swaps
// the subscription item to the yearly price and invoices right away with
// proration, so unused monthly time comes off the yearly charge as a credit.
// A trialing subscriber's trial ends now: the switch bills immediately, and a
// running trial cannot survive that. New yearly signups DO trial (see
// trialApplies); this is about an existing subscription changing cadence
// mid-trial, which /plus asks them to confirm in exactly those words first.
export async function upgradeToYearlyAction() {
  const user = await getUser();
  if (!user) redirect("/signin");

  // getSubscription is scoped to the signed-in user, so this Stripe
  // subscription id is theirs by construction.
  const sub = await getSubscription();
  if (!sub?.stripe_subscription_id) {
    await setFlash("No active subscription to change.", "error");
    redirect("/plus");
  }
  if (sub.plan === "yearly") {
    await setFlash("You're already on the yearly plan.", "info");
    redirect("/plus");
  }

  let stripeSub: Stripe.Subscription;
  try {
    stripeSub = await stripe.subscriptions.retrieve(
      sub.stripe_subscription_id
    );
  } catch {
    await setFlash(
      "Something went sideways talking to Stripe. Try Manage billing instead.",
      "error"
    );
    redirect("/plus");
  }
  // Convert the BASE plan item (never the add-on) to yearly.
  const base = baseSubItem(stripeSub);

  // Stripe requires every item on a subscription to share one interval, so a
  // member holding a monthly extra-home add-on must have that item converted to
  // the yearly home-slot price in the SAME update - otherwise the switch either
  // errors (mixed intervals) or silently drops their paid homes. Keep the same
  // quantity, priced at the yearly volume tier, and preserve the metadata tag
  // so the webhook still recognizes it as the add-on.
  const addon = stripeSub.items.data.find(isHomeSlotItem);
  const addonQty = addon?.quantity ?? 0;

  type ItemUpdate = Stripe.SubscriptionUpdateParams.Item;

  try {
    // Price resolution sits INSIDE the try: it talks to Stripe (list/create),
    // so a failure here is the same "couldn't reach Stripe" story as the update
    // itself and gets the same flash rather than an unhandled 500.
    const items: ItemUpdate[] = [
      { id: base.id, price: await plusPriceId("yearly"), quantity: 1 },
    ];
    if (addon && addonQty > 0) {
      items.push({
        id: addon.id,
        price: await homeSlotPriceId("yearly", addonQty),
        quantity: addonQty,
        metadata: { hearth_addon: "home_slots" },
      });
    }

    await stripe.subscriptions.update(sub.stripe_subscription_id, {
      items,
      // Bill the yearly price today; unused monthly time becomes a credit.
      proration_behavior: "always_invoice",
      // A free trial doesn't carry over - yearly starts (and bills) now. The
      // button's confirm copy says exactly that before this runs, which is the
      // consent this early charge rests on (see /plus page.tsx).
      ...(stripeSub.status === "trialing" ? { trial_end: "now" as const } : {}),
    });
  } catch {
    await setFlash(
      "Something went sideways talking to Stripe. Try Manage billing instead.",
      "error"
    );
    redirect("/plus");
  }

  // The webhook flips the stored plan once Stripe confirms the update.
  await setFlash("You're on yearly now. Unused monthly time was credited.");
  revalidatePath("/plus");
}

// Schedule a switch to monthly at renewal, for a yearly subscriber OR a weekly
// one. Nothing is charged or refunded now: they keep the
// access they already paid for (the rest of their yearly term, or their
// current weekly period), and the subscription simply renews at $4.99/mo
// instead. Implemented as a Stripe subscription schedule - phase 1 mirrors the
// rest of the current paid period, phase 2 is one month of the monthly price
// (no trial, no proration), then the schedule releases and the subscription
// renews monthly on its own. Same pattern regardless of the starting cadence.
export async function downgradeToMonthlyAction() {
  const user = await getUser();
  if (!user) redirect("/signin");

  const sub = await getSubscription();
  if (!sub?.stripe_subscription_id) {
    await setFlash("No active subscription to change.", "error");
    redirect("/plus");
  }
  // Only monthly subscribers have nothing to switch to. Yearly and weekly rows
  // both switch to monthly through the same schedule below.
  if (sub.plan === "monthly") {
    await setFlash("You're already on the monthly plan.", "info");
    redirect("/plus");
  }

  let stripeSub: Stripe.Subscription;
  try {
    stripeSub = await stripe.subscriptions.retrieve(
      sub.stripe_subscription_id
    );
  } catch {
    await setFlash(
      "Something went sideways talking to Stripe. Try Manage billing instead.",
      "error"
    );
    redirect("/plus");
  }
  if (stripeSub.schedule) {
    await setFlash("Your switch to monthly is already scheduled.", "info");
    redirect("/plus");
  }

  // NOT WHILE THE FREE DAYS ARE RUNNING. This is the live billing bug: handing
  // a trialing subscription to a subscription schedule ended the trial the
  // moment the schedule took over and drafted a real invoice minutes into a
  // 3-day free trial, contradicting every disclosure the buyer consented to.
  // See TRIAL_PLAN_SWITCH_MESSAGE for the full story. Refuse before any Stripe
  // write happens, which is the only version of this that is provably
  // incapable of charging early. /plus hides the button in the same state, so
  // this is the belt to that page's braces (a stale render, a double submit).
  if (stripeSub.status === "trialing") {
    await setFlash(TRIAL_PLAN_SWITCH_MESSAGE, "info");
    redirect("/plus");
  }

  let schedule: Stripe.SubscriptionSchedule;
  try {
    schedule = await stripe.subscriptionSchedules.create({
      from_subscription: sub.stripe_subscription_id,
    });
  } catch {
    await setFlash(
      "Couldn't schedule the switch. If your plan is set to cancel, use Manage billing instead.",
      "error"
    );
    redirect("/plus");
  }

  // from_subscription yields a single phase covering the current (already
  // paid) period. Re-send it unchanged and append the monthly phase after it.
  const current = schedule.phases[0];

  // SECOND GUARD, on Stripe's own answer rather than on ours. The status read
  // above can be stale (retrieved a moment earlier, or a trial applied by the
  // dashboard between the two calls). If the phase Stripe generated carries a
  // trial that is still running, sending phases back without it is exactly what
  // ends the trial and invoices - so back out entirely instead: release the
  // schedule, leave the subscription exactly as it was, and say the same thing
  // the up-front guard says.
  const phaseTrialEnd =
    typeof current?.trial_end === "number" ? current.trial_end : null;
  if (phaseTrialEnd !== null && phaseTrialEnd * 1000 > Date.now()) {
    await stripe.subscriptionSchedules.release(schedule.id).catch(() => {});
    await setFlash(TRIAL_PLAN_SWITCH_MESSAGE, "info");
    redirect("/plus");
  }

  // The extra-home add-on, if any, must ride into the monthly phase too, priced
  // at the monthly volume tier - otherwise phase 2 lists only the base item and
  // the member silently loses their paid homes at renewal. Preserve the same
  // quantity and the metadata tag so the webhook still recognizes it. The
  // add-on's current price id lets us re-tag it in phase 1 as well.
  const addon = stripeSub.items.data.find(isHomeSlotItem);
  const addonQty = addon?.quantity ?? 0;
  const addonCurrentPriceId = addon?.price?.id ?? null;

  type PhaseItem = Stripe.SubscriptionScheduleUpdateParams.Phase.Item;

  // Phase 1 mirrors the current paid period unchanged, but keeps the add-on's
  // metadata tag on its item so it stays identifiable even without env prices.
  const phase1Items: PhaseItem[] = current.items.map((i) => {
    const priceId = typeof i.price === "string" ? i.price : i.price.id;
    const isAddon = addonCurrentPriceId != null && priceId === addonCurrentPriceId;
    return {
      price: priceId,
      quantity: i.quantity ?? undefined,
      ...(isAddon ? { metadata: { hearth_addon: "home_slots" } } : {}),
    };
  });

  // Phase 2: the base plan at the monthly price, plus the add-on at the monthly
  // tier when present. Both are resolved Price ids (never inline price_data
  // pointing at a product read off the subscription, which is what broke the
  // yearly switch live - see the note at the top of this file).
  let phase2Items: PhaseItem[];
  try {
    phase2Items = [{ price: await plusPriceId("monthly"), quantity: 1 }];
    if (addon && addonQty > 0) {
      phase2Items.push({
        price: await homeSlotPriceId("monthly", addonQty),
        quantity: addonQty,
        metadata: { hearth_addon: "home_slots" },
      });
    }
  } catch {
    // Nothing has been changed on the subscription yet beyond the schedule
    // wrapper, so drop that too rather than leave an empty schedule attached.
    await stripe.subscriptionSchedules.release(schedule.id).catch(() => {});
    await setFlash(
      "Couldn't schedule the switch. If your plan is set to cancel, use Manage billing instead.",
      "error"
    );
    redirect("/plus");
  }

  try {
    await stripe.subscriptionSchedules.update(schedule.id, {
      end_behavior: "release",
      proration_behavior: "none",
      phases: [
        {
          items: phase1Items,
          start_date: current.start_date,
          end_date: current.end_date,
        },
        {
          items: phase2Items,
          // One month at the new price, then release: the subscription
          // carries on renewing monthly by itself.
          duration: { interval: "month" as const, interval_count: 1 },
          proration_behavior: "none",
        },
      ],
    });
  } catch (err) {
    // Don't leave a half-built schedule attached to the subscription.
    await stripe.subscriptionSchedules.release(schedule.id).catch(() => {});
    // ...and don't rethrow into the error page either: the subscription is back
    // exactly as it was, so this is a failed attempt, not a broken account.
    // Logged rather than shown, since a Stripe error string is not copy.
    console.error("Plus downgrade schedule update failed:", err);
    await setFlash(
      "Couldn't schedule the switch. If your plan is set to cancel, use Manage billing instead.",
      "error"
    );
    redirect("/plus");
  }

  await setFlash("Done. You'll switch to monthly at your renewal date.");
  revalidatePath("/plus");
}

// Undo a scheduled downgrade: release the schedule so the subscription keeps
// renewing on its CURRENT cadence as if nothing happened. Named for the yearly
// case it was written for, but the button is shown to weekly members too
// (downgradeToMonthlyAction schedules the same switch from either cadence), so
// the confirmation names the plan actually being kept - it used to say "yearly"
// to a weekly subscriber.
export async function keepYearlyAction() {
  const user = await getUser();
  if (!user) redirect("/signin");

  const sub = await getSubscription();
  if (!sub?.stripe_subscription_id) {
    await setFlash("No active subscription to change.", "error");
    redirect("/plus");
  }

  let stripeSub: Stripe.Subscription;
  try {
    stripeSub = await stripe.subscriptions.retrieve(
      sub.stripe_subscription_id
    );
  } catch {
    await setFlash(
      "Something went sideways talking to Stripe. Try Manage billing instead.",
      "error"
    );
    redirect("/plus");
  }
  const scheduleId =
    typeof stripeSub.schedule === "string"
      ? stripeSub.schedule
      : stripeSub.schedule?.id;
  if (scheduleId) {
    await stripe.subscriptionSchedules.release(scheduleId);
  }

  // The stored plan is the one they are keeping: the schedule never took
  // effect, so nothing switched. An unknown/absent plan falls back to wording
  // that names no cadence at all rather than guessing one.
  const keptPlan =
    sub.plan === "weekly"
      ? "weekly"
      : sub.plan === "monthly"
        ? "monthly"
        : sub.plan === "yearly"
          ? "yearly"
          : null;
  await setFlash(
    keptPlan
      ? `You're keeping the ${keptPlan} plan.`
      : "You're keeping your current plan."
  );
  revalidatePath("/plus");
}

// Cancel the membership at period end. Nothing changes today: they keep every
// Plus benefit through the time they already paid for, and it simply doesn't
// renew. If a switch to monthly was scheduled, that schedule is released
// first, since a canceled plan has no next phase to switch into.
export async function cancelMembershipAction() {
  const user = await getUser();
  if (!user) redirect("/signin");

  const sub = await getSubscription();
  if (!sub?.stripe_subscription_id) {
    await setFlash("No active subscription to cancel.", "error");
    redirect("/plus");
  }

  let stripeSub: Stripe.Subscription;
  try {
    stripeSub = await stripe.subscriptions.retrieve(
      sub.stripe_subscription_id
    );
  } catch {
    await setFlash(
      "Something went sideways talking to Stripe. Try Manage billing instead.",
      "error"
    );
    redirect("/plus");
  }
  const scheduleId =
    typeof stripeSub.schedule === "string"
      ? stripeSub.schedule
      : stripeSub.schedule?.id;
  if (scheduleId) {
    await stripe.subscriptionSchedules.release(scheduleId);
  }

  try {
    await stripe.subscriptions.update(sub.stripe_subscription_id, {
      cancel_at_period_end: true,
    });
  } catch {
    await setFlash(
      "Something went sideways talking to Stripe. Try Manage billing instead.",
      "error"
    );
    redirect("/plus");
  }

  await setFlash("Your membership won't renew. You keep Plus until it ends.");
  revalidatePath("/plus");
}

// Undo a pending cancellation: the membership keeps renewing as before.
export async function resumeMembershipAction() {
  const user = await getUser();
  if (!user) redirect("/signin");

  const sub = await getSubscription();
  if (!sub?.stripe_subscription_id) {
    await setFlash("No subscription to resume.", "error");
    redirect("/plus");
  }

  try {
    await stripe.subscriptions.update(sub.stripe_subscription_id, {
      cancel_at_period_end: false,
    });
  } catch {
    await setFlash(
      "Something went sideways talking to Stripe. Try Manage billing instead.",
      "error"
    );
    redirect("/plus");
  }

  await setFlash("Welcome back. Your membership will keep renewing.");
  revalidatePath("/plus");
}

// Send the user to Stripe's billing portal to manage or cancel their plan.
export async function manageBillingAction() {
  const sub = await getSubscription();
  if (!sub?.stripe_customer_id) redirect("/plus");

  const portal = await stripe.billingPortal.sessions.create({
    customer: sub.stripe_customer_id,
    return_url: `${siteUrl()}/plus`,
  });

  redirect(portal.url);
}
