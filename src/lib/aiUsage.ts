import { createAdminClient } from "@/lib/supabase/admin";
import { AI_GLOBAL_DAILY_LIMIT, AI_GLOBAL_BUCKET } from "@/lib/constants";
import { trackServerEvent } from "@/lib/trackServer";

// Shared per-user daily cap for the AI-backed TOOL routes (analyze-quote,
// extract-document, ingest-inspection, insurance-packet, tax-appeal, the pro
// tools), counted in the ai_usage table (migration 0024) so every route that
// touches the paid model shares one daily budget instead of each being its
// own side door around the abuse limits.
//
// These are the tool budgets, not the chat budget. The homeowner chat has its
// own, much tighter bucket below (ASK_DAILY_FREE / ASK_DAILY_PLUS): a free
// homeowner gets three chat questions a day, and that allowance must not be
// spendable on document scans, nor drained by them.
export const DAILY_LIMIT_FREE = 25;
export const DAILY_LIMIT_PLUS = 250;
// The trial's tool budget IS the paid one. An alias, not a copied number, so
// the two cannot drift apart later. See ASK_DAILY_TRIAL below for why parity
// was chosen over a smaller trial ceiling.
export const DAILY_LIMIT_TRIAL = DAILY_LIMIT_PLUS;

// The homeowner chat's OWN daily bucket. Free is a taste, not a product:
// three text questions a day, no photos (the vision calls are the expensive
// ones). Plus gets more, with photos.
export const ASK_DAILY_FREE = 3;
export const ASK_DAILY_PLUS = 15;
// The trial gets the SAME ceiling as a paid plan, as an alias so the two can
// never drift. The trial can run on any cadence, and the owner's rule is that
// weekly, monthly, and annual include exactly the same things: a smaller trial
// number made a trialing member a lesser member, and someone who paid for
// a week of Plus was getting less Plus than someone who paid for a month.
// The trade-off, kept here so a future reader knows it was a choice: a trial
// costs nothing to start and nothing to start again from a fresh email, so full
// parity does let a throwaway account farm a paid day of vision calls. The
// burst limits, the global bucket below, and the per-account trial eligibility
// check are what hold that line now. MIRRORED by TRIAL_ASK_PER_DAY in
// src/lib/constants.ts (which the client-side /plus card reads), and
// src/lib/constants.test.ts fails if the two ever drift.
export const ASK_DAILY_TRIAL = ASK_DAILY_PLUS;

// The PRO copilot's ceiling for a paying Hearth Pro member (and a Pro trial:
// same rule the homeowner trial follows, parity with paid). A free pro is on
// ASK_DAILY_FREE, exactly like a free homeowner - the copilot used to run on
// the tool budget (DAILY_LIMIT_FREE, 25 a day), which is the document-scan
// allowance and far too generous for a chat.
//
// A few more than Plus's 15, because a pro is asking about their own business
// during a working day, not about their house on a weekend.
export const ASK_DAILY_PRO = 20;

// Which chat this is. The two surfaces have different ceilings AND their own
// counters (see askBucket): a dual-side account is one person, but their
// homeowner questions must not eat the pro copilot's allowance, or a Pro member
// would be told they were out of questions after three asks on the other side.
export type AskSurface = "homeowner" | "pro";

// Which allowance a caller gets. Not the same question as hasPlus(): see
// PlusTier in src/lib/subscription.ts, which is where these strings come from.
// Declared here rather than imported so this module keeps its short dependency
// list (subscription.ts pulls in Stripe and the request-scoped Supabase
// client, neither of which a counter should need).
export type AiTier = "free" | "trialing" | "paid";

// Callers that already know the tier pass it straight in. The older boolean
// call sites (every pro-side route, which has its own membership and its own
// trial) keep their exact meaning: true was always "the Plus ceiling".
export function toAiTier(plan: AiTier | boolean): AiTier {
  if (plan === true) return "paid";
  if (plan === false) return "free";
  return plan;
}

// The two ceilings, as pure functions of the tier, so the three-way resolution
// is testable without a database.
export function askDailyLimitFor(
  tier: AiTier,
  surface: AskSurface = "homeowner"
): number {
  // The pro copilot: free is the same taste a free homeowner gets, and both
  // paid and trialing Pro get ASK_DAILY_PRO (the trial is not a lesser plan).
  if (surface === "pro") {
    return tier === "free" ? ASK_DAILY_FREE : ASK_DAILY_PRO;
  }
  if (tier === "paid") return ASK_DAILY_PLUS;
  if (tier === "trialing") return ASK_DAILY_TRIAL;
  return ASK_DAILY_FREE;
}

export function toolDailyLimitFor(tier: AiTier): number {
  if (tier === "paid") return DAILY_LIMIT_PLUS;
  if (tier === "trialing") return DAILY_LIMIT_TRIAL;
  return DAILY_LIMIT_FREE;
}

