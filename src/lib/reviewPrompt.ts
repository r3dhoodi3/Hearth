// Pure, DOM-light helpers for the "Enjoying Hearth?" review prompt
// (src/components/ReviewPrompt.tsx). Kept separate from the component so the
// trigger rules can be unit tested without rendering anything, and separate
// from src/app/(app)/feedback/actions.ts so the DB-backed signals it needs
// (settled, owed a follow-up, done something meaningful) stay server-only.
//
// The full gate for the "Enjoying Hearth?" card, in order, is:
//   1. not on an excluded page (onboarding, sign-in, checkout, /feedback itself)
//   2. not the first time this browser has ever loaded the app
//   3. the account has never settled the prompt (rated it, or answered
//      "Not really" and gone to the private feedback form)
//   4. the account has done something meaningful (claimed a home, posted a
//      job, asked Ask Hearth 3+ times, or a pro applied to one of its jobs)
//   5. this session was drawn as an "ask" session (see isAskSession)
//   6. they have actually been USING the app for the 15 to 20 minutes drawn
//      for this session (see advanceActiveTime), and have not been asked
//      already in this session
// (1), (2), (5) and (6) are decided here, client-side, for free. (3) and (4)
// come from the server (getReviewPromptSignals in feedback/actions.ts) because
// they depend on app_feedback, which this account cannot SELECT from directly
// (see migration 0133) - by design, so nobody can probe their own "have I been
// asked" state from the browser.
//
// WHAT CHANGED, AND WHY (2026-08-29): a 'prompt_shown' row used to settle the
// account forever, so one silent dismissal was the end of it, and tapping the
// store link counted as "rated" even though nobody had rated anything. Now
// only two things are permanent - an explicit "Yes, done" ('rated') and the
// negative branch ('not_really') - and everything else is a snooze that puts
// the card back into the session pool.

import { isNativePlatform, requestPlatformReview } from "./nativeReview";

const FIRST_SEEN_KEY = "hearth_first_seen_at";

// A page the prompt must never appear on, even though ReviewPrompt is mounted
// globally in the signed-in shell: onboarding and sign-in are never actually
// under (app) so this is belt and braces there, but /feedback and /plus
// (billing/checkout) genuinely are, and this is the only thing keeping the
// prompt off them.
// "/signin", not "/sign-in": the real route is src/app/signin. The hyphenated
// spelling excluded a page that does not exist while leaving the one that does
// wide open.
export const REVIEW_PROMPT_EXCLUDED_PATHS = [
  "/feedback",
  "/plus",
  "/onboarding",
  "/signin",
  "/checkout",
] as const;

