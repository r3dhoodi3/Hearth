// The app-side idle timeout: sign somebody out after 30 days of not using
// Hearth, even though their Supabase refresh token is still perfectly valid.
//
// WHY THIS EXISTS. Supabase issues a short-lived access token (1 hour by
// default) plus a refresh token, and the refresh token does NOT expire on its
// own unless "time-boxed sessions" or "inactivity timeout" are switched on in
// the Supabase dashboard (Authentication, Sessions - see docs/SECURITY-OPS.md).
// On top of that, @supabase/ssr stores the session in a cookie whose Max-Age is
// 400 days. So a laptop or a phone left signed in stays signed in effectively
// forever: every visit silently mints a fresh access token off a refresh token
// that has no end date. That is the "tokens work forever" problem. The
// dashboard setting is the real fix and the owner still has to click it; this
// is the half that lives in the app and works on every plan.
//
// HOW IT WORKS. src/lib/supabase/middleware.ts stamps a first-party cookie with
// the current time on guarded requests. When a request arrives carrying a stamp
// older than IDLE_LIMIT_MS, the middleware revokes the session at Supabase,
// clears the auth cookies, and bounces to /signin?expired=1 with a plain
// "please sign in again" message. Nothing else changes: the user signs in and
// carries on.
//
// EDGE SAFE AND DEPENDENCY FREE ON PURPOSE, same rule as src/lib/authCookie.ts
// and src/lib/risk/cookies.ts: this module is imported by middleware, which runs
// on the Edge runtime, so it must not import next/headers, the Supabase
// clients, "server-only", or anything else. Pure functions over a cookie value,
// which is also what makes them directly unit testable.

// First-party, httpOnly, and holds one thing: the millisecond timestamp of the
// last guarded request this browser made. It is not an analytics id and is
// never joined to anything.
export const ACTIVITY_COOKIE = "hearth_seen";

// 30 days for both sides, homeowner and pro. Long enough that a homeowner who
// only opens Hearth when something breaks is not logged out between problems,
// short enough that an abandoned phone or a borrowed laptop stops being a live
// session within a month.
export const IDLE_LIMIT_MS = 30 * 24 * 60 * 60 * 1000;

// The cookie itself outlives the window it measures. If Max-Age equalled the
// window, an idle browser's cookie would simply vanish and the next request
// would look identical to a first-ever visit, so the timeout could never fire.
// Five extra days is enough room to SEE a stale stamp and act on it.
const COOKIE_MAX_AGE_SECONDS = 35 * 24 * 60 * 60;

// Re-stamping on literally every request would put a Set-Cookie on every
// navigation for no benefit: the value only has to be accurate to within much
// less than the 30-day window. One write an hour is plenty.
const STAMP_INTERVAL_MS = 60 * 60 * 1000;

// Parse the stored stamp. Anything that is not a plain positive integer (hand
// typed, truncated, left over from an older format) reads as "no stamp".
export function readStamp(value: string | undefined | null): number | null {
  if (!value) return null;
  if (!/^\d+$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

// Has this session gone unused for longer than the window?
//
// A MISSING stamp is deliberately NOT treated as expired. Every browser that is
// already signed in when this ships has no cookie yet, and reading that as
// "idle for 30 days" would sign out the entire user base on deploy. It would
// also be a lie: absence proves nothing about when the session was last used.
// A future-dated stamp (clock skew, a hand-edited cookie) is not expired
// either; the worst it can buy is a slightly longer window, and the cookie is
// httpOnly so a page script cannot write one anyway.
export function isIdleExpired(
  value: string | undefined | null,
  now: number
): boolean {
  const stamp = readStamp(value);
  if (stamp === null) return false;
  return now - stamp > IDLE_LIMIT_MS;
}

// Should this response carry a fresh stamp? Yes when there is none yet, and
// yes once an hour after that.
export function shouldStampActivity(
  value: string | undefined | null,
  now: number
): boolean {
  const stamp = readStamp(value);
  if (stamp === null) return true;
  return now - stamp >= STAMP_INTERVAL_MS;
}

// secure is conditional on production for the same reason every other cookie in
// this app is: a Secure cookie is dropped on plain http and local dev runs on
// http://localhost. httpOnly so no page script can extend its own session by
// rewriting the stamp.
export function activityCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: COOKIE_MAX_AGE_SECONDS,
  };
}