// Burst limits, on top of the daily cap. The daily cap alone still lets a
// script fire its whole allowance in two seconds, and the global bucket below
// is the only thing standing between a bot swarm and an unbounded Gemini bill.
export const AI_BURST_LIMIT = 6; // requests per user
export const AI_BURST_WINDOW_SECONDS = 60;
// The TOOL routes' burst limit, separate from the chat's. A document scan or
// a packet build is a much heavier call than a chat turn and nobody makes ten
// of them a minute by hand, so the window is wider and the ceiling lower in
// per-second terms. It uses its OWN bucket, never the chat's: rate_limits is
// keyed by (bucket, window_start), so two different window SIZES on one
// bucket would sometimes floor to the same row and enforce whichever limit
// happened to be passed in first.
export const AI_TOOL_BURST_LIMIT = 10;
export const AI_TOOL_BURST_WINDOW_SECONDS = 300;
export const AI_GLOBAL_HOURLY_LIMIT = 1500; // requests across ALL users
export const AI_GLOBAL_HOUR_BUCKET = "ai-global-hour";

// WHY a refusal carries a reason.
//
// All three of these used to come back as one undifferentiated `overLimit`,
// and the chat then told everyone the same thing: "you've used your 3 free
// questions, Hearth Plus gives you more". That sentence is a lie in two of
// the three cases. A tripped owner-wide breaker is Hearth's ceiling, not the
// homeowner's, and a broken counter is a bug: neither is fixed by buying
// anything, and pitching Plus to someone whose allowance is untouched is the
// kind of thing people screenshot.
//
//  - "user_daily"           this person spent their own allowance today
//  - "user_burst"           this person is firing requests faster than a human
//  - "global"               an owner-wide spend breaker or ceiling tripped
//  - "counter_unavailable"  the counter itself failed, so we denied to be safe
//
// The first two are real limits the person hit; the last two are Hearth's own
// ceilings and Hearth's own bugs, and must never be worded as "you are out".
export type AiLimitReason =
  | "user_daily"
  | "user_burst"
  | "global"
  | "counter_unavailable";

// Count one usage for this user today and report whether they are now over
// their daily cap. Counted via the service-role client through the atomic
// bump_ai_usage RPC (migration 0070), so parallel requests can't race each
// other into overwriting the same row and fanning out past the cap.
//
// Fails CLOSED: if the counter is broken (e.g. the RPC or table is missing),
// every AI route is a paid side door, so a broken counter must block rather
// than silently grant unlimited access. It logs loudly and treats the caller
// as over-limit. Migration 0070 MUST be applied before this code runs, or all
// AI routes go dark.
// `remaining` is how many of today's questions are left AFTER this one, or
// null when the counter could not be read. It exists purely so a caller can
// quietly show someone where they stand near the end of their allowance,
// instead of letting the wall arrive with no warning. Nothing gates on it.
export async function countAiUsage(
  userId: string,
  // Tier or the older boolean (see toAiTier). A trialing caller gets
  // DAILY_LIMIT_TRIAL rather than the full paid ceiling.
  plan: AiTier | boolean,
  // The two chat routes run these same two checks themselves, in their own
  // order and with their own copy, so they opt out here rather than being
  // counted twice. Every other caller gets them for free, which is the point:
  // the eleven tool routes each had a daily cap and NOTHING else, so a script
  // could fire a document scan every 200ms all day and never touch a burst
  // limit or the owner-wide hourly ceiling.
  opts?: { burst?: boolean; hourly?: boolean }
): Promise<{
  overLimit: boolean;
  reason: AiLimitReason | null;
  remaining: number | null;
  dailyLimit: number;
}> {
  const tier = toAiTier(plan);
  const isPlus = tier !== "free";
  const dailyLimit = toolDailyLimitFor(tier);
  const admin = createAdminClient();
  let remaining: number | null = null;

  // BURST first: it is the cheapest check and the one an automated caller
  // trips first, and failing here must not spend anything else.
  if (opts?.burst !== false) {
    const { overLimit: overBurst } = await countAiUsageWindow(
      userId,
      AI_TOOL_BURST_WINDOW_SECONDS,
      AI_TOOL_BURST_LIMIT,
      "ai-tool-burst"
    );
    if (overBurst) {
      return {
        overLimit: true,
        reason: "user_burst",
        remaining: null,
        dailyLimit,
      };
    }
  }

  // Per-user daily cap (unchanged). Fails CLOSED, same as before.
  try {
    const { data, error } = await admin.rpc("bump_ai_usage", {
      p_user: userId,
      p_delta: 1,
    });
    if (error) throw error;
    const used = data as number;
    remaining = Math.max(0, dailyLimit - used);
    if (used > dailyLimit)
      return {
        overLimit: true,
        reason: "user_daily",
        remaining: 0,
        dailyLimit,
      };
  } catch (err) {
    console.error("bump_ai_usage failed - failing CLOSED:", err);
    return {
      overLimit: true,
      reason: "counter_unavailable",
      remaining: null,
      dailyLimit,
    };
  }

  // Owner-wide daily SPEND BREAKER, on top of the per-user cap above. One
  // shared bucket across EVERY user (AI_GLOBAL_BUCKET), so no number of free
  // signups can fan the paid Gemini bill past AI_GLOBAL_DAILY_LIMIT in a day.
  // Uses the same atomic fixed-window rate_limit_hit RPC (migration 0068) the
  // rest of the abuse limits use; it returns true while inside the limit and
  // false once tripped. FAILS CLOSED to match the per-user counter above: a
  // broken breaker denies rather than leaving the paid model wide open. Since
  // every AI route funnels through this helper, this single check caps them
  // all. Counted once per request (fan-out weighting stays per-user via
  // addAiUsage), which is the right granularity for a runaway-cost breaker.
  //
  // IT DOES NOT REFUSE A MEMBER WHO HAS ACTUALLY PAID. The daily breaker is a
  // single shared bucket, so a swarm of free accounts can spend the whole
  // day's budget by 9am and the next person turned away is a Plus member or a
  // Pro who paid for the feature that morning. That is the swarm getting what
  // it came for: it cannot run the bill past the ceiling, but it CAN black out
  // every paying customer, which is the cheaper attack of the two.
  //
  // The breaker is still CONSULTED for everybody - the call is what does the
  // counting, so the bucket keeps meaning "requests today" rather than
  // "requests today by free accounts" - it is only ENFORCED against accounts
  // that have not paid. A paying account is still bounded by its own
  // DAILY_LIMIT_PLUS, and the HOURLY brake below still applies to everybody,
  // so how fast any budget can burn is unchanged. What changes is who gets
  // shed first.
  const globalDaily = await checkAiGlobalDailyLimit();
  if (globalDaily !== "ok" && !(await exemptFromGlobalDaily(userId, isPlus))) {
    // Hand back the usage bump above. The chat path has always done this
    // (countAskUsage -> refundAskUsage): this request is being turned away
    // by HEARTH's ceiling, not the caller's, and charging them one of their
    // 25 for a request that never reached the model means an honest retry
    // burns their day. Best effort, exactly like refundAskUsage.
    await refundAiUsage(userId);
    return {
      overLimit: true,
      reason: globalDaily === "over" ? "global" : "counter_unavailable",
      remaining,
      dailyLimit,
    };
  }

  // And the owner-wide HOURLY ceiling, last: a request already refused above
  // must not bump the shared bucket and shed load from someone who still has
  // allowance. Same reasoning as the chat routes' ordering. This brake stays
  // on for paying members too - it is what caps how fast any budget can burn.
  if (opts?.hourly !== false && (await overAiGlobalHourlyLimit())) {
    await refundAiUsage(userId);
    return { overLimit: true, reason: "global", remaining, dailyLimit };
  }

  return { overLimit: false, reason: null, remaining, dailyLimit };
}

