import { timingSafeEqual } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendNotification } from "@/lib/notify";
import { AGING_LEAD_TIERS } from "@/lib/leadPricing";
import { MAX_APPLICANTS_PER_JOB,
  PRO_LEADS_HREF,
} from "@/lib/constants";

export const runtime = "nodejs";

// Weekly job (Vercel Cron, see vercel.json) that sends every contractor, free
// and member alike, one short business brief. This started as a pure trade
// activity digest (jobs posted in their categories, pending applications,
// aging discounts) and now folds in the rest of a pro's weekly picture, so a
// pro gets a single weekly notification instead of several competing ones:
//
//   1. Follow ups: pro_clients rows (src/app/pro/crm) whose follow_up_on is
//      today or earlier, with up to 2 client names.
//   2. Pipeline pulse: applications submitted and jobs won in the last 7
//      days, from the same lead_applications and contractor_leads tables
//      /pro/business reads, plus the original jobs posted, pending
//      application, and aging deal counts.
//   3. Renewals: license_expires and insurance_expires on contractors
//      (migration 0051, added by a separate change) expiring within 30 days.
//      Queried defensively: if those columns do not exist yet on this
//      database, the section is skipped cleanly rather than failing the run.
//
// The notification leads with whichever section is most urgent (a client
// waiting on a follow up beats a renewal beats plain trade numbers), links to
// the matching page, and is skipped entirely when a contractor has nothing to
// report: silence beats noise.
//
// Dedupe: one brief per contractor per ISO week. The week key (e.g. "2026-
// W27") rides as a query param on the notification url, and a brief whose url
// already carries this week's key for that contractor is never sent twice,
// the same existing-notification-lookup pattern the other crons use, just
// keyed to the calendar week instead of a rolling time window so an
// early or late cron run can never suppress or duplicate a real week's brief.

const MAX_CONTRACTORS = 1000; // cap the work a single run does
const MAX_JOBS = 2000; // sanity cap on each job scan
const MAX_ROWS_PER_CHUNK = 5000; // sanity cap on each per-chunk bulk read
const DAY_MS = 24 * 60 * 60 * 1000;

// PostgREST caps every response at its max-rows setting (1000 in
// supabase/config.toml), silently, regardless of a larger .limit(). So any
// scan whose cap exceeds that (MAX_JOBS, MAX_ROWS_PER_CHUNK) pages with
// .range() in cap-sized steps via fetchPaged() below instead of a single
// over-cap .limit() that would quietly undercount.
const PAGE_SIZE = 1000;

const DIGEST_WINDOW_MS = 7 * DAY_MS;
const RENEWAL_WINDOW_DAYS = 30;

const DIGEST_KIND = "weekly_digest";

// Keep .in() lists and Promise.all fan-out bounded.
const QUERY_CHUNK = 200;
const SEND_CHUNK = 20;

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

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// Drains a query past the PostgREST max-rows cap by paging with .range() in
// PAGE_SIZE steps, up to maxRows total. Callers MUST order deterministically
// (with an id tiebreak) so pages never skip or repeat rows; a short page
// means the result set is exhausted.
async function fetchPaged<T>(
  maxRows: number,
  page: (
    from: number,
    to: number
  ) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>
): Promise<{ rows: T[]; error: string | null }> {
  const rows: T[] = [];
  for (let from = 0; from < maxRows; from += PAGE_SIZE) {
    const to = Math.min(from + PAGE_SIZE, maxRows) - 1;
    const { data, error } = await page(from, to);
    if (error) return { rows, error: error.message };
    rows.push(...(data ?? []));
    if (!data || data.length < to - from + 1) break;
  }
  return { rows, error: null };
}

function plural(n: number, word: string): string {
  return n === 1 ? `${n} ${word}` : `${n} ${word}s`;
}

