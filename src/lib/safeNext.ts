// Shared open-redirect guard for ?next=: only ever follow a RELATIVE path.
// An absolute URL (or a protocol-relative //host) in that param would be an
// open redirect an attacker could use to bounce a signed-in victim to a
// look-alike site. Used everywhere ?next= is read across the sign-in and
// sign-up funnel (src/app/signin, /homeowner-signup,
// /contractor-signup, /onboarding, /auth/callback, /auth/confirm) so the
// rule can't drift between them.
export function safeNextPath(value: string | null | undefined): string | null {
  // No C0 control characters (tab, newline, CR, etc.) or DEL: the WHATWG URL
  // parser strips these anywhere in the string, so "/%09/evil.com" would
  // look relative here but resolve to an absolute "https://evil.com" once
  // passed to `new URL()`. Must be rejected before the checks below run.
  if (value && /[\x00-\x1f\x7f]/.test(value)) {
    return null;
  }
  // No backslashes anywhere: browsers normalize "/\evil.com" to
  // "//evil.com", which would sneak an absolute URL past the "//" check.
  if (
    value &&
    value.startsWith("/") &&
    !value.startsWith("//") &&
    !value.includes("\\")
  ) {
    return value;
  }
  return null;
}