// The homeowner chat's own daily cap, separate from the tool budget above.
//
// Implementation: the fixed-window rate_limit_hit RPC (migration 0070), on a
// per-user bucket with an 86400 second window, rather than a second column in
// ai_usage. That RPC is already exactly a "N per window per key" counter, it
// is atomic, and it needs no migration. It answers "are you over?" but not
// "how many are left", so the count is read back off the same rate_limits row
// afterwards, purely to power the quiet meter the client shows a free
// homeowner. Nothing gates on that read: if it fails, `remaining` is null and
// the client simply shows no meter.
//
// Fails CLOSED, like every other counter here: a broken counter must block
// rather than hand out unmetered access to a paid model.
export async function countAskUsage(
  userId: string,
  // Tier or the older boolean (see toAiTier). "trialing" gets ASK_DAILY_TRIAL:
  // photos and a real Plus-sized allowance, but not the paid ceiling.
  plan: AiTier | boolean,
  // Which chat is asking. "pro" swaps in the pro copilot's ceiling and its own
  // counter; omitted means the homeowner chat, so every existing call site
  // behaves exactly as before.
  surface: AskSurface = "homeowner"
): Promise<{
  overLimit: boolean;
  reason: AiLimitReason | null;
  remaining: number | null;
  dailyLimit: number;
  // The window this call CHARGED, handed back so a refund later in the same
  // request targets the row that was actually bumped. The window is a fixed
  // 24 hour block: a request that starts at 23:59:59 and fails at 00:00:01
  // would otherwise compute tomorrow's window on the way out and decrement a
  // row nobody was charged in (or, worse, none at all), leaving the question
  // spent. Captured once, up front, and threaded through.
  windowStart: string;
}> {
  const tier = toAiTier(plan);
  const isPlus = tier !== "free";
  const dailyLimit = askDailyLimitFor(tier, surface);
  const admin = createAdminClient();
  const bucket = askBucket(userId, surface);
  const windowStart = askWindowStart();

  try {
    const { data: allowed, error } = await admin.rpc("rate_limit_hit", {
      p_bucket: bucket,
      p_limit: dailyLimit,
      p_window_seconds: ASK_DAY_WINDOW_SECONDS,
    });
    if (error) throw error;
    if (allowed === false) {
      return {
        overLimit: true,
        reason: "user_daily",
        remaining: 0,
        dailyLimit,
        windowStart,
      };
    }
  } catch (err) {
    console.error("countAskUsage rate_limit_hit failed - failing CLOSED:", err);
    return {
      overLimit: true,
      reason: "counter_unavailable",
      remaining: null,
      dailyLimit,
      windowStart,
    };
  }

  // Same daily spend breaker across EVERY user that the tool routes go
  // through, so the chat cannot be the one paid surface with no global
  // ceiling behind it. Fails CLOSED for the same reason. This one already
  // spent a question out of the bucket above, so hand it back: the homeowner
  // is being turned away by OUR ceiling, and charging them for that is the
  // bug. Best effort - see refundAskUsage.
  //
  // AND IT DOES NOT REFUSE A MEMBER WHO HAS ACTUALLY PAID, exactly as in
  // countAiUsage above. The breaker is one shared bucket, so a swarm of free
  // accounts that spends the day's budget by 9am would otherwise take Ask
  // Hearth away from every Plus member too - the cheap attack is not running
  // up the bill (the bucket caps that), it is blacking out the people who
  // paid. Still CONSULTED for everybody, because that call is what does the
  // counting and the bucket has to keep meaning "questions today"; only
  // ENFORCED against accounts that have not paid, who are still bounded by
  // ASK_DAILY_FREE. The hourly brake the two chat routes run either side of
  // this (overAiGlobalHourlyLimit) stays on for everyone, so how fast any
  // budget can burn is unchanged. An exempt member is never refused here, so
  // nothing is ever refunded to them either.
  const globalDaily = await checkAiGlobalDailyLimit();
  if (globalDaily !== "ok" && !(await exemptFromGlobalDaily(userId, isPlus))) {
    await refundAskUsage(userId, windowStart, surface);
    return {
      overLimit: true,
      reason: globalDaily === "over" ? "global" : "counter_unavailable",
      remaining: null,
      dailyLimit,
      windowStart,
    };
  }

  return {
    overLimit: false,
    reason: null,
    remaining: await askRemaining(bucket, dailyLimit, windowStart),
    dailyLimit,
    windowStart,
  };
}

