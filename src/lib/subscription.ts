import { cache } from "react";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getUser } from "@/lib/auth";
import { getActiveProperty } from "@/lib/property";
import { stripe } from "@/lib/stripe";
import type { Subscription } from "@/lib/database.types";

// One user can hold TWO subscriptions rows at once (migration 0036): the
// homeowner Hearth Plus side ("monthly"/"yearly") and the contractor Hearth
// Pro side ("pro_monthly"/"pro_yearly"). The pro_ prefix keeps the two
// memberships from satisfying each other's checks.
function isProPlanName(plan: string | null | undefined): boolean {
  return typeof plan === "string" && plan.startsWith("pro_");
}

// Pure liveness predicate for a Pro-side row: a pro_ plan, active or
// trialing, and not past a known period end. Shared with server code that
// reads subscription rows directly (webhook lookups, crons, alerts), so it
// stays dependency-free: no auth, no Supabase, just the row.
export function isLiveProPlanRow(row: {
  plan?: string | null;
  status?: string | null;
  current_period_end?: string | null;
}): boolean {
  if (!isProPlanName(row.plan)) return false;
  if (row.status !== "active" && row.status !== "trialing") return false;
  if (row.current_period_end && new Date(row.current_period_end) <= new Date())
    return false;
  return true;
}

// All of the current user's subscription rows (at most one per side), together
// with whether the read itself FAILED. Written only by the Stripe webhook via
// the service role, so this is a read-only view for the app. Cached per
// request; the side-specific getters below share the single query. The side is
// derived from the plan prefix in code so these work the same whether or not
// migration 0036 has run yet.
//
// The `errored` flag exists so callers can tell "this user has no row" apart
// from "we couldn't read the table". A swallowed read error used to collapse
// both into an empty list, which made a transient or RLS failure read as
// "no Pro subscription" and hand a repeat free trial to a pro who already
// burned one (see isProTrialEligible below). The lenient getters keep treating
// an error as "no row" (an outage should not flip a member's perks on), but the
// trial grant is money and fails CLOSED off this flag instead.
const getSubscriptionRowsResult = cache(
  async (): Promise<{ rows: Subscription[]; errored: boolean }> => {
    const user = await getUser();
    if (!user) return { rows: [], errored: false };

    const supabase = await createClient();
    const { data, error } = await supabase
      .from("subscriptions")
      .select("*")
      .eq("user_id", user.id);

    if (error) {
      console.error(
        "getSubscriptionRows read failed:",
        error.message ?? error
      );
      return { rows: [], errored: true };
    }

    return { rows: (data ?? []) as Subscription[], errored: false };
  }
);

const getSubscriptionRows = cache(async (): Promise<Subscription[]> => {
  return (await getSubscriptionRowsResult()).rows;
});

// The current user's homeowner Hearth Plus subscription row (billing status,
// plan, renewal date). Never returns the contractor Pro-side row.
export const getSubscription = cache(
  async (): Promise<Subscription | null> => {
    const rows = await getSubscriptionRows();
    return rows.find((row) => !isProPlanName(row.plan)) ?? null;
  }
);

// The current user's contractor Hearth Pro membership row. Never returns the
// homeowner Plus-side row.
export const getProSubscription = cache(
  async (): Promise<Subscription | null> => {
    const rows = await getSubscriptionRows();
    return rows.find((row) => isProPlanName(row.plan)) ?? null;
  }
);

// Whether the current user may start a first-time Hearth Pro free trial. The
// Pro-side row survives a cancellation (it lands on "canceled", it is not
// deleted), so any existing Pro row means NOT eligible. Critically, this fails
// CLOSED: a read that ERRORED also returns false, so a transient or RLS read
// failure can never let a pro who already used their trial farm another one.
// getProSubscription() alone can't carry this, because its null return can't
// tell "no row" apart from "read failed". The normal no-row-means-eligible path
// is preserved: no Pro row and no read error returns true.
export async function isProTrialEligible(): Promise<boolean> {
  const { rows, errored } = await getSubscriptionRowsResult();
  if (errored) return false;
  return !rows.some((row) => isProPlanName(row.plan));
}

// Pending billing changes, read live from Stripe (one call) so the UI can't
// drift out of sync. Generic over whichever side's row is passed in:
// - scheduledDowngrade: a yearly subscriber's pending switch to monthly (the
//   subscription schedule created by downgradeToMonthlyAction), with the date
//   the monthly phase starts.
// - cancelsAt: when the membership is set to end (cancel_at_period_end), on
//   either plan, or null if it will keep renewing.
// Wrapped in React's per-request cache(): both /plus and /pro/plus render
// this off the SAME Subscription object (getSubscription/getProSubscription
// are themselves cached above, so repeated calls within one request return
// the identical reference), so cache() correctly collapses any repeat call
// with that same sub into the one live Stripe lookup already in flight/done.
// Nothing about the returned data changes - this only stops the same request
// from hitting Stripe twice for the same row.
export const getBillingOutlook = cache(
  async (
    sub: Subscription | null
  ): Promise<{
    scheduledDowngrade: { switchesAt: Date } | null;
    cancelsAt: Date | null;
  }> => {
    const none = { scheduledDowngrade: null, cancelsAt: null };
    if (!sub?.stripe_subscription_id) return none;

    try {
      const stripeSub = await stripe.subscriptions.retrieve(
        sub.stripe_subscription_id,
        { expand: ["schedule"] }
      );

      let scheduledDowngrade: { switchesAt: Date } | null = null;
      const schedule = stripeSub.schedule;
      // A pending switch-to-monthly schedule can exist on a yearly row or on a
      // grandfathered weekly one (both use downgradeToMonthlyAction).
      if (
        (sub.plan === "yearly" || sub.plan === "weekly") &&
        schedule &&
        typeof schedule !== "string" &&
        schedule.phases.length >= 2
      ) {
        const next = schedule.phases[schedule.phases.length - 1];
        scheduledDowngrade = { switchesAt: new Date(next.start_date * 1000) };
      }

      const cancelsAt =
        stripeSub.cancel_at_period_end && sub.current_period_end
          ? new Date(sub.current_period_end)
          : stripeSub.cancel_at
            ? new Date(stripeSub.cancel_at * 1000)
            : null;

      return { scheduledDowngrade, cancelsAt };
    } catch {
      return none;
    }
  }
);

