import { timingSafeEqual } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendNotification } from "@/lib/notify";
import { billingTerms, type PaidPlan } from "@/lib/billingTerms";

export const runtime = "nodejs";

// Daily job (Vercel Cron - add to vercel.json alongside the other crons; the
// exact block belongs to the wave lead since RE does not own that file, see
// docs/NOTIFICATIONS.md) that follows up on the dunning notice the Stripe
// webhook already sent: src/app/api/stripe/webhook/route.ts's
// invoice.payment_failed branch flags the subscriptions row past_due and
// writes ONE in-app notice per failed invoice the moment the card declines.
// That notice is real news the first time. This cron is the second and last
// beat of the same story: if the member has not fixed their card 72 hours
// later, one gentle reminder goes out, and then this cron leaves that
// invoice alone forever (the dedupe below is permanent, not a retry loop).
//
// NO STRIPE CALLS. Unlike renewal-reminders, which has to ask Stripe whether
// a subscription is set to cancel before warning about a charge that will not
// happen, this cron trusts subscriptions.status the same way the webhook's
// own DUNNING_OVERWRITABLE_STATUSES logic does: customer.subscription.updated
// flips the row back to "active" the moment a retry succeeds, so a row still
// reading "past_due" at cron time is still genuinely past due right now.
//
// FINDING "THE FIRST NOTICE" WITHOUT A NEW TABLE. The webhook's notice is
// deduped on (user_id, kind="payment_failed", url), where the url carries the
// Stripe invoice id: `${cancelPath}?billing=past_due&invoice=<id>`. Reading
// that row back - most recent first, kind and cancelPath both matched - gives
// this cron both facts it needs: WHEN the first notice went out (its
// created_at, for the 72-hour gate) and WHICH invoice it was about (the
// `invoice` query param, reused as this cron's own dedupe key). No new table,
// no new column: the notifications row the webhook already writes is the
// entire memory this cron needs.

// The SAME kind DUNNING_KIND the webhook writes (src/app/api/stripe/webhook/
// route.ts). Duplicated here rather than imported - a route.ts file may only
// export its HTTP handlers, so importing a business-logic const out of one is
// not available the way it would be from an ordinary module. The
// renewal-reminders cron and the webhook already duplicate TRIAL_REMINDER_KIND
// this same way for the same reason; see the comment there.
const DUNNING_KIND = "payment_failed";

// This cron's own kind, distinct from DUNNING_KIND so its dedupe guard can
// never collide with the webhook's. Also on TRANSACTIONAL_NOTIFICATION_KINDS
// and PUSH_NOTIFICATION_KINDS in src/lib/notifyGating.ts - a card that is
// still declined 72 hours later is exactly as urgent as the first notice.
const FOLLOWUP_KIND = "payment_failed_followup";

// How long to wait after the first notice before nudging again. Long enough
// that "give the retry a chance to succeed on its own" is a real window
// (Stripe's Smart Retries space attempts out over days), short enough that a
// member who missed the first notice still has time to act before the
// subscription is canceled outright.
const FOLLOWUP_LEAD_HOURS = 72;
const HOUR_MS = 60 * 60 * 1000;

const MAX_SUBSCRIPTIONS = 300; // cap the work (and the row reads) per run
const SEND_CHUNK = 10;

function isAuthorized(req: NextRequest): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;
  // Vercel Cron automatically sends "Authorization: Bearer <CRON_SECRET>" when
  // the CRON_SECRET env var is set. Also accept an explicit x-cron-secret
  // header for manual runs / other schedulers.
  const auth = req.headers.get("authorization");
  const bearer = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
  const provided = bearer ?? req.headers.get("x-cron-secret");
  if (!provided) return false;
  // Constant-time compare (mirrors every other cron in this app): only call
  // timingSafeEqual once both buffers are a confirmed equal length, since it
  // throws on a length mismatch.
  const providedBuf = Buffer.from(provided, "utf8");
  const expectedBuf = Buffer.from(expected, "utf8");
  if (providedBuf.length !== expectedBuf.length) return false;
  try {
    return timingSafeEqual(providedBuf, expectedBuf);
  } catch {
    return false;
  }
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// Normalize a stored plan string to the union billingTerms understands.
// Mirrors toPaidPlan in the webhook and the renewal-reminders cron: anything
// unrecognized returns null and the row is skipped rather than guessed at, a
// billing notice quoting the wrong product is worse than none.
function toPaidPlan(plan: string | null | undefined): PaidPlan | null {
  if (plan === "weekly" || plan === "monthly" || plan === "yearly") return plan;
  if (plan === "pro_monthly" || plan === "pro_yearly") return plan;
  return null;
}