// One bucket per user PER SURFACE. The homeowner key is unchanged, so nobody's
// count moves; the pro copilot counts in its own key so the two chats cannot
// drain each other on a dual-side account.
function askBucket(userId: string, surface: AskSurface = "homeowner"): string {
  return surface === "pro" ? `ask-day:pro:${userId}` : `ask-day:${userId}`;
}

// Hand back one chat question this user was charged but never got an answer
// for: the request was shed by a ceiling above them, or the model call itself
// threw before producing a word.
//
// Why a read-modify-write instead of an RPC: rate_limit_hit (migration 0070)
// only ever increments, and there is no decrement counterpart to call. Adding
// one is a live migration for a path that fires on failures only, so this
// walks the row directly with the service-role client instead (it is the only
// client that can: the table has RLS on and no policies).
//
// COMPARE-AND-SWAP, not a blind write. This used to read the count and write
// back count-1 unconditionally, which loses every increment that landed in
// between: two tabs asking at once plus one failing request was enough to
// hand back a question that had already been re-spent, and a caller who could
// arrange that reliably had no daily cap at all. The update now carries the
// value it read as part of its WHERE clause, so a row somebody else moved
// matches nothing, and we re-read and try again. Three attempts is plenty:
// this is one user's own row, and each retry only loses to a genuinely
// concurrent request from the same account.
//
// `windowStart` is the window countAskUsage actually CHARGED. Recomputing it
// here would target tomorrow's row for a request that started just before
// midnight and failed just after, so the charge would silently stand. Callers
// thread it through; it falls back to the current window for the internal
// call sites that charge and refund in the same breath.
//
// Never throws and never blocks: a failed refund is logged and the request
// carries on, exactly like addAiUsage. It also never drives a count below 0.
export async function refundAskUsage(
  userId: string,
  windowStart?: string,
  // Which chat's counter to hand the question back to. Same default as
  // countAskUsage, so every homeowner call site is untouched.
  surface: AskSurface = "homeowner"
): Promise<void> {
  const bucket = askBucket(userId, surface);
  const target = windowStart ?? askWindowStart();
  try {
    const admin = createAdminClient();
    for (let attempt = 0; attempt < REFUND_CAS_ATTEMPTS; attempt++) {
      const { data, error } = await admin
        .from("rate_limits")
        .select("count")
        .eq("bucket", bucket)
        .eq("window_start", target)
        .maybeSingle();
      // No row means nothing was charged in this window, and a count already
      // at 0 must never go negative.
      if (error || !data || data.count <= 0) return;

      const { data: updated, error: updateError } = await admin
        .from("rate_limits")
        .update({ count: data.count - 1 })
        .eq("bucket", bucket)
        .eq("window_start", target)
        // The COMPARE half: only swap if the row still holds what we read.
        .eq("count", data.count)
        .select("count");
      if (updateError) {
        console.error("refundAskUsage update failed:", updateError);
        return;
      }
      // Rows affected. One means we won the swap; zero means a concurrent
      // request moved the count under us, so read it fresh and try again.
      if (updated && updated.length > 0) return;
    }
    console.warn(
      `refundAskUsage gave up after ${REFUND_CAS_ATTEMPTS} attempts (bucket ${bucket})`
    );
  } catch (err) {
    console.error("refundAskUsage failed:", err);
  }
}

// How many times a refund re-reads and retries its compare-and-swap before
// giving up. Giving up charges the user for a question they did not get,
// which is the safe direction to fail and one they can retry out of.
const REFUND_CAS_ATTEMPTS = 3;

