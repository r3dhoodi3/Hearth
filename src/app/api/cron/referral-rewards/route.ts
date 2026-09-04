import { timingSafeEqual } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendNotification } from "@/lib/notify";
import { isMissingSchemaError } from "@/lib/dbErrors";

export const runtime = "nodejs";

// Daily job (Vercel Cron, see vercel.json) behind the pro-refers-pro program:
// when a referred pro CLOSES their first PAID job (contractor_leads.status =
// 'closed', a real fee actually paid - not refunded, not waived, not a $0
// rehire), and 21 days have passed since it closed, both the referred pro and
// their referrer get $25 of 90-day expiring application credit (never cash).
//
// All the money logic lives in the grant_referral_rewards() DB function
// (migration 0044, tightened by 0084's sybil guard and 0088's closed-deal +
// 21-day-hold gate), which re-checks every rule atomically (real attribution,
// not self, a real closed and paid deal past its hold, once per referred pro
// ever, referrer capped at 10 rewarded referrals per calendar year and a $500
// lifetime ceiling) behind FOR UPDATE locks on both wallets. This route only
// finds rough candidates, calls the function per referred contractor, and
// notifies both parties on each success, so re-runs and overlapping runs are
// safe and nobody is ever credited twice.

const MAX_GRANTS = 100; // cap the RPC calls (and money) per run
const MAX_SCAN = 500; // sanity cap on the candidate scan
const QUERY_CHUNK = 200; // keep .in() lists bounded
const REFERRAL_HOLD_DAYS = 21; // keep in sync with 0088's v_hold

const REWARD_KIND = "referral_reward";
const REWARD_URL = "/pro/billing";

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

type Candidate = {
  id: string;
  user_id: string | null;
  referred_by: string;
};

