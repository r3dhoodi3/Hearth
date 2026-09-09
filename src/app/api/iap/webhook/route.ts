import { NextRequest, NextResponse } from "next/server";
import { createHash, timingSafeEqual as nodeTimingSafeEqual } from "crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { isMissingSchemaError } from "@/lib/dbErrors";
import { PLUS_ENTITLEMENT_ID, PRO_ENTITLEMENT_ID } from "@/lib/iap";

// =============================================================================
// RevenueCat server webhook, modeled directly on
// src/app/api/stripe/webhook/route.ts so the two stay consistent in how they
// touch `subscriptions` (read that file's upsertSubscriptionRow before
// changing this one). RevenueCat verifies the Apple/Google receipt for us and
// posts a normalized event here - this route never talks to Apple or Google
// directly.
//
// WHAT IS WIRED vs STUBBED (appstore-execute report has the full list):
//   WIRED   - webhook auth (Authorization header vs REVENUECAT_WEBHOOK_SECRET)
//   WIRED   - app_user_id -> subscriptions.user_id mapping (they are the SAME
//             id: configurePurchases() in src/lib/iap.ts passes the Supabase
//             user id as RevenueCat's appUserID, so no separate identity
//             table is needed), validated as a UUID AND checked to exist in
//             auth.users before anything is written
//   WIRED   - entitlement -> side/plan mapping, status derivation, the
//             subscriptions upsert itself (same table/shape Stripe writes)
//   WIRED   - replay/out-of-order protection and Stripe-row protection, see
//             the two blocks marked REPLAY GUARD and STRIPE GUARD below
//   STUBBED - no in-app notification is sent on a RevenueCat-driven billing
//             event (the Stripe webhook's notifyOnce/dunning-notice paths are
//             NOT mirrored here - a renewal or a billing issue on native
//             updates the row silently). Wiring that up is a follow-up, not
//             done tonight given the time budget - see the execute report.
//   STUBBED - PRO_TRIAL_PROMO_KEY / promo_claims reservation bookkeeping the
//             Stripe pro-checkout path does (src/app/pro/plus/actions.ts) has
//             no RevenueCat equivalent here. Apple/Google's own introductory-
//             offer eligibility is enforced by the STORE, not by OakTend, so
//             this is lower-risk to skip than it would be on the Stripe side,
//             but it does mean OakTend's own promo_claims bookkeeping does not
//             know about a trial granted via IAP.
// =============================================================================

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// RevenueCat sends `Authorization: Bearer <your configured secret>` (set the
// SAME string in the RevenueCat dashboard's webhook config and here). This is
// NOT a signature over the body (RevenueCat's webhook auth is a shared-secret
// bearer token, unlike Stripe's HMAC signature).
//
// Compared through Node's crypto.timingSafeEqual over SHA-256 digests rather
// than character by character: hashing first makes both sides a fixed 32
// bytes, so the comparison cannot leak the secret's LENGTH the way an
// "a.length !== b.length" early return does, and timingSafeEqual itself is
// the platform's constant-time primitive rather than a hand-rolled loop a JIT
// is free to turn into an early exit.
function constantTimeEquals(a: string, b: string): boolean {
  const da = createHash("sha256").update(a, "utf8").digest();
  const db = createHash("sha256").update(b, "utf8").digest();
  return nodeTimingSafeEqual(da, db);
}

function isAuthorized(req: NextRequest): boolean {
  const secret = process.env.REVENUECAT_WEBHOOK_SECRET;
  // Never accept an unconfigured webhook: without this, an unset env var would
  // turn this route into an unauthenticated "grant anyone Plus" endpoint.
  if (!secret) return false;
  const header = req.headers.get("authorization") ?? "";
  return constantTimeEquals(header, `Bearer ${secret}`);
}

// The subset of RevenueCat's event payload this route reads. RevenueCat's
// real payload carries many more fields (see
// https://www.revenuecat.com/docs/integrations/webhooks/event-types-and-fields)
// - only what is needed to write a subscriptions row is typed here.
type RevenueCatEvent = {
  id?: string;
  type: string; // INITIAL_PURCHASE | RENEWAL | CANCELLATION | UNCANCELLATION | EXPIRATION | BILLING_ISSUE | PRODUCT_CHANGE | TRANSFER | TEST | ...
  app_user_id: string; // the OakTend/Supabase user id, per configurePurchases()
  entitlement_ids?: string[] | null;
  entitlement_id?: string | null; // RevenueCat's older singular field
  product_id?: string | null;
  new_product_id?: string | null; // PRODUCT_CHANGE carries the plan being moved TO
  period_type?: string | null; // TRIAL | INTRO | NORMAL | PROMOTIONAL
  event_timestamp_ms?: number | null;
  expiration_at_ms?: number | null;
  environment?: string; // SANDBOX | PRODUCTION
};