// Matched segment-wise, not by bare prefix. startsWith() alone excludes
// /plusters (and any future route that merely begins with one of these
// spellings) while a query string or a child path is still correctly inside
// the excluded route. Same rule roleRouting.ts's isUnder uses, kept local so
// this file stays importable from a client component with no dependencies.
export function isExcludedPath(pathname: string): boolean {
  // A pathname carries no query string in Next's usePathname(), but callers
  // and tests hand this "/plus?reason=ask" too, so cut at the first ? or #
  // before comparing rather than pretending they cannot appear.
  const path = pathname.split(/[?#]/)[0];
  return REVIEW_PROMPT_EXCLUDED_PATHS.some(
    (p) => path === p || path.startsWith(p + "/")
  );
}

// True the very first time this browser has ever loaded the signed-in app,
// and marks that moment so every later load reads false. "Session" here means
// "this browser has been here before", not a login session - a homeowner who
// signs out and back in on the same phone is not a new session, but a fresh
// browser (or private window) always is, which is the safe direction to be
// wrong in for a feature whose whole point is to not be naggy.
//
// Storage is an explicit parameter (defaulting to window.localStorage) so this
// is testable without touching the real browser storage. Fails toward NOT
// showing the prompt: a storage read/write that throws (private mode, storage
// disabled) is treated as "first session" so a device that can't remember
// state never gets nagged on every load instead.
export function isFirstSession(storage?: Storage): boolean {
  const s = storage ?? (typeof window !== "undefined" ? window.localStorage : undefined);
  if (!s) return true;
  try {
    if (s.getItem(FIRST_SEEN_KEY)) return false;
    s.setItem(FIRST_SEEN_KEY, String(Date.now()));
    return true;
  } catch {
    return true;
  }
}

// ---------------------------------------------------------------------------
// Active time: how long somebody has really been USING the app this session
// ---------------------------------------------------------------------------
//
// The owner's rule is "15 to 20 consecutive minutes in the app". Wall-clock
// time since page load is not that: a tab left open on a desk all afternoon
// would clear any threshold without a single tap. So the clock here only runs
// while the tab is VISIBLE, and it resets to zero after five minutes with no
// pointer, keyboard, or scroll event, which is the difference between somebody
// using Hearth and somebody who walked away with it open.

// The owner's window, drawn per session so everybody does not get asked at the
// same minute mark.
export const REVIEW_ACTIVE_MIN_MS = 15 * 60 * 1000;
export const REVIEW_ACTIVE_MAX_MS = 20 * 60 * 1000;
// Five minutes untouched while on screen wipes the accumulated time.
export const REVIEW_IDLE_RESET_MS = 5 * 60 * 1000;
// The card may only LAND while somebody is demonstrably on the screen: a tap,
// key or scroll within the last minute. Without this the threshold could be
// crossed during the idle grace period above, which is exactly the phone
// sitting face up on the counter, and the card would be waiting there when
// they came back to it.
export const REVIEW_RECENT_ACTIVITY_MS = 60 * 1000;
// How often the component adds elapsed time. 15s is coarse enough to cost
// nothing and fine enough that the card lands within a few seconds of the
// threshold.
export const REVIEW_TICK_MS = 15 * 1000;
// From session 6 on, one app open in four is an "ask" session.
export const REVIEW_ASK_SESSION_CHANCE = 0.25;
// "The first few sessions": 2 through 5 always carry the 15 to 20 minute rule.
export const REVIEW_FIRST_FEW_LAST_SESSION = 5;

export type ActiveTimeState = {
  // Active milliseconds banked in this session so far.
  totalMs: number;
  // When advanceActiveTime last ran, so the next call knows what to add.
  lastTickAt: number;
  // Last pointer/keyboard/scroll event (or return to the tab).
  lastActivityAt: number;
  visible: boolean;
};

export function createActiveTimeState(
  now: number,
  totalMs = 0,
  visible = true
): ActiveTimeState {
  return {
    totalMs: Math.max(0, totalMs) || 0,
    lastTickAt: now,
    lastActivityAt: now,
    visible,
  };
}

// One tick of the clock. Pure, so the whole rule is testable by handing it a
// list of timestamps instead of driving a real browser.
//
// maxStepMs caps what a single tick can bank: a phone that suspends JavaScript
// for twenty minutes and then resumes (screen off with the app foregrounded,
// a throttled tab) must not hand back the entire gap as "active" time.
export function advanceActiveTime(
  state: ActiveTimeState,
  now: number,
  opts?: { idleMs?: number; maxStepMs?: number }
): ActiveTimeState {
  const idleMs = opts?.idleMs ?? REVIEW_IDLE_RESET_MS;
  const maxStepMs = opts?.maxStepMs ?? REVIEW_TICK_MS * 4;
  // Hidden time is never active time, and it must not become active time later
  // either, so the tick mark moves forward without banking anything.
  if (!state.visible) return { ...state, lastTickAt: now };
  if (now - state.lastActivityAt >= idleMs) {
    // Idle: start over rather than pausing. The owner asked for consecutive
    // minutes of use, not a total that a week of glances can add up to.
    return { ...state, totalMs: 0, lastTickAt: now };
  }
  const step = Math.min(Math.max(0, now - state.lastTickAt), maxStepMs);
  return { ...state, totalMs: state.totalMs + step, lastTickAt: now };
}

// A pointer/keyboard/scroll event: pushes the idle deadline out.
export function noteActivity(
  state: ActiveTimeState,
  now: number
): ActiveTimeState {
  return { ...state, lastActivityAt: now };
}

// document.visibilitychange. Going hidden banks whatever was earned up to this
// instant first; coming back counts as activity, so switching to another app
// for a while does not wipe time that was genuinely spent using Hearth (the
// idle reset is about somebody sitting on an open screen doing nothing).
export function setActiveTimeVisibility(
  state: ActiveTimeState,
  visible: boolean,
  now: number
): ActiveTimeState {
  if (visible) {
    return { ...state, visible: true, lastTickAt: now, lastActivityAt: now };
  }
  const banked = advanceActiveTime(state, now);
  return { ...banked, visible: false, lastTickAt: now };
}

// Uniform in [15 min, 20 min]. Clamped because a seeded or mocked random that
// returns something outside 0..1 must never push the ask outside the owner's
// window.
export function drawActiveThresholdMs(random: () => number = Math.random): number {
  const raw = random();
  // NaN survives Math.min/Math.max, so it is caught first, and it fails toward
  // the LATEST possible ask rather than the earliest.
  const r = Number.isFinite(raw) ? Math.min(Math.max(raw, 0), 1) : 1;
  return Math.round(
    REVIEW_ACTIVE_MIN_MS + r * (REVIEW_ACTIVE_MAX_MS - REVIEW_ACTIVE_MIN_MS)
  );
}

// Is this app open allowed to ask at all?
//   session 1        never (the browser has just met us)
//   sessions 2 to 5  yes, "the first few"
//   session 6+       one in four, drawn once at session start
// poolOnly forces the random-pool rule even inside the first few: that is what
// a "Not yet" on the follow-up buys, so somebody who has already been asked
// once does not get the guaranteed-ask treatment all over again.
export function isAskSession(opts: {
  sessionNumber: number;
  roll: number;
  poolOnly?: boolean;
}): boolean {
  if (opts.sessionNumber < 2) return false;
  if (!opts.poolOnly && opts.sessionNumber <= REVIEW_FIRST_FEW_LAST_SESSION) {
    return true;
  }
  return opts.roll < REVIEW_ASK_SESSION_CHANCE;
}

// ---------------------------------------------------------------------------
// Session bookkeeping (localStorage per user, sessionStorage per app open)
// ---------------------------------------------------------------------------

// How many times this account has opened the app, keyed by user id the way
// ValueAutoFetch and the pro onboarding draft key theirs: one shared prefix
// plus the id, so two accounts on the same phone never read each other's
// count.
const SESSION_COUNT_PREFIX = "hearth_review_sessions:";
// Which user this tab's session bookkeeping belongs to. Its presence is also
// what makes "have I already counted this app open" a single read.
const SESSION_USER_KEY = "hearth_review_session_user";
const SESSION_ASK_KEY = "hearth_review_ask_session";
const SESSION_THRESHOLD_KEY = "hearth_review_threshold_ms";
// Active milliseconds, mirrored to sessionStorage every tick so navigating
// between pages (which remounts the component) does not restart the clock.
const SESSION_ACTIVE_MS_KEY = "hearth_review_active_ms";
// The card was already put on screen in this app open, answered or not.
const SESSION_ASKED_KEY = "hearth_review_asked";
// The "did you get a chance to rate Hearth?" follow-up was already asked in
// this app open. Once per session, however they answered it.
const SESSION_FOLLOW_UP_KEY = "hearth_review_followup_asked";
// They tapped through to the store and have not come back yet. This is the
// whole fix for "it says it's complete when I come back": the tap records an
// intent, not a rating, and this flag is what turns the return into a
// question instead of a celebration.
const SESSION_STORE_RETURN_KEY = "hearth_review_awaiting_store_return";

export function reviewSessionCountKey(userId: string): string {
  return `${SESSION_COUNT_PREFIX}${userId}`;
}

function safeStorage(which: "local" | "session"): Storage | null {
  try {
    if (typeof window === "undefined") return null;
    return which === "local" ? window.localStorage : window.sessionStorage;
  } catch {
    return null;
  }
}

function readFlag(key: string, storage?: Storage | null): boolean {
  const s = storage ?? safeStorage("session");
  if (!s) return false;
  try {
    return s.getItem(key) === "1";
  } catch {
    return false;
  }
}

function writeFlag(key: string, on: boolean, storage?: Storage | null): void {
  const s = storage ?? safeStorage("session");
  if (!s) return;
  try {
    if (on) s.setItem(key, "1");
    else s.removeItem(key);
  } catch {
    // Storage unavailable (private mode, disabled). Worst case the flag does
    // not survive a navigation, which costs at most one repeat ask.
  }
}

export function wasPromptAskedThisSession(storage?: Storage): boolean {
  return readFlag(SESSION_ASKED_KEY, storage);
}
export function markPromptAskedThisSession(storage?: Storage): void {
  writeFlag(SESSION_ASKED_KEY, true, storage);
}
export function wasFollowUpAskedThisSession(storage?: Storage): boolean {
  return readFlag(SESSION_FOLLOW_UP_KEY, storage);
}
export function markFollowUpAskedThisSession(storage?: Storage): void {
  writeFlag(SESSION_FOLLOW_UP_KEY, true, storage);
}
export function isAwaitingStoreReturn(storage?: Storage): boolean {
  return readFlag(SESSION_STORE_RETURN_KEY, storage);
}
export function setAwaitingStoreReturn(on: boolean, storage?: Storage): void {
  writeFlag(SESSION_STORE_RETURN_KEY, on, storage);
}

export function readSessionActiveMs(storage?: Storage): number {
  const s = storage ?? safeStorage("session");
  if (!s) return 0;
  try {
    return Number(s.getItem(SESSION_ACTIVE_MS_KEY) ?? "0") || 0;
  } catch {
    return 0;
  }
}

export function writeSessionActiveMs(ms: number, storage?: Storage): void {
  const s = storage ?? safeStorage("session");
  if (!s) return;
  try {
    s.setItem(SESSION_ACTIVE_MS_KEY, String(Math.max(0, Math.round(ms))));
  } catch {
    // Same as writeFlag: the clock just restarts on the next navigation.
  }
}

// The session's 15 to 20 minute mark on its own, drawn and stored the same
// way getReviewSessionPlan does it and sharing the same key. The native path
// needs the active-time bar without any of the ask-session pooling: on native
// the OS does the throttling, and the trigger moment does the choosing.
// Falls back to the top of the window (the latest possible ask) rather than to
// zero whenever storage cannot answer.
export function getSessionActiveThresholdMs(
  session?: Storage,
  random?: () => number
): number {
  const s = session ?? safeStorage("session");
  if (!s) return REVIEW_ACTIVE_MAX_MS;
  try {
    const stored = Number(s.getItem(SESSION_THRESHOLD_KEY) ?? "");
    if (Number.isFinite(stored) && stored > 0) return stored;
    const drawn = drawActiveThresholdMs(random ?? Math.random);
    s.setItem(SESSION_THRESHOLD_KEY, String(drawn));
    return drawn;
  } catch {
    return REVIEW_ACTIVE_MAX_MS;
  }
}

export type ReviewSessionPlan = {
  // 1 for this account's very first app open on this browser.
  sessionNumber: number;
  askSession: boolean;
  thresholdMs: number;
};

// Counts this app open once and draws its two dice (ask or not, and the 15 to
// 20 minute threshold), then remembers both in sessionStorage so every later
// navigation in the same tab reads the same plan instead of rolling again -
// re-rolling per page view would turn "one in four sessions" into "one in four
// page views", which is the naggy version of this feature.
//
// Returns null when storage is unavailable, which the caller treats as "do not
// show": a browser that cannot remember whether it has asked must not ask.
export function getReviewSessionPlan(opts: {
  userId: string;
  // Skip the guaranteed "sessions 2 to 5" run: set after a "Not yet".
  poolOnly?: boolean;
  local?: Storage;
  session?: Storage;
  random?: () => number;
}): ReviewSessionPlan | null {
  const local = opts.local ?? safeStorage("local");
  const session = opts.session ?? safeStorage("session");
  if (!local || !session) return null;
  const random = opts.random ?? Math.random;
  const countKey = reviewSessionCountKey(opts.userId);
  try {
    if (session.getItem(SESSION_USER_KEY) === opts.userId) {
      const stored = Number(session.getItem(SESSION_THRESHOLD_KEY) ?? "");
      return {
        sessionNumber: Number(local.getItem(countKey) ?? "0") || 0,
        askSession: session.getItem(SESSION_ASK_KEY) === "1",
        // A missing or junk threshold falls back to the top of the window
        // rather than to zero, so a corrupted value cannot show the card
        // instantly.
        thresholdMs:
          Number.isFinite(stored) && stored > 0 ? stored : REVIEW_ACTIVE_MAX_MS,
      };
    }
    const sessionNumber = (Number(local.getItem(countKey) ?? "0") || 0) + 1;
    local.setItem(countKey, String(sessionNumber));
    const askSession = isAskSession({
      sessionNumber,
      roll: random(),
      poolOnly: opts.poolOnly,
    });
    const thresholdMs = drawActiveThresholdMs(random);
    session.setItem(SESSION_USER_KEY, opts.userId);
    session.setItem(SESSION_ASK_KEY, askSession ? "1" : "0");
    session.setItem(SESSION_THRESHOLD_KEY, String(thresholdMs));
    return { sessionNumber, askSession, thresholdMs };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The two gates the component actually calls
// ---------------------------------------------------------------------------

// "Enjoying Hearth?" - the first card. Pure and synchronous on purpose, so
// each rule is its own assertion in the test file rather than folded into one
// opaque boolean.
export function isEligibleForReviewPrompt(opts: {
  pathname: string;
  isFirstSession: boolean;
  // 'rated' or 'not_really' exists for this account: permanent, every device.
  // A bare 'prompt_shown' no longer counts - that was the old "asked once and
  // never again" behaviour, and it made a mis-tap final.
  settled: boolean;
  // Claimed a home, posted a job, asked Ask Hearth 3+ times, or a pro applied
  // to one of the account's jobs.
  hasMeaningfulActivity: boolean;
  // This app open was drawn as an ask session (getReviewSessionPlan).
  askSession: boolean;
  // Active milliseconds so far this session, and the 15 to 20 minute mark
  // drawn for it.
  activeMs: number;
  thresholdMs: number;
  // Since the last pointer/keyboard/scroll event.
  msSinceActivity: number;
  // The card already appeared in this app open.
  askedThisSession: boolean;
}): boolean {
  if (isExcludedPath(opts.pathname)) return false;
  if (opts.isFirstSession) return false;
  if (opts.settled) return false;
  if (!opts.hasMeaningfulActivity) return false;
  if (opts.askedThisSession) return false;
  if (!opts.askSession) return false;
  if (opts.activeMs < opts.thresholdMs) return false;
  if (opts.msSinceActivity > REVIEW_RECENT_ACTIVITY_MS) return false;
  return true;
}

// "Did you get a chance to rate Hearth?" - the honest follow-up, and the fix
// for the bug the owner reported: tapping the store link used to mark the
// whole thing complete, so somebody who bounced straight back without rating
// was never asked again. Apple never tells an app whether a rating was left,
// so the only truthful source is the person themselves.
//
// Shown at most once per app open. Straight away when they come back from the
// store in the same session, or at the start of the next one; after a "Not
// yet" it rejoins the random pool and has to clear the same session and
// active-time bar as the first card.
export function isEligibleForRateFollowUp(opts: {
  pathname: string;
  settled: boolean;
  // A 'rate_clicked' row exists with no 'rated' after it.
  awaitingRateConfirm: boolean;
  // They already answered "Not yet" once.
  rateDeferred: boolean;
  followUpAskedThisSession: boolean;
  // They tapped the store link in THIS session and have just come back.
  returnedFromStore: boolean;
  askSession: boolean;
  activeMs: number;
  thresholdMs: number;
  msSinceActivity: number;
}): boolean {
  if (isExcludedPath(opts.pathname)) return false;
  if (opts.settled) return false;
  if (!opts.awaitingRateConfirm) return false;
  if (opts.followUpAskedThisSession) return false;
  if (opts.returnedFromStore) return true;
  if (!opts.rateDeferred) return true;
  if (!opts.askSession) return false;
  if (opts.msSinceActivity > REVIEW_RECENT_ACTIVITY_MS) return false;
  return opts.activeMs >= opts.thresholdMs;
}

// ---------------------------------------------------------------------------
// NO INCENTIVES. EVER.
// ---------------------------------------------------------------------------
// There was an idea to hand out a $5 lead credit for leaving a rating. It
// cannot be built, here or anywhere else:
//   - App Store Review Guidelines 1.1.7 / 3.2.2: you may not offer
//     compensation of any kind for a review or rating, and doing so is a
//     removal-grade violation, not a warning.
//   - Google Play's Developer Program Policy says the same about incentivised
//     ratings.
//   - The FTC treats an undisclosed incentivised review as deceptive, which is
//     an advertising-law problem on top of the store one.
// So: no credit, no discount, no entry into a draw, no "thanks for rating"
// perk awarded after the fact. If somebody asks for it later, this comment is
// the answer. The prompt may only ever ASK.

// ---------------------------------------------------------------------------
// The native review sheet, and Hearth's own cap on top of the OS's
// ---------------------------------------------------------------------------

// Per DEVICE, not per account: Apple and Google both cap their sheet per app
// per device, so a per-account key would let two accounts on one phone burn
// six attempts against a three-attempt allowance.
const NATIVE_REVIEW_LOG_KEY = "hearth_native_review_calls";
export const NATIVE_REVIEW_MAX_CALLS = 3;
export const NATIVE_REVIEW_WINDOW_MS = 365 * 24 * 60 * 60 * 1000;

function readNativeReviewCalls(storage: Storage, now: number): number[] {
  const raw = storage.getItem(NATIVE_REVIEW_LOG_KEY);
  const parsed: unknown = raw ? JSON.parse(raw) : [];
  if (!Array.isArray(parsed)) return [];
  const cutoff = now - NATIVE_REVIEW_WINDOW_MS;
  return parsed.filter(
    (t): t is number => typeof t === "number" && Number.isFinite(t) && t > cutoff
  );
}

// Hearth's own throttle, on top of the OS's. iOS ignores anything past three
// sheets a year without telling us, so a week where somebody both builds a
// plan and hires a pro must not spend all three slots on the same person in
// three days: those calls would vanish and the year's allowance would be gone.
export function canRequestNativeReview(now: number, storage?: Storage): boolean {
  const s = storage ?? safeStorage("local");
  // Fail toward NOT asking, the same posture as isFirstSession: a device that
  // cannot remember how often it has asked must not ask.
  if (!s) return false;
  try {
    return readNativeReviewCalls(s, now).length < NATIVE_REVIEW_MAX_CALLS;
  } catch {
    return false;
  }
}

// Logs the ATTEMPT, never the outcome: there is no outcome to log. The OS
// never reports whether its sheet appeared or whether a rating was left.
export function recordNativeReviewCall(now: number, storage?: Storage): void {
  const s = storage ?? safeStorage("local");
  if (!s) return;
  try {
    const recent = readNativeReviewCalls(s, now);
    recent.push(now);
    s.setItem(NATIVE_REVIEW_LOG_KEY, JSON.stringify(recent));
  } catch {
    // Worst case one extra local attempt, which the OS's own cap absorbs
    // silently. Not worth failing loudly over.
  }
}

// The one hook a native wrapper needs. On the web this is always a no-op: the
// "Rate Hearth" step in ReviewPrompt.tsx shows a plain link to
// NEXT_PUBLIC_APP_STORE_URL instead, and a web page is not an App Store app.
// Inside a Capacitor shell it asks the platform for ITS own sheet, through the
// adapter in src/lib/nativeReview.ts.
//
// On native, SKStoreReviewController (and Google's equivalent) IS the only
// allowed prompt. Apple shows its own sheet, throttles it to three a year,
// may show nothing at all, and never reports back whether a rating was left.
// It must not be tied to a reward (see the block above), and per App Store
// Review Guideline 5.6.1 it must not sit behind a "do you like this app?"
// filter that only routes happy people to it - so on native this is called
// straight from a positive moment, never from the "Love it" button. Takes no
// arguments and returns nothing, because none of those APIs report anything
// useful.
export function requestNativeReview(now: number = Date.now()): void {
  // Web: nothing to ask. Checked before the counter so a browser session can
  // never spend one of a future phone's three yearly attempts.
  if (!isNativePlatform()) return;
  if (!canRequestNativeReview(now)) return;
  recordNativeReviewCall(now);
  void requestPlatformReview();
}
