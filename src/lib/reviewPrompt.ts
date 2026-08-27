// Pure, DOM-light helpers for the "Enjoying Hearth?" review prompt
// (src/components/ReviewPrompt.tsx). Kept separate from the component so the
// trigger rules can be unit tested without rendering anything, and separate
// from src/app/(app)/feedback/actions.ts so the two DB-backed signals it needs
// (already shown/answered, done something meaningful) stay server-only.
//
// The full gate, in order, is:
//   1. not on an excluded page (onboarding, sign-in, checkout, /feedback itself)
//   2. not the first time this browser has ever loaded the app
//   3. the account has never been shown or answered the prompt before
//   4. the account has done something meaningful (claimed a home, posted a
//      job, asked Ask Hearth 3+ times, or a pro applied to one of its jobs)
// (1) and (2) are decided here, client-side, for free. (3) and (4) come from
// the server (getReviewPromptSignals in feedback/actions.ts) because they
// depend on app_feedback, which this account cannot SELECT from directly (see
// migration 0133) - by design, so nobody can probe their own "have I been
// asked" state from the browser.

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

// The trigger helper: combines the two client-only checks above with the two
// booleans the server already computed. Pure and synchronous on purpose, so
// "once per account" and "meaningful-action gate" are each their own
// assertion in the test file rather than folded into one opaque boolean.
export function isEligibleForReviewPrompt(opts: {
  pathname: string;
  isFirstSession: boolean;
  // Any app_feedback row already exists for this account (any kind,
  // including a dismissed-with-X 'prompt_shown' that was never answered).
  alreadyShownOrAnswered: boolean;
  // Claimed a home, posted a job, asked Ask Hearth 3+ times, or a pro applied
  // to one of the account's jobs.
  hasMeaningfulActivity: boolean;
}): boolean {
  if (isExcludedPath(opts.pathname)) return false;
  if (opts.isFirstSession) return false;
  if (opts.alreadyShownOrAnswered) return false;
  if (!opts.hasMeaningfulActivity) return false;
  return true;
}

// The one hook a native wrapper needs to fill in. On the web today this is
// always a no-op: the "Rate Hearth" step in ReviewPrompt.tsx shows a plain
// link to NEXT_PUBLIC_APP_STORE_URL instead. When Hearth ships inside
// Capacitor (or any native shell), THIS is where to call the platform's own
// in-app review API (e.g. @capacitor-community/in-app-review on iOS, the Play
// Core review API on Android) so the native prompt appears instead of - or in
// addition to - the store link. Deliberately takes no arguments and returns
// nothing: the native review APIs are fire-and-forget and never report
// whether the user actually left a rating.
export function requestNativeReview(): void {
  // Capacitor/App Store wiring goes here.
}
