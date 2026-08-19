"use server";

import type Stripe from "stripe";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { stripe } from "@/lib/stripe";
import { getUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSubscription, getProSubscription } from "@/lib/subscription";
import { billingTermsText } from "@/lib/billingTerms";
import { subscriptionCheckoutData } from "@/lib/checkoutSubscriptionData";
import { PLUS_PLAN, EXTRA_HOME, extraHomeUnitPrice } from "@/lib/constants";
import { setFlash } from "@/lib/flash";

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

// The Stripe product id backing a subscription item's price, for the inline
// price_data fallback paths (which need a product reference).
function productIdOf(item: Stripe.SubscriptionItem): string {
  return typeof item.price.product === "string"
    ? item.price.product
    : item.price.product.id;
}


// Start a Hearth Plus checkout (monthly or yearly). Weekly was retired as a
// new-checkout option and is no longer offered here; existing weekly
// subscribers keep their plan (see PLUS_PLAN.weekly, grandfathered-only). Uses
// the pre-created Stripe Price if one is configured, otherwise falls back to
// inline price_data so the flow works before Products/Prices are set up in
// Stripe.
export async function startPlusCheckoutAction(formData: FormData) {
  const rawPlan = formData.get("plan") as string;
  const plan = rawPlan === "yearly" ? "yearly" : "monthly";

  // Deliberately NOT src/lib/auth.ts's getUser(): that helper trusts
  // getSession(), which reads the user id straight off the (unverified)
  // cookie. user.id below is written into the Stripe session's
  // metadata.user_id, which the webhook trusts via the admin client to
  // attribute the resulting subscription, so a cookie-edited id would let an
  // attacker misattribute a subscription to a victim. supabase.auth.getUser()
  // re-checks the id against Supabase's auth server.
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/signin");

  const priceId =
    plan === "yearly"
      ? process.env.STRIPE_PRICE_PLUS_YEARLY
      : process.env.STRIPE_PRICE_PLUS_MONTHLY;

  const planAmount = plan === "yearly" ? PLUS_PLAN.yearly : PLUS_PLAN.monthly;
  const planInterval =
    plan === "yearly" ? ("year" as const) : ("month" as const);

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

  // Double-checkout guard: our subscriptions row only appears after the
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
      alreadySubscribed = stripeSubs.data.some(
        (s) =>
          (s.status === "active" || s.status === "trialing") &&
          s.id !== proSub?.stripe_subscription_id
      );
    } catch {
      // If Stripe is unreachable, fall through to checkout as before.
    }
    if (alreadySubscribed) {
      setFlash(
        "You already have a Hearth Plus membership. No need to buy it twice.",
        "info"
      );
      redirect("/plus");
    }
  }

  // Every brand-new subscriber gets a free trial (PLUS_PLAN.trialDays), on
  // either cadence they can pick (monthly or yearly). `existing` already scopes
  // to a homeowner-side Plus subscription, so a returning subscriber switching
  // cadence never gets a second trial.
  const freeTrial = !existing;

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
  const idempotencyBucket = Math.floor(Date.now() / (5 * 60 * 1000));
  const idempotencyKey = `plus-checkout:${user.id}:${plan}:${idempotencyBucket}`;

  // consent_at has to be derived from the bucket start, not a fresh Date: the
  // idempotency key above is stable across two submits landing in the same
  // bucket, but a freshly-computed timestamp would make the request body
  // differ between those submits, and Stripe treats a replayed key with a
  // different body as a conflict error. This lands within 5 minutes of "now",
  // which is fine for what it records - the billing-terms acknowledgment
  // above, not a precise click time.
  const consentAt = new Date(idempotencyBucket * 5 * 60 * 1000).toISOString();

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
        },
        success_url: `${siteUrl()}/plus?welcome=1`,
        cancel_url: `${siteUrl()}/plus`,
      },
      { idempotencyKey }
    );
  } catch {
    setFlash("We couldn't start checkout. Please try again.", "error");
    redirect("/plus");
  }

  if (session.url) redirect(session.url);
  redirect("/plus");
}

