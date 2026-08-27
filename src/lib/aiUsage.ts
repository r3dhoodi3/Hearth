import { createAdminClient } from "@/lib/supabase/admin";
import { AI_GLOBAL_DAILY_LIMIT, AI_GLOBAL_BUCKET } from "@/lib/constants";

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

// The homeowner chat's OWN daily bucket. Free is a taste, not a product:
// three text questions a day, no photos (the vision calls are the expensive
// ones). Plus gets 15 a day with photos.
export const ASK_DAILY_FREE = 3;
export const ASK_DAILY_PLUS = 15;

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
  isPlus: boolean,
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
  const dailyLimit = isPlus ? DAILY_LIMIT_PLUS : DAILY_LIMIT_FREE;
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
  isPlus: boolean
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
  const dailyLimit = isPlus ? ASK_DAILY_PLUS : ASK_DAILY_FREE;
  const admin = createAdminClient();
  const bucket = askBucket(userId);
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
    await refundAskUsage(userId, windowStart);
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

function askBucket(userId: string): string {
  return `ask-day:${userId}`;
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
  windowStart?: string
): Promise<void> {
  const bucket = askBucket(userId);
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
