import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { verifyWebhookSignature, parseCheckrWebhookPayload } from "@/lib/checkr";

// Checkr needs the raw body + Node runtime to verify the signature, same
// requirement as the Stripe webhook (src/app/api/stripe/webhook/route.ts).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// FCRA note: OakTend is not the "user" of the report under the Fair Credit
// Reporting Act - Checkr's own candidate-facing flow (consent, disclosures,
// adverse-action notices) carries those obligations directly with the
// candidate. This route only ever reads and stores a pass/no-pass STATUS
// (background_check_status/_at). It never reads, logs, or persists the
// report's actual contents (criminal records, etc.) - background_check_detail
// below is limited to report id / package / completed_at / the last
// processed event id, nothing from the report body itself.

export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  const signature = req.headers.get("x-checkr-signature");

  // Signature verification FIRST, before anything else touches the payload.
  if (!verifyWebhookSignature(rawBody, signature)) {
    return new NextResponse("Bad signature", { status: 401 });
  }

  let payload: any;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return new NextResponse("Bad payload", { status: 400 });
  }

  const event = parseCheckrWebhookPayload(payload);
  if (!event.candidateId || event.type === "other") {
    // Nothing this route acts on (an event type we don't handle, or one with
    // no candidate to match). Acknowledge anyway so Checkr doesn't retry.
    return NextResponse.json({ received: true });
  }

  const admin = createAdminClient();
  const { data: contractor, error: lookupError } = await (admin as any)
    .from("contractors")
    .select("id, user_id, background_check_status, background_check_detail")
    .eq("checkr_candidate_id", event.candidateId)
    .maybeSingle();

  if (lookupError) {
    // A real DB error (not "no rows" - maybeSingle only errors on an actual
    // failure) is indistinguishable from "no contractor" unless checked
    // explicitly. Ack with a 500 so Checkr retries instead of the event
    // being silently lost.
    console.error("checkr webhook: contractor lookup failed:", lookupError.message);
    return NextResponse.json({ error: "lookup failed" }, { status: 500 });
  }

  if (!contractor) {
    // No matching contractor (candidate id was never saved, or belongs to a
    // stale/replaced invite). Ack and move on - never an error.
    return NextResponse.json({ received: true });
  }

  // Idempotency: skip a replayed delivery of an event we already applied.
  // The last processed event id lives inside background_check_detail
  // (0057) rather than a separate column, per the migration's design.
  const existingDetail = (contractor.background_check_detail ?? {}) as Record<
    string,
    unknown
  >;
  if (event.id && existingDetail.last_event_id === event.id) {
    return NextResponse.json({ received: true });
  }

  let fields: Record<string, unknown> | null = null;

  if (event.type === "report.completed") {
    if (event.reportResult === "clear") {
      fields = {
        background_check_status: "clear",
        background_checked_at: new Date().toISOString(),
        background_check_detail: {
          report_id: event.reportId,
          package: event.packageSlug,
          completed_at: event.completedAt,
          last_event_id: event.id,
        },
      };
    } else {
      // "consider" or any other non-clear result: never the badge, private
      // status only. An in-progress/failed check must never show publicly.
      fields = {
        background_check_status: "consider",
        background_checked_at: null,
        background_check_detail: {
          report_id: event.reportId,
          package: event.packageSlug,
          completed_at: event.completedAt,
          last_event_id: event.id,
        },
      };
    }
  } else if (event.type === "invitation.completed") {
    // Candidate finished the invitation; the report is now running.
    // ORDERING GUARD: invitation events may only advance a live 'invited'
    // state. Checkr delivers at-least-once with retries, so a stale
    // invitation event can arrive AFTER report.completed already resolved
    // the check; without this gate it would knock a resolved status back to
    // 'pending'. report.completed above stays authoritative/unconditional.
    if (contractor.background_check_status === "invited") {
      fields = {
        background_check_status: "pending",
        background_check_detail: { ...existingDetail, last_event_id: event.id },
      };
    }
  } else if (
    event.type === "invitation.expired" ||
    event.type === "invitation.canceled"
  ) {
    // Back to 'none' so the pro can retry from /pro/profile. Same ordering
    // guard as above: only an invitation still in 'invited' can expire.
    // Without it, a stale retry of this event could silently erase a
    // legitimately EARNED badge ('clear' + background_checked_at) that a
    // later report.completed already granted.
    if (contractor.background_check_status === "invited") {
      fields = {
        background_check_status: "none",
        background_checked_at: null,
        background_check_detail: { ...existingDetail, last_event_id: event.id },
      };
    }
  }

  if (fields) {
    const { error } = await (admin as any)
      .from("contractors")
      .update(fields)
      .eq("id", contractor.id);
    if (error) {
      // The status update is the whole point of this event; a failed write
      // must not ACK as if it landed. 500 makes Checkr retry.
      console.error("checkr webhook: contractor update failed:", error.message);
      return NextResponse.json({ error: "update failed" }, { status: 500 });
    }
  }

  // Notify the pro on a clear result, best-effort - a notification hiccup
  // must never turn into a failed webhook delivery / retry storm.
  if (fields?.background_check_status === "clear" && contractor.user_id) {
    try {
      await (admin as any).from("notifications").insert({
        user_id: contractor.user_id,
        kind: "background_check_clear",
        title: "Your background check cleared",
        body: "The badge is live on your public page.",
        url: "/pro/profile",
      });
    } catch (err) {
      console.error("checkr webhook: notification failed:", err);
    }
  }

  return NextResponse.json({ received: true });
}
