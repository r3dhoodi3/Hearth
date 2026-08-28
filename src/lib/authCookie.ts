// "Could this request possibly carry a session?", answered from the cookie
// names alone.
//
// EDGE SAFE AND DEPENDENCY FREE ON PURPOSE. This module is imported by
// src/lib/supabase/middleware.ts (Edge runtime) as well as by server
// components, so it must not import next/headers, the Supabase clients,
// "server-only", or anything else. It is a pure predicate over a list of
// cookie names, which is why it can be unit tested directly.
//
// WHAT IT IS FOR. Supabase's @supabase/ssr clients store the session in
// cookies named `sb-<project-ref>-auth-token` (plus `.0`/`.1` chunk suffixes
// when the token is too big for one cookie). If not one cookie of that shape
// is present, there is no stored session, and every auth call that follows can
// only ever resolve to "signed out". Checking that first lets a public page
// skip building a Supabase client at all.
//
// WHAT IT IS NOT. It is NOT a claim that the visitor is signed in, and nothing
// may treat it as one. A cookie of the right NAME proves nothing about its
// contents: it can be expired, revoked, or typed in by hand. It is only ever
// safe in the direction it is used here - as proof of ABSENCE. `false` means
// "there is definitely no session, do not bother asking"; `true` means "ask
// properly", which is exactly what the callers then do (getVerifiedUser(), or
// middleware's own supabase.auth.getUser()).
export function hasAuthCookie(cookies: { name: string }[]): boolean {
  return cookies.some(
    (c) => c.name.startsWith("sb-") && c.name.includes("-auth-token")
  );
}