// Hand back one TOOL usage this user was charged but never got a result for:
// the request was shed by a ceiling above them, or the model call itself
// threw. The chat's twin is refundAskUsage above.
//
// WHY NOT bump_ai_usage(-1): that RPC clamps its delta with
// `greatest(coalesce(p_delta, 1), 0)` (migration 0072), so a negative delta is
// silently a no-op, not a decrement. Adding a decrementing RPC is a live
// migration for a path that only fires on failures, so this walks the row
// directly with the service-role client, under the same compare-and-swap as
// the chat refund: read the count, then update only if it still holds that
// value, retrying on a lost race.
//
// It targets the NEWEST ai_usage row for the user rather than computing
// today's date here. bump_ai_usage writes `current_date` in the database's own
// timezone, and this always runs moments after that bump, so the newest row IS
// the row that was charged. Recomputing a date in the app would go wrong at
// exactly the boundary a refund most needs to be right.
//
// Best effort, like addAiUsage: never throws, never blocks, never below 0.
export async function refundAiUsage(userId: string): Promise<void> {
  try {
    const admin = createAdminClient();
    for (let attempt = 0; attempt < REFUND_CAS_ATTEMPTS; attempt++) {
      // Cast: ai_usage (migration 0027) is a real table that
      // src/lib/database.types.ts has never been regenerated for, the same
      // convention the rest of the app uses for post-0029 columns.
      const { data, error } = await (admin as any)
        .from("ai_usage")
        .select("usage_date, count")
        .eq("user_id", userId)
        .order("usage_date", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error || !data || data.count <= 0) return;

      const { data: updated, error: updateError } = await (admin as any)
        .from("ai_usage")
        .update({ count: data.count - 1 })
        .eq("user_id", userId)
        .eq("usage_date", data.usage_date)
        // The COMPARE half, same as above.
        .eq("count", data.count)
        .select("count");
      if (updateError) {
        console.error("refundAiUsage update failed:", updateError);
        return;
      }
      if (updated && updated.length > 0) return;
    }
    console.warn(
      `refundAiUsage gave up after ${REFUND_CAS_ATTEMPTS} attempts (user ${userId})`
    );
  } catch (err) {
    console.error("refundAiUsage failed:", err);
  }
}

// The same window boundary rate_limit_hit computes in SQL: the epoch second
// floored to the window size.
function askWindowStart(): string {
  return new Date(
    Math.floor(Date.now() / 1000 / ASK_DAY_WINDOW_SECONDS) *
      ASK_DAY_WINDOW_SECONDS *
      1000
  ).toISOString();
}

// Fixed 24 hour window for the chat bucket. The window is aligned to epoch
// day (see rate_limit_hit), not to the user's local midnight, so "resets
// tomorrow" is approximate for anyone far from UTC. That was already true of
// every other limit in this file.
const ASK_DAY_WINDOW_SECONDS = 86400;

// How many chat questions are left after this one, read off the rate_limits
// row rate_limit_hit just bumped. Advisory only: the meter the free homeowner
// sees. Returns null when the row cannot be read, and the client then shows
// no meter rather than a guess.
async function askRemaining(
  bucket: string,
  dailyLimit: number,
  windowStart: string
): Promise<number | null> {
  try {
    const admin = createAdminClient();
    const { data, error } = await admin
      .from("rate_limits")
      .select("count")
      .eq("bucket", bucket)
      .eq("window_start", windowStart)
      .maybeSingle();
    if (error || !data) return null;
    return Math.max(0, dailyLimit - data.count);
  } catch {
    return null;
  }
}

// May this caller ignore the owner-wide DAILY breaker (never the hourly one,
// and never their own per-user cap)?
//
// ONLY A MEMBERSHIP THAT HAS ACTUALLY BEEN PAID FOR. The `isPlus` flag every
// caller passes comes from hasPlus()/ownsPlus() in src/lib/subscription.ts,
// which counts status "trialing" as Plus - correct for deciding what someone
// may USE, and exactly wrong for deciding who may spend past a cost ceiling.
// A free trial is free to start and can be started again from a fresh email,
// so exempting trialers would hand the whole exemption back to the swarm it
// exists to defend against: 20 trial accounts at DAILY_LIMIT_PLUS is the
// entire AI_GLOBAL_DAILY_LIMIT, with no daily ceiling in front of any of it.
// A trialing account is treated as free here and stays under the breaker.
//
// Costs one indexed read, and ONLY on the path where the breaker has already
// refused - so on every normal request this is not called at all.
//
// FAILS CLOSED: an unreadable subscriptions table means "not exempt", which
// keeps the ceiling standing. The cost of being wrong that way is a paying
// member shedding one request during an outage of both the breaker and the
// database; the other way is the ceiling quietly not existing.
async function exemptFromGlobalDaily(
  userId: string,
  isPlus: boolean
): Promise<boolean> {
  // Not even a trialer: no lookup needed.
  if (!isPlus) return false;
  try {
    const admin = createAdminClient();
    const { data, error } = await admin
      .from("subscriptions")
      .select("status, current_period_end")
      .eq("user_id", userId);
    if (error) throw error;
    const now = Date.now();
    // Either side counts: a homeowner Plus row or a contractor pro_ row. Both
    // are money that arrived, and both buy access to model-backed features.
    return (data ?? []).some(
      (row) =>
        row.status === "active" &&
        (!row.current_period_end ||
          new Date(row.current_period_end).getTime() > now)
    );
  } catch (err) {
    console.error(
      "exemptFromGlobalDaily lookup failed - treating as unpaid:",
      err
    );
    return false;
  }
}

// The owner-wide daily spend breaker, shared by the tool routes and the chat.
// Anything but "ok" means deny; "error" is separated from "over" only so the
// caller can say something true to the person in front of it (see
// AiLimitReason). Both still fail CLOSED.
async function checkAiGlobalDailyLimit(): Promise<"ok" | "over" | "error"> {
  try {
    const admin = createAdminClient();
    const { data: allowed, error } = await admin.rpc("rate_limit_hit", {
      p_bucket: AI_GLOBAL_BUCKET,
      p_limit: AI_GLOBAL_DAILY_LIMIT,
      p_window_seconds: 86400,
    });
    if (error) throw error;
    if (allowed === false) {
      // "[ALERT]" is a stable, greppable prefix: it is what an operator filters
      // the Vercel logs on, and what a log drain can be pointed at. Do not
      // reword it.
      console.error(
        `[ALERT] AI global spend breaker tripped (${AI_GLOBAL_BUCKET} over ${AI_GLOBAL_DAILY_LIMIT}/day) - denying to cap runaway cost`
      );
      return "over";
    }
    return "ok";
  } catch (err) {
    console.error("ai-global rate_limit_hit failed - failing CLOSED:", err);
    return "error";
  }
}

