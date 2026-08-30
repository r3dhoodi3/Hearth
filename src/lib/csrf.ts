// Same-origin check for state-changing API routes.
//
// WHAT ALREADY PROTECTS US, so this is understood as a second lock and not the
// only one:
//
//   1. Server Actions. Next.js compares Origin against Host on every action
//      POST and rejects a mismatch. next.config.mjs sets no
//      experimental.serverActions.allowedOrigins, so that default stands.
//   2. The session cookie. @supabase/ssr writes the auth cookie with
//      SameSite=Lax (src/lib/supabase/server.ts only overrides `secure`), and a
//      browser does not attach a Lax cookie to a cross-site POST. So a form on
//      evil.example that posts at one of our routes arrives with no session and
//      is refused by the route's own getUser() check.
//   3. Content type. Every route here reads JSON, and a cross-origin
//      application/json fetch is not a "simple request": it needs a CORS
//      preflight, and we send no CORS headers, so the browser never sends the
//      real request.
//
// WHY ADD THIS ANYWAY. Each of those three is a default owned by somebody else:
// a Supabase or @supabase/ssr release could change the cookie default, a route
// could grow a form-encoded body, a future CORS header could be added for the
// widget and scoped too widely. This check does not depend on any of them, it
// costs two header reads, and it fails in the safe direction.
//
// THE RULE: refuse only on POSITIVE evidence that the request came from another
// site. Absence of evidence is not evidence - a non-browser caller (curl, an
// uptime check, a native app) sends neither header, and refusing those would
// break real things while stopping no attack, because the attack we care about
// is a page in a browser, and browsers always send Origin on POST.

// Hosts are compared, not full origins: behind Vercel the request's own scheme
// is not visible on the request object (x-forwarded-proto carries it), and a
// scheme mismatch is not the thing CSRF turns on.
function hostOf(value: string | null): string | null {
  if (!value) return null;
  try {
    return new URL(value).host.toLowerCase();
  } catch {
    return null;
  }
}

// The host the browser actually addressed. x-forwarded-host first (Vercel and
// any other proxy set it), then Host. Same derivation as
// src/lib/requestOrigin.ts, and the comma split is for chained proxies.
function requestHost(req: Request): string | null {
  const raw =
    req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "";
  const host = raw.split(",")[0].trim().toLowerCase();
  return host || null;
}

/**
 * True when the request is same-origin, or when there is nothing to judge it
 * by. False only when a header proves it came from another site.
 */
export function isSameOrigin(req: Request): boolean {
  // Sec-Fetch-Site is the browser's own answer to this exact question and is
  // not settable by page script. Chrome, Edge, Firefox and Safari 16.4+ all
  // send it. "none" means the user typed the URL or used a bookmark.
  const site = req.headers.get("sec-fetch-site");
  if (site === "same-origin" || site === "same-site" || site === "none") {
    return true;
  }
  if (site === "cross-site") return false;

  // No Sec-Fetch-Site (older Safari, non-browser caller): fall back to Origin.
  const origin = hostOf(req.headers.get("origin"));
  if (!origin) return true; // nothing to judge by - see THE RULE above
  const host = requestHost(req);
  if (!host) return true;
  return origin === host;
}

/**
 * The 403 to return from a state-changing route when {@link isSameOrigin} says
 * no, or null when the request is fine. Written as "return this or carry on" so
 * a route adds exactly two lines:
 *
 *   const bad = sameOriginGuard(req);
 *   if (bad) return bad;
 *
 * The body says nothing useful: a cross-site caller learns only that it was
 * refused, not what the route does or whether a session existed.
 */
export function sameOriginGuard(req: Request): Response | null {
  if (isSameOrigin(req)) return null;
  return new Response(JSON.stringify({ error: "Forbidden" }), {
    status: 403,
    headers: { "content-type": "application/json" },
  });
}