// Set the number of paid extra homes on a live Plus subscription (0 to
// EXTRA_HOME.maxExtra). Extra homes are a Plus-only add-on: only a monthly or
// yearly Plus member can buy them. A grandfathered weekly subscriber can't -
// they're told to switch to monthly or yearly first. If Plus lapses, the slots
// lapse with it (the webhook zeroes the column on cancellation).
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
    setFlash("Start Hearth Plus first, then you can add extra homes.", "error");
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
    setFlash(
      "Fix your payment method first, then you can add extra homes.",
      "error"
    );
    redirect("/plus");
  }

  // Grandfathered weekly rows can't buy the add-on: the volume Prices are
  // monthly/yearly only, and the interval has to match the base plan. Tell
  // them to switch cadence first.
  if (sub.plan !== "monthly" && sub.plan !== "yearly") {
    setFlash(
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
    setFlash(
      "Something went sideways talking to Stripe. Try Manage billing instead.",
      "error"
    );
    redirect("/plus");
  }

  const homeSlotPriceId =
    interval === "yearly"
      ? process.env.STRIPE_PRICE_HOME_SLOT_YEARLY
      : process.env.STRIPE_PRICE_HOME_SLOT_MONTHLY;

  // The existing add-on item, if any: matched by our metadata tag or the
  // configured price id. Everything else on the subscription is the base plan.
  const addonItem = stripeSub.items.data.find(
    (i) =>
      (i as any).metadata?.hearth_addon === "home_slots" ||
      (homeSlotPriceId && i.price.id === homeSlotPriceId)
  );

  const stripeInterval = interval === "yearly" ? ("year" as const) : ("month" as const);

  try {
    if (quantity <= 0) {
      // Remove the add-on entirely. Nothing to do if it was never added.
      if (addonItem) {
        await stripe.subscriptions.update(sub.stripe_subscription_id, {
          items: [{ id: addonItem.id, deleted: true }],
        });
      }
    } else {
      // Inline fallback charges a flat per-slot unit_amount from the volume
      // tier for THIS quantity (every slot at the crossed-tier price), which
      // matches how the pre-created Stripe volume Price would bill.
      const unitAmount = Math.round(
        extraHomeUnitPrice(interval, quantity) * 100
      );
      const pricePart = homeSlotPriceId
        ? { price: homeSlotPriceId }
        : {
            price_data: {
              currency: "usd",
              unit_amount: unitAmount,
              recurring: { interval: stripeInterval },
              product_data: { name: "Extra Hearth home" },
            },
          };
      const itemPayload = {
        ...(addonItem ? { id: addonItem.id } : {}),
        ...pricePart,
        quantity,
        metadata: { hearth_addon: "home_slots" },
      };
      await stripe.subscriptions.update(sub.stripe_subscription_id, {
        items: [itemPayload as any],
      });
    }
  } catch {
    setFlash(
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

  setFlash(
    quantity > 0
      ? `Done. You can now track up to ${5 + quantity} homes.`
      : "Done. Your extra homes were removed."
  );
  revalidatePath("/plus");
}

// Switch a monthly subscriber to yearly, effective immediately. Stripe swaps
// the subscription item to the yearly price and invoices right away with
// proration, so unused monthly time comes off the yearly charge as a credit.
// A trialing subscriber's trial ends now: yearly never carries a trial.
export async function upgradeToYearlyAction() {
  const user = await getUser();
  if (!user) redirect("/signin");

  // getSubscription is scoped to the signed-in user, so this Stripe
  // subscription id is theirs by construction.
  const sub = await getSubscription();
  if (!sub?.stripe_subscription_id) {
    setFlash("No active subscription to change.", "error");
    redirect("/plus");
  }
  if (sub.plan === "yearly") {
    setFlash("You're already on the yearly plan.", "info");
    redirect("/plus");
  }

  let stripeSub: Stripe.Subscription;
  try {
    stripeSub = await stripe.subscriptions.retrieve(
      sub.stripe_subscription_id
    );
  } catch {
    setFlash(
      "Something went sideways talking to Stripe. Try Manage billing instead.",
      "error"
    );
    redirect("/plus");
  }
  // Convert the BASE plan item (never the add-on) to yearly.
  const base = baseSubItem(stripeSub);
  const yearlyPriceId = process.env.STRIPE_PRICE_PLUS_YEARLY;
  const productId = productIdOf(base);

  // Stripe requires every item on a subscription to share one interval, so a
  // member holding a monthly extra-home add-on must have that item converted to
  // the yearly home-slot price in the SAME update - otherwise the switch either
  // errors (mixed intervals) or silently drops their paid homes. Keep the same
  // quantity, priced at the yearly volume tier, and preserve the metadata tag
  // so the webhook still recognizes it as the add-on.
  const addon = stripeSub.items.data.find(isHomeSlotItem);
  const addonQty = addon?.quantity ?? 0;
  const yearlyHomeSlotPriceId = process.env.STRIPE_PRICE_HOME_SLOT_YEARLY;

  type ItemUpdate = Stripe.SubscriptionUpdateParams.Item;
  const items: ItemUpdate[] = [
    yearlyPriceId
      ? { id: base.id, price: yearlyPriceId, quantity: 1 }
      : {
          id: base.id,
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: 3999,
            recurring: { interval: "year" as const },
            product: productId,
          },
        },
  ];
  if (addon && addonQty > 0) {
    items.push(
      yearlyHomeSlotPriceId
        ? {
            id: addon.id,
            price: yearlyHomeSlotPriceId,
            quantity: addonQty,
            metadata: { hearth_addon: "home_slots" },
          }
        : {
            id: addon.id,
            quantity: addonQty,
            price_data: {
              currency: "usd",
              unit_amount: Math.round(
                extraHomeUnitPrice("yearly", addonQty) * 100
              ),
              recurring: { interval: "year" as const },
              product: productIdOf(addon),
            },
            metadata: { hearth_addon: "home_slots" },
          }
    );
  }

  try {
    await stripe.subscriptions.update(sub.stripe_subscription_id, {
      items,
      // Bill the yearly price today; unused monthly time becomes a credit.
      proration_behavior: "always_invoice",
      // A free-month trial doesn't carry over - yearly starts (and bills) now.
      ...(stripeSub.status === "trialing" ? { trial_end: "now" as const } : {}),
    });
  } catch {
    setFlash(
      "Something went sideways talking to Stripe. Try Manage billing instead.",
      "error"
    );
    redirect("/plus");
  }

  // The webhook flips the stored plan once Stripe confirms the update.
  setFlash("You're on yearly now. Unused monthly time was credited.");
  revalidatePath("/plus");
}

// Schedule a switch to monthly at renewal, for a yearly subscriber OR a
// grandfathered weekly one. Nothing is charged or refunded now: they keep the
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
    setFlash("No active subscription to change.", "error");
    redirect("/plus");
  }
  // Only monthly subscribers have nothing to switch to. Yearly and legacy
  // weekly rows both switch to monthly through the same schedule below.
  if (sub.plan === "monthly") {
    setFlash("You're already on the monthly plan.", "info");
    redirect("/plus");
  }

  let stripeSub: Stripe.Subscription;
  try {
    stripeSub = await stripe.subscriptions.retrieve(
      sub.stripe_subscription_id
    );
  } catch {
    setFlash(
      "Something went sideways talking to Stripe. Try Manage billing instead.",
      "error"
    );
    redirect("/plus");
  }
  if (stripeSub.schedule) {
    setFlash("Your switch to monthly is already scheduled.", "info");
    redirect("/plus");
  }

  let schedule: Stripe.SubscriptionSchedule;
  try {
    schedule = await stripe.subscriptionSchedules.create({
      from_subscription: sub.stripe_subscription_id,
    });
  } catch {
    setFlash(
      "Couldn't schedule the switch. If your plan is set to cancel, use Manage billing instead.",
      "error"
    );
    redirect("/plus");
  }

  // from_subscription yields a single phase covering the current (already
  // paid) period. Re-send it unchanged and append the monthly phase after it.
  const current = schedule.phases[0];
  const base = baseSubItem(stripeSub);
  const monthlyPriceId = process.env.STRIPE_PRICE_PLUS_MONTHLY;
  const productId = productIdOf(base);

  // The extra-home add-on, if any, must ride into the monthly phase too, priced
  // at the monthly volume tier - otherwise phase 2 lists only the base item and
  // the member silently loses their paid homes at renewal. Preserve the same
  // quantity and the metadata tag so the webhook still recognizes it. The
  // add-on's current price id lets us re-tag it in phase 1 as well.
  const addon = stripeSub.items.data.find(isHomeSlotItem);
  const addonQty = addon?.quantity ?? 0;
  const addonCurrentPriceId = addon?.price?.id ?? null;
  const monthlyHomeSlotPriceId = process.env.STRIPE_PRICE_HOME_SLOT_MONTHLY;

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
  // tier when present.
  const phase2Items: PhaseItem[] = [
    monthlyPriceId
      ? { price: monthlyPriceId, quantity: 1 }
      : {
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: 499,
            recurring: { interval: "month" as const },
            product: productId,
          },
        },
  ];
  if (addon && addonQty > 0) {
    phase2Items.push(
      monthlyHomeSlotPriceId
        ? {
            price: monthlyHomeSlotPriceId,
            quantity: addonQty,
            metadata: { hearth_addon: "home_slots" },
          }
        : {
            quantity: addonQty,
            price_data: {
              currency: "usd",
              unit_amount: Math.round(
                extraHomeUnitPrice("monthly", addonQty) * 100
              ),
              recurring: { interval: "month" as const },
              // Schedule phase price_data takes a product id (not product_data),
              // so reuse the add-on's own Stripe product.
              product: productIdOf(addon),
            },
            metadata: { hearth_addon: "home_slots" },
          }
    );
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
    throw err;
  }

  setFlash("Done. You'll switch to monthly at your renewal date.");
  revalidatePath("/plus");
}

