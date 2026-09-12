import { trackServerEvent } from "@/lib/trackServer";
import { legacyKey } from "@/lib/legacyStorage";

// Global Privacy Control (Cal. Civ. Code 1798.135(b)(1); the CPRA treats a
// GPC signal as a valid opt-out-of-sale/share request with no further action
// needed from the person sending it).
//
// OakTend does not sell personal information and does not share it for
// cross-context behavioral advertising (see THIRD_PARTIES and the
// export_metadata.sold_or_shared_for_cross_context_behavioral_advertising
// flag in src/lib/privacy.ts), so honoring this signal changes no behavior:
// there is no sale or share to turn off. What this module exists for is
// proof that the signal was seen and that "honoring" it was a real, logged
// decision rather than silence - see logGpcSignalOncePerSession below.
//
// "Sec-GPC: 1" is the one wire format every implementation (browsers,
// extensions) sends; there is no other value the header takes.
const GPC_HEADER = "sec-gpc";

export function hasGlobalPrivacyControl(headers: Headers): boolean {
  return headers.get(GPC_HEADER) === "1";
}

// Where this gets called: src/middleware.ts, right after attachDeviceCookie()
// builds its response, fired via event.waitUntil so the DB insert never adds
// a round trip to the request it rode in on. Middleware has no user id handy
// (it never decodes the session past updateSession()'s own check), so that
// call passes null; a route handler or server action can call this directly
// with a real user id and cookies()/headers() from next/headers instead.
export const GPC_SEEN_COOKIE = "oaktend_gpc_seen";

// Brand rename cleanup, remove after 2026-12-31. The pre-rename name of the
// marker cookie. Nothing writes it any more: a value found under it is
// promoted onto GPC_SEEN_COOKIE and the old name deleted, so the new name is
// never an empty slot while the reader below prefers it.
const LEGACY_GPC_SEEN_COOKIE = legacyKey(GPC_SEEN_COOKIE);

// The options every write of the marker uses, so a promoted cookie is
// byte-for-byte the same kind of cookie as a freshly set one. No maxAge: it is
// a session cookie, which is the whole point of "once per browser session".
function gpcSeenCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
  };
}

// Minimal shape both NextRequest.cookies/NextResponse.cookies and the
// next/headers cookies() jar satisfy, so this has no hard dependency on
// next/server and works the same in middleware, a route handler, or a test.
export type GpcCookieJar = {
  get(name: string): { value: string } | undefined;
  set(name: string, value: string, options?: Record<string, unknown>): void;
  // Optional: NextResponse.cookies and the next/headers cookies() jar both
  // have it, a plain test double may not, and the promotion below is
  // best-effort either way.
  delete?(name: string | { name: string; path?: string }): void;
};

// Logs the first-party app_event "gpc_signal_seen" (src/lib/trackServer.ts ->
// public.app_events) the first time this browser session sends the GPC
// signal, and never again for that session: a session cookie (no maxAge, so
// it clears when the browser session ends) marks it done. No other behavior
// changes - see the module comment above for why that is the correct, honest
// response for a business that does not sell or share data.
// `requestCookies` is what the browser SENT (NextRequest.cookies);
// `responseCookies` is where the marker is WRITTEN (NextResponse.cookies).
// They must be two different jars in middleware: a ResponseCookies.get()
// only sees cookies set on this response, never the incoming ones, so
// reading the marker from the response jar made the once-per-session guard
// a no-op (red team, 2026-09-03). In a route handler using next/headers
// cookies(), pass the same jar for both.
export async function logGpcSignalOncePerSession(
  headers: Headers,
  requestCookies: Pick<GpcCookieJar, "get">,
  responseCookies: Pick<GpcCookieJar, "set" | "delete">,
  userId: string | null
): Promise<void> {
  if (!hasGlobalPrivacyControl(headers)) return;

  if (requestCookies.get(GPC_SEEN_COOKIE)?.value) return;

  // Brand rename cleanup, remove after 2026-12-31. Only the pre-rename marker:
  // promote its value onto the new name with the same options a fresh marker
  // gets, delete the old name, and treat the session as already logged.
  const legacySeen = requestCookies.get(LEGACY_GPC_SEEN_COOKIE)?.value;
  if (legacySeen) {
    responseCookies.set(GPC_SEEN_COOKIE, legacySeen, gpcSeenCookieOptions());
    responseCookies.delete?.({ name: LEGACY_GPC_SEEN_COOKIE, path: "/" });
    return;
  }

  responseCookies.set(GPC_SEEN_COOKIE, "1", gpcSeenCookieOptions());

  // Only write the event for a signed-in user. Middleware passes null for
  // every request, and an anonymous client can drop the session cookie and
  // resend the header on every hit, which would turn this into an unbounded
  // service-role insert per request (red-team finding, 2026-09-02). For a
  // signed-in user the once-per-session cookie plus the account itself bound
  // the write; for everyone else the cookie alone records that the signal
  // was honored, which is all a no-sale, no-share business needs.
  if (userId === null) return;

  await trackServerEvent(userId, "gpc_signal_seen", {});
}
