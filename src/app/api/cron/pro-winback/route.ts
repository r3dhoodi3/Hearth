import { PRO_LEADS_HREF } from "@/lib/constants";
import { timingSafeEqual } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendNotification } from "@/lib/notify";

export const runtime = "nodejs";

// Daily job (Vercel Cron, see vercel.json) that gives stalled pros a real
// reason to come back: a one-time $15 expiring bonus credit. A pro qualifies
// when they (a) onboarded 14+ days ago and have never applied to any job, or
// (b) sit at a zero wallet balance (cash and bonus both 0) with no application
// in 30+ days.
//
// All the money logic lives in the grant_winback_credit() DB function
// (migration 0038), which re-checks eligibility atomically and is
// once-per-contractor-EVER by construction: any existing 'winback_credit'
// ledger row on the wallet makes a repeat call a no-op that returns false.
// This route's bulk scan is only a cheap pre-filter; each surviving candidate
// gets an exact per-contractor verification right before the RPC, then calls
// the function and notifies on each success, so re-runs and overlapping runs
// are safe, and nobody is ever credited twice.

const NEVER_APPLIED_DAYS = 14;
const QUIET_DAYS = 30;
const MAX_GRANTS = 200; // cap the money a single run hands out
const MAX_CONTRACTORS = 2000; // sanity cap on the candidate scan
// PostgREST silently truncates any single response at its max-rows cap
// (default 1000), so the candidate scan below pages in steps of this size
// instead of asking for MAX_CONTRACTORS in one .limit() call, which used to
// mean every contractor past row 1000 was silently never scanned.
const CONTRACTOR_PAGE = 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

const CREDIT_KIND = "winback_credit";
const CREDIT_URL = PRO_LEADS_HREF;
const CREDIT_TITLE = "$15 of application credit added";
const CREDIT_BODY =
  "We added $15 of application credit to your wallet. It covers most of a first application fee and expires in 14 days.";

// PostgREST silently truncates every response at its max-rows cap (default
// 1000 rows), so an unbounded .in() fetch can quietly drop rows. Chunks of 50
// keep each bulk fetch's realistic worst case under the cap, and explicit
// .order() makes any residual truncation deterministic instead of arbitrary.
// No money decision rests on these bulk reads: each candidate is re-verified
// with exact single-contractor queries before the RPC, and the DB function
// re-checks everything again atomically.
const QUERY_CHUNK = 50;

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