// Undo a scheduled downgrade: release the schedule so the subscription keeps
// renewing yearly as if nothing happened.
export async function keepYearlyAction() {
  const user = await getUser();
  if (!user) redirect("/signin");

  const sub = await getSubscription();
  if (!sub?.stripe_subscription_id) {
    setFlash("No active subscription to change.", "error");
    redirect("/plus");
  }

  let stripeSub: Stripe.Subscription;
  try {
    stripeSub = await stripe.subscriptions.retrieve(
      sub.stripe_subscription_id
    );
  } catch {
    setFlash(
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

  setFlash("You're keeping the yearly plan.");
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
    setFlash("No active subscription to cancel.", "error");
    redirect("/plus");
  }

  let stripeSub: Stripe.Subscription;
  try {
    stripeSub = await stripe.subscriptions.retrieve(
      sub.stripe_subscription_id
    );
  } catch {
    setFlash(
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
    setFlash(
      "Something went sideways talking to Stripe. Try Manage billing instead.",
      "error"
    );
    redirect("/plus");
  }

  setFlash("Your membership won't renew. You keep Plus until it ends.");
  revalidatePath("/plus");
}

// Undo a pending cancellation: the membership keeps renewing as before.
export async function resumeMembershipAction() {
  const user = await getUser();
  if (!user) redirect("/signin");

  const sub = await getSubscription();
  if (!sub?.stripe_subscription_id) {
    setFlash("No subscription to resume.", "error");
    redirect("/plus");
  }

  try {
    await stripe.subscriptions.update(sub.stripe_subscription_id, {
      cancel_at_period_end: false,
    });
  } catch {
    setFlash(
      "Something went sideways talking to Stripe. Try Manage billing instead.",
      "error"
    );
    redirect("/plus");
  }

  setFlash("Welcome back. Your membership will keep renewing.");
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