// Pull the `invoice` query param the webhook stamped on its own notice's url,
// so the follow-up's dedupe key matches the SAME invoice the first notice was
// about. Falls back to the whole url when the param is missing (the webhook's
// own fallback path for a draft/preview invoice with no id) - still a stable,
// unique-enough key for this one cycle.
function invoiceKeyFromUrl(url: string): string {
  try {
    const parsed = new URL(url, "https://hearth.invalid");
    const invoice = parsed.searchParams.get("invoice");
    if (invoice) return invoice;
  } catch {
    // Not a parseable URL; fall through to the raw-url fallback below.
  }
  return url;
}

type PastDueRow = {
  user_id: string;
  plan: string | null;
  status: string | null;
};

async function runCron(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const supabase = createAdminClient();

  const { data: rawSubs, error: subsError } = await (
    supabase.from("subscriptions") as any
  )
    .select("user_id, plan, status")
    .eq("status", "past_due")
    .not("user_id", "is", null)
    .limit(MAX_SUBSCRIPTIONS);

  if (subsError) {
    console.error(
      "dunning-followup cron: subscriptions query failed:",
      subsError.message
    );
    return NextResponse.json(
      { checked: 0, notified: 0, error: subsError.message },
      { status: 200 }
    );
  }

  const subs = ((rawSubs ?? []) as PastDueRow[]).filter((s) =>
    Boolean(s.user_id)
  );
  if (subs.length === 0) {
    return NextResponse.json({ checked: 0, notified: 0 });
  }

  let checked = 0;
  let notified = 0;

  for (const batch of chunk(subs, SEND_CHUNK)) {
    await Promise.all(
      batch.map(async (sub) => {
        checked += 1;
        try {
          const plan = toPaidPlan(sub.plan);
          if (!plan) return;
          const terms = billingTerms(plan, false);

          // The webhook's own first notice for this membership, newest first:
          // whichever failed invoice is CURRENT (an older, already-resolved
          // episode's notice would only surface here if no newer one exists,
          // and a resolved episode means the row would not still read
          // past_due, so it would not have reached this cron at all).
          const { data: firstNotice } = await supabase
            .from("notifications")
            .select("url, created_at")
            .eq("user_id", sub.user_id)
            .eq("kind", DUNNING_KIND)
            .like("url", `${terms.cancelPath}?billing=past_due%`)
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();
          if (!firstNotice?.url || !firstNotice.created_at) return;

          const ageMs = Date.now() - new Date(firstNotice.created_at).getTime();
          if (ageMs < FOLLOWUP_LEAD_HOURS * HOUR_MS) return;

          const invoiceKey = invoiceKeyFromUrl(firstNotice.url);
          const followupUrl = `${terms.cancelPath}?billing=past_due_followup&invoice=${encodeURIComponent(invoiceKey)}`;

          // Dedupe, same (user, kind, url) shape every notifyOnce-style guard
          // in this app uses: a re-run of this cron before the NEXT invoice
          // fails is a no-op, and a genuinely new failed cycle carries a new
          // invoice id (a new firstNotice.url above), which re-arms this on
          // its own.
          const { data: existingFollowup } = await supabase
            .from("notifications")
            .select("id")
            .eq("user_id", sub.user_id)
            .eq("kind", FOLLOWUP_KIND)
            .eq("url", followupUrl)
            .limit(1)
            .maybeSingle();
          if (existingFollowup) return;

          const { data: user } = await supabase
            .from("users")
            .select("email")
            .eq("id", sub.user_id)
            .maybeSingle();

          const sent = await sendNotification(supabase, {
            userId: sub.user_id,
            kind: FOLLOWUP_KIND,
            title: `Your ${terms.product} card still needs an update`,
            body:
              "Your card did not go through. Update it in a minute and nothing changes. " +
              `Open your ${terms.product} page and use Manage billing to update your card, ` +
              "and we'll retry the charge automatically.",
            url: followupUrl,
            email: user?.email ?? null,
            // No SMS: a billing notice is something to keep and re-read, same
            // call the webhook's own dunning notice and the renewal-reminders
            // cron both make.
            phone: null,
          });
          if (sent) notified += 1;
        } catch (err) {
          // One bad row must not stop the rest of the batch.
          console.error("dunning-followup cron: row failed:", err);
        }
      })
    );
  }

  return NextResponse.json({ checked, notified });
}

export async function POST(req: NextRequest) {
  return runCron(req);
}

export async function GET(req: NextRequest) {
  return runCron(req);
}
