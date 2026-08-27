// The walk-up guard on /reset-password?step=update.
//
// THE HOLE: that page decided which of its two steps to render from the query
// string alone. `?step=update` rendered the "Set a new password" form to
// anybody who typed the URL - no emailed link, no recovery code, nothing. The
// form itself calls supabase.auth.updateUser({ password }), which needs a real
// session, so a signed-OUT stranger only got an error. The problem is the
// person who is already signed in: an unattended laptop, a shared machine, a
// borrowed session. Walk up, type the URL, set a new password, and the account
// is taken over without ever knowing the old one. Supabase's own "Secure
// password change" setting (see docs/SECURITY-OPS.md) is the server-side half
// of that fix and has to be turned on; this is the half that lives in the app.
//
// THE FIX: /auth/callback sets this cookie when, and only when, it just
// exchanged a code for a RECOVERY session (the flow that starts with the
// emailed reset link). The page renders the update step only when the query
// says so AND this cookie is present, so the URL on its own is inert. The
// cookie is httpOnly (script on the page cannot mint it), sameSite lax (it has
// to survive the top-level navigation the emailed link performs), and expires
// in 15 minutes, which is longer than the flow takes and far shorter than a
// session. src/app/reset-password/actions.ts clears it as soon as the password
// is actually changed, so one emailed link is one password change.

export const PW_RECOVERY_COOKIE = "hearth_pwrecovery";

// 15 minutes. The window between clicking the emailed link and typing a new
// password, with room for a slow reader.
export const PW_RECOVERY_MAX_AGE_SECONDS = 15 * 60;

// secure is conditional on production for the same reason every other cookie
// in this app is: a `secure` cookie is dropped on plain http, and local dev
// runs on http://localhost, so hard-coding true here would break the reset
// flow on every developer machine while changing nothing in production.
export function passwordRecoveryCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: PW_RECOVERY_MAX_AGE_SECONDS,
  };
}