async function runCron(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const supabase = createAdminClient();

  // Rough candidates: every contractor with a referral attribution. The
  // referred_by column arrives with migration 0044; if it isn't there yet,
  // log and report cleanly instead of crashing the run.
  const { data: rawContractors, error: scanError } = await (supabase as any)
    .from("contractors")
    .select("id, user_id, referred_by")
    .not("referred_by", "is", null)
    .order("created_at", { ascending: true })
    .limit(MAX_SCAN);
  if (scanError) {
    console.error("referral-rewards scan failed:", scanError.message);
    return NextResponse.json(
      { checked: 0, granted: 0, error: scanError.message },
      { status: 200 }
    );
  }
  let candidates = (rawContractors ?? []) as Candidate[];
  candidates = candidates.filter((c) => c.referred_by && c.referred_by !== c.id);
  if (candidates.length === 0) {
    return NextResponse.json({ checked: 0, granted: 0 });
  }

  // Closed-deal filter: the reward now fires only on a real, closed, paid
  // deal past its 21-day hold, not merely a "win". This is an
  // over-approximation ONLY - the DB function (grant_referral_rewards) is the
  // sole authority and re-checks every rule (fee actually paid, not
  // refunded/waived, payout_amount > 0, the hold itself) atomically behind
  // wallet locks. This filter must never MISS a contractor who will actually
  // qualify; passing through some who won't is fine and expected.
  const candidateIds = candidates.map((c) => c.id);
  const holdCutoffIso = new Date(
    Date.now() - REFERRAL_HOLD_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();
  const closedDealContractors = new Set<string>();
  let closedAtAvailable = true;
  for (const ids of chunk(candidateIds, QUERY_CHUNK)) {
    // closed_at (0088) isn't in the hand-maintained database.types.ts, same
    // as referred_by above - go through a cast rather than widen the shared
    // Database type just for this one column.
    const { data: closedLeads, error: closedError } = await (
      supabase.from("contractor_leads") as any
    )
      .select("contractor_id")
      .in("contractor_id", ids)
      .eq("status", "closed")
      .not("closed_at", "is", null)
      .lte("closed_at", holdCutoffIso);
    if (closedError) {
      if (isMissingSchemaError(closedError)) {
        // Pre-0088 DB: closed_at doesn't exist yet. Fall back to treating
        // every candidate as a rough winner - the RPC still decides, so this
        // only widens the (harmless) over-approximation, never narrows it.
        console.error(
          "referral-rewards: closed_at not available yet (pre-0088 DB), falling back to all candidates:",
          closedError.message
        );
        closedAtAvailable = false;
        break;
      }
      // Any other error (transient network/DB hiccup, timeout, etc.): the RPC
      // is the sole authority on whether a candidate actually qualifies, so a
      // pre-filter must never NARROW the candidate set just because one of
      // its own queries failed. Treat this chunk's contractors as rough
      // winners too, same fail-open contract as the missing-schema branch
      // above, rather than silently dropping them from the run.
      console.error(
        "referral-rewards: closed-deal query failed, treating chunk as rough winners:",
        closedError.message
      );
      for (const id of ids) closedDealContractors.add(id);
      continue;
    }
    for (const l of closedLeads ?? []) {
      if (l.contractor_id) closedDealContractors.add(l.contractor_id);
    }
  }
  candidates = closedAtAvailable
    ? candidates.filter((c) => closedDealContractors.has(c.id))
    : candidates;

  // Already-rewarded filter: a referral_reward ledger row on the referred
  // pro's wallet means this referral was already paid out. Cheap pre-filter
  // only; the DB function is still the authority behind its wallet locks.
  const walletByContractor = new Map<string, string>();
  for (const ids of chunk(
    candidates.map((c) => c.id),
    QUERY_CHUNK
  )) {
    const { data: wallets } = await supabase
      .from("wallets")
      .select("id, contractor_id")
      .in("contractor_id", ids);
    for (const w of wallets ?? []) walletByContractor.set(w.contractor_id, w.id);
  }
  const rewardedWallets = new Set<string>();
  for (const ids of chunk(
    Array.from(walletByContractor.values()),
    QUERY_CHUNK
  )) {
    const { data: prior } = await supabase
      .from("wallet_transactions")
      .select("wallet_id")
      .in("wallet_id", ids)
      .eq("type", REWARD_KIND);
    for (const p of prior ?? []) rewardedWallets.add(p.wallet_id);
  }
  candidates = candidates.filter((c) => {
    const wallet = walletByContractor.get(c.id);
    return !wallet || !rewardedWallets.has(wallet);
  });

  // Resolve the referrers' users, then contact details for both parties, so
  // the notifications (and dormant email/SMS channels) can address them.
  const referrerUserById = new Map<string, string | null>();
  for (const ids of chunk(
    Array.from(new Set(candidates.map((c) => c.referred_by))),
    QUERY_CHUNK
  )) {
    const { data: referrers } = await supabase
      .from("contractors")
      .select("id, user_id")
      .in("id", ids);
    for (const r of referrers ?? []) referrerUserById.set(r.id, r.user_id);
  }
  const allUserIds = Array.from(
    new Set(
      [
        ...candidates.map((c) => c.user_id),
        ...Array.from(referrerUserById.values()),
      ].filter((u): u is string => Boolean(u))
    )
  );
  const userById = new Map<
    string,
    { id: string; email: string | null; phone: string | null; sms_consent: boolean | null }
  >();
  for (const ids of chunk(allUserIds, QUERY_CHUNK)) {
    const { data: users } = await supabase
      .from("users")
      .select("id, email, phone, sms_consent")
      .in("id", ids);
    for (const u of users ?? []) userById.set(u.id, u);
  }

  let checked = 0;
  let granted = 0;

  for (const candidate of candidates.slice(0, MAX_GRANTS)) {
    try {
      checked += 1;

      // The DB function is the authority: false means not actually eligible
      // (or already granted), and a missing migration just logs and moves on.
      let ok: unknown = null;
      try {
        const { data, error } = await (supabase as any).rpc(
          "grant_referral_rewards",
          { p_referred: candidate.id }
        );
        if (error) {
          console.error("grant_referral_rewards failed:", error.message);
          continue;
        }
        ok = data;
      } catch (e) {
        console.error("grant_referral_rewards unavailable:", e);
        continue;
      }
      if (ok !== true) continue;
      granted += 1;

      // Tell both parties. Best-effort: the credits are already committed,
      // and a notification hiccup must not stop the run.
      if (candidate.user_id) {
        const contact = userById.get(candidate.user_id);
        await sendNotification(supabase, {
          userId: candidate.user_id,
          kind: REWARD_KIND,
          title: "You earned $25 of application credit",
          body: "You completed your first job on OakTend, so $25 of application credit was added to your wallet as a referral bonus. It works on any application and expires in 90 days.",
          url: REWARD_URL,
          email: contact?.email ?? null,
          phone: contact?.phone ?? null,
          smsConsent: contact?.sms_consent === true,
        });
      }
      const referrerUserId = referrerUserById.get(candidate.referred_by);
      if (referrerUserId) {
        const contact = userById.get(referrerUserId);
        await sendNotification(supabase, {
          userId: referrerUserId,
          kind: REWARD_KIND,
          title: "Your referral earned you $25 of credit",
          body: "A pro you referred completed their first job on OakTend, so $25 of application credit was added to your wallet. It works on any application and expires in 90 days.",
          url: REWARD_URL,
          email: contact?.email ?? null,
          phone: contact?.phone ?? null,
          smsConsent: contact?.sms_consent === true,
        });
      }
    } catch {
      // One bad candidate shouldn't stop the rest of the run.
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
