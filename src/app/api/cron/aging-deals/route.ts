import { timingSafeEqual } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendNotification } from "@/lib/notify";
import { AGING_LEAD_TIERS } from "@/lib/leadPricing";
import { MAX_APPLICANTS_PER_JOB,
  PRO_LEADS_HREF,
} from "@/lib/constants";

export const runtime = "nodejs";

// Daily job (Vercel Cron, see vercel.json) that pings Hearth Pro members about
// aging-deal jobs in their trades: open, unassigned, not-yet-full jobs whose
// apply fee JUST crossed a markdown tier (15% off at 3 days, 30% off at 7:
// AGING_LEAD_TIERS, priced for real by lead_fee_cents() in migration 0028).
//
// Noise control is structural: a job only qualifies during the 24 hours right
// after it crosses a tier boundary, so each job can appear in at most one run
// per tier. Each member gets at most ONE summary notification per run, only
// when at least one job qualifies, and a cheap dup-guard (same kind + link
// already written in the last ~day) makes an accidental second run a no-op.
// Free pros get nothing here: the discounts themselves stay visible to
// everyone on the board; this is just the members-only ping.

const MAX_MEMBERS = 500; // cap the work a single run does
const MAX_JOBS = 1000; // sanity cap on the candidate job scan
// Sanity cap on the live-subscription scan, paged in SUBSCRIPTION_PAGE steps
// (see its comment) since PostgREST silently truncates any single response
// at its max-rows cap (default 1000).
const MAX_SUBSCRIPTIONS = 2000;
const SUBSCRIPTION_PAGE = 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

// Dup-guard lookback. Shorter than 24h so a scheduler that fires a few
// minutes early never suppresses tomorrow's legitimate alert.
const DUP_GUARD_MS = 20 * 60 * 60 * 1000;

const ALERT_KIND = "aging_deal";
const ALERT_URL = PRO_LEADS_HREF;
const ALERT_TITLE = "Deals on jobs in your trades";

// Keep Promise.all fan-out bounded.
const SEND_CHUNK = 10;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

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

// Discount a job just unlocked, or null if it did not cross a tier boundary in
// the last 24 hours. Tiers are declared deepest-first, so a job sitting in the
// day after the 7-day line reports 30, the day after the 3-day line reports
// 15, and everything else (fresh, mid-tier, ancient) stays quiet.
function justCrossedOff(createdAt: string, nowMs: number): number | null {
  const ageDays = (nowMs - new Date(createdAt).getTime()) / DAY_MS;
  for (const t of AGING_LEAD_TIERS) {
    if (ageDays >= t.days && ageDays < t.days + 1) return t.off;
  }
  return null;
}

// "15% off" for one tier, "15-30% off" when a member's deals span tiers.
function offLabel(offs: number[]): string {
  const min = Math.min(...offs);
  const max = Math.max(...offs);
  return min === max ? `${min}% off` : `${min}-${max}% off`;
}

