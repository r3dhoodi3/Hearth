import { PRO_LEADS_HREF } from "@/lib/constants";
import { timingSafeEqual } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendNotification } from "@/lib/notify";

export const runtime = "nodejs";

// Daily job (Vercel Cron, see vercel.json) that runs ghost protection for pros:
// if a pro paid to apply and the homeowner never engaged (no pick, no message)
// for 7 days while the job sat untouched, the apply fee comes back to their
// wallet automatically.
//
// All the money logic lives in the ghost_refund_application() DB function
// (migration 0028), which re-checks every eligibility rule atomically and
// double-refund-guards with `where refunded_at is null`. This route only finds
// rough candidates, calls the function per application, and notifies the pro
// on each success - so re-runs and overlapping runs are safe by construction.

const GHOST_DAYS = 7;
const MAX_REFUNDS = 200; // cap the work a single run does

const DAY_MS = 24 * 60 * 60 * 1000;

function isAuthorized(req: NextRequest): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;
  // Vercel Cron automatically sends "Authorization: Bearer <CRON_SECRET>" when
  // the CRON_SECRET env var is set. Also accept an explicit x-cron-secret header
  // for manual runs / other schedulers.
  const auth = req.headers.get("authorization");
  const bearer = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
  const provided = bearer ?? req.headers.get("x-cron-secret");
  if (!provided) return false;
  // Constant-time compare (mirrors src/lib/checkr.ts / the twilio inbound
  // webhook): only call timingSafeEqual once both buffers are a confirmed
  // equal length, since it throws on a length mismatch.
  const providedBuf = Buffer.from(provided, "utf8");
  const expectedBuf = Buffer.from(expected, "utf8");
  if (providedBuf.length !== expectedBuf.length) return false;
  try {
    return timingSafeEqual(providedBuf, expectedBuf);
  } catch {
    return false;
  }
}

// "$50" or "$12.50", matching how fees render on the pro dashboard.
function feeLabel(cents: number): string {
  const v = cents / 100;
  return Number.isInteger(v) ? `$${v}` : `$${v.toFixed(2)}`;
}