// Per-user BURST limit: has this caller made more than `limit` AI requests in
// the last `seconds`? Registers this request in the window as it checks, so
// calling it IS the request being counted.
//
// Implementation note: ai_usage cannot answer this. It is one row per user per
// DAY (user_id, usage_date, count - see migration 0024/0027), with no
// created_at and no per-request rows, so there is nothing to count inside a
// 60 second window. Rather than add a migration and a second write on every
// AI request, this rides the existing fixed-window rate_limits table and its
// atomic rate_limit_hit RPC (migration 0068/0070), which is exactly a windowed
// request counter. rate_limit_hit returns true while count <= limit, so a
// limit of 6 refuses the 7th request inside the window.
//
// FAILS CLOSED, deliberately, and this is a behaviour change from the old
// fail-open posture: if the counter query errors we treat the caller as over
// the limit. A DB blip then costs the honest user one retry a minute later,
// whereas a silent fail-open hands an attacker unmetered access to a paid
// model and costs real money. Cost asymmetry decides it.
export async function countAiUsageWindow(
  userId: string,
  seconds: number = AI_BURST_WINDOW_SECONDS,
  limit: number = AI_BURST_LIMIT,
  // Which bucket family to count in. The chat and the tool routes keep
  // SEPARATE buckets because they use different window sizes, and rate_limits
  // is keyed by (bucket, window_start): two window sizes sharing one bucket
  // would sometimes floor to the same row and enforce whichever limit arrived
  // first.
  bucketPrefix: string = "ai-burst"
): Promise<{ overLimit: boolean }> {
  try {
    const admin = createAdminClient();
    const { data: allowed, error } = await admin.rpc("rate_limit_hit", {
      p_bucket: `${bucketPrefix}:${userId}`,
      p_limit: limit,
      p_window_seconds: seconds,
    });
    if (error) throw error;
    return { overLimit: allowed === false };
  } catch (err) {
    console.error("countAiUsageWindow failed - failing CLOSED:", err);
    return { overLimit: true };
  }
}

// A cheap, NON-COUNTING look at this user's tool-burst window, for use as a
// pre-check in front of a request body read.
//
// WHY. Every tool route used to parse its (potentially multi-megabyte) body
// before any rate limit ran, because the burst check lives inside
// countAiUsage and countAiUsage runs after validation. So the one check meant
// to make a flood cheap to refuse was the check that only happened after the
// expensive part was already paid for. This lets a route ask "is this caller
// already over?" for the price of a single indexed row read, before it reads
// a byte.
//
// It reads the SAME bucket and window countAiUsage will later increment
// (ai-tool-burst, AI_TOOL_BURST_WINDOW_SECONDS), so it cannot double count:
// rate_limit_hit is the only thing that ever bumps the counter, and this does
// not call it. Mirrors rate_limit_hit's own arithmetic: that RPC increments
// then allows while count <= limit, so a window already sitting AT the limit
// is one whose next request would be refused.
//
// FAILS OPEN, unlike everything else in this file, and deliberately: it is an
// optimisation in front of the authoritative check, not the check itself. If
// this read fails the request simply continues to countAiUsage, which fails
// CLOSED as it always has. Failing closed here would turn a read blip into a
// refusal for someone with allowance left.
export async function overToolBurst(userId: string): Promise<boolean> {
  try {
    const admin = createAdminClient();
    const windowStart = new Date(
      Math.floor(Date.now() / 1000 / AI_TOOL_BURST_WINDOW_SECONDS) *
        AI_TOOL_BURST_WINDOW_SECONDS *
        1000
    ).toISOString();
    const { data, error } = await admin
      .from("rate_limits")
      .select("count")
      .eq("bucket", `ai-tool-burst:${userId}`)
      .eq("window_start", windowStart)
      .maybeSingle();
    if (error || !data) return false;
    return data.count >= AI_TOOL_BURST_LIMIT;
  } catch (err) {
    console.error("overToolBurst pre-check failed - continuing:", err);
    return false;
  }
}

// Owner-wide hourly CEILING across every user, so a swarm of fresh accounts
// cannot add up to a runaway bill even though each one stays under its own
// daily cap. Same fixed-window counter as above, one shared bucket, counted
// once per request. This sits alongside the daily spend breaker in
// countAiUsage: the daily one caps the day, this one caps how fast a day's
// budget can be burned. Fails CLOSED for the same reason as above.
export async function overAiGlobalHourlyLimit(): Promise<boolean> {
  try {
    const admin = createAdminClient();
    const { data: allowed, error } = await admin.rpc("rate_limit_hit", {
      p_bucket: AI_GLOBAL_HOUR_BUCKET,
      p_limit: AI_GLOBAL_HOURLY_LIMIT,
      p_window_seconds: 3600,
    });
    if (error) throw error;
    if (allowed === false) {
      // Same greppable prefix as the daily breaker above.
      console.error(
        `[ALERT] AI global hourly ceiling tripped (${AI_GLOBAL_HOUR_BUCKET} over ${AI_GLOBAL_HOURLY_LIMIT}/hour) - shedding load`
      );
      return true;
    }
    return false;
  } catch (err) {
    console.error("overAiGlobalHourlyLimit failed - failing CLOSED:", err);
    return true;
  }
}