// ISO 8601 week key, e.g. "2026-W27". Used only as a stable per-week dedupe
// key on the notification url, never shown to the pro.
function isoWeekKey(d: Date): string {
  const date = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
  );
  const dayNum = (date.getUTCDay() + 6) % 7; // Monday = 0 .. Sunday = 6
  date.setUTCDate(date.getUTCDate() - dayNum + 3); // nearest Thursday
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const firstDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3);
  const week =
    1 +
    Math.round((date.getTime() - firstThursday.getTime()) / (7 * DAY_MS));
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

// Whole days between today and a plain YYYY-MM-DD date column, timezone safe
// (never Date-parse a bare date string on its own, which JS treats as UTC and
// can shift a day once local math gets involved), same approach as the
// insurance-renewal cron. Both sides of the subtraction are UTC midnights:
// the caller passes today's UTC midnight, NOT the raw run instant, otherwise
// a 13:00 UTC run rounds an expires-today date to -1 ("expired 1 day ago"
// while the document is still valid) and shifts every clause a day early.
function daysUntil(dateStr: string, todayUtcMs: number): number {
  const target = new Date(`${dateStr}T00:00:00Z`).getTime();
  return Math.round((target - todayUtcMs) / DAY_MS);
}

function renewalClause(label: string, days: number): string {
  if (days < 0) return `Your ${label} expired ${plural(Math.abs(days), "day")} ago.`;
  if (days === 0) return `Your ${label} expires today.`;
  return `Your ${label} expires in ${plural(days, "day")}.`;
}