// Shared billing-status check: active or trialing, and not past a known
// period end.
function isLive(
  sub: Pick<Subscription, "status" | "current_period_end">
): boolean {
  if (sub.status !== "active" && sub.status !== "trialing") return false;
  if (sub.current_period_end && new Date(sub.current_period_end) <= new Date())
    return false;
  return true;
}

// Whether the current user PERSONALLY holds a live Hearth Plus subscription.
// This is the billing truth: the /plus manage-billing UI and the owned-home
// cap (claimPropertyAction, mirrored by the 0108 DB trigger, which checks the
// inserting user's own row) key off it. A household member of a Plus home
// does NOT count here - for feature gating use hasPlus() below.
export async function ownsPlus(): Promise<boolean> {
  const sub = await getSubscription();
  if (!sub) return false;
  return isLive(sub);
}

// Household Plus half of hasPlus(): whether the ACTIVE property is someone
// else's home whose owner holds a live Plus row. getActiveProperty
// re-validates ownership/membership through RLS on every read, so
// property.user_id is trusted. The owner's subscriptions row is NOT readable
// through the member's session ("subscriptions owner read" is self-only), so
// the lookup uses the service-role client with that RLS-validated owner id,
// the same trusted-server pattern the household join flow uses. Cached per
// request like the other getters.
const activeHomeOwnerHasPlus = cache(async (): Promise<boolean> => {
  const user = await getUser();
  if (!user) return false;

  const property = await getActiveProperty();
  if (!property || property.user_id === user.id) return false;

  const admin = createAdminClient();
  const { data } = await admin
    .from("subscriptions")
    .select("plan,status,current_period_end")
    .eq("user_id", property.user_id);

  // Homeowner side only: a pro_ plan never counts as Plus.
  return (data ?? []).some((row) => !isProPlanName(row.plan) && isLive(row));
});

// Whether the current user has Plus BENEFITS on the active property. True
// when they hold a live Plus subscription themselves, or when the active
// home's owner does: Plus carries with the home, so household members of a
// Plus home get Plus features there at no extra cost. Gates the paid tools
// (posting/contacting pros, forecast, quote check, home report, AI limits).
// Billing UI and the owned-home cap must use ownsPlus() instead. Homeowner
// plans only: getSubscription never returns the Pro-side row, so a
// contractor's pro_ plan never counts as Plus.
export async function hasPlus(): Promise<boolean> {
  if (await ownsPlus()) return true;
  return activeHomeOwnerHasPlus();
}

// Paid extra-home slots on the current user's homeowner Plus subscription.
// Extra homes are a Plus-only add-on (see setExtraHomesAction): the Stripe
// webhook writes extra_home_slots off the add-on subscription item's quantity,
// and sets it to 0 when Plus is canceled. Counted only when the homeowner row
// is LIVE (same active/trialing + period check ownsPlus uses), so a lapsed row
// with a stale value never grants extra capacity - slots lapse with Plus. The
// column isn't in database.types.ts yet, so it's read cast-through-any, the
// same convention the other not-yet-typed columns use. Returns 0 when there is
// no live Plus row.
export async function getExtraHomeSlots(): Promise<number> {
  const sub = await getSubscription();
  if (!sub || !isLive(sub)) return 0;
  const slots = Number((sub as any).extra_home_slots) || 0;
  return slots > 0 ? slots : 0;
}

// Whether the current user has an active Hearth Pro membership (contractor
// side). Unlocks perks only: deposit bonus boost, alerts, back-office tools.
// It NEVER changes which leads a pro can see or apply to.
export async function hasProPlan(): Promise<boolean> {
  const sub = await getProSubscription();
  if (!sub) return false;
  return isLiveProPlanRow(sub);
}

// Whether the current user has already consumed a one-time promo (e.g. the
// Pro intro month). Explicit, lifecycle-independent guard against repeat
// intro-price farming: the promo_claims ledger (migration 0071) is never
// pruned by a subscription cancel, so this holds even if canceled
// subscription rows are ever deleted. Fails CLOSED: a broken lookup returns
// true so a farmer can never turn an outage into a repeat intro. Returns
// false only when the DB positively confirms no claim exists.
export async function hasClaimedPromo(key: string): Promise<boolean> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("has_claimed_promo", {
    p_key: key,
  });
  if (error) {
    // fail CLOSED: a broken lookup must never hand out a repeat intro
    console.error("has_claimed_promo failed - denying intro:", error.message ?? error);
    return true;
  }
  return Boolean(data);
}