// Event types this route knows how to turn into a subscriptions row. Anything
// NOT in this map is acknowledged and ignored rather than defaulted to
// "active": RevenueCat keeps adding event types (SUBSCRIPTION_PAUSED,
// NON_RENEWING_PURCHASE, SUBSCRIBER_ALIAS, TEMPORARY_ENTITLEMENT_GRANT, and
// so on) and a catch-all default of "active" would silently grant paid access
// on the next type RevenueCat invents. Fail closed: unknown means write
// nothing.
//
// TRANSFER is deliberately NOT here. Its payload describes a move BETWEEN two
// app_user_ids (transferred_from / transferred_to) and app_user_id alone does
// not say which end this event is about, so treating it as a grant could hand
// a paid entitlement to the account that just LOST it. Ack and skip until that
// is handled properly with both id lists.
const STATUS_BY_EVENT: Record<string, string> = {
  INITIAL_PURCHASE: "active",
  RENEWAL: "active",
  UNCANCELLATION: "active",
  PRODUCT_CHANGE: "active",
  // RevenueCat's CANCELLATION fires when auto-renew is turned off, not when
  // access actually ends - the member keeps the entitlement through
  // expiration_at_ms. Mirrors the Stripe webhook's own cancel-at-period-end
  // handling: status stays "active" and the period end is what the app's gates
  // already check. A REFUND also arrives as CANCELLATION, but with
  // expiration_at_ms set to the refund moment, so the same period-end check in
  // src/lib/subscription.ts's isLive() revokes access immediately.
  CANCELLATION: "active",
  EXPIRATION: "canceled",
  BILLING_ISSUE: "past_due",
};

// Status values mirror what the Stripe webhook writes to the same column
// (subscription.status: "active" | "trialing" | "past_due" | "canceled"), so
// ownsPlus()/isLiveProPlanRow() in src/lib/subscription.ts read either source
// identically.
function statusForEvent(event: RevenueCatEvent): string | null {
  const base = STATUS_BY_EVENT[event.type];
  if (!base) return null;
  // A store-granted free trial is "trialing" on the Stripe side, so it is
  // "trialing" here too - isLive() accepts both, and the billing UI can tell a
  // trial from a paid cycle either way.
  if (base === "active" && event.period_type === "TRIAL") return "trialing";
  return base;
}

// entitlement_ids -> which side of the app this event is about. A payload
// carrying BOTH ids (should not happen given OakTend sells them as separate
// entitlements) prefers pro, since a contractor account is the rarer/higher-
// stakes side to get wrong.
function sideForEntitlements(ids: string[]): "homeowner" | "pro" | null {
  if (ids.includes(PRO_ENTITLEMENT_ID)) return "pro";
  if (ids.includes(PLUS_ENTITLEMENT_ID)) return "homeowner";
  return null;
}

// product_id -> the same "monthly"/"yearly"/"weekly" (or "pro_monthly"/
// "pro_yearly") plan strings the Stripe webhook stores, read by NAME
// convention rather than a fixed id list: RevenueCat product ids are whatever
// Landen names them in App Store Connect/Play Console, so this looks for the
// cadence word inside the id instead of an exact match. Falls back to
// "monthly" (never null) so a row is never written with an unreadable plan -
// the same "always write something ownsPlus() can read" preference the Stripe
// side takes with its planFromItems fallback.
function planForProduct(productId: string | null | undefined, side: "homeowner" | "pro"): string {
  const id = (productId ?? "").toLowerCase();
  const cadence = id.includes("year")
    ? "yearly"
    : id.includes("week")
      ? "weekly"
      : "monthly";
  return side === "pro" ? `pro_${cadence === "weekly" ? "monthly" : cadence}` : cadence;
}

// The pro_ prefix convention src/lib/subscription.ts uses to tell the two
// sides apart from the plan name alone.
function isProPlanName(plan: string | null | undefined): boolean {
  return typeof plan === "string" && plan.startsWith("pro_");
}

// The same liveness predicate src/lib/subscription.ts's isLive() applies, kept
// local so this route does not pull that module's Supabase/auth imports into a
// webhook. Used only by the STRIPE GUARD below.
function rowIsLive(row: { status?: string | null; current_period_end?: string | null }): boolean {
  if (row.status !== "active" && row.status !== "trialing") return false;
  if (row.current_period_end && new Date(row.current_period_end) <= new Date()) return false;
  return true;
}