async function runCron(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const supabase = createAdminClient();
  const nowMs = Date.now();
  const now = new Date(nowMs);
  // Today's UTC midnight, for date-only math against date columns (see
  // daysUntil).
  const todayMs = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate()
  );
  const weekKey = isoWeekKey(now);

  // Everyone with a pro profile gets the brief, free and member alike.
  // Oldest first so the recipient set stays stable when a run hits the cap.
  const { data: rawContractors, error: contractorsError } = await supabase
    .from("contractors")
    .select("id, user_id, categories")
    .order("created_at", { ascending: true })
    .limit(MAX_CONTRACTORS);
  if (contractorsError) {
    return NextResponse.json(
      { checked: 0, notified: 0, error: contractorsError.message },
      { status: 200 }
    );
  }
  const contractors = (rawContractors ?? []).filter(
    (c): c is typeof c & { user_id: string } => Boolean(c.user_id)
  );
  if (contractors.length === 0) {
    return NextResponse.json({ checked: 0, notified: 0 });
  }
  const contractorIds = contractors.map((c) => c.id);

  // ---- Pipeline pulse: jobs posted in their categories -----------------------
  // Jobs posted in the last 7 days (any status: "posted" is the fact being
  // reported; openness is checked separately below).
  const weekCutoff = new Date(nowMs - DIGEST_WINDOW_MS).toISOString();
  const { rows: recentJobs, error: jobsError } = await fetchPaged(
    MAX_JOBS,
    (from, to) =>
      supabase
        .from("contractor_leads")
        .select("id, category, status, contractor_id")
        .gte("created_at", weekCutoff)
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to)
  );
  if (jobsError) {
    return NextResponse.json(
      { checked: 0, notified: 0, error: jobsError },
      { status: 200 }
    );
  }

  // Open jobs old enough for an aging markdown (3+ days per AGING_LEAD_TIERS).
  // The fee math itself lives in lead_fee_cents(); age is all that gates it.
  const minAgingDays = Math.min(...AGING_LEAD_TIERS.map((t) => t.days));
  const agingCutoff = new Date(nowMs - minAgingDays * DAY_MS).toISOString();
  const { rows: agingJobs } = await fetchPaged(MAX_JOBS, (from, to) =>
    supabase
      .from("contractor_leads")
      .select("id, category")
      .is("contractor_id", null)
      .eq("status", "new")
      .lte("created_at", agingCutoff)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, to)
  );

  // Live (non-refunded) application counts per job, so "still open" and the
  // aging-deal count both respect the applicant cap.
  const jobIds = Array.from(
    new Set([
      ...(recentJobs ?? []).map((j) => j.id),
      ...(agingJobs ?? []).map((j) => j.id),
    ])
  );
  const liveAppsByJob = new Map<string, number>();
  for (const ids of chunk(jobIds, QUERY_CHUNK)) {
    const { data: apps } = await supabase
      .from("lead_applications")
      .select("lead_id")
      .in("lead_id", ids)
      .is("refunded_at", null);
    for (const a of apps ?? []) {
      liveAppsByJob.set(a.lead_id, (liveAppsByJob.get(a.lead_id) ?? 0) + 1);
    }
  }
  const jobHasRoom = (id: string) =>
    (liveAppsByJob.get(id) ?? 0) < MAX_APPLICANTS_PER_JOB;

  // Each contractor's pending applications (still sitting at 'applied').
  const pendingByContractor = new Map<string, number>();
  for (const ids of chunk(contractorIds, QUERY_CHUNK)) {
    const { data: pending } = await supabase
      .from("lead_applications")
      .select("contractor_id")
      .in("contractor_id", ids)
      .eq("status", "applied");
    for (const p of pending ?? []) {
      pendingByContractor.set(
        p.contractor_id,
        (pendingByContractor.get(p.contractor_id) ?? 0) + 1
      );
    }
  }

  // ---- Pipeline pulse: applications submitted and jobs won, last 7 days ------
  // Same lead_applications table /pro/business reads (via my_applications):
  // every application row this contractor created in the window, regardless
  // of its current status.
  const appsSubmittedByContractor = new Map<string, number>();
  for (const ids of chunk(contractorIds, QUERY_CHUNK)) {
    const { rows: submitted } = await fetchPaged(MAX_ROWS_PER_CHUNK, (from, to) =>
      supabase
        .from("lead_applications")
        .select("contractor_id")
        .in("contractor_id", ids)
        .gte("created_at", weekCutoff)
        .order("contractor_id", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to)
    );
    for (const s of submitted ?? []) {
      appsSubmittedByContractor.set(
        s.contractor_id,
        (appsSubmittedByContractor.get(s.contractor_id) ?? 0) + 1
      );
    }
  }

  // Same contractor_leads table /pro/business reads for "Jobs won". A job is
  // won the moment choose_applicant() stamps paid_at (migration 0005/0028),
  // which is the real win event, unlike created_at which is when the job was
  // first posted, so filtering on paid_at is what makes this "last 7 days"
  // instead of "posted in the last 7 days and happens to be won".
  const wonByContractor = new Map<string, number>();
  for (const ids of chunk(contractorIds, QUERY_CHUNK)) {
    const { rows: won } = await fetchPaged(MAX_ROWS_PER_CHUNK, (from, to) =>
      supabase
        .from("contractor_leads")
        .select("contractor_id")
        .in("contractor_id", ids)
        .gte("paid_at", weekCutoff)
        .order("contractor_id", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to)
    );
    for (const w of won ?? []) {
      if (!w.contractor_id) continue;
      wonByContractor.set(
        w.contractor_id,
        (wonByContractor.get(w.contractor_id) ?? 0) + 1
      );
    }
  }

  // ---- Follow ups: pro_clients due today or overdue --------------------------
  // Same rule /pro/crm uses for its "Follow up today" section: follow_up_on
  // at or before today's date, oldest due date first.
  const todayStr = new Date(nowMs).toISOString().slice(0, 10);
  const followUpsByContractor = new Map<
    string,
    { client_name: string; follow_up_on: string }[]
  >();
  for (const ids of chunk(contractorIds, QUERY_CHUNK)) {
    const { rows: dueClients } = await fetchPaged(MAX_ROWS_PER_CHUNK, (from, to) =>
      supabase
        .from("pro_clients")
        .select("contractor_id, client_name, follow_up_on")
        .in("contractor_id", ids)
        .not("follow_up_on", "is", null)
        .lte("follow_up_on", todayStr)
        .order("follow_up_on", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to)
    );
    for (const row of dueClients ?? []) {
      const list = followUpsByContractor.get(row.contractor_id) ?? [];
      list.push({
        client_name: row.client_name,
        follow_up_on: row.follow_up_on as string,
      });
      followUpsByContractor.set(row.contractor_id, list);
    }
  }

  // ---- Renewals: license_expires / insurance_expires, within 30 days --------
  // Migration 0051 (a separate, parallel change) adds these two columns to
  // contractors. Query them defensively: on a database where that migration
  // has not run yet, Postgres rejects the select with 42703 (undefined
  // column), and the section is skipped for this run instead of failing the
  // whole brief. Not yet in the generated types, so the query goes through a
  // cast, same pattern as insurance_renewal_date on the insurance-renewal cron.
  let renewalsAvailable = true;
  const renewalByContractor = new Map<
    string,
    { license_expires: string | null; insurance_expires: string | null }
  >();
  try {
    for (const ids of chunk(contractorIds, QUERY_CHUNK)) {
      const { data: renewalRows, error: renewalError } = await (
        supabase.from("contractors") as any
      )
        .select("id, license_expires, insurance_expires")
        .in("id", ids)
        .order("id", { ascending: true });
      if (renewalError) {
        if (renewalError.code && renewalError.code !== "42703") {
          console.error(
            "pro-weekly-digest cron: renewals query failed:",
            renewalError.message
          );
        }
        renewalsAvailable = false;
        break;
      }
      for (const row of renewalRows ?? []) {
        renewalByContractor.set(row.id, {
          license_expires: row.license_expires ?? null,
          insurance_expires: row.insurance_expires ?? null,
        });
      }
    }
  } catch {
    renewalsAvailable = false;
  }
  if (!renewalsAvailable) renewalByContractor.clear();

  // Dedupe: anyone who already has a brief for this ISO week (the "brief="
  // param on the notification url is the exact key) is skipped. A bulk
  // pre-check, chunked the same way as every other lookup here.
  const alreadyNotified = new Set<string>();
  for (const ids of chunk(
    contractors.map((c) => c.user_id),
    QUERY_CHUNK
  )) {
    const { data: recent } = await supabase
      .from("notifications")
      .select("user_id")
      .in("user_id", ids)
      .eq("kind", DIGEST_KIND)
      .like("url", `%brief=${weekKey}`)
      .order("user_id", { ascending: true });
    for (const r of recent ?? []) alreadyNotified.add(r.user_id);
  }

  // Build each pro's brief.
  let checked = 0;
  const briefs: { userId: string; title: string; body: string; url: string }[] =
    [];

  for (const contractor of contractors) {
    try {
      checked += 1;
      if (alreadyNotified.has(contractor.user_id)) continue;

      // Null categories means "takes anything", matching open_jobs_for_me().
      const cats: string[] | null = contractor.categories;
      const inTrades = (category: string) =>
        cats === null || cats.includes(category);

      const posted = (recentJobs ?? []).filter((j) => inTrades(j.category));
      const stillOpen = posted.filter(
        (j) =>
          j.contractor_id === null && j.status === "new" && jobHasRoom(j.id)
      );
      const pending = pendingByContractor.get(contractor.id) ?? 0;
      const appsSubmitted = appsSubmittedByContractor.get(contractor.id) ?? 0;
      const wonThisWeek = wonByContractor.get(contractor.id) ?? 0;
      const deals = (agingJobs ?? []).filter(
        (j) => inTrades(j.category) && jobHasRoom(j.id)
      );

      const dueClients = followUpsByContractor.get(contractor.id) ?? [];
      const followUpCount = dueClients.length;
      const followUpNames = dueClients.slice(0, 2).map((c) => c.client_name);

      const renewalInfo = renewalByContractor.get(contractor.id);
      const renewalItems: { label: string; days: number }[] = [];
      if (renewalInfo?.license_expires) {
        const d = daysUntil(renewalInfo.license_expires, todayMs);
        if (d <= RENEWAL_WINDOW_DAYS) renewalItems.push({ label: "license", days: d });
      }
      if (renewalInfo?.insurance_expires) {
        const d = daysUntil(renewalInfo.insurance_expires, todayMs);
        if (d <= RENEWAL_WINDOW_DAYS) renewalItems.push({ label: "insurance", days: d });
      }

      const pipelineParts: string[] = [];
      if (posted.length > 0) {
        pipelineParts.push(
          `${plural(posted.length, "job")} posted in your trades this week, ${
            stillOpen.length
          } still open.`
        );
      }
      if (appsSubmitted > 0) {
        pipelineParts.push(
          `You submitted ${plural(appsSubmitted, "application")} this week.`
        );
      }
      if (wonThisWeek > 0) {
        pipelineParts.push(`You won ${plural(wonThisWeek, "job")} this week.`);
      }
      if (pending > 0) {
        pipelineParts.push(`You have ${plural(pending, "pending application")}.`);
      }
      if (deals.length > 0) {
        pipelineParts.push(
          `${plural(deals.length, "open job")} in your trades ${
            deals.length === 1 ? "has" : "have"
          } a reduced apply fee right now.`
        );
      }

      // Nothing to say, nothing sent: silence beats noise.
      if (
        followUpCount === 0 &&
        renewalItems.length === 0 &&
        pipelineParts.length === 0
      ) {
        continue;
      }

      let followUpSentence: string | null = null;
      if (followUpCount === 1) {
        followUpSentence = `1 client is due for a follow up: ${followUpNames[0]}.`;
      } else if (followUpCount === 2) {
        followUpSentence = `2 clients are due for a follow up: ${followUpNames[0]} and ${followUpNames[1]}.`;
      } else if (followUpCount > 2) {
        followUpSentence = `${followUpCount} clients are due for a follow up, including ${followUpNames[0]} and ${followUpNames[1]}.`;
      }

      const renewalSentence =
        renewalItems.length > 0
          ? renewalItems.map((r) => renewalClause(r.label, r.days)).join(" ")
          : null;

      // Lead with whichever section is most urgent: a client waiting on a
      // follow up is the most actionable, a compliance renewal is next, and
      // plain trade numbers are the fallback. The link always points at the
      // page for the leading section.
      let title: string;
      let url: string;
      const parts: string[] = [];
      if (followUpSentence) {
        title = "Clients waiting on a follow up";
        url = "/pro/crm";
        parts.push(followUpSentence);
        if (renewalSentence) parts.push(renewalSentence);
      } else if (renewalSentence) {
        title = "A renewal is coming up";
        url = "/pro/business";
        parts.push(renewalSentence);
      } else {
        title = "This week in your trades";
        url = PRO_LEADS_HREF;
      }
      parts.push(...pipelineParts);

      briefs.push({
        userId: contractor.user_id,
        title,
        body: parts.join(" "),
        url: `${url}?brief=${weekKey}`,
      });
    } catch {
      // One bad contractor shouldn't stop the rest of the run.
      continue;
    }
  }

  if (briefs.length === 0) {
    return NextResponse.json({ checked, notified: 0 });
  }

  // Contact details so the email/SMS channels can fire once their providers
  // are configured (same pattern as proAlerts.ts).
  const userById = new Map<
    string,
    { id: string; email: string | null; phone: string | null; sms_consent: boolean | null }
  >();
  for (const ids of chunk(briefs.map((d) => d.userId), QUERY_CHUNK)) {
    const { data: users } = await supabase
      .from("users")
      .select("id, email, phone, sms_consent")
      .in("id", ids);
    for (const u of users ?? []) userById.set(u.id, u);
  }

  // Send in bounded parallel batches.
  let notified = 0;
  for (const batch of chunk(briefs, SEND_CHUNK)) {
    await Promise.all(
      batch.map(async (d) => {
        try {
          const contact = userById.get(d.userId);
          const sent = await sendNotification(supabase, {
            userId: d.userId,
            kind: DIGEST_KIND,
            title: d.title,
            body: d.body,
            url: d.url,
            email: contact?.email ?? null,
            phone: contact?.phone ?? null,
            smsConsent: contact?.sms_consent === true,
          });
          if (sent) notified += 1;
        } catch {
          // One failed send shouldn't stop the rest of the batch.
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