async function runCron(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const supabase = createAdminClient();
  const nowMs = Date.now();
  const neverAppliedCutoff = nowMs - NEVER_APPLIED_DAYS * DAY_MS;
  const quietCutoff = nowMs - QUIET_DAYS * DAY_MS;

  // Rough candidates: every contractor with a login, oldest first so the same
  // pros aren't perpetually pushed past the cap by newer signups. Paged in
  // CONTRACTOR_PAGE steps (see its comment) up to MAX_CONTRACTORS so the
  // scan actually reaches every contractor instead of silently stopping at
  // PostgREST's 1000-row response cap.
  const rawContractors: { id: string; user_id: string | null; created_at: string }[] = [];
  for (let start = 0; start < MAX_CONTRACTORS; start += CONTRACTOR_PAGE) {
    const end = Math.min(start + CONTRACTOR_PAGE, MAX_CONTRACTORS) - 1;
    const { data: page, error: contractorsError } = await supabase
      .from("contractors")
      .select("id, user_id, created_at")
      .order("created_at", { ascending: true })
      .range(start, end);
    if (contractorsError) {
      return NextResponse.json(
        { checked: 0, granted: 0, error: contractorsError.message },
        { status: 200 }
      );
    }
    rawContractors.push(...(page ?? []));
    if (!page || page.length < end - start + 1) break;
  }
  const contractors = rawContractors.filter(
    (c): c is typeof c & { user_id: string } => Boolean(c.user_id)
  );
  if (contractors.length === 0) {
    return NextResponse.json({ checked: 0, granted: 0 });
  }
  const contractorIds = contractors.map((c) => c.id);

  // Latest application per contractor (any status: applying at all counts as
  // activity, refunded or not). Newest first: if the row cap still truncates,
  // the drop makes pros LOOK quieter (more candidates), and the exact
  // per-candidate check below catches every false positive.
  const lastAppliedAt = new Map<string, number>();
  for (const ids of chunk(contractorIds, QUERY_CHUNK)) {
    const { data: apps } = await supabase
      .from("lead_applications")
      .select("contractor_id, created_at")
      .in("contractor_id", ids)
      .order("created_at", { ascending: false });
    for (const a of apps ?? []) {
      const at = new Date(a.created_at).getTime();
      const prev = lastAppliedAt.get(a.contractor_id);
      if (prev === undefined || at > prev) lastAppliedAt.set(a.contractor_id, at);
    }
  }

  // Wallet balances. A contractor with no wallet row yet has never deposited,
  // so they count as a zero balance.
  const balanceByContractor = new Map<string, number>();
  for (const ids of chunk(contractorIds, QUERY_CHUNK)) {
    const { data: wallets } = await supabase
      .from("wallets")
      .select("contractor_id, cash_balance_cents, bonus_balance_cents")
      .in("contractor_id", ids)
      .order("contractor_id", { ascending: true });
    for (const w of wallets ?? []) {
      balanceByContractor.set(
        w.contractor_id,
        Number(w.cash_balance_cents) + Number(w.bonus_balance_cents)
      );
    }
  }

  // Cheap pre-filter: anyone we already told about this credit was already
  // granted it (the notification only fires on a successful grant), so skip
  // the RPC round-trip. The DB function stays the authority either way.
  const alreadyCredited = new Set<string>();
  for (const ids of chunk(contractors.map((c) => c.user_id), QUERY_CHUNK)) {
    const { data: prior } = await supabase
      .from("notifications")
      .select("user_id")
      .in("user_id", ids)
      .eq("kind", CREDIT_KIND)
      .order("created_at", { ascending: false });
    for (const p of prior ?? []) alreadyCredited.add(p.user_id);
  }

  // Contact details so the email/SMS channels can fire once their providers
  // are configured (same pattern as proAlerts.ts).
  const userById = new Map<
    string,
    { id: string; email: string | null; phone: string | null; sms_consent: boolean | null }
  >();
  for (const ids of chunk(contractors.map((c) => c.user_id), QUERY_CHUNK)) {
    const { data: users } = await supabase
      .from("users")
      .select("id, email, phone, sms_consent")
      .in("id", ids)
      .order("id", { ascending: true });
    for (const u of users ?? []) userById.set(u.id, u);
  }

  let checked = 0;
  let granted = 0;

  for (const contractor of contractors) {
    if (granted >= MAX_GRANTS) break;
    try {
      checked += 1;
      if (alreadyCredited.has(contractor.user_id)) continue;

      const onboardedAt = new Date(contractor.created_at).getTime();
      const lastApplied = lastAppliedAt.get(contractor.id);

      // (a) Onboarded 14+ days ago, never applied to any job.
      const neverGotGoing =
        lastApplied === undefined && onboardedAt <= neverAppliedCutoff;

      // (b) Zero wallet balance and quiet for 30+ days. "Quiet" means their
      // last sign of life (most recent application, or onboarding if they
      // never applied) is 30+ days back, so a brand-new signup with an
      // (obviously) empty wallet doesn't trip this arm on day one.
      const lastActivity = Math.max(onboardedAt, lastApplied ?? 0);
      const brokeAndQuiet =
        (balanceByContractor.get(contractor.id) ?? 0) === 0 &&
        lastActivity <= quietCutoff;

      if (!neverGotGoing && !brokeAndQuiet) continue;

      // Exact per-candidate verification, right before money moves. The bulk
      // maps above can be silently truncated at the PostgREST row cap, so
      // re-derive both arms from exact single-contractor lookups (only
      // candidates pay these two cheap queries). The DB function re-checks
      // everything again atomically; this keeps the RPC calls honest.
      const { data: newestApp } = await supabase
        .from("lead_applications")
        .select("created_at")
        .eq("contractor_id", contractor.id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      const { data: wallet } = await supabase
        .from("wallets")
        .select("cash_balance_cents, bonus_balance_cents")
        .eq("contractor_id", contractor.id)
        .limit(1)
        .maybeSingle();
      const exactLastApplied = newestApp
        ? new Date(newestApp.created_at).getTime()
        : undefined;
      const exactBalance = wallet
        ? Number(wallet.cash_balance_cents) + Number(wallet.bonus_balance_cents)
        : 0;
      const exactNeverGotGoing =
        exactLastApplied === undefined && onboardedAt <= neverAppliedCutoff;
      const exactLastActivity = Math.max(onboardedAt, exactLastApplied ?? 0);
      const exactBrokeAndQuiet =
        exactBalance === 0 && exactLastActivity <= quietCutoff;
      if (!exactNeverGotGoing && !exactBrokeAndQuiet) continue;

      // The DB function is the once-ever guard: false means already granted
      // (or an unknown contractor), and a missing migration just logs.
      let ok: unknown = null;
      try {
        const { data, error } = await (supabase as any).rpc(
          "grant_winback_credit",
          { p_contractor: contractor.id }
        );
        if (error) {
          console.error("grant_winback_credit failed:", error.message);
          continue;
        }
        ok = data;
      } catch (e) {
        console.error("grant_winback_credit unavailable:", e);
        continue;
      }
      if (ok !== true) continue;
      granted += 1;

      // Tell the pro. Best-effort: the credit itself is already committed,
      // and a notification hiccup must not stop the run.
      const contact = userById.get(contractor.user_id);
      await sendNotification(supabase, {
        userId: contractor.user_id,
        kind: CREDIT_KIND,
        title: CREDIT_TITLE,
        body: CREDIT_BODY,
        url: CREDIT_URL,
        email: contact?.email ?? null,
        phone: contact?.phone ?? null,
        smsConsent: contact?.sms_consent === true,
      });
    } catch {
      // One bad contractor shouldn't stop the rest of the run.
      continue;
    }
  }

  return NextResponse.json({ checked, granted });
}

export async function POST(req: NextRequest) {
  return runCron(req);
}

export async function GET(req: NextRequest) {
  return runCron(req);
}