// Same "one subscriptions row per (user, side)" upsert the Stripe webhook uses
// (migration 0036's side column) - see that route's upsertSubscriptionRow for
// the full reasoning, including the pre-0036 fallback.
async function upsertRow(
  // `any`, matching src/app/api/stripe/webhook/route.ts's own
  // upsertSubscriptionRow: the strictly-typed admin client rejects an upsert
  // payload built from a dynamic Record the way both webhooks build theirs
  // (RejectExcessProperties on the generated Update type), so both routes take
  // the same escape hatch rather than fighting the generated types for a shape
  // that is correct at runtime.
  admin: any,
  row: Record<string, unknown>,
  side: "homeowner" | "pro"
): Promise<{ message?: string } | null> {
  const { error } = await admin
    .from("subscriptions")
    .upsert({ ...row, side }, { onConflict: "user_id,side" });
  if (!error) return null;
  if (!isMissingSchemaError(error)) return error;
  const { error: fallbackError } = await admin
    .from("subscriptions")
    .upsert(row, { onConflict: "user_id" });
  return fallbackError ?? null;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Acknowledged but ignored. 200, not 4xx: RevenueCat retries a non-2xx for
// hours, and none of the conditions that land here are transient (a TEST
// event, an entitlement OakTend does not sell, an id that is not a real user).
// Only a genuine processing failure returns 500 below.
function skip(reason: string) {
  return NextResponse.json({ ok: true, skipped: true, reason });
}

export async function POST(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { event?: RevenueCatEvent };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }

  const event = body.event;
  if (!event || typeof event.app_user_id !== "string" || !event.app_user_id) {
    return skip("no_event");
  }

  // SANDBOX events reach the SAME webhook URL as production ones (RevenueCat
  // has one webhook config per project, not one per environment). An App Store
  // sandbox tester, or anyone who can point a sandbox Apple ID at this
  // project, can produce a real, RevenueCat-sent INITIAL_PURCHASE that never
  // charged a card - so a sandbox event must never grant paid access on the
  // production deploy. Set REVENUECAT_ALLOW_SANDBOX=1 on a preview/staging
  // deploy where sandbox purchases SHOULD grant, and leave it unset in prod.
  const sandboxAllowed =
    process.env.REVENUECAT_ALLOW_SANDBOX === "1" ||
    process.env.VERCEL_ENV === "preview" ||
    (process.env.NODE_ENV !== "production" && !process.env.VERCEL_ENV);
  if (event.environment === "SANDBOX" && !sandboxAllowed) {
    return skip("sandbox_event_on_production");
  }

  // app_user_id IS the OakTend user id (see configurePurchases() in
  // src/lib/iap.ts) - no separate lookup table. Shape-checked before it ever
  // reaches a query, the same discipline reportActions.ts applies to a
  // browser-supplied id.
  if (!UUID_RE.test(event.app_user_id)) {
    return skip("app_user_id_not_a_uuid");
  }

  const statusValue = statusForEvent(event);
  if (!statusValue) {
    // TEST, TRANSFER, and every RevenueCat event type this route does not map
    // land here. Ack so RevenueCat stops retrying; write nothing.
    return skip(`unhandled_event_type:${event.type}`);
  }

  const entitlementIds = Array.isArray(event.entitlement_ids)
    ? event.entitlement_ids
    : typeof event.entitlement_id === "string"
      ? [event.entitlement_id]
      : [];
  const side = sideForEntitlements(entitlementIds);
  if (!side) {
    // A RevenueCat event for an entitlement OakTend doesn't recognize (a
    // dashboard test product, a future entitlement not yet wired here).
    return skip("unknown_entitlement");
  }

  const admin = createAdminClient();

  // The app_user_id is whatever the DEVICE told RevenueCat to call itself
  // (Purchases.configure({ appUserID })), so a modified build can put an
  // arbitrary uuid there. subscriptions.user_id has a foreign key to
  // auth.users, so a made-up id could not be inserted anyway - but it would
  // fail as a 500 and put RevenueCat into a retry loop forever. Check it
  // against auth.users up front instead: a forged id is acknowledged and
  // dropped, and only a real account can ever have a row written for it.
  const { data: authUser, error: authLookupError } =
    await admin.auth.admin.getUserById(event.app_user_id);
  if (authLookupError) {
    // Distinguish "no such user" (Supabase returns a 404-shaped error) from a
    // real outage: the first is a forged id to drop, the second deserves a
    // retry. Anything that is not clearly "not found" gets the retry.
    const message = String(authLookupError.message ?? "").toLowerCase();
    const notFound =
      (authLookupError as { status?: number }).status === 404 ||
      message.includes("not found");
    if (!notFound) {
      console.error("iap/webhook: auth user lookup failed:", authLookupError.message ?? authLookupError);
      return NextResponse.json({ error: "Could not process event" }, { status: 500 });
    }
    return skip("unknown_app_user_id");
  }
  if (!authUser?.user) {
    return skip("unknown_app_user_id");
  }

  // Read every row this user has and pick the one for THIS side by the plan
  // prefix, rather than filtering on the `side` column in the query. Same
  // approach src/lib/subscription.ts's getSubscription/getProSubscription
  // take, and for the same reason: `side` arrived in migration 0036 and is
  // still absent from the generated database.types.ts, so a .eq("side", ...)
  // both fails typecheck and breaks on a DB where 0036 has not run.
  const { data: existingRows, error: existingError } = await admin
    .from("subscriptions")
    .select("status, plan, current_period_end, updated_at, stripe_subscription_id")
    .eq("user_id", event.app_user_id);
  // A read failure here is transient, not a reason to write blind: 500 and let
  // RevenueCat redeliver rather than risk clobbering a Stripe row this read
  // would have protected. isMissingSchemaError covers a pre-0036 DB with no
  // `side` column, where there is nothing to protect against yet.
  if (existingError && !isMissingSchemaError(existingError)) {
    console.error(
      "iap/webhook: subscriptions read failed:",
      existingError.message ?? existingError
    );
    return NextResponse.json({ error: "Could not process event" }, { status: 500 });
  }
  const existing =
    (existingRows ?? []).find(
      (row) => isProPlanName(row.plan) === (side === "pro")
    ) ?? null;

  // STRIPE GUARD. One subscriptions row per (user, side) is shared by both
  // billing rails, and a RevenueCat row carries no Stripe ids. Without this, a
  // stale EXPIRATION for a long-dead IAP product would overwrite a LIVE Stripe
  // subscriber's row: status becomes "canceled", and (worse) the
  // stripe_subscription_id needed to cancel that subscription at deletion time
  // is gone, leaving the member paying Stripe with no access and no way for
  // deleteAccountAction to stop the billing. Refuse instead: a Stripe-managed
  // row that is still live is never touched from this route.
  if (existing?.stripe_subscription_id && rowIsLive(existing)) {
    console.warn(
      `iap/webhook: ignoring ${event.type} for ${event.app_user_id} (${side}): that side is managed by a live Stripe subscription`
    );
    return skip("stripe_managed_side");
  }

  // REPLAY GUARD. RevenueCat retries on any non-2xx and does not guarantee
  // ordering, so the same event can arrive twice and an older event can arrive
  // after a newer one. updated_at is written FROM the event's own timestamp
  // (not Date.now()), which makes it a high-water mark: an event at or before
  // the mark is a replay or an out-of-order straggler and is dropped. Without
  // this, a redelivered EXPIRATION landing after a RENEWAL would downgrade a
  // paying member.
  const eventAtMs =
    typeof event.event_timestamp_ms === "number" &&
    Number.isFinite(event.event_timestamp_ms)
      ? event.event_timestamp_ms
      : Date.now();
  if (
    existing?.updated_at &&
    eventAtMs <= new Date(existing.updated_at).getTime()
  ) {
    return skip("stale_or_replayed_event");
  }

  const productId = event.new_product_id || event.product_id;
  const row: Record<string, unknown> = {
    user_id: event.app_user_id,
    status: statusValue,
    plan: planForProduct(productId, side),
    current_period_end: event.expiration_at_ms
      ? new Date(event.expiration_at_ms).toISOString()
      : null,
    updated_at: new Date(eventAtMs).toISOString(),
  };
  // stripe_customer_id / stripe_subscription_id are OMITTED, not set to null,
  // when a row already exists: PostgREST's upsert only updates the columns
  // present in the payload, so leaving them out means a RevenueCat event can
  // never blank out Stripe ids on a row that has them. On a first insert they
  // default to NULL on their own. The one case that DOES clear them is a
  // takeover of a DEAD Stripe row (the live case is refused above), where
  // leaving a stale stripe_subscription_id behind would point
  // deleteAccountAction's cancel loop at a subscription this row no longer
  // describes.
  if (existing?.stripe_subscription_id) {
    row.stripe_customer_id = null;
    row.stripe_subscription_id = null;
  }

  const upsertError = await upsertRow(admin, row, side);
  if (upsertError) {
    console.error(
      "iap/webhook: subscriptions upsert failed:",
      upsertError.message ?? upsertError
    );
    // 500 so RevenueCat redelivers. The upsert is idempotent on
    // (user_id, side), so a retry after a partial failure is harmless - same
    // reasoning as the Stripe webhook's equivalent branch.
    return NextResponse.json({ error: "Could not process event" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