// HOW MANY EARLY ABORTS AN HOUR STILL EARN A REFUND.
//
// Both chat routes hand a question back when the client hangs up before the
// first delta arrives: nothing was delivered, so charging for it would be
// charging for nothing. That is right for a phone that lost signal, and it is
// also a free-questions machine: fire a request, abort it the instant the
// headers land, and the daily counter goes up and straight back down again,
// forever, while every one of those requests still opened a paid model call.
//
// Five an hour is far more than a real connection drops and far too few to farm
// with. Past that the refund quietly stops: the request still ends silently
// (there is nobody on the other end to tell), the question just stays spent.
export const ASK_ABORT_REFUND_LIMIT = 5;
export const ASK_ABORT_REFUND_WINDOW_SECONDS = 3600;

// Counts one early abort for this user and reports whether it still earns a
// refund. Same fixed-window rate_limit_hit RPC as every other bucket here, on
// its own "ask-abort:<user>" key so it can never interact with the burst or
// daily counters.
//
// FAILS OPEN, unlike the gates above, and deliberately: this decides whether to
// give something BACK, not whether to let something through. A counter blip must
// cost an honest homeowner nothing, and the worst case of failing open is that
// an abuser gets refunds during a database outage - during which their questions
// are not being counted either.
export async function allowAbortRefund(userId: string): Promise<boolean> {
  try {
    const admin = createAdminClient();
    const { data: allowed, error } = await admin.rpc("rate_limit_hit", {
      p_bucket: `ask-abort:${userId}`,
      p_limit: ASK_ABORT_REFUND_LIMIT,
      p_window_seconds: ASK_ABORT_REFUND_WINDOW_SECONDS,
    });
    if (error) throw error;
    return allowed !== false;
  } catch (err) {
    console.error("allowAbortRefund failed - refunding anyway:", err);
    return true;
  }
}

// HOW MANY REFUSED OR EMPTY ANSWERS AN HOUR STILL EARN A REFUND.
//
// Both chat routes hand the question back when the model returns no text at
// all, which includes a hard safety refusal (stop_reason "refusal"). That is
// right for a hiccup and wrong as an unlimited rule: a caller who can reliably
// make the model refuse - and someone probing for a jailbreak is doing exactly
// that, over and over - never depletes their daily allowance, while every one
// of those attempts still opens a paid model call. The red-team writeup filed
// this as RT3-3.
//
// Three an hour is far more than an honest person ever sees (a genuine refusal
// on a home question is rare) and far too few to farm with. Past that the
// refusal still gets its honest answer on screen, the question just stays
// spent, so probing costs the prober their own allowance.
export const ASK_REFUSAL_REFUND_LIMIT = 3;
export const ASK_REFUSAL_REFUND_WINDOW_SECONDS = 3600;

// Counts one refused/empty answer for this user and reports whether it still
// earns a refund. Its own bucket, so it can never interact with the daily,
// burst, or abort counters.
//
// FAILS OPEN, like allowAbortRefund and for the same reason: this decides
// whether to give something BACK. A counter blip must not cost an honest
// homeowner a question, and during an outage their questions are not being
// counted either.
export async function allowRefusalRefund(userId: string): Promise<boolean> {
  try {
    const admin = createAdminClient();
    const { data: allowed, error } = await admin.rpc("rate_limit_hit", {
      p_bucket: `ask-refusal:${userId}`,
      p_limit: ASK_REFUSAL_REFUND_LIMIT,
      p_window_seconds: ASK_REFUSAL_REFUND_WINDOW_SECONDS,
    });
    if (error) throw error;
    return allowed !== false;
  } catch (err) {
    console.error("allowRefusalRefund failed - refunding anyway:", err);
    return true;
  }
}

// A PER-DAY OUTPUT-TOKEN BUDGET, on top of the per-day question count.
//
// Counting questions bounds how OFTEN someone asks, not how much they get
// back. "Write me the longest possible answer" repeated fifteen times is the
// same fifteen questions as fifteen one-line answers and several times the
// output bill, and output tokens are the expensive half ($10 per million
// against $2 for input). This is the second ceiling: a day's questions may
// also only produce so many words.
//
// Sized as questions x ASK_OUTPUT_TOKENS_PER_ANSWER rather than a flat number,
// so it scales with whatever allowance the tier already has and cannot
// accidentally bite before the question cap does. 2,000 tokens is roughly
// three times the longest answer the prompt asks for (an answer under about
// 150 words plus its trailing blocks lands near 300 to 600), so a normal
// conversation never comes near it and a farmer asking for maximum-length
// output every time runs out around half way through their day.
export const ASK_OUTPUT_TOKENS_PER_ANSWER = 2000;

export function askOutputBudgetFor(
  tier: AiTier,
  surface: AskSurface = "homeowner"
): number {
  return askDailyLimitFor(tier, surface) * ASK_OUTPUT_TOKENS_PER_ANSWER;
}