async function runCron(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const supabase = createAdminClient();
  const cutoff = new Date(Date.now() - GHOST_DAYS * DAY_MS).toISOString();

  let refunded = 0;

  // Refunds this run actually performed, collected per contractor so one
  // summary notification can go out instead of one per refund. Declared out
  // here (not inside the application block) so the notification loop below can
  // read it even on a run with no open-board candidates.
  const refundsByContractor = new Map<
    string,
    { userId: string; feeCents: number }[]
  >();

  // Rough candidates: 7+ days old, never refunded, still just "applied".
  // Oldest first, so nobody waits extra days when a run hits the cap.
  const { data: apps, error } = await supabase
    .from("lead_applications")
    .select("id, lead_id, contractor_id, fee_cents")
    .is("refunded_at", null)
    .eq("status", "applied")
    .gt("fee_cents", 0)
    .lte("created_at", cutoff)
    .order("created_at", { ascending: true })
    .limit(MAX_REFUNDS);

  // No open-board candidates this run is not the end of the work: the direct
  // sweep below runs regardless. Only skip the application block here.
  if (!error && apps && apps.length > 0) {
    // Cheap pre-filter: drop applications whose lead was already assigned or
    // closed. The DB function is still the authority on every rule.
    const leadIds = Array.from(new Set(apps.map((a) => a.lead_id)));
    const { data: leads } = await supabase
      .from("contractor_leads")
      .select("id, contractor_id, status")
      .in("id", leadIds);
    const openLeads = new Set(
      (leads ?? [])
        .filter((l) => l.contractor_id === null && l.status === "new")
        .map((l) => l.id)
    );
    const candidates = apps.filter((a) => openLeads.has(a.lead_id));

    // Resolve each candidate's contractor to a user for the notification.
    const contractorIds = Array.from(
      new Set(candidates.map((a) => a.contractor_id))
    );
    const { data: contractors } = contractorIds.length
      ? await supabase
          .from("contractors")
          .select("id, user_id")
          .in("id", contractorIds)
      : { data: [] };
    const userByContractor = new Map(
      (contractors ?? []).map((c) => [c.id, c.user_id])
    );

    // The refund itself (the rpc call, the ok check, and the refunded count) is
    // untouched; each success is collected into refundsByContractor for the
    // single summary notification below.
    for (const app of candidates) {
      try {
        const { data: ok } = await supabase.rpc("ghost_refund_application", {
          p_application: app.id,
        });
        if (ok !== true) continue;
        refunded += 1;

        const userId = userByContractor.get(app.contractor_id);
        if (userId) {
          const list = refundsByContractor.get(app.contractor_id) ?? [];
          list.push({ userId, feeCents: Number(app.fee_cents) });
          refundsByContractor.set(app.contractor_id, list);
        }
      } catch {
        // One bad application shouldn't stop the rest of the run.
        continue;
      }
    }
  }

  // Contact details so the email/SMS channels can fire once their providers
  // are configured (same pattern as the other crons), for just the pros who
  // actually got a refund this run.
  const refundUserIds = Array.from(
    new Set(Array.from(refundsByContractor.values(), (list) => list[0].userId))
  );
  const { data: refundUsers } = refundUserIds.length
    ? await supabase
        .from("users")
        .select("id, email, phone, sms_consent")
        .in("id", refundUserIds)
    : { data: [] };
  const contactByUser = new Map((refundUsers ?? []).map((u) => [u.id, u]));

  // Tell each pro their money came back, once per contractor for this run.
  // Best-effort: the refunds are already committed, and a notification
  // hiccup must not stop the run. No extra dedupe key is needed here: a
  // same-day rerun would find zero eligible candidates above, since
  // ghost_refund_application guards on refunded_at, so this batch can never
  // fire twice for the same refunds.
  for (const refunds of refundsByContractor.values()) {
    try {
      const userId = refunds[0].userId;
      const totalCents = refunds.reduce((sum, r) => sum + r.feeCents, 0);
      const title =
        refunds.length === 1
          ? "Ghost protection: your fee came back as credit"
          : "Ghost protection: your fees came back as credit";
      const body =
        refunds.length === 1
          ? `The homeowner never responded, so your ${feeLabel(
              refunds[0].feeCents
            )} apply fee is back in your wallet as credit for your next application.`
          : `Your apply fee came back on ${refunds.length} jobs today: the homeowners never responded, so ${feeLabel(
              totalCents
            )} total is back in your wallet as credit.`;

      const contact = contactByUser.get(userId);
      await sendNotification(supabase, {
        userId,
        kind: "ghost_refund",
        title,
        body,
        url: PRO_LEADS_HREF,
        email: contact?.email ?? null,
        phone: contact?.phone ?? null,
        smsConsent: contact?.sms_consent === true,
      });
    } catch {
      // One bad notification shouldn't stop the rest of the run.
      continue;
    }
  }

  // ---- Direct-request unlocks (0104) ---------------------------------------
  // Same protection, other lead direction: a pro paid to unlock a direct
  // request and the homeowner never messaged within 7 days. ghost_refund_direct
  // re-checks everything (the 7-day clock, the un-refunded chosen row, and any
  // homeowner message since the unlock), so this only needs a loose pre-filter.
  // The lead stays assigned; only the money is reversed.
  let directRefunded = 0;

  // Candidate leads: unlocked at least 7 days ago, oldest first. On a live DB
  // without 0104 this errors on the new columns; treat that as "nothing to do"
  // rather than failing the whole cron (the application sweep already ran).
  const { data: directLeads, error: directError } = await supabase
    .from("contractor_leads")
    .select("id, contractor_id, direct_unlocked_at")
    .not("direct_to", "is", null)
    .not("contractor_id", "is", null)
    .not("direct_unlocked_at", "is", null)
    .lte("direct_unlocked_at", cutoff)
    .order("direct_unlocked_at", { ascending: true })
    .limit(MAX_REFUNDS);

  if (!directError && directLeads && directLeads.length > 0) {
    // Loose join against the un-refunded 'chosen' unlock rows: only leads that
    // still have a refundable fee are worth calling the RPC on. The row also
    // carries the fee_cents the notification quotes.
    const directLeadIds = directLeads.map((l) => l.id);
    const { data: chosenApps } = await supabase
      .from("lead_applications")
      .select("lead_id, contractor_id, fee_cents")
      .eq("status", "chosen")
      .is("refunded_at", null)
      .gt("fee_cents", 0)
      .in("lead_id", directLeadIds);
    const feeByLead = new Map(
      (chosenApps ?? []).map((a) => [
        a.lead_id,
        { contractorId: a.contractor_id, feeCents: Number(a.fee_cents) },
      ])
    );
    const directCandidates = directLeads.filter((l) => {
      const app = feeByLead.get(l.id);
      return app && app.contractorId === l.contractor_id;
    });

    // Resolve each candidate's contractor to a user for the notification.
    const directContractorIds = Array.from(
      new Set(directCandidates.map((l) => l.contractor_id))
    );
    const { data: directContractors } = directContractorIds.length
      ? await supabase
          .from("contractors")
          .select("id, user_id")
          .in("id", directContractorIds)
      : { data: [] };
    const userByDirectContractor = new Map(
      (directContractors ?? []).map((c) => [c.id, c.user_id])
    );

    const directRefunds: { userId: string; feeCents: number }[] = [];
    for (const lead of directCandidates) {
      try {
        const { data: ok } = await supabase.rpc("ghost_refund_direct", {
          p_lead: lead.id,
        });
        if (ok !== true) continue;
        directRefunded += 1;

        const userId = userByDirectContractor.get(lead.contractor_id);
        const app = feeByLead.get(lead.id);
        if (userId && app) {
          directRefunds.push({ userId, feeCents: app.feeCents });
        }
      } catch {
        // One bad lead shouldn't stop the rest of the run.
        continue;
      }
    }

    // Contact details for the email/SMS channels, for just the pros refunded.
    const directUserIds = Array.from(new Set(directRefunds.map((r) => r.userId)));
    const { data: directUsers } = directUserIds.length
      ? await supabase
          .from("users")
          .select("id, email, phone, sms_consent")
          .in("id", directUserIds)
      : { data: [] };
    const directContactByUser = new Map(
      (directUsers ?? []).map((u) => [u.id, u])
    );

    // Tell each refunded pro. One row per refund is fine: a homeowner reaches a
    // pro directly one job at a time, so batching would rarely change anything.
    for (const r of directRefunds) {
      try {
        const contact = directContactByUser.get(r.userId);
        await sendNotification(supabase, {
          userId: r.userId,
          kind: "ghost_refund",
          title: "Ghost protection: your fee came back as credit",
          body: `The homeowner never responded to a direct request, so your ${feeLabel(
            r.feeCents
          )} lead fee is back in your wallet as credit for your next lead.`,
          url: PRO_LEADS_HREF,
          email: contact?.email ?? null,
          phone: contact?.phone ?? null,
          smsConsent: contact?.sms_consent === true,
        });
      } catch {
        // One bad notification shouldn't stop the rest of the run.
        continue;
      }
    }
  }

  // Surface either sweep's query error without blocking the other: a broken
  // sweep must not read as a healthy zero-refund run. Still status 200 (the run
  // did what it could), and directError stays "nothing to do" for execution
  // (e.g. a live DB without 0104) while its message remains visible here.
  return NextResponse.json({
    refunded,
    directRefunded,
    ...(error ? { applicationSweepError: error.message } : {}),
    ...(directError ? { directSweepError: directError.message } : {}),
  });
}

export async function POST(req: NextRequest) {
  return runCron(req);
}

export async function GET(req: NextRequest) {
  return runCron(req);
}
