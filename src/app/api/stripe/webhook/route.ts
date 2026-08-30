import { NextRequest, NextResponse } from "next/server";
import { stripe } from "@/lib/stripe";
import { createAdminClient } from "@/lib/supabase/admin";
import { PRO_DEPOSIT_BOOST_PTS, MAX_DEPOSIT_CENTS } from "@/lib/constants";
import { isMissingSchemaError } from "@/lib/dbErrors";
import { sendNotification } from "@/lib/notify";
import { isLiveProPlanRow } from "@/lib/subscription";
import { recordCardSignal, flagAbuse } from "@/lib/risk/signals";
import { computeRisk } from "@/lib/risk/facts";
import { riskEnforcementEnabled } from "@/lib/risk/decision";
import {
  billingTerms,
  billingTermsText,
  type PaidPlan,
} from "@/lib/billingTerms";
import {
  convertedRef,
  reservedSessionRef,
  PLUS_RESERVATION_REF,
  PRO_RESERVATION_REF,
} from "@/lib/promoClaimRef";
import { trackServerEvent } from "@/lib/trackServer";

// Notification kind for the post-purchase auto-renewal acknowledgment.
const ACK_KIND = "renewal_acknowledgment";

// Dunning: the notice a member gets when a renewal charge is declined. Its own
// kind, deliberately NOT one of the Plus-gated kinds in src/lib/notifyGating.ts
// - withholding "your card was declined" from someone whose card was declined
// in order to sell them an upgrade would be indefensible, and it is a billing
// notice, which that module already carves out on principle.
const DUNNING_KIND = "payment_failed";

// The SAME kind the renewal-reminders cron writes
// (src/app/api/cron/renewal-reminders/route.ts). customer.subscription.trial_will_end
// and that cron's case-1 "trial ending" branch are two roads to one message, so
// they share a kind AND a url shape (`${cancelPath}?renewal=<trial end date>`).
// Whichever arrives first writes the row; the other one's dup guard then finds
// it and does nothing, so a trialing member gets exactly one heads-up instead
// of two saying the same thing in slightly different words.
const TRIAL_REMINDER_KIND = "renewal_reminder";

// Statuses a live subscriptions row can hold when a dunning failure is genuine
// news. Anything else (already past_due, canceled, unpaid, incomplete) is
// either the same news twice or a later, more final state that a late-arriving
// failure event must not walk backwards over.
const DUNNING_OVERWRITABLE_STATUSES = ["active", "trialing"];

// The subscription id on an invoice. It lives at invoice.subscription in older
// Stripe API versions and under invoice.parent.subscription_details in newer
// ones, and either may be an id string or an expanded object - read whichever
// is present rather than pinning a version.
function subscriptionIdFromInvoice(invoice: any): string | null {
  const raw =
    invoice?.subscription ??
    invoice?.parent?.subscription_details?.subscription ??
    null;
  return typeof raw === "string" ? raw : (raw?.id ?? null);
}

// Normalize a stored plan string to the union billingTerms understands. Mirrors
// toPaidPlan in the renewal-reminders cron: anything unrecognized returns null
// and the caller stays silent rather than guessing, because a billing notice
// quoting the wrong product or price is worse than no notice at all.
function toPaidPlan(plan: string | null | undefined): PaidPlan | null {
  if (plan === "weekly" || plan === "monthly" || plan === "yearly") return plan;
  if (plan === "pro_monthly" || plan === "pro_yearly") return plan;
  return null;
}