async function runCron(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const supabase = createAdminClient();
  const nowMs = Date.now();

  // Candidate jobs: open, unassigned, and old enough for the shallowest tier
  // but not past a full day beyond the deepest one. Everything outside that
  // band either hasn't crossed a boundary yet or crossed it on a prior run.
  const minDays = Math.min(...AGING_LEAD_TIERS.map((t) => t.days));
  const maxDays = Math.max(...AGING_LEAD_TIERS.map((t) => t.days));
  const newestCutoff = new Date(nowMs - minDays * DAY_MS).toISOString();
  const oldestCutoff = new Date(nowMs - (maxDays + 1) * DAY_MS).toISOString();

  const { data: rawJobs, error: jobsError } = await supabase
    .from("contractor_leads")
    .select("id, category, created_at")
    .is("contractor_id", null)
    .eq("status", "new")
    .lte("created_at", newestCutoff)
    .gt("created_at", oldestCutoff)
    .limit(MAX_JOBS);
  if (jobsError) {
    return NextResponse.json(
      { checked: 0, notified: 0, error: jobsError.message },
      { status: 200 }
    );
  }

  // Keep only jobs that crossed a tier in the last 24h, tagged with the
  // discount they just unlocked.
  const jobs = (rawJobs ?? [])
    .map((j) => ({ ...j, off: justCrossedOff(j.created_at, nowMs) }))
    .filter((j): j is typeof j & { off: number } => j.off !== null);
  if (jobs.length === 0) {
    return NextResponse.json({ checked: 0, notified: 0 });
  }

  // Live applications per job: full jobs (all spots taken) drop out, and each
  // job remembers who already applied so those pros aren't pinged about it.
  const jobIds = jobs.map((j) => j.id);
  const { data: apps } = await supabase
    .from("lead_applications")
    .select("lead_id, contractor_id")
    .in("lead_id", jobIds)
    .is("refunded_at", null);
  const applicantsByJob = new Map<string, Set<string>>();
  for (const a of apps ?? []) {
    const set = applicantsByJob.get(a.lead_id) ?? new Set<string>();
    set.add(a.contractor_id);
    applicantsByJob.set(a.lead_id, set);
  }
  const openJobs = jobs.filter(
    (j) => (applicantsByJob.get(j.id)?.size ?? 0) < MAX_APPLICANTS_PER_JOB
  );
  if (openJobs.length === 0) {
    return NextResponse.json({ checked: 0, notified: 0 });
  }

  // Live Pro memberships. Same liveness rules as hasProPlan() and the
  // new-lead alerts in proAlerts.ts: a pro_ plan, active or trialing, and not
  // past a known period end. The like() is only a coarse server-side
  // prefilter (in SQL LIKE the underscore is a single-character wildcard), so
  // the real startsWith check and the date check happen in code below.
  const subs: {
    user_id: string;
    plan: string | null;
    current_period_end: string | null;
  }[] = [];
  for (let start = 0; start < MAX_SUBSCRIPTIONS; start += SUBSCRIPTION_PAGE) {
    const end = Math.min(start + SUBSCRIPTION_PAGE, MAX_SUBSCRIPTIONS) - 1;
    const { data: page, error: subsError } = await (supabase as any)
      .from("subscriptions")
      .select("user_id, plan, status, current_period_end")
      .in("status", ["active", "trialing"])
      .like("plan", "pro_%")
      .range(start, end);
    if (subsError) {
      return NextResponse.json(
        { checked: 0, notified: 0, error: subsError.message },
        { status: 200 }
      );
    }
    subs.push(...(page ?? []));
    if (!page || page.length < end - start + 1) break;
  }

  const memberIds: string[] = [];
  for (const sub of subs) {
    if (!sub.plan?.startsWith("pro_")) continue;
    if (
      sub.current_period_end &&
      new Date(sub.current_period_end).getTime() <= nowMs
    )
      continue;
    if (!memberIds.includes(sub.user_id)) memberIds.push(sub.user_id);
    if (memberIds.length >= MAX_MEMBERS) break;
  }
  if (memberIds.length === 0) {
    return NextResponse.json({ checked: 0, notified: 0 });
  }

  // The members' contractor profiles (for categories and applied-already
  // checks). A member with no contractor row can't apply, so they drop out.
  const { data: contractors } = await supabase
    .from("contractors")
    .select("id, user_id, categories")
    .in("user_id", memberIds);
  const memberContractors = (contractors ?? []).filter(
    (c): c is typeof c & { user_id: string } => Boolean(c.user_id)
  );
  if (memberContractors.length === 0) {
    return NextResponse.json({ checked: 0, notified: 0 });
  }

  // Dup guard: anyone who already got this alert in the last ~day (e.g. the
  // cron ran twice) is skipped. Keyed on kind + link, which never vary.
  const guardCutoff = new Date(nowMs - DUP_GUARD_MS).toISOString();
  const { data: recent } = await supabase
    .from("notifications")
    .select("user_id")
    .in(
      "user_id",
      memberContractors.map((c) => c.user_id)
    )
    .eq("kind", ALERT_KIND)
    .eq("url", ALERT_URL)
    .gte("created_at", guardCutoff);
  const alreadyNotified = new Set((recent ?? []).map((r) => r.user_id));

  // Contact details so the email/SMS channels can fire once their providers
  // are configured (same pattern as proAlerts.ts).
  const { data: users } = await supabase
    .from("users")
    .select("id, email, phone, sms_consent")
    .in(
      "id",
      memberContractors.map((c) => c.user_id)
    );
  const userById = new Map((users ?? []).map((u) => [u.id, u]));

  let checked = 0;
  let notified = 0;

  for (const batch of chunk(memberContractors, SEND_CHUNK)) {
    await Promise.all(
      batch.map(async (contractor) => {
        try {
          checked += 1;
          if (alreadyNotified.has(contractor.user_id)) return;

          // Null categories means "takes anything", matching open_jobs_for_me().
          const cats: string[] | null = contractor.categories;
          const deals = openJobs.filter(
            (j) =>
              (cats === null || cats.includes(j.category)) &&
              !applicantsByJob.get(j.id)?.has(contractor.id)
          );
          if (deals.length === 0) return;

          const label = offLabel(deals.map((d) => d.off));
          const body =
            deals.length === 1
              ? `1 job in your trades is now ${label} to apply.`
              : `${deals.length} jobs in your trades are now ${label} to apply.`;

          const contact = userById.get(contractor.user_id);
          const sent = await sendNotification(supabase, {
            userId: contractor.user_id,
            kind: ALERT_KIND,
            title: ALERT_TITLE,
            body,
            url: ALERT_URL,
            email: contact?.email ?? null,
            phone: contact?.phone ?? null,
            smsConsent: contact?.sms_consent === true,
          });
          if (sent) notified += 1;
        } catch {
          // One bad member shouldn't stop the rest of the batch.
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