// The bucket the day's output tokens accumulate in. Per user, per surface,
// same 24 hour window as the question counter, so the two reset together.
function askOutputBucket(userId: string, surface: AskSurface): string {
  return `ask-out:${surface}:${userId}`;
}

/**
 * Has this caller already produced their day's worth of answer text?
 *
 * Read-only: it does not count anything, so calling it costs one indexed row
 * read and it can safely run in front of the question counter (an over-budget
 * request is refused without spending a question on the refusal).
 *
 * FAILS OPEN, deliberately, unlike the gates above it. This is a second
 * ceiling behind the authoritative one: the per-user question cap still binds,
 * still fails closed, and already bounds the day. Failing closed here would
 * turn a single unreadable row into "Ask Hearth is down" for someone who has
 * asked nothing today, which is a much worse trade than one extra long answer.
 */
export async function overAskOutputBudget(
  userId: string,
  tier: AiTier,
  surface: AskSurface = "homeowner"
): Promise<boolean> {
  try {
    const admin = createAdminClient();
    const { data, error } = await admin
      .from("rate_limits")
      .select("count")
      .eq("bucket", askOutputBucket(userId, surface))
      .eq("window_start", askWindowStart())
      .maybeSingle();
    if (error || !data) return false;
    return data.count >= askOutputBudgetFor(tier, surface);
  } catch (err) {
    console.error("overAskOutputBudget read failed - continuing:", err);
    return false;
  }
}

/**
 * Add the output tokens one answer actually cost to today's budget.
 *
 * WHY NOT rate_limit_hit: that RPC increments by exactly one, and this needs
 * to add a few hundred. Rather than ship a migration for a counter that only
 * ever informs a soft ceiling, this walks the row directly with the
 * service-role client (the only client that can: rate_limits has RLS on and no
 * policies), under the same compare-and-swap the refunds use, so two answers
 * finishing at once cannot lose one of the two writes.
 *
 * Best effort, exactly like addAiUsage: never throws, never blocks the answer
 * on its way to the person waiting for it.
 */
export async function addAskOutputTokens(
  userId: string,
  surface: AskSurface,
  tokens: number
): Promise<void> {
  if (!Number.isFinite(tokens) || tokens <= 0) return;
  const bucket = askOutputBucket(userId, surface);
  const windowStart = askWindowStart();
  try {
    const admin = createAdminClient();
    for (let attempt = 0; attempt < REFUND_CAS_ATTEMPTS; attempt++) {
      const { data, error } = await admin
        .from("rate_limits")
        .select("count")
        .eq("bucket", bucket)
        .eq("window_start", windowStart)
        .maybeSingle();
      if (error) return;

      if (!data) {
        // First answer of the day in this window. A concurrent insert wins the
        // primary key and this loops round to the update branch instead.
        const { error: insertError } = await admin
          .from("rate_limits")
          .insert({ bucket, window_start: windowStart, count: Math.round(tokens) });
        if (!insertError) return;
        continue;
      }

      const { data: updated, error: updateError } = await admin
        .from("rate_limits")
        .update({ count: data.count + Math.round(tokens) })
        .eq("bucket", bucket)
        .eq("window_start", windowStart)
        // The COMPARE half: a row somebody else moved matches nothing, so we
        // re-read and try again rather than clobbering their write.
        .eq("count", data.count)
        .select("count");
      if (updateError) return;
      if (updated && updated.length > 0) return;
    }
  } catch (err) {
    console.error("addAskOutputTokens failed:", err);
  }
}

// THE ABUSE SIGNAL, as an enum and nothing else.
//
// These land in app_events next to the product analytics, so the payload rule
// from docs/ANALYTICS.md applies at its strictest: a KIND, never the text that
// triggered it. A homeowner's question, a pasted document, and a jailbreak
// attempt are all free text, and free text in an analytics table is a data
// leak waiting for someone to run the wrong query. Knowing that a user tripped
// "burst" eleven times in an hour is the whole signal; knowing what they typed
// adds nothing an operator can act on.
export type AiAbuseKind =
  | "burst" // firing requests faster than a person can read them
  | "daily" // spent their own day's allowance
  | "output_budget" // spent their day's worth of answer text
  | "global" // an owner-wide breaker or ceiling shed this request
  | "oversize" // a body past the hard byte ceiling
  | "empty" // a send with no question and no photo in it
  | "refusal" // the model itself declined to answer
  | "refund_denied"; // an abort or refusal refund that was not granted

/**
 * Record one abuse signal. Fire-and-forget, and deliberately not awaited on
 * the hot path by every caller: a counter that slows down the answer is a
 * counter that gets removed later.
 */
export async function trackAiAbuse(
  userId: string | null,
  kind: AiAbuseKind,
  surface: AskSurface | "tool" = "homeowner"
): Promise<void> {
  await trackServerEvent(userId, "ai_abuse_signal", { kind, surface });
}

// Add N extra usages for this user today (e.g. a route that fans out to the
// model more than once per request). Best-effort: it never throws and never
// blocks the caller, since the gating decision is already made by
// countAiUsage. Non-positive extras are a no-op.
export async function addAiUsage(userId: string, extra: number): Promise<void> {
  if (extra <= 0) return;
  try {
    const admin = createAdminClient();
    await admin.rpc("bump_ai_usage", { p_user: userId, p_delta: extra });
  } catch (err) {
    console.error("addAiUsage failed:", err);
  }
}