// Same rendering the renewal-reminders cron uses, so a date in a trial notice
// reads identically whichever path sent it. UTC on purpose: the server's local
// zone is not the member's, and a date that shifts by a day depending on which
// region the function ran in is worse than a consistent one.
function fmtDate(d: Date): string {
  return d.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

// Write a notification exactly once for a given (user, kind, url) key.
//
// This is the dup guard sendRenewalAcknowledgment and the renewal-reminders
// cron already use, lifted into one place for the dunning paths. It keys on the
// `notifications` table rather than on processed_stripe_events, and that is a
// deliberate difference from the money paths:
//
//   - The money paths claim a bare Stripe EVENT id, because crediting a
//     deposit twice is a real loss and the claim must be atomic.
//   - A notice needs the opposite property. Stripe Smart Retries fire
//     invoice.payment_failed once per retry attempt over a multi-week window,
//     each with a NEW event id but the SAME invoice id, and nobody wants four
//     copies of "your card was declined". Keying the url on the invoice (or the
//     trial end date) collapses both the retries AND any duplicate delivery of
//     one event id into a single message, which an event-id claim would not.
//   - `notifications` is migration 0001. processed_stripe_events is 0060. On a
//     live database missing the newer table this still works.
//
// Best-effort throughout: a failed notice is logged, never a 500. Stripe
// redelivering the whole event to retry a notification would risk re-running
// the money handlers beside it, which is a far worse trade.
async function notifyOnce(
  admin: any,
  input: {
    userId: string;
    kind: string;
    title: string;
    body: string;
    url: string;
  }
): Promise<void> {
  try {
    const { data: existing } = await admin
      .from("notifications")
      .select("id")
      .eq("user_id", input.userId)
      .eq("kind", input.kind)
      .eq("url", input.url)
      .limit(1)
      .maybeSingle();
    if (existing) return;

    const { data: user } = await admin
      .from("users")
      .select("email")
      .eq("id", input.userId)
      .maybeSingle();

    await sendNotification(admin, {
      userId: input.userId,
      kind: input.kind,
      title: input.title,
      body: input.body,
      url: input.url,
      email: user?.email ?? null,
      // Never SMS. Both of these are billing documents meant to be re-read,
      // and charging someone's phone plan to warn them about a charge is a
      // poor trade (the renewal cron makes the same call).
      phone: null,
    });
  } catch (err) {
    console.error(`${input.kind} notification failed:`, err);
  }
}

// Stripe needs the raw body + Node runtime to verify the signature.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// current_period_end lives on the subscription in older API versions and on
// the subscription item in newer ones - read whichever is present.
function periodEnd(subscription: any): string | null {
  const ts =
    subscription?.current_period_end ??
    subscription?.items?.data?.[0]?.current_period_end;
  return ts ? new Date(ts * 1000).toISOString() : null;
}

// The env-configured tiered volume Price ids for the extra-home add-on. An
// add-on subscription item is identified by matching one of these price ids,
// or - for the inline price_data fallback path that has no pre-created Price -
// by the hearth_addon="home_slots" metadata setExtraHomesAction stamps on the
// item.
function homeSlotPriceIds(): string[] {
  return [
    process.env.STRIPE_PRICE_HOME_SLOT_MONTHLY,
    process.env.STRIPE_PRICE_HOME_SLOT_YEARLY,
  ].filter((id): id is string => Boolean(id));
}

// Whether a subscription item is the extra-home add-on rather than the base
// Plus plan.
function isHomeSlotItem(item: any): boolean {
  if (!item) return false;
  if (item.metadata?.hearth_addon === "home_slots") return true;
  const priceId = item.price?.id;
  return priceId ? homeSlotPriceIds().includes(priceId) : false;
}

// The BASE plan item on a subscription: the one that is NOT the extra-home
// add-on. A subscription carries only the base item until a member buys extra
// homes, when a second (add-on) item joins it. planFromItems must read the
// base item's interval, never the add-on's, so a two-item subscription still
// reports the plan the member actually bought.
function baseItem(subscription: any): any {
  const items = subscription?.items?.data ?? [];
  return items.find((i: any) => !isHomeSlotItem(i)) ?? items[0] ?? null;
}

// Total paid extra-home slots on the subscription, read off the add-on item's
// quantity. 0 when there is no add-on item.
function extraHomeSlotsFromItems(subscription: any): number {
  const items = subscription?.items?.data ?? [];
  const addon = items.find((i: any) => isHomeSlotItem(i));
  const qty = Number(addon?.quantity);
  return Number.isFinite(qty) && qty > 0 ? qty : 0;
}

// Derive the stored plan ("weekly"/"monthly"/"yearly") from the price on the
// BASE subscription item (never the extra-home add-on item). It changes on an
// immediate upgrade and again when a scheduled downgrade's monthly phase kicks
// in at period end.
//
// All three Plus cadences are sold, so "week" maps as readily as the other two.
// Pro sells monthly and yearly only, and the caller that re-derives a pro_ plan
// name from this value ignores a weekly result for exactly that reason.
function planFromItems(subscription: any): string | null {
  const interval = baseItem(subscription)?.price?.recurring?.interval;
  if (interval === "year") return "yearly";
  if (interval === "month") return "monthly";
  if (interval === "week") return "weekly";
  return null;
}

// One subscriptions row per (user, side) since migration 0036: a user can
// hold homeowner Plus AND a Pro membership at once, and the two checkout
// branches must never clobber each other's row. Graceful degradation: if
// 0036 hasn't run on the live DB yet (no side column / no composite unique,
// which surfaces as a missing-schema error), retry once with the pre-0036
// payload and the old user_id conflict target so checkouts keep working
// either way. Any OTHER first-attempt error (transient network, RLS, bad
// payload) must NOT fall back: post-0036 the user_id conflict target has no
// unique constraint, so the fallback would always fail with 42P10 and mask
// the real error. Returns the final error (null on success) so the caller
// can 500 and let Stripe redeliver instead of silently losing a paid
// membership; both upserts are idempotent by conflict target, so a
// redelivery after a partial success is harmless.
async function upsertSubscriptionRow(
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

// True when an RPC error is the "this signature isn't on the live DB yet"
// fingerprint, so a call can fall back to an older overload instead of failing.
function isMissingFn(error: any, fn: string): boolean {
  const msg = error?.message ?? "";
  return (
    error?.code === "PGRST202" ||
    error?.code === "42883" ||
    (new RegExp(fn, "i").test(msg) &&
      /(does not exist|schema cache|not find)/i.test(msg))
  );
}

// Apply a deposit exactly once. Prefers the event-keyed 0058 signature, so a
// duplicated Stripe delivery of the same checkout.session.completed becomes a
// no-op in the database. If the live DB predates 0058 (or 0032), the call
// degrades to the older overloads, which still credit correctly but without
// idempotency - acceptable because Stripe live mode, and therefore any real
// duplicate delivery, is not enabled until the migration is applied.
//
// Failure handling splits by rung. A non-missing-function error on the
// event-keyed rung means the 0058 signature exists, and apply_deposit claims
// p_event_id in processed_stripe_events inside the same transaction as the
// credit, so forcing a Stripe redelivery (HTTP 500) is provably safe: if the
// first attempt actually committed, the retry is a no-op. Returns
// { retry: true } so the caller does exactly that instead of ACKing 200 and
// silently losing a paid deposit. On the older, non-keyed overloads a retry
// COULD double-credit, so those keep the log-and-ACK behavior
// ({ retry: false }): never double-credit beats never lose.
async function applyDepositOnce(
  admin: any,
  contractorId: string,
  cents: number,
  boostPts: number,
  eventId: string
): Promise<{ retry: boolean; credited: boolean }> {
  const ladder: Record<string, unknown>[] = [
    { p_contractor: contractorId, p_deposit_cents: cents, p_bonus_boost_pts: boostPts, p_event_id: eventId },
    { p_contractor: contractorId, p_deposit_cents: cents, p_bonus_boost_pts: boostPts },
    { p_contractor: contractorId, p_deposit_cents: cents },
  ];
  for (let i = 0; i < ladder.length; i++) {
    const { error } = await admin.rpc("apply_deposit", ladder[i]);
    if (!error) return { retry: false, credited: true };
    if (isMissingFn(error, "apply_deposit") && i < ladder.length - 1) {
      continue; // older DB: try the next-oldest overload
    }
    if (i === 0) {
      console.error(
        "apply_deposit failed on the event-keyed call, asking Stripe to redeliver:",
        error.message ?? error
      );
      return { retry: true, credited: false };
    }
    console.error("apply_deposit failed, not retrying:", error.message ?? error);
    return { retry: false, credited: false };
  }
  return { retry: false, credited: false }; // unreachable: the loop always returns
}

// How many cents a wallet-deposit checkout session is worth, or null if it is
// not an amount this system will act on.
//
// THE ONE PREDICATE, used by BOTH ends: the credit path and the reversal path.
// They must never disagree. A session this refuses is never credited, so a
// later dispute or refund on it must reverse nothing either - if the reversal
// side had its own, looser rule (clamping an over-cap amount down to the cap,
// say), a refund on a session that was never credited would debit $2,000 out
// of a balance the pro put there legitimately.
function acceptedDepositCents(session: any): number | null {
  const cents = Number(session?.amount_total);
  if (!Number.isFinite(cents) || cents <= 0 || cents > MAX_DEPOSIT_CENTS) {
    return null;
  }
  return cents;
}

// deposit_made's amount, bucketed to the nearest $250 rather than the exact
// cents Stripe charged (docs/ANALYTICS.md's payload rule: ids and enums only,
// never a precise dollar figure someone typed or paid). Rounds up, so a
// $50 deposit lands in the 250 bucket and the $2,000 cap lands in its own.
function depositAmountBucket(cents: number): number {
  const dollars = cents / 100;
  const capDollars = MAX_DEPOSIT_CENTS / 100;
  return Math.min(capDollars, Math.ceil(dollars / 250) * 250);
}

// Credit a deposit checkout session: look up the Pro boost, then apply the
// deposit exactly once. Shared by checkout.session.completed (instant
// methods) and checkout.session.async_payment_succeeded (delayed methods);
// each event type carries its own event id, and only ONE of them ever has
// payment_status "paid" for a given session, so the credit lands exactly
// once. Returns { retry: true } when the caller should 500 so Stripe
// redelivers a safely-retryable failed credit.
async function creditDepositSession(
  session: any,
  eventId: string
): Promise<{ retry: boolean; credited: boolean }> {
  const meta = session.metadata ?? {};
  if (meta.type !== "deposit" || !meta.contractor_id) {
    return { retry: false, credited: false };
  }

  // Delayed-notification methods (ACH debit etc.) fire completed with
  // payment_status "unpaid" and only settle later. Never credit money that
  // hasn't arrived: the async_payment_succeeded event re-enters here with
  // payment_status "paid" once it has.
  if (session.payment_status !== "paid") {
    return { retry: false, credited: false };
  }

  // THE AMOUNT COMES OFF THE SESSION, NEVER OFF METADATA.
  //
  // amount_total is what Stripe actually charged the card. metadata is a
  // free-text bag that merely rides along with the session, and it is not the
  // money that moved: any path that can produce a session with a chosen
  // metadata blob could otherwise mint wallet cash at a price it also chose.
  // depositAction writes both today and they agree, so this changes nothing
  // about a normal deposit - it just removes the only number in the credit
  // path that was not Stripe's own. Metadata still says WHICH contractor to
  // credit; it no longer says how much.
  //
  // Bounded on both ends, and the upper bound is the same MAX_DEPOSIT_CENTS
  // depositAction refuses to exceed when it creates the session. A session
  // outside the band is not credited and not retried: a redelivery would carry
  // the same out-of-band amount, so 500ing would only loop forever.
  const cents = acceptedDepositCents(session);
  if (cents === null) {
    console.error(
      "deposit credit refused: amount_total out of band for contractor",
      meta.contractor_id,
      "session",
      session.id,
      "amount_total",
      session.amount_total
    );
    return { retry: false, credited: false };
  }
  const admin = createAdminClient();

  // Hearth Pro members earn extra points on the deposit bonus. The
  // lookup is best-effort: any hiccup here means "no boost", never a
  // failed deposit. Also the only place this function learns the pro's
  // OWN account id (contractors.user_id), which deposit_made below needs -
  // metadata only carries the contractor id, not the user id analytics rows
  // are keyed on.
  let boostPts = 0;
  let proUserId: string | null = null;
  try {
    const { data: proRow } = await (admin as any)
      .from("contractors")
      .select("user_id")
      .eq("id", meta.contractor_id)
      .maybeSingle();
    if (proRow?.user_id) {
      proUserId = proRow.user_id as string;
      // Filter to the pro row explicitly. Since migration 0036 a user can
      // hold BOTH homeowner Plus and a Pro membership, so a bare
      // .eq(user_id).maybeSingle() would throw on two rows and silently
      // cost a paying Pro member their boost. A user holds at most one
      // pro_ plan, so this stays single-row (and works pre-0036 too).
      const { data: proSub } = await (admin as any)
        .from("subscriptions")
        .select("plan, status, current_period_end")
        .eq("user_id", proRow.user_id)
        .like("plan", "pro_%")
        .maybeSingle();
      // "active" only, NOT "trialing": same perk-before-payment reasoning as
      // the $10 membership credit gate in the checkout branch below. The boost
      // is real money (up to +5% of a $2,000 deposit) and a trial has not paid
      // for it yet, so a trialer who deposits and cancels on day two can't walk
      // off with the match. Deposits made during the trial simply earn the
      // normal tier bonus; nothing is granted retroactively when the trial
      // converts, so what a pro is shown at deposit time is always what lands.
      const activePro =
        proSub?.plan?.startsWith("pro_") &&
        proSub.status === "active" &&
        (!proSub.current_period_end ||
          new Date(proSub.current_period_end) > new Date());
      if (activePro) boostPts = PRO_DEPOSIT_BOOST_PTS;
    }
  } catch {
    // Boost is a perk, deposits are not: swallow and continue unboosted.
  }

  // Credits cash, computes + grants the tier bonus, writes the ledger,
  // and (on the 0058 signature) dedups on the Stripe event id so a
  // duplicate delivery can't double-credit.
  const result = await applyDepositOnce(
    admin,
    meta.contractor_id,
    cents,
    Math.max(boostPts, 0),
    eventId
  );

  // Funnel analytics (docs/ANALYTICS.md), only on the attempt that actually
  // moved money - never a refused amount, an unsettled ACH session, or a
  // failed/retryable RPC call. amount_bucket, not the exact cents charged.
  if (result.credited) {
    await trackServerEvent(proUserId, "deposit_made", {
      amount_bucket: depositAmountBucket(cents),
    });
  }

  return result;
}

// Claw back a deposit after a dispute/refund. Mirrors applyDepositOnce's
// retry contract: reverse_deposit (migration 0085) claims the event id
// inside the same transaction as the debit, so on any non-missing-function
// error the safe move is to ask Stripe to redeliver (retry: true) - a retry
// after a real commit is a provable no-op. If the live DB predates 0085 the
// RPC doesn't exist yet; log loudly and ACK (retry: false) rather than 500
// forever on a migration that hasn't shipped.
//
// The event id alone is NOT enough to dedup a chargeback/refund: one
// underlying dispute fires charge.dispute.created AND
// charge.dispute.funds_withdrawn (same dispute.amount, different event ids),
// and charge.refunded fires once per partial refund with a CUMULATIVE
// amount_refunded. reverse_deposit tracks a cumulative reversed_cents PER
// CHARGE (deposit_reversals, keyed on payment_intent) and only debits the
// wallet by the increment over what's already been reversed for that charge,
// so passing the same reported total twice (or a growing cumulative total)
// is always safe - the caller here doesn't need to do any of that math
// itself, just report the (payment_intent, reported cumulative total,
// original deposit) triple on every call.
async function reverseDepositOnce(
  admin: any,
  eventId: string,
  contractorId: string,
  paymentIntentId: string,
  reportedCents: number,
  depositCents: number,
  reason: string
): Promise<{ retry: boolean }> {
  const { error } = await admin.rpc("reverse_deposit", {
    p_event_id: eventId,
    p_contractor_id: contractorId,
    p_payment_intent: paymentIntentId,
    p_reported_cents: reportedCents,
    p_deposit_cents: depositCents,
    p_reason: reason,
  });
  if (!error) return { retry: false };
  if (isMissingFn(error, "reverse_deposit")) {
    console.error(
      "reverse_deposit RPC missing (migration 0085 not live yet), skipping wallet reversal for",
      contractorId,
      error.message ?? error
    );
    return { retry: false };
  }
  console.error(
    "reverse_deposit failed, asking Stripe to redeliver:",
    error.message ?? error
  );
  return { retry: true };
}

// Resolve a payment_intent id back to the wallet-deposit checkout session
// that created it, the same metadata shape creditDepositSession reads
// (type "deposit", contractor_id, deposit_cents). Stripe Checkout sessions
// aren't reachable from a PaymentIntent directly, so this lists sessions by
// payment_intent instead. Returns null for any charge that isn't a wallet
// deposit (a subscription invoice charge, for instance) - nothing to
// reverse, and dispute/refund events on those are silently ignored here.
async function resolveDepositSession(
  paymentIntentId: string | null
): Promise<{ contractorId: string; depositCents: number } | null> {
  if (!paymentIntentId) return null;
  try {
    const sessions = await stripe.checkout.sessions.list({
      payment_intent: paymentIntentId,
      limit: 1,
    });
    const session = sessions.data[0] as any;
    const meta = session?.metadata ?? {};
    if (meta.type !== "deposit" || !meta.contractor_id) return null;
    // THE SAME predicate the credit path uses, not a clamped version of it.
    // This number is the CAP reverse_deposit reverses up to, so it has to be
    // the number that was actually credited. A session the credit path refused
    // (over the cap, zero, unreadable) put NOTHING in the wallet, so there is
    // nothing to claw back and the cap is 0 - clamping an over-cap amount down
    // to MAX_DEPOSIT_CENTS instead would take $2,000 of somebody else's money
    // out of the balance on a refund of a deposit that never landed.
    const cents = acceptedDepositCents(session);
    if (cents === null) {
      console.error(
        "deposit reversal target is 0: this session was never credited",
        "(contractor",
        meta.contractor_id,
        "session",
        session.id,
        "amount_total",
        session.amount_total,
        ")"
      );
    }
    return { contractorId: meta.contractor_id, depositCents: cents ?? 0 };
  } catch (err) {
    console.error(
      "resolveDepositSession failed for payment_intent",
      paymentIntentId,
      err
    );
    return null;
  }
}

// Shared by all three dispute/refund event handlers below: resolve the
// charge back to its deposit session, then reverse it. reportedCents is
// whatever this event reports as the running total for the charge (a
// dispute's flat dispute.amount, or a refund's cumulative amount_refunded) -
// NOT an increment. reverse_deposit itself caps the target at
// deposit.depositCents and debits only the increment over what's already
// been reversed for this payment_intent, so it's safe to pass the same or a
// growing reportedCents on every call for the same charge.
async function handleDepositReversal(
  paymentIntentId: string | null,
  eventId: string,
  reportedCents: number,
  reason: string
): Promise<{ retry: boolean }> {
  if (!paymentIntentId || reportedCents <= 0) return { retry: false };
  const deposit = await resolveDepositSession(paymentIntentId);
  if (!deposit) return { retry: false }; // not a wallet-deposit charge
  const admin = createAdminClient();
  return reverseDepositOnce(
    admin,
    eventId,
    deposit.contractorId,
    paymentIntentId,
    reportedCents,
    deposit.depositCents,
    reason
  );
}

// Resolve a payment_intent id back to the Pro membership invoice it paid
// (if any) and the contractor whose per-cycle wallet credit that invoice
// earned (grant_membership_credit, migration 0034). The Charge object no
// longer carries an `invoice` field in this Stripe API version (Charges and
// Invoices decoupled behind the newer Invoice Payments API), so the invoice
// is looked up the supported way: list InvoicePayments by payment_intent and
// read `.invoice` off the match. From there this walks the same subscription
// -> subscriptions.user_id -> contractors chain invoice.payment_succeeded
// below already walks to GRANT the credit in the first place, run in
// reverse. Returns null for anything that isn't a Pro membership invoice
// charge: a homeowner Plus invoice (a subscriptions row exists but its plan
// doesn't start with pro_), an invoice with no matching subscriptions row, or
// - most commonly - a payment_intent that was never invoice-backed at all (a
// wallet deposit is a one-time Checkout Session payment with no invoice).
async function resolveMembershipContractor(
  paymentIntentId: string | null
): Promise<{ contractorId: string; invoiceId: string } | null> {
  if (!paymentIntentId) return null;
  try {
    const payments = await stripe.invoicePayments.list({
      payment: { type: "payment_intent", payment_intent: paymentIntentId },
      limit: 1,
    });
    const invoiceRef = payments.data[0]?.invoice;
    const invoiceId =
      typeof invoiceRef === "string" ? invoiceRef : invoiceRef?.id ?? null;
    if (!invoiceId) return null;

    const invoice = await stripe.invoices.retrieve(invoiceId);
    const rawSub =
      (invoice as any).subscription ??
      (invoice as any).parent?.subscription_details?.subscription ??
      null;
    const subscriptionId = typeof rawSub === "string" ? rawSub : rawSub?.id ?? null;
    if (!subscriptionId) return null;

    const admin = createAdminClient();
    // Side-blind matching would be wrong here too (see invoice.payment_succeeded
    // below): only a pro_ plan ever earned a membership credit on this invoice.
    const { data: subRow } = await (admin as any)
      .from("subscriptions")
      .select("user_id, plan")
      .eq("stripe_subscription_id", subscriptionId)
      .maybeSingle();
    if (!subRow?.user_id || !subRow?.plan?.startsWith("pro_")) return null;

    const { data: contractorRow } = await (admin as any)
      .from("contractors")
      .select("id")
      .eq("user_id", subRow.user_id)
      .maybeSingle();
    if (!contractorRow?.id) return null;
    return { contractorId: contractorRow.id, invoiceId };
  } catch (err) {
    console.error(
      "resolveMembershipContractor failed for payment_intent",
      paymentIntentId,
      err
    );
    return null;
  }
}

// Claw back a Pro membership's per-cycle wallet credit after the invoice that
// earned it is disputed/refunded. Mirrors reverseDepositOnce's retry contract:
// reverse_membership_credit (migration 0090) claims the event id inside the
// same transaction as the debit, so on any non-missing-function error the
// safe move is to ask Stripe to redeliver (retry: true) - a retry after a
// real commit is a provable no-op. If the live DB predates 0090 the RPC
// doesn't exist yet; log loudly and ACK (retry: false) rather than 500
// forever on a migration that hasn't shipped.
async function reverseMembershipCreditOnce(
  admin: any,
  eventId: string,
  contractorId: string,
  invoiceId: string,
  amountCents: number,
  reason: string
): Promise<{ retry: boolean }> {
  const { error } = await admin.rpc("reverse_membership_credit", {
    p_event_id: eventId,
    p_contractor_id: contractorId,
    p_reference: invoiceId,
    p_amount_cents: amountCents,
    p_reason: reason,
  });
  if (!error) return { retry: false };
  if (isMissingFn(error, "reverse_membership_credit")) {
    console.error(
      "reverse_membership_credit RPC missing (migration 0090 not live yet), skipping credit clawback for",
      contractorId,
      error.message ?? error
    );
    return { retry: false };
  }
  console.error(
    "reverse_membership_credit failed, asking Stripe to redeliver:",
    error.message ?? error
  );
  return { retry: true };
}

// Shared by all three dispute/refund event handlers below (the membership
// side): resolve the payment_intent back to the Pro membership invoice and
// contractor whose credit it earned, then reverse it. Takes the SAME
// payment_intent id each handler already extracts for the deposit path below
// (handleDepositReversal) - a charge is never both a wallet deposit and a
// membership invoice charge, so trying both resolutions unconditionally on
// every dispute/refund event is always safe; exactly one of them can match.
// reportedCents is whatever this event reports as the running total for the
// underlying charge (a dispute's flat dispute.amount, or a refund's
// cumulative amount_refunded) - reverse_membership_credit caps the actual
// debit at what this invoice actually granted and tracks the cumulative
// amount already reversed per invoice, so it's safe to pass the same or a
// growing reportedCents on every call for the same charge, exactly like
// handleDepositReversal above.
async function handleMembershipReversal(
  paymentIntentId: string | null,
  eventId: string,
  reportedCents: number,
  reason: string
): Promise<{ retry: boolean }> {
  if (!paymentIntentId || reportedCents <= 0) return { retry: false };
  const target = await resolveMembershipContractor(paymentIntentId);
  if (!target) return { retry: false }; // not a Pro membership invoice charge
  const admin = createAdminClient();
  return reverseMembershipCreditOnce(
    admin,
    eventId,
    target.contractorId,
    target.invoiceId,
    reportedCents,
    reason
  );
}

// Billing interval read off a paid invoice's own line items, for deciding
// the membership-credit amount. The recurring interval lives at
// line.price.recurring.interval in older Stripe API versions, line.plan on
// legacy shapes, and under line.pricing on newer ones: read whichever is
// present. Proration lines are skipped when a non-proration line is
// readable: a monthly-to-yearly upgrade invoice carries the old monthly
// price on its proration credit line, and only the non-proration charge
// line carries the interval that was actually bought.
function invoiceLineInterval(invoice: any): "year" | "month" | null {
  const readInterval = (line: any) =>
    line?.price?.recurring?.interval ??
    line?.plan?.interval ??
    line?.pricing?.price_details?.recurring?.interval ??
    null;
  const isProration = (line: any) =>
    line?.proration === true ||
    line?.parent?.subscription_item_details?.proration === true;
  let prorated: "year" | "month" | null = null;
  for (const line of invoice?.lines?.data ?? []) {
    const interval = readInterval(line);
    if (interval !== "year" && interval !== "month") continue;
    if (!isProration(line)) return interval;
    if (!prorated) prorated = interval;
  }
  return prorated;
}

// Post-purchase acknowledgment. California's Automatic Renewal Law requires
// the buyer to receive the automatic renewal terms, the cancellation policy,
// and how to cancel, "in a manner that is capable of being retained"
// (Bus. & Prof. Code 17602(a)(3)). The welcome screens show this too, but a
// screen is not retainable: this is the copy that lands in an inbox and the
// notification list, and it is the only acknowledgment that knows what Stripe
// actually billed.
//
// The text comes from the same billingTerms source as the pre-checkout
// disclosure, so the promise made before payment and the record sent after it
// cannot drift apart.
//
// Idempotency uses the once-per-key-forever pattern the crons use: the Stripe
// subscription id rides in the notification url, so a redelivered
// checkout.session.completed is a no-op while a genuine resubscribe (a new
// subscription id) still gets its own acknowledgment. Both pages ignore
// unknown query params, so the link still lands correctly.
//
// Best-effort throughout: a failed acknowledgment must never 500 the webhook
// and cost someone a paid membership. It is logged loudly instead, because a
// missing acknowledgment is a compliance gap, not a cosmetic one.
async function sendRenewalAcknowledgment(
  admin: any,
  userId: string,
  plan: PaidPlan,
  introEligible: boolean,
  subscriptionId: string
): Promise<void> {
  try {
    const terms = billingTerms(plan, introEligible);
    const url = `${terms.cancelPath}?ack=${subscriptionId}`;

    const { data: existing } = await admin
      .from("notifications")
      .select("id")
      .eq("user_id", userId)
      .eq("kind", ACK_KIND)
      .eq("url", url)
      .limit(1)
      .maybeSingle();
    if (existing) return;

    const { data: user } = await admin
      .from("users")
      .select("email")
      .eq("id", userId)
      .maybeSingle();

    await sendNotification(admin, {
      userId,
      kind: ACK_KIND,
      title: `Your ${terms.product} subscription: renewal and cancellation terms`,
      body: billingTermsText(plan, introEligible),
      url,
      email: user?.email ?? null,
      // Deliberately no phone: this is a document to keep, not an alert.
      phone: null,
    });
  } catch (err) {
    console.error("renewal acknowledgment failed:", err);
  }
}

// True when the subscription's current period is running on a discount, i.e.
// the Hearth Pro intro month. Read off the subscription rather than the plan
// name because the intro is a one-time coupon that can silently fail to apply
// (see proIntroCouponId): if it didn't apply, there is no step-up to disclose
// and the acknowledgment must not claim one. `discounts` is the newer Stripe
// shape, `discount` the older singular one - read whichever is present.
function hasIntroDiscount(subscription: any): boolean {
  const list = subscription?.discounts;
  if (Array.isArray(list)) return list.length > 0;
  return Boolean(list ?? subscription?.discount);
}

// Release a reserved-but-never-spent Pro intro-price claim (the
// promo_claims row for 'pro_intro_monthly') so an abandoned checkout doesn't
// permanently cost the user their one intro. Called from two spots below: an
// expired checkout session (the user never finished paying) and a
// subscription that lands on canceled/incomplete_expired without ever having
// gone active/trialing (the payment itself failed or was abandoned mid-flow -
// a declined card, a closed 3-D Secure tab).
//
// Guarded on both ends. The callers only invoke this when the specific thing
// they're looking at (intro_reserved on the session, intro_step_up on the
// subscription - both stamped by startProCheckoutAction at checkout
// creation) shows THIS attempt is the one holding the reservation. This
// function then re-confirms no LIVE pro subscription exists for the user
// before deleting anything, so a user who won the promo_claims race in one
// tab while a second, concurrent tab's session independently expires never
// has their genuinely-in-use intro clawed back - that second tab's session
// never won the reservation in the first place (claim_promo's PK made sure
// of that), so its intro_reserved is "false" and its expiry never even calls
// this function. Best-effort throughout: a failure here just means the user
// has to contact support to get their intro back, never a blocked checkout.
//
// SCOPED BY `ref`, not just by user. The ledger row now records WHICH checkout
// session holds the reservation (see src/lib/promoClaimRef.ts), because the
// checkout actions read that to tell an abandoned checkout apart from one that
// is still open. A blanket delete here could therefore throw away a reservation
// that a LATER attempt has since taken over - a redelivered expiry event for a
// long-dead session wiping the row for the session the buyer is looking at
// right now - and the next click would mint a second reservation alongside it.
// So each caller passes the refs its own event is entitled to release.
async function releaseIntroReservationIfUnused(
  admin: ReturnType<typeof createAdminClient>,
  userId: string,
  refs: string[]
): Promise<void> {
  try {
    const { data: rows } = await (admin as any)
      .from("subscriptions")
      .select("plan, status, current_period_end")
      .eq("user_id", userId)
      .like("plan", "pro_%");
    const stillLive = ((rows as any[]) ?? []).some((row) =>
      isLiveProPlanRow(row)
    );
    if (stillLive) return;

    const { error } = await admin
      .from("promo_claims")
      .delete()
      .eq("user_id", userId)
      .eq("promo_key", "pro_intro_monthly")
      .in("ref", refs);
    // A reservation whose checkout completed but whose conversion stamp never
    // landed still reads "<reservation>:<session id>". Neither ref above
    // matches it, so a subscription that never went live would strand the
    // buyer's one offer forever (2026-08-30 pre-push review, M2). Only the
    // unconverted, session-scoped shape can match this LIKE, so it can never
    // touch a converted claim.
    for (const base of refs.filter((r) => !r.startsWith("converted:"))) {
      const { error: likeError } = await admin
        .from("promo_claims")
        .delete()
        .eq("user_id", userId)
        .eq("promo_key", "pro_intro_monthly")
        .like("ref", `${base}:%`);
      if (likeError) {
        console.error(
          "promo_claims session-scoped rollback failed for",
          userId,
          likeError.message ?? likeError
        );
      }
    }
    if (error) {
      console.error(
        "promo_claims rollback failed for",
        userId,
        error.message ?? error
      );
    }
  } catch (err) {
    console.error("promo_claims rollback threw for", userId, err);
  }
}

// The homeowner twin of the function above: release a reserved-but-never-spent
// Plus free-trial claim (the promo_claims row for 'plus_trial').
//
// startPlusCheckoutAction claims that row synchronously, before the Stripe
// session exists, so two tabs cannot each mint a free trial for one account
// (see the long note there). A buyer who then closes the Stripe tab, or whose
// card is declined, must not lose their one trial to a checkout they never
// completed - so the same two events that roll back the Pro intro roll this
// back too: an expired checkout session, and a subscription landing on
// canceled/incomplete_expired without ever having gone live.
//
// Guarded the same way at both ends. The callers only invoke this when the
// specific thing they are looking at (trial_reserved on the session,
// intro_step_up on the subscription) shows THIS attempt is the one holding the
// reservation, and this function re-confirms there is no LIVE homeowner-side
// subscription before deleting anything, so a trial that is genuinely running
// is never clawed back. Best effort throughout: a failure here means the buyer
// has to ask support for their trial back, never a blocked checkout.
// Scoped by `ref` for the same reason the Pro one is: the caller says which
// refs its event may release.
async function releasePlusTrialReservationIfUnused(
  admin: ReturnType<typeof createAdminClient>,
  userId: string,
  refs: string[]
): Promise<void> {
  try {
    const { data: rows } = await (admin as any)
      .from("subscriptions")
      .select("plan, status, current_period_end")
      .eq("user_id", userId);
    // The homeowner side is every row whose plan is NOT a pro_ one, matching
    // how getSubscription splits the two sides.
    const stillLive = ((rows as any[]) ?? []).some((row) => {
      if (typeof row?.plan === "string" && row.plan.startsWith("pro_")) {
        return false;
      }
      if (row?.status !== "active" && row?.status !== "trialing") return false;
      if (
        row?.current_period_end &&
        new Date(row.current_period_end) <= new Date()
      ) {
        return false;
      }
      return true;
    });
    if (stillLive) return;

    const { error } = await admin
      .from("promo_claims")
      .delete()
      .eq("user_id", userId)
      .eq("promo_key", "plus_trial")
      .in("ref", refs);
    // A reservation whose checkout completed but whose conversion stamp never
    // landed still reads "<reservation>:<session id>". Neither ref above
    // matches it, so a subscription that never went live would strand the
    // buyer's one offer forever (2026-08-30 pre-push review, M2). Only the
    // unconverted, session-scoped shape can match this LIKE, so it can never
    // touch a converted claim.
    for (const base of refs.filter((r) => !r.startsWith("converted:"))) {
      const { error: likeError } = await admin
        .from("promo_claims")
        .delete()
        .eq("user_id", userId)
        .eq("promo_key", "plus_trial")
        .like("ref", `${base}:%`);
      if (likeError) {
        console.error(
          "promo_claims session-scoped rollback failed for",
          userId,
          likeError.message ?? likeError
        );
      }
    }
    if (error) {
      console.error(
        "promo_claims(plus_trial) rollback failed for",
        userId,
        error.message ?? error
      );
    }
  } catch (err) {
    console.error("promo_claims(plus_trial) rollback threw for", userId, err);
  }
}

// Stamp a promo claim as spent: ref becomes converted:<subscription id>.
//
// The claim row is one per (user, promo), and the checkout actions now read its
// `ref` to decide whether a losing claim_promo call means "somebody already
// bought with this" or "an abandoned checkout is still holding it, give it
// back" (src/lib/checkoutReservation.ts). Without this stamp those two look
// identical forever, and a converted account could reclaim its own spent offer.
//
// Deliberately unconditional on the current ref: a newer conversion overwriting
// an older one is harmless, and every non-reservation value (a backfill row, a
// legacy subscription id) means spent either way. Best effort - the checkout's
// own eligibility checks still hold if this write fails.
async function markPromoConverted(
  admin: ReturnType<typeof createAdminClient>,
  userId: string,
  promoKey: string,
  subscriptionId: string
): Promise<void> {
  try {
    const { error } = await admin
      .from("promo_claims")
      .update({ ref: convertedRef(subscriptionId) })
      .eq("user_id", userId)
      .eq("promo_key", promoKey);
    if (error) {
      console.error(
        "promo_claims conversion stamp failed for",
        promoKey,
        userId,
        error.message ?? error
      );
    }
  } catch (err) {
    console.error("promo_claims conversion stamp threw for", promoKey, err);
  }
}

// ---------------------------------------------------------------------------
// Trial-abuse signals (src/lib/risk, migration 0130)
// ---------------------------------------------------------------------------
// The card is the strongest anti-farming signal there is, because it is the one
// identifier a farmer cannot mint for free. Stripe's card.fingerprint is a
// stable opaque id for the underlying card number - the SAME card added to two
// different customers produces the same fingerprint - which is exactly the
// question we need answered, and it is not a PAN, so nothing sensitive travels.
// We hash it again on our side before storing it (src/lib/risk/hash.ts).
//
// Everything below is BEST EFFORT and silent on failure. A missing payment
// method, an older API shape, a Stripe hiccup, a live database without 0130:
// all of them mean "no signal recorded", never a failed webhook. A membership
// must never be lost over abuse bookkeeping.

// Claim a Stripe event id for a specific side effect, exactly once, ever.
//
// Same processed_stripe_events table (migration 0060) the money paths use, but
// with a NAMESPACED key so it can never collide with their claims: the deposit
// and reversal RPCs claim the bare event id, and this claims
// "risk:<event id>". A duplicate delivery of the same checkout - Stripe retries,
// and it does redeliver - therefore ends a trial at most once and sends at most
// one "billing starts today" notice.
//
// Returns true when THIS call won the claim. Fails CLOSED on any error: if we
// cannot prove we have not already done it, we do not do it again. The cost of
// being wrong that way is a farmer keeping a trial we could have ended; the cost
// of the other way is telling a paying customer twice that their billing changed.
async function claimRiskEvent(
  admin: any,
  eventId: string,
  kind: string
): Promise<boolean> {
  try {
    const { error } = await admin
      .from("processed_stripe_events")
      .insert({ event_id: `risk:${eventId}`, kind });
    if (!error) return true;
    // 23505 is the duplicate-key claim losing the race, which is the normal
    // outcome on a redelivery and not worth logging as an error.
    if (error.code !== "23505") {
      console.error("claimRiskEvent failed:", error.message ?? error);
    }
    return false;
  } catch (err) {
    console.error("claimRiskEvent threw:", err);
    return false;
  }
}

// THE FIX FOR THE ONE HOLE THAT MATTERED.
//
// The card fingerprint is the strongest signal the score has, and until this
// existed it could never reach the decision it was written for. Stripe only
// tells us the card AFTER checkout completes, and the trial was granted before
// the checkout session was even created. So on the FIRST checkout of any account
// - the only one that can hand over a free trial - the card was necessarily
// unknown. A farmer with a fresh email, a cleared cookie jar and a phone hotspot
// got trial after trial on the same physical card, and the 60-point weight sat
// there doing nothing.
//
// This closes it at the first moment the evidence exists. Re-run the score now
// that the card is recorded; if the subscription is still trialing and the card
// links it to somebody we have met, end the trial immediately
// (trial_end: "now") and tell the buyer their billing starts today. That is the
// same outcome `medium` produces at checkout, applied three seconds later
// instead of never.
//
// The buyer is TOLD, in the same words the checkout would have used, built from
// the same billingTerms source. Silently converting somebody's free trial to a
// charge would be the one genuinely indefensible thing this system could do.
//
// Respects RISK_ENFORCE like everything else: while it is off, this logs what it
// would have done and changes nothing.
async function endTrialIfRisky(
  admin: any,
  userId: string,
  subscription: any,
  plan: PaidPlan,
  eventId: string
): Promise<void> {
  try {
    if (subscription?.status !== "trialing" || !subscription?.id) return;

    const { score, level, reasons } = await computeRisk(userId);
    if (level === "low") return;

    const summary = JSON.stringify({
      userId,
      subscriptionId: subscription.id,
      score,
      level,
      enforcing: riskEnforcementEnabled(),
      reasons: reasons.map((r) => `${r.code}:${r.points}`),
    });

    if (!riskEnforcementEnabled()) {
      // Log-only week: this is the line that tells the operator the card signal
      // is working before it is allowed to charge anybody.
      console.error("[risk] would end trial (log-only mode)", summary);
      return;
    }

    // Claim AFTER the cheap checks so a low-risk checkout never burns a row.
    if (!(await claimRiskEvent(admin, eventId, "risk_trial_end"))) return;

    console.error("[risk] ending trial early", summary);
    await stripe.subscriptions.update(subscription.id, { trial_end: "now" });

    // The corrective notice. billingTermsText(plan, false) is the "charged
    // today" wording - the exact sentences the checkout would have shown had the
    // card been known in time - so what they are told now cannot drift from what
    // they would have been told then.
    try {
      const { data: user } = await admin
        .from("users")
        .select("email")
        .eq("id", userId)
        .maybeSingle();
      const terms = billingTerms(plan, false);
      await sendNotification(admin, {
        userId,
        kind: ACK_KIND,
        title: `Your ${terms.product} membership starts today`,
        body:
          "Your free trial could not be applied to this account, so your membership starts now instead. " +
          billingTermsText(plan, false),
        url: `${terms.cancelPath}?ack=${subscription.id}`,
        email: user?.email ?? null,
        phone: null,
      });
    } catch (err) {
      console.error("[risk] trial-end notification failed:", err);
    }
  } catch (err) {
    // Never fail the webhook over this. A membership is worth more than a trial.
    console.error("[risk] endTrialIfRisky failed:", err);
  }
}

// Pull the card fingerprint off a subscription and record it against the user.
// Looks at the subscription's default_payment_method first (what Checkout sets
// when it collects a card up front, which is every trial signup here), then the
// setup intent Stripe attaches when the card was collected without an immediate
// charge.
async function recordSubscriptionCard(
  userId: string,
  subscription: any,
  context: string
): Promise<void> {
  try {
    const fromSubscription =
      subscription?.default_payment_method ??
      subscription?.pending_setup_intent?.payment_method ??
      null;
    let paymentMethodId =
      typeof fromSubscription === "string"
        ? fromSubscription
        : fromSubscription?.id ?? null;

    // The setup intent can arrive as a bare id, in which case its payment
    // method needs one more lookup.
    if (!paymentMethodId && typeof subscription?.pending_setup_intent === "string") {
      const intent = await stripe.setupIntents.retrieve(
        subscription.pending_setup_intent
      );
      const pm = (intent as any)?.payment_method;
      paymentMethodId = typeof pm === "string" ? pm : pm?.id ?? null;
    }
    if (!paymentMethodId) return;

    const method = await stripe.paymentMethods.retrieve(paymentMethodId);
    const fingerprint = (method as any)?.card?.fingerprint ?? null;
    if (fingerprint) await recordCardSignal(userId, fingerprint, context);
  } catch {
    // No card signal this time. Skip silently, as designed.
  }
}

// Same, starting from a subscription id (the invoice path, which does not carry
// the subscription object).
async function recordCardFromSubscriptionId(
  userId: string,
  subscriptionId: string,
  context: string
): Promise<void> {
  try {
    const subscription = await stripe.subscriptions.retrieve(subscriptionId);
    await recordSubscriptionCard(userId, subscription, context);
  } catch {
    // Skip silently.
  }
}

// A chargeback is the clearest confirmed-abuse event Stripe ever hands us, so
// it becomes a sticky abuse_flags row: from then on, any OTHER account sharing
// a card, device or network with this one carries the weight of it (see
// src/lib/risk/score.ts). Resolved through the PaymentIntent's customer, which
// is the one link that works for both a membership invoice and a wallet
// deposit.
async function flagChargebackForCharge(
  paymentIntentId: string | null,
  disputeId: string
): Promise<void> {
  if (!paymentIntentId) return;
  try {
    const intent = await stripe.paymentIntents.retrieve(paymentIntentId);
    const customer = (intent as any)?.customer;
    const customerId =
      typeof customer === "string" ? customer : customer?.id ?? null;
    if (!customerId) return;

    const admin = createAdminClient();
    const { data } = await (admin as any)
      .from("subscriptions")
      .select("user_id")
      .eq("stripe_customer_id", customerId)
      .limit(1)
      .maybeSingle();
    if (data?.user_id) {
      await flagAbuse(data.user_id, "chargeback", `Stripe dispute ${disputeId}`);
    }
  } catch (err) {
    console.error("flagChargebackForCharge failed:", err);
  }
}

export async function POST(req: NextRequest) {
  const body = await req.text();
  const sig = req.headers.get("stripe-signature") ?? "";

  // FAIL CLOSED ON A MISSING SECRET, BEFORE constructEvent EVER RUNS.
  //
  // stripe-node does not object to an empty signing secret: it happily computes
  // HMAC-SHA256 of the payload keyed by the empty string and compares. Anyone
  // can compute that same value, so an unconfigured deployment does not reject
  // forged webhooks - it accepts them, and every money path below (deposit
  // credits, membership rows, wallet reversals) runs on attacker-chosen JSON.
  // A deployment with no secret must be dead to this route, not open to it.
  //
  // 500, not 400: this is Hearth's own misconfiguration, and a 5xx makes Stripe
  // keep the event queued and redeliver once the secret is set, instead of
  // marking real events permanently failed.
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error(
      "STRIPE_WEBHOOK_SECRET is not set - refusing every Stripe webhook. " +
        "An empty secret verifies nothing (see docs/GO-LIVE-WIRING.md)."
    );
    return new NextResponse("Webhook not configured", { status: 500 });
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(body, sig, webhookSecret);
  } catch {
    return new NextResponse("Bad signature", { status: 400 });
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object as any;
    const meta = session.metadata ?? {};

    if (meta.type === "deposit" && meta.contractor_id) {
      const { retry } = await creditDepositSession(session, event.id);
      if (retry) {
        // Safely-retryable credit failure (see applyDepositOnce): non-2xx
        // makes Stripe redeliver instead of marking a paid-but-uncredited
        // deposit consumed forever.
        return NextResponse.json({ error: "deposit credit failed" }, { status: 500 });
      }
    }

    if (meta.type === "pro_subscription" && meta.user_id && session.subscription) {
      const subscription = await stripe.subscriptions.retrieve(
        session.subscription as string
      );
      const admin = createAdminClient();
      const interval = planFromItems(subscription);
      const upsertError = await upsertSubscriptionRow(
        admin,
        {
          user_id: meta.user_id,
          stripe_customer_id: session.customer ?? null,
          stripe_subscription_id: subscription.id,
          status: subscription.status,
          // Contractor plans carry the pro_ prefix so they never satisfy the
          // homeowner Plus checks (and vice versa).
          plan: meta.plan ?? (interval ? `pro_${interval}` : null),
          current_period_end: periodEnd(subscription),
          updated_at: new Date().toISOString(),
        },
        "pro"
      );
      if (upsertError) {
        // Without this row the membership never activates and no later event
        // heals it (updates match by stripe_subscription_id, invoices skip
        // row-less subscriptions). 500 makes Stripe redeliver; the upsert is
        // idempotent and the credit grant below is keyed on the invoice id,
        // so a retry can't double anything.
        console.error(
          "subscriptions upsert failed for pro checkout:",
          upsertError.message ?? upsertError
        );
        return NextResponse.json({ error: "subscription upsert failed" }, { status: 500 });
      }

      // First-cycle wallet credit. This event and the first
      // invoice.payment_succeeded race each other, and the invoice branch
      // below can only map an invoice to a user through the subscriptions row
      // upserted above. Granting here too, keyed on the SAME invoice id, means
      // the credit lands whichever event arrives first: the RPC's idempotency
      // guard makes the loser a no-op.
      //
      // NOT during a free trial. A trial start still finalizes an invoice, for
      // $0, and latest_invoice points at it - so granting off it would hand
      // every trialer $10 of spendable lead credit before a cent had been
      // charged, farmable by starting a trial and cancelling on day two. The
      // credit is a perk of a PAID cycle: it lands when the trial converts and
      // the first real invoice is paid (the invoice.payment_succeeded branch
      // below, which now requires money to have actually moved).
      try {
        const plan = meta.plan ?? (interval ? `pro_${interval}` : null);
        const latest = (subscription as any).latest_invoice;
        const invoiceId = typeof latest === "string" ? latest : latest?.id ?? null;
        // Positive check, not `!== "trialing"`: a negative gate lets through
        // every OTHER not-yet-paid status too (incomplete, past_due), and only
        // "active" actually means money moved. Nothing is lost by being strict
        // here, because the invoice.payment_succeeded branch below grants the
        // same credit off the same invoice id once the payment really lands.
        if (
          typeof plan === "string" &&
          plan.startsWith("pro_") &&
          invoiceId &&
          subscription.status === "active"
        ) {
          const yearly = plan === "pro_yearly";
          // Keyed off the plan, never the amount paid: the $9.99 intro first
          // month still earns the full $10 on purpose.
          const { error } = await (admin as any).rpc("grant_membership_credit", {
            p_user: meta.user_id,
            p_amount_cents: yearly ? 12000 : 1000,
            p_period_key: invoiceId,
            p_expiry_days: yearly ? 400 : 60,
          });
          // Graceful degradation: if migration 0034 isn't on the live DB yet,
          // the RPC doesn't exist. The perk can wait; the membership can't.
          if (error) {
            console.error("grant_membership_credit failed:", error.message ?? error);
          }
        }
      } catch (err) {
        // The credit is a perk, the subscription is not: log and continue.
        console.error("grant_membership_credit failed:", err);
      }

      // Card fingerprint, for the trial-abuse score. This is the first moment
      // Hearth ever learns which physical card is behind an account, so it is
      // the moment to record it: a farmer's fifth throwaway email paying with
      // the same card as the first is exactly what this catches.
      await recordSubscriptionCard(meta.user_id, subscription, "pro_checkout");

      // Retainable acknowledgment of the auto-renewal terms. The step-up
      // signal is read off the SUBSCRIPTION Stripe actually created, never the
      // plan name or our own checkout intent, so an offer that failed to
      // attach can't produce an acknowledgment promising terms that were never
      // billed. Two shapes count: a Stripe trial ("trialing", what every new
      // Pro signup gets today) and a discount (the retired intro coupon, still
      // read for any legacy subscription that carries one).
      const proPlan: PaidPlan =
        interval === "yearly" || meta.plan === "pro_yearly"
          ? "pro_yearly"
          : "pro_monthly";
      await sendRenewalAcknowledgment(
        admin,
        meta.user_id,
        proPlan,
        subscription.status === "trialing" || hasIntroDiscount(subscription),
        subscription.id
      );

      // Now that the card is known, re-run the score and end the trial if it
      // says so (see endTrialIfRisky above: the card is the signal that could
      // never reach the checkout decision, and this is the first moment it
      // exists). Runs AFTER the acknowledgment on purpose, so a buyer whose
      // trial is ended reads the correction second and it is the one that
      // stands.
      await endTrialIfRisky(
        admin,
        meta.user_id,
        subscription,
        proPlan,
        event.id
      );

      // Record the one-time intro claim so it can never be farmed again, even
      // if this canceled subscription's row is later pruned (migration 0071).
      // Gated on the SAME signal the acknowledgment uses - the discount
      // actually on the subscription, never our own checkout intent - so a
      // coupon that silently failed to apply doesn't burn the user's one
      // intro. Best-effort: never 500 over the ledger; the !existing check in
      // the checkout action still holds meanwhile.
      if (hasIntroDiscount(subscription)) {
        const { error } = await admin.rpc("claim_promo", {
          p_user: meta.user_id,
          p_key: "pro_intro_monthly",
          p_ref: subscription.id,
        });
        if (error) {
          console.error(
            "claim_promo(pro_intro_monthly) FAILED - intro may be repeatable for",
            meta.user_id,
            error.message ?? error
          );
        }
      }

      // Mark the claim SPENT. claim_promo inserts, and its "on conflict do
      // nothing" leaves an existing row's ref exactly as the checkout action
      // wrote it - which since the reservation fix means the ledger could still
      // read "reserved" for a claim that has just bought a subscription, and a
      // later retry would be entitled to take it back. Stamping the
      // subscription id is what makes "already spent" answerable from the
      // ledger alone, without a subscriptions row to read. Best effort: the
      // !existing check in the checkout action still holds meanwhile.
      await markPromoConverted(
        admin,
        meta.user_id,
        "pro_intro_monthly",
        subscription.id
      );

      // Funnel analytics (docs/ANALYTICS.md). Same reasoning as the Plus
      // checkout_completed below: fired off the webhook, the trustworthy
      // completion signal, not the ?welcome=1 page render, which can beat or
      // lose the race with this event.
      await trackServerEvent(meta.user_id, "pro_checkout_completed", {
        plan: proPlan,
      });
    }

    if (meta.type === "plus_subscription" && meta.user_id && session.subscription) {
      const subscription = await stripe.subscriptions.retrieve(
        session.subscription as string
      );
      const admin = createAdminClient();
      const upsertError = await upsertSubscriptionRow(
        admin,
        {
          user_id: meta.user_id,
          stripe_customer_id: session.customer ?? null,
          stripe_subscription_id: subscription.id,
          status: subscription.status,
          plan: meta.plan ?? planFromItems(subscription),
          current_period_end: periodEnd(subscription),
          updated_at: new Date().toISOString(),
        },
        "homeowner"
      );
      if (upsertError) {
        // Same reasoning as the pro branch: no row means Plus never
        // activates and nothing heals it. 500 so Stripe redelivers the
        // idempotent upsert.
        console.error(
          "subscriptions upsert failed for plus checkout:",
          upsertError.message ?? upsertError
        );
        return NextResponse.json({ error: "subscription upsert failed" }, { status: 500 });
      }

      // Card fingerprint, for the trial-abuse score. Same reasoning as the pro
      // branch above; the two sides share one signals table on purpose, so a
      // card that burned a Plus trial is also known to the Pro checkout.
      await recordSubscriptionCard(meta.user_id, subscription, "plus_checkout");

      // Retainable acknowledgment of the auto-renewal terms. The free days are
      // a Stripe trial, so "trialing" is the step-up signal here.
      //
      // The interval Stripe actually billed wins over the session metadata:
      // metadata is what the buyer's form said, the items are what the
      // subscription is. Only when the interval is unreadable does the
      // metadata plan decide, and it is checked against the same three names.
      const derivedPlusPlan = planFromItems(subscription);
      const plusPlan: PaidPlan =
        derivedPlusPlan === "weekly" ||
        derivedPlusPlan === "monthly" ||
        derivedPlusPlan === "yearly"
          ? derivedPlusPlan
          : meta.plan === "weekly" || meta.plan === "yearly"
            ? meta.plan
            : "monthly";
      await sendRenewalAcknowledgment(
        admin,
        meta.user_id,
        plusPlan,
        subscription.status === "trialing",
        subscription.id
      );

      // Same card re-check as the Pro branch above. Plus only trials on the
      // weekly plan, so on monthly and yearly this is a no-op (the
      // subscription is never "trialing"), which is correct and costs one
      // status comparison.
      await endTrialIfRisky(
        admin,
        meta.user_id,
        subscription,
        plusPlan,
        event.id
      );

      // The free days are now spent. Stamp the ledger so a later checkout can
      // never take this reservation back and hand out a second trial (see
      // reclaimCheckoutReservation): until this existed, a converted claim and
      // an abandoned one read identically. Unconditional, not gated on
      // trial_reserved - a monthly buyer who had reserved the trial on an
      // earlier weekly attempt has spent it too, and their subscriptions row
      // already says so.
      await markPromoConverted(
        admin,
        meta.user_id,
        "plus_trial",
        subscription.id
      );

      // Funnel analytics (docs/ANALYTICS.md). Fired here, not off the
      // ?welcome=1 page render, because this is the trustworthy completion
      // signal - the render can beat or lose the race with this webhook (see
      // the extensive comments in PlusWelcome.tsx and plus/page.tsx).
      await trackServerEvent(meta.user_id, "checkout_completed", {
        plan: plusPlan,
      });
    }
  }

  // Abandoned Pro checkout: the user opened Stripe Checkout - and
  // startProCheckoutAction's reservation logic won the promo_claims race and
  // attached the intro coupon to this session - but never finished paying
  // (declined card, closed the tab, walked away). Stripe expires the session
  // on its own (24h by default) rather than ever completing it. Release the
  // reservation so the user still has their one intro to spend on a real
  // attempt later. Gated on `intro_reserved`, the flag startProCheckoutAction
  // stamps on the session ONLY when it actually won the reservation - a
  // session that lost the race (full price, no coupon) has nothing to
  // release, and this is a no-op for it.
  if (event.type === "checkout.session.expired") {
    const session = event.data.object as any;
    const meta = session.metadata ?? {};
    if (
      meta.type === "pro_subscription" &&
      meta.user_id &&
      meta.intro_reserved === "true"
    ) {
      const admin = createAdminClient();
      // Only the refs THIS session could be holding: the bare marker (the
      // checkout action failed to record the session id) or the marker naming
      // this exact session.
      await releaseIntroReservationIfUnused(admin, meta.user_id, [
        PRO_RESERVATION_REF,
        reservedSessionRef(PRO_RESERVATION_REF, String(session.id)),
      ]);
    }

    // Funnel analytics (docs/ANALYTICS.md), mirroring checkout_abandoned
    // below: any expired Pro checkout session counts, not only the ones
    // holding an intro-coupon reservation above.
    if (meta.type === "pro_subscription" && meta.user_id) {
      await trackServerEvent(meta.user_id, "pro_checkout_abandoned", {
        plan: meta.plan ?? null,
      });
    }

    // The homeowner half of the same story: an abandoned Plus checkout whose
    // session won the one-trial reservation (see startPlusCheckoutAction).
    // Release it so the buyer still has their free days to spend on a real
    // attempt later. A session that lost the race carries trial_reserved
    // "false" and this is a no-op for it.
    if (
      meta.type === "plus_subscription" &&
      meta.user_id &&
      meta.trial_reserved === "true"
    ) {
      const admin = createAdminClient();
      await releasePlusTrialReservationIfUnused(admin, meta.user_id, [
        PLUS_RESERVATION_REF,
        reservedSessionRef(PLUS_RESERVATION_REF, String(session.id)),
      ]);
    }

    // Funnel analytics (docs/ANALYTICS.md). Any expired Plus checkout session
    // counts as abandoned, not only the ones that were holding a trial
    // reservation above - a monthly/yearly buyer who backed out never sets
    // trial_reserved at all and would otherwise never show up here.
    if (meta.type === "plus_subscription" && meta.user_id) {
      await trackServerEvent(meta.user_id, "checkout_abandoned", {
        plan: meta.plan ?? null,
      });
    }
  }

  // Delayed-notification payment methods (e.g. ACH debit): the checkout
  // session completes with payment_status "unpaid" and the money only settles
  // later. Credit the deposit when Stripe confirms settlement; the 0058 dedup
  // keys on THIS event's id, and creditDepositSession skipped the earlier
  // unpaid completed event, so the credit applies exactly once.
  if (event.type === "checkout.session.async_payment_succeeded") {
    const session = event.data.object as any;
    const { retry } = await creditDepositSession(session, event.id);
    if (retry) {
      return NextResponse.json({ error: "deposit credit failed" }, { status: 500 });
    }
  }

  // The delayed payment never settled (e.g. ACH insufficient funds). Nothing
  // was credited (the unpaid completed event was skipped above), so there is
  // nothing to claw back: log loudly for support visibility and ACK.
  if (event.type === "checkout.session.async_payment_failed") {
    const session = event.data.object as any;
    const failMeta = session.metadata ?? {};
    if (failMeta.type === "deposit") {
      console.error(
        "checkout.session.async_payment_failed: deposit never settled for contractor",
        failMeta.contractor_id ?? "(unknown)",
        "session",
        session.id
      );
    }
  }

  // Chargeback: pull the deposited money back out of the wallet. Both
  // dispute.created and dispute.funds_withdrawn are handled (a card network
  // can fire either or both depending on when funds actually leave the
  // account); each carries its own Stripe event id and the same
  // dispute.amount. reverse_deposit tracks the cumulative amount already
  // reversed per payment_intent (deposit_reversals, migration 0085), so the
  // second event is a provable no-op rather than a second debit.
  if (
    event.type === "charge.dispute.created" ||
    event.type === "charge.dispute.funds_withdrawn"
  ) {
    const dispute = event.data.object as any;
    const paymentIntentId =
      typeof dispute.payment_intent === "string"
        ? dispute.payment_intent
        : dispute.payment_intent?.id ?? null;
    // Sticky abuse flag, on dispute.created ONLY (not funds_withdrawn, which is
    // the same dispute reported twice). A chargeback is the clearest confirmed
    // abuse signal Stripe hands us, and flagging the account makes every future
    // account sharing its card, device or network carry the weight of it.
    // Best-effort and before the money paths, which own their own retry
    // contract and must not be perturbed by this.
    if (event.type === "charge.dispute.created") {
      await flagChargebackForCharge(
        paymentIntentId,
        String(dispute.id ?? "unknown")
      );
    }

    const { retry } = await handleDepositReversal(
      paymentIntentId,
      event.id,
      Number(dispute.amount) || 0,
      `Chargeback: dispute ${dispute.id ?? "(unknown)"} (${event.type})`
    );
    if (retry) {
      return NextResponse.json({ error: "deposit reversal failed" }, { status: 500 });
    }

    // Same dispute, checked against the OTHER money bucket a charge can back:
    // a Pro membership invoice's per-cycle wallet credit (see
    // resolveMembershipContractor above). Reuses the SAME paymentIntentId
    // just resolved for the deposit path above: a charge is never both a
    // deposit and a membership invoice charge, so this is a no-op whenever
    // the deposit branch above actually matched, and vice versa.
    const { retry: retryMembership } = await handleMembershipReversal(
      paymentIntentId,
      event.id,
      Number(dispute.amount) || 0,
      `Chargeback: dispute ${dispute.id ?? "(unknown)"} (${event.type})`
    );
    if (retryMembership) {
      return NextResponse.json({ error: "membership credit reversal failed" }, { status: 500 });
    }
  }

  // Refund (not a dispute): the pro or support refunded the charge directly.
  // amount_refunded is the charge's cumulative refunded total, so a charge
  // refunded in several partial increments fires this event once per
  // increment, each reporting the new running total. reverse_deposit debits
  // the wallet only by the increment over what's already been reversed for
  // this payment_intent, so cumulative partial refunds are handled correctly
  // instead of re-debiting the running total on every event.
  if (event.type === "charge.refunded") {
    const charge = event.data.object as any;
    const paymentIntentId =
      typeof charge.payment_intent === "string"
        ? charge.payment_intent
        : charge.payment_intent?.id ?? null;
    const { retry } = await handleDepositReversal(
      paymentIntentId,
      event.id,
      Number(charge.amount_refunded) || 0,
      `Refund: charge ${charge.id ?? "(unknown)"} refunded`
    );
    if (retry) {
      return NextResponse.json({ error: "deposit reversal failed" }, { status: 500 });
    }

    // Same refund, checked against the membership-credit bucket (see the
    // dispute branch above for why both checks can run unconditionally on
    // the same paymentIntentId already resolved for the deposit path).
    const { retry: retryMembership } = await handleMembershipReversal(
      paymentIntentId,
      event.id,
      Number(charge.amount_refunded) || 0,
      `Refund: charge ${charge.id ?? "(unknown)"} refunded`
    );
    if (retryMembership) {
      return NextResponse.json({ error: "membership credit reversal failed" }, { status: 500 });
    }
  }

  if (
    event.type === "customer.subscription.updated" ||
    event.type === "customer.subscription.deleted"
  ) {
    const subscription = event.data.object as any;
    const status =
      event.type === "customer.subscription.deleted"
        ? "canceled"
        : subscription.status;
    const interval = planFromItems(subscription);
    const admin = createAdminClient();
    // planFromItems only sees the billing interval, so on its own it would
    // rewrite a contractor's "pro_monthly" as "monthly". Check the stored row
    // (matched by stripe_subscription_id, so this only ever touches the one
    // side that Stripe subscription belongs to) and keep pro_ plans pro_.
    // Only the two standard names are re-derived from the interval (that's
    // how a plan switch lands); any other pro_ plan name is preserved as-is
    // rather than being normalized to pro_monthly/pro_yearly.
    //
    // The row is also read here for the intro-reservation rollback below
    // (status, user_id), so it's fetched whenever the plan can't be derived
    // from the interval alone OR the subscription just landed on a status the
    // rollback cares about - not only when `interval` is present.
    let plan: string | null = interval;
    if (interval || status === "canceled" || status === "incomplete_expired") {
      const { data: existing } = await (admin as any)
        .from("subscriptions")
        .select("plan, status, user_id")
        .eq("stripe_subscription_id", subscription.id)
        .maybeSingle();
      const existingPlan: string | null = existing?.plan ?? null;
      if (interval && existingPlan?.startsWith("pro_")) {
        // Pro sells monthly and yearly only. A "weekly" interval on a pro_ row
        // is not a plan that exists, so the stored name is kept rather than
        // inventing a pro_weekly - the same conservative branch any other
        // non-standard pro_ plan name already takes.
        const proCadence = interval === "monthly" || interval === "yearly";
        plan =
          proCadence &&
          (existingPlan === "pro_monthly" || existingPlan === "pro_yearly")
            ? `pro_${interval}`
            : existingPlan;
      }

      // Rollback: this subscription is landing on canceled or
      // incomplete_expired WITHOUT ever having gone active/trialing - i.e.
      // the payment failed or was abandoned mid-flow (declined card, closed
      // 3-D Secure tab), not a real cancellation of a used membership.
      // incomplete_expired is unambiguous by itself: Stripe only reaches it
      // from "incomplete", 23h after creation, having never billed a cent.
      // "canceled" is ambiguous in general - it's also the terminal state of
      // a subscription that WAS billed and later canceled - so it only
      // qualifies here when the row's own previously-stored status was still
      // "incomplete" (i.e. it never went live before being canceled).
      // intro_step_up on the Stripe subscription (stamped at checkout
      // creation by startProCheckoutAction) confirms this specific
      // subscription actually won the promo reservation, so an ordinary
      // full-price subscription never triggers a needless lookup or delete.
      const neverWentLive =
        status === "incomplete_expired" ||
        (status === "canceled" && existing?.status === "incomplete");
      if (
        existingPlan?.startsWith("pro_") &&
        existing?.user_id &&
        neverWentLive &&
        subscription.metadata?.intro_step_up === "true"
      ) {
        // By this point the checkout completed, so the branch above stamped
        // the claim converted:<subscription id>. That, or a bare marker if the
        // stamp never landed, is what this subscription is entitled to release.
        await releaseIntroReservationIfUnused(admin, existing.user_id, [
          PRO_RESERVATION_REF,
          convertedRef(subscription.id),
        ]);
      }

      // Same rollback on the HOMEOWNER side, for the Plus free-trial
      // reservation (see releasePlusTrialReservationIfUnused). A Plus checkout
      // that reserved the trial and then never went live - declined card,
      // abandoned 3-D Secure - must give the free days back. Recognized by the
      // same intro_step_up flag, which subscriptionCheckoutData stamps on the
      // subscription whenever the trial was granted, on a row that is NOT a
      // pro_ one.
      if (
        existingPlan &&
        !existingPlan.startsWith("pro_") &&
        existing?.user_id &&
        neverWentLive &&
        subscription.metadata?.intro_step_up === "true"
      ) {
        await releasePlusTrialReservationIfUnused(admin, existing.user_id, [
          PLUS_RESERVATION_REF,
          convertedRef(subscription.id),
        ]);
      }

      // Cancelled while still inside the free trial. This is the shape of trial
      // farming: three days of perks, cancel on day two, nothing ever paid. It
      // is ALSO the shape of an honest "I tried it and it is not for me", which
      // is why it is a 25-point signal on LINKED accounts rather than a block on
      // this one - this account keeps every right it had, and nothing about its
      // own next checkout changes. What it does is make the NEXT account on the
      // same card or device look less new than it claims.
      //
      // Two ways to recognise it: our stored status was still "trialing" when
      // the cancellation landed (the normal case, since the webhook keeps that
      // column in step with Stripe), or Stripe's own trial_end is still in the
      // future. Either is enough.
      const trialEndMs = Number(subscription.trial_end) * 1000;
      const cancelledInTrial =
        status === "canceled" &&
        (existing?.status === "trialing" ||
          (Number.isFinite(trialEndMs) && trialEndMs > Date.now()));

      // CORROBORATION IS REQUIRED before a flag is written. Cancelling inside
      // the trial is not abuse on its own - it is exactly what the product tells
      // people they may do, in those words ("cancelling before then costs
      // nothing"), and it is also what happens when a card expires and Stripe
      // cancels rather than leaving the subscription past_due. Flagging on
      // status alone marked every honest three-day tyre-kicker forever, and the
      // mark then followed anybody who shared a house or a router with them.
      //
      // So the cancel has to land on an account that ALREADY looked like a
      // farm for some other reason. computeRisk is the cheapest way to ask that
      // question, because it is the same question the score already answers:
      // anything above `low` means at least one real signal is on this account.
      // A clean account that simply changed its mind is not flagged at all.
      if (cancelledInTrial && existing?.user_id) {
        try {
          const { level, score } = await computeRisk(existing.user_id, {
            persist: false,
          });
          if (level === "low") {
            console.log(
              "[risk] trial cancelled with no corroborating signal, not flagging",
              existing.user_id
            );
          } else {
            await flagAbuse(
              existing.user_id,
              "trial_abuse",
              `Cancelled during free trial (${subscription.id ?? "unknown"}), risk ${level}/${score}`
            );
          }
        } catch (err) {
          // Fail CLOSED on the FLAG, which here means "do not flag": an
          // unreadable score is not evidence of anything.
          console.error("[risk] trial-cancel corroboration check failed:", err);
        }
      }
    }
    // Paid extra-home slots are the source-of-truth here: derived from the
    // add-on item's quantity, and forced to 0 on deletion/cancellation so the
    // bought homes lapse with Plus (existing homes are never deleted; the cap
    // only blocks NEW inserts). A pro-side subscription never carries a
    // home-slot item, so this is 0 for pro rows and harmless to write.
    const extraSlots =
      event.type === "customer.subscription.deleted"
        ? 0
        : extraHomeSlotsFromItems(subscription);

    const baseUpdate = {
      status,
      // Only overwrite the plan when the payload carries items we can read.
      ...(plan ? { plan } : {}),
      current_period_end: periodEnd(subscription),
      updated_at: new Date().toISOString(),
    };

    // CANCELED IS TERMINAL, and Stripe does not guarantee event ordering.
    // customer.subscription.deleted and a customer.subscription.updated for the
    // same subscription are frequently in flight together (a cancel emits
    // both), and the updated one can be delivered second - carrying the status
    // Stripe had a moment BEFORE the deletion. That write walked a canceled row
    // back to "active" or "trialing", which restored a membership nobody was
    // paying for and, on a trial, handed the perks back with no subscription
    // behind them. Nothing then heals it: there are no further events.
    //
    // So an `updated` may write anything EXCEPT over a row already canceled.
    // The `deleted` branch is deliberately not scoped: it is the authority on
    // that state, and it is what has to be able to write it (and to force
    // extra_home_slots to 0) in the first place. A Stripe subscription is never
    // reactivated after cancellation - a new membership is a new subscription
    // with a new id - so this can never block a legitimate revival.
    const scopeToLive = <T extends { neq: (c: string, v: string) => T }>(q: T): T =>
      event.type === "customer.subscription.updated"
        ? q.neq("status", "canceled")
        : q;

    const { error: updateError } = await scopeToLive(
      (admin as any)
        .from("subscriptions")
        .update({ ...baseUpdate, extra_home_slots: extraSlots })
        .eq("stripe_subscription_id", subscription.id)
    );
    // Graceful degradation: if the live DB hasn't run migration 0108 yet, the
    // extra_home_slots column doesn't exist. Retry without it so status/plan
    // sync - the part that actually keeps a membership live - never breaks over
    // the add-on column, same convention as upsertSubscriptionRow above.
    if (updateError && isMissingSchemaError(updateError)) {
      const { error: fallbackError } = await scopeToLive(
        (admin as any)
          .from("subscriptions")
          .update(baseUpdate)
          .eq("stripe_subscription_id", subscription.id)
      );
      if (fallbackError) {
        // Same reasoning as the checkout upsert branches above: without this
        // write the row drifts from Stripe and nothing else heals it until
        // the next subscription event. 500 so Stripe redelivers.
        console.error(
          "subscriptions update (fallback) failed for",
          subscription.id,
          fallbackError.message ?? fallbackError
        );
        return NextResponse.json({ error: "subscription update failed" }, { status: 500 });
      }
    } else if (updateError) {
      // Non-schema failure (transient network, RLS, bad payload): the DB can
      // drift from Stripe until the next subscription event. 500 so Stripe
      // redelivers instead of the write being silently lost.
      console.error(
        "subscriptions update failed for",
        subscription.id,
        updateError.message ?? updateError
      );
      return NextResponse.json({ error: "subscription update failed" }, { status: 500 });
    }
  }

  // Recurring Pro perk: every paid billing cycle grants bonus lead credit
  // ($10 monthly, $120 up front yearly). Subscription invoices only, and only
  // real cycles: proration and other mid-cycle update invoices don't count.
  if (event.type === "invoice.payment_succeeded") {
    const invoice = event.data.object as any;
    // Shared with the invoice.payment_failed branch below, so the two cannot
    // drift on which Stripe API shape they understand.
    const subscriptionId = subscriptionIdFromInvoice(invoice);
    // subscription_create and subscription_cycle are the normal cycles.
    // subscription_update counts too when money actually moved (amount_paid
    // over zero): a monthly-to-yearly upgrade bills the $120 on an update
    // invoice and must earn its credit. Idempotency by invoice id already
    // prevents double grants on retries and duplicate deliveries.
    //
    // subscription_create carries the same amount_paid gate for the free
    // trial's sake: starting a trial finalizes a $0 subscription_create
    // invoice, and crediting off it would pay the $10 perk out before the
    // member had paid anything. Every genuine paid create invoice is well over
    // zero, so the gate only ever removes the trial's placeholder. The real
    // first cycle then arrives as subscription_cycle at trial end and earns
    // the credit normally.
    const isGrantableReason =
      (invoice.billing_reason === "subscription_create" &&
        (invoice.amount_paid ?? 0) > 0) ||
      invoice.billing_reason === "subscription_cycle" ||
      (invoice.billing_reason === "subscription_update" &&
        (invoice.amount_paid ?? 0) > 0);
    if (subscriptionId && isGrantableReason) {
      // Best-effort from here down: the webhook must never fail over a perk.
      try {
        const admin = createAdminClient();
        // Match ONLY by stripe_subscription_id. A customer-id fallback would
        // be side-blind: one Stripe customer can carry both the homeowner
        // Plus and the Pro subscription, and a Plus invoice must never grant
        // pro credit off whichever row the customer lookup happened to hit.
        const { data: subRow } = await (admin as any)
          .from("subscriptions")
          .select("user_id, plan")
          .eq("stripe_subscription_id", subscriptionId)
          .maybeSingle();
        if (!subRow?.user_id) {
          console.error(
            "invoice.payment_succeeded: no subscriptions row for",
            subscriptionId,
            "- skipping membership credit"
          );
        }

        // Card fingerprint, for the trial-abuse score. Recorded on BOTH sides
        // (homeowner and pro, unlike the credit below) and on every paid cycle,
        // not only the first: a card swapped at renewal is a new link, and the
        // upsert makes a repeat sighting free.
        if (subRow?.user_id) {
          await recordCardFromSubscriptionId(
            subRow.user_id,
            subscriptionId,
            "invoice_paid"
          );
        }
        if (subRow?.user_id && subRow?.plan?.startsWith("pro_")) {
          // The amount comes from the interval on the PAID INVOICE's own
          // lines, never the stored plan: on a portal plan switch the
          // subscriptions row is only flipped by customer.subscription.updated,
          // Stripe does not guarantee event ordering (see the race notes in
          // the checkout branch), and the invoice-id idempotency key would
          // lock a wrong stale-plan amount in forever. The stored plan stays
          // as the gate above (Pro vs homeowner Plus) and as the fallback
          // when no line carries a readable interval.
          const lineInterval = invoiceLineInterval(invoice);
          const yearly = lineInterval
            ? lineInterval === "year"
            : subRow.plan === "pro_yearly";
          // Credit is keyed off the BILLING INTERVAL, never the amount paid:
          // the $9.99 intro first month earns the full $10 on purpose, and
          // the yearly price change didn't touch the $120. The invoice id is
          // the idempotency key: Stripe retries and duplicate deliveries
          // reuse it, while every new cycle mints a fresh one. A period-start
          // YYYY-MM key would wrongly collapse two legitimate grants landing
          // in the same month (e.g. a monthly-to-yearly switch) and depends
          // on our own clock rendering; the invoice id does neither.
          const { error } = await (admin as any).rpc("grant_membership_credit", {
            p_user: subRow.user_id,
            p_amount_cents: yearly ? 12000 : 1000,
            p_period_key: invoice.id,
            p_expiry_days: yearly ? 400 : 60,
          });
          // Graceful degradation: if migration 0034 isn't on the live DB yet,
          // the RPC doesn't exist. Log and move on; never 500 over this.
          if (error) {
            console.error("grant_membership_credit failed:", error.message ?? error);
          }
        }
      } catch (err) {
        console.error("grant_membership_credit failed:", err);
      }
    }
  }

  // -------------------------------------------------------------------------
  // DUNNING: a renewal charge was declined.
  // -------------------------------------------------------------------------
  // Before this existed, a churning subscriber looked identical in-app to a
  // happy one until customer.subscription.deleted finally fired - which, across
  // a full Smart Retry window, can be a month after the first decline. The
  // member saw nothing, and neither did the owner.
  //
  // Two things happen here, both best-effort, neither able to fail the webhook:
  //   1. The subscriptions row is flipped to past_due, so every surface that
  //      already reads that column (isLiveProPlanRow, the renewal cron, the
  //      account pages) stops treating the membership as healthy.
  //   2. The member gets ONE in-app notice per failed invoice pointing at the
  //      page whose "Manage billing" button opens the Stripe Customer Portal,
  //      which is where a card is actually replaced.
  if (event.type === "invoice.payment_failed") {
    const invoice = event.data.object as any;
    const subscriptionId = subscriptionIdFromInvoice(invoice);
    // A one-off invoice with no subscription has no membership to flag and no
    // renewal to save - nothing to do.
    if (subscriptionId) {
      try {
        const admin = createAdminClient();
        // Matched ONLY by stripe_subscription_id, never by customer id: one
        // Stripe customer can hold both the homeowner Plus and the Pro
        // subscription, and a failed Plus renewal must not mark the Pro
        // membership past_due.
        const { data: subRow } = await (admin as any)
          .from("subscriptions")
          .select("user_id, plan, status")
          .eq("stripe_subscription_id", subscriptionId)
          .maybeSingle();

        if (!subRow?.user_id) {
          console.error(
            "invoice.payment_failed: no subscriptions row for",
            subscriptionId,
            "- nothing to flag"
          );
        } else {
          // Conditional update. The row is a MIRROR of Stripe, and
          // customer.subscription.updated is the authority on its status - it
          // fires for this same failure and will also set the row back to
          // active the moment a retry succeeds. Stripe does not guarantee
          // event ordering, so this write is scoped to the statuses where
          // "the card just failed" is genuinely new information. That keeps a
          // late-arriving failure from walking a canceled row backwards into
          // past_due, or from overwriting a recovery that already landed.
          const { error: statusError } = await (admin as any)
            .from("subscriptions")
            .update({ status: "past_due", updated_at: new Date().toISOString() })
            .eq("stripe_subscription_id", subscriptionId)
            .in("status", DUNNING_OVERWRITABLE_STATUSES);
          if (statusError) {
            // Graceful degradation: a live database without the column (or the
            // row locked down another way) still gets the notice below. Never
            // 500 over bookkeeping.
            console.error(
              "invoice.payment_failed: could not mark past_due:",
              statusError.message ?? statusError
            );
          }

          const plan = toPaidPlan(subRow.plan);
          if (plan) {
            // introEligible false: this member is past signup and is being
            // billed at the standard recurring price, so the terms quoted back
            // to them must be the standard ones, not trial or intro copy.
            const terms = billingTerms(plan, false);
            // There is no standalone Customer Portal ROUTE in this app - the
            // portal session is minted by manageBillingAction, the server
            // action behind the "Manage billing" button on the membership
            // page. So the link goes to that page (/plus for homeowners,
            // /pro/plus for contractors, straight off terms.cancelPath), which
            // is one click from the portal and works whether or not the member
            // still has a live Stripe customer.
            //
            // The invoice id in the url is the dup key: Smart Retries fire
            // this event repeatedly for ONE failed invoice, and the member
            // should hear about it once. A genuinely new failed cycle carries
            // a new invoice id and re-arms the notice.
            //
            // GUARDED, because an invoice id is not guaranteed to be there: a
            // draft or preview invoice can arrive without one, and
            // `invoice=undefined` in the url is a string that is identical for
            // every failure - so notifyOnce would find its own earlier row and
            // withhold the notice for a genuinely new failed cycle, forever.
            // The fallback keys on the subscription plus the cycle it failed
            // in, which is the same "one notice per failed cycle" the invoice
            // id gives, from fields the payload always carries.
            const dedupeKey =
              typeof invoice.id === "string" && invoice.id
                ? invoice.id
                : `${subscriptionId}:${
                    invoice.period_start ?? invoice.created ?? "unknown"
                  }`;
            const url = `${terms.cancelPath}?billing=past_due&invoice=${encodeURIComponent(dedupeKey)}`;
            await notifyOnce(admin, {
              userId: subRow.user_id,
              kind: DUNNING_KIND,
              title: `Your ${terms.product} payment didn't go through, update your card`,
              body:
                `We couldn't charge the card on file for your ${terms.product} membership. ` +
                `Open your ${terms.product} page and use Manage billing to update your card, ` +
                `and we'll retry the charge automatically. ${terms.cancel}`,
              url,
            });
          } else {
            // An unrecognized stored plan name means the copy would have to
            // guess at the product and the price. The row is still flagged
            // past_due above; only the message is withheld.
            console.error(
              "invoice.payment_failed: unrecognized plan on the subscriptions row for",
              subscriptionId,
              "- flagged past_due, no notice sent"
            );
          }
        }
      } catch (err) {
        console.error("invoice.payment_failed handling threw:", err);
      }
    }
  }

  // -------------------------------------------------------------------------
  // TRIAL ENDING: Stripe's 3-days-out heads-up.
  // -------------------------------------------------------------------------
  // Required reading for the member and the one number the trial-to-paid
  // conversion rate depends on. The price quoted comes from billingTerms, which
  // derives everything from PLUS_PLAN / PRO_PLAN in src/lib/constants.ts, so
  // this notice can never quote a number the card is not actually charged - the
  // whole reason no price is written here by hand.
  if (event.type === "customer.subscription.trial_will_end") {
    const subscription = event.data.object as any;
    const trialEndSec = subscription?.trial_end;
    if (subscription?.id && typeof trialEndSec === "number") {
      try {
        const admin = createAdminClient();
        const { data: subRow } = await (admin as any)
          .from("subscriptions")
          .select("user_id, plan")
          .eq("stripe_subscription_id", subscription.id)
          .maybeSingle();

        if (!subRow?.user_id) {
          console.error(
            "customer.subscription.trial_will_end: no subscriptions row for",
            subscription.id
          );
        } else {
          // The stored plan is the authority on WHICH product this is, since
          // the billing interval alone cannot tell Plus monthly from Pro
          // monthly. planFromItems is the fallback for the one case the stored
          // name cannot cover: a homeowner row written before its cadence was
          // known. A pro_ row is never re-derived from the interval here -
          // same conservative rule the subscription.updated branch follows.
          const plan =
            toPaidPlan(subRow.plan) ??
            (subRow.plan?.startsWith("pro_")
              ? null
              : toPaidPlan(planFromItems(subscription)));
          if (plan) {
            // introEligible true: this subscription IS on the trial right now,
            // so terms.recurring is the "after the free trial, $X is charged
            // and renews until you cancel" sentence - the exact wording shown
            // before checkout, which is what makes the two impossible to
            // drift apart.
            const terms = billingTerms(plan, true);
            const trialEnd = new Date(trialEndSec * 1000);
            const url = `${terms.cancelPath}?renewal=${trialEnd
              .toISOString()
              .slice(0, 10)}`;
            await notifyOnce(admin, {
              userId: subRow.user_id,
              kind: TRIAL_REMINDER_KIND,
              title: `Your ${terms.product} free trial ends on ${fmtDate(trialEnd)}`,
              body: `${terms.recurring} ${terms.cancel}`,
              url,
            });
          } else {
            console.error(
              "customer.subscription.trial_will_end: unrecognized plan for",
              subscription.id,
              "- no notice sent"
            );
          }
        }
      } catch (err) {
        console.error("customer.subscription.trial_will_end handling threw:", err);
      }
    }
  }

  return NextResponse.json({ received: true });
}
