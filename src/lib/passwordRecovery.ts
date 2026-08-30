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

// The redirectTo every resetPasswordForEmail() call in the app hands Supabase.
// One function so the two callers (the forgot-password form and the "set a
// password" link for Google-only accounts) cannot drift apart.
//
// WHY type=recovery IS WRITTEN HERE. /auth/callback sets the recovery cookie on
// exactly one signal: ?type=recovery on the request that lands back on our
// site. Whether Supabase itself puts that parameter on the redirect depends on
// the auth flow and the email template, and when it does not arrive the reset
// silently falls back to step one - the user clicks the emailed link and is
// asked for their email again, which is the "the forgot-password link doesn't
// even work" report. Putting it on the URL we hand over means it is there by
// construction.
//
// This does NOT widen anything. `type` was already read straight off the URL,
// so anyone who could craft a callback URL could already append it; and the
// cookie is only ever set inside the `if (code)` branch, AFTER
// exchangeCodeForSession has succeeded. A made-up ?type=recovery with no valid
// code still gets nothing. See the long note in src/app/auth/callback/route.ts.
export function passwordRecoveryRedirectTo(origin: string): string {
  return `${origin}/auth/callback?type=recovery&next=${encodeURIComponent(
    "/reset-password?step=update"
  )}`;
}

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
