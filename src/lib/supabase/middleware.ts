import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import type { Database } from "@/lib/database.types";
import { hasAuthCookie } from "@/lib/authCookie";
import { requestOrigin } from "@/lib/requestOrigin";
import {
  ACTIVITY_COOKIE,
  activityCookieOptions,
  isIdleExpired,
  shouldStampActivity,
} from "@/lib/sessionActivity";

type CookieToSet = { name: string; value: string; options: CookieOptions };

// Refreshes the auth session on every request and guards app routes.
// Public routes: "/", "/get-started", "/signin", "/reset-password", the
// sign-up pages, "/auth/*". Everything else requires a session.
//
// INVARIANT: NO SERVER ACTION MAY RELY ON THE MIDDLEWARE FOR AUTH. What this
// function does is redirect page navigations, and that is all it is allowed to
// be worth. A server action posts to whatever path it was rendered on, the
// matcher can be narrowed, and a Next release can change when middleware runs
// at all - so every action must call getVerifiedUser() (or assertContractor,
// or its own equivalent) and re-check ownership of every id it was handed,
// exactly as if this file did not exist. Treat a redirect from here as a
// courtesy to the person navigating, never as a security boundary.
export async function updateSession(request: NextRequest) {
  const path = request.nextUrl.pathname;
  const isPublic = isPublicPath(path);

  // Public paths are readable with no session, so the auth check below can
  // only ever produce a result we throw away. Answering them WITHOUT the
  // supabase.auth.getUser() round trip is the difference between "middleware
  // is free" and "every marketing page, every SEO guide, every webhook, and
  // every <Link> prefetch of a public route pays a network hop to Supabase
  // before Next even starts rendering".
  //
  // The cost of skipping it: getUser() is also what silently refreshes an
  // expiring access token and writes the rotated cookie back on the response.
  // On a public path we no longer do that, so a signed-in reader whose token
  // expires while they sit on, say, a guide page keeps a stale cookie until
  // their next protected navigation, where the refresh happens as it always
  // has. The only visible effect is a session-aware public header briefly
  // rendering its signed-out variant; nothing is granted, nothing is lost.
  if (isPublic) {
    return NextResponse.next({ request });
  }

  // Nothing in the app tree serves this path, so there is no private data
  // behind it and no reason to demand a session for it: the only thing at the
  // end of the request is Next's 404. Before this, "/some-missing-page" (a
  // typo, a stale bookmark, an old marketing link) bounced a signed-out
  // visitor to /signin?next=/some-missing-page, so they logged in only to be
  // dropped on a 404 - the site looked like it was hiding the page behind an
  // account. Reads only: an unsafe method aimed at an unrouted path is never
  // something we want to wave through, and it costs a real user nothing.
  if (isReadMethod(request.method) && !isGuardedPath(path)) {
    return NextResponse.next({ request });
  }

  // A request with no `sb-...-auth-token` cookie on it cannot produce a user:
  // the Supabase client below reads the session out of cookies and out of
  // nothing else, so getUser() would parse an empty cookie store, return
  // AuthSessionMissingError with no network call, and fall through to exactly
  // the redirect this line takes. Skipping it saves building a Supabase client
  // per request for the traffic that never had a session in the first place -
  // crawlers, scanners, and anyone following a link into the app signed out.
  // hasAuthCookie is only ever trusted in this direction (see authCookie.ts):
  // false proves absence, true proves nothing and still gets verified below.
  if (!hasAuthCookie(request.cookies.getAll())) {
    return signInRedirect(request);
  }

  let response = NextResponse.next({ request });

  const supabase = createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      // Secure in production, same reasoning (and the same conditional) as
      // src/lib/supabase/server.ts. This is the client that rotates the
      // session cookie on every guarded request, so it writes the auth cookie
      // more often than either of the other two.
      cookieOptions: { secure: process.env.NODE_ENV === "production" },
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet: CookieToSet[]) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          );
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  // WHY THIS IS STILL getUser() AND NOT THE LOCAL getClaims() FAST PATH.
  // getUser() costs a round trip to Supabase's auth server on every guarded
  // request (measured 2026-08-30: 75 ms median from a laptop, and it is the
  // single biggest server-side cost in a signed-in navigation). The project
  // signs access tokens with an asymmetric key (ES256 + a published JWKS), so
  // @supabase/ssr's getClaims() CAN verify them locally with WebCrypto and a
  // process-wide cached key: the same measurement run put that at 3.0 ms.
  //
  // It is not used, because getUser() detects something getClaims() cannot.
  // Measured against the live project on a throwaway session: revoke a session
  // (logout scope "local", which is also what a password change and "sign out
  // other devices" do to the OTHER sessions) and GET /auth/v1/user with that
  // session's still-unexpired access token answers 403 immediately. A local
  // signature check answers "valid" for the rest of the token's hour, and so
  // does PostgREST - RLS checks the signature and the expiry, not whether the
  // session still exists - so a revoked session would keep rendering real
  // signed-in pages with real data until its access token ran out. This one
  // call is what closes that window today, and 72 ms a navigation is the price
  // of closing it. Do not swap it without deciding, on purpose, how long a
  // revoked session may keep reading.
  //
  // IMPORTANT: do not run code between createServerClient and getUser().
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  // A network failure reaching Supabase is NOT proof the user is signed out:
  // getUser() resolves with user null + a retryable fetch error when the
  // auth server is unreachable (wifi blip, outage). If the request carries
  // auth cookies, fail open instead of bouncing a signed-in user to /signin:
  // RLS still guards every read downstream, and the segment error boundaries
  // show a retry screen if data loads fail too.
  //
  // Reads only. The fail-open is a UX cushion for someone LOOKING at a page,
  // and the cost of being wrong there is a rendered shell with no data. On a
  // POST it is a different trade: that's a server action or form submit that
  // WRITES, and the only thing standing between an unverified caller and the
  // handler would be RLS alone. Anything reached with the service-role client
  // (admin lookups, notifications, wallet RPCs) sits outside RLS entirely, so
  // a forged/expired cookie during an outage must not get that far. Unsafe
  // methods keep the strict behavior and bounce to /signin; the user retries
  // the write once auth is back.
  const authUnreachable =
    authError != null &&
    (authError.name === "AuthRetryableFetchError" || authError.status === 0);
  const hasAuthCookies = hasAuthCookie(request.cookies.getAll());
  if (authUnreachable && hasAuthCookies && isReadMethod(request.method)) {
    return response;
  }

  if (!user) {
    return signInRedirect(request);
  }

  // IDLE TIMEOUT (src/lib/sessionActivity.ts). Supabase's refresh token has no
  // expiry of its own unless time-boxed sessions are enabled in the dashboard,
  // and @supabase/ssr keeps it in a 400-day cookie, so a session left alone
  // stays usable indefinitely. This is the app's own answer: 30 days without a
  // guarded request ends the session. The check lives here because this is the
  // one place every signed-in request already passes through.
  const now = Date.now();
  const stamp = request.cookies.get(ACTIVITY_COOKIE)?.value;
  if (isIdleExpired(stamp, now)) {
    // Cookie names collected BEFORE signOut, because signOut writes through the
    // adapter above and rewrites request.cookies as it goes.
    const authCookieNames = request.cookies
      .getAll()
      .map((c) => c.name)
      .filter((name) => name.startsWith("sb-") && name.includes("-auth-token"));
    try {
      // Revoke THIS session's refresh token at Supabase (scope "local"), not
      // every session the user has: the default global scope would sign the
      // owner's phone out because a forgotten iPad went idle for 30 days.
      // Local still hits the auth server, so the token is dead server-side.
      await supabase.auth.signOut({ scope: "local" });
    } catch {
      // Best effort. Clearing the cookies below is what actually ends this
      // browser's session, and it has to happen whether or not the auth server
      // was reachable.
    }
    const url = new URL("/signin", requestOrigin(request));
    url.search = "?expired=1";
    const bounced = NextResponse.redirect(url);
    for (const name of authCookieNames) bounced.cookies.delete(name);
    bounced.cookies.delete(ACTIVITY_COOKIE);
    return bounced;
  }
  if (shouldStampActivity(stamp, now)) {
    // Once an hour at most, so this is not a Set-Cookie on every navigation.
    response.cookies.set(ACTIVITY_COOKIE, String(now), activityCookieOptions());
  }

  return response;
}

// The bounce a guarded request gets when there is no session behind it. Pulled
// out of updateSession so the "no auth cookie at all" short circuit and the
// "the auth server says no" branch give byte-identical answers; they are the
// same outcome reached two ways, and they must not drift apart.
function signInRedirect(request: NextRequest): NextResponse {
  // Origin from requestOrigin, not nextUrl.clone(): nextUrl carries the
  // dev server's bind address (`-H 0.0.0.0`) and strands the browser there.
  const url = new URL("/signin", requestOrigin(request));
  // One unified sign-in for everyone; "/" routes by role after login.
  // The page they were headed to rides along as ?next= so signin can send
  // them back instead of dropping them on the dashboard (GET pages only:
  // a POST's destination would just 404 or sit empty after a redirect).
  const next = request.nextUrl.pathname + request.nextUrl.search;
  url.search =
    request.method === "GET" && next.startsWith("/") && !next.startsWith("//")
      ? `?next=${encodeURIComponent(next)}`
      : "";
  return NextResponse.redirect(url);
}

export function isReadMethod(method: string): boolean {
  return method === "GET" || method === "HEAD";
}

// Every top-level route segment in src/app that serves something private:
// the (app) group's pages plus the signed-in-only pages that sit at the root.
// A path under one of these keeps the sign-in redirect even when the exact
// route does not exist (a bad id under /chats/ still means "you need an
// account here"); anything outside them is unrouted, so the request is let
// through to Next's 404 instead.
//
// KEEP THIS IN SYNC WITH src/app. Adding a new signed-in section means adding
// its segment here - the middleware has no access to Next's route table, so
// this list is the only thing that tells it the difference between "private"
// and "does not exist". The bias is deliberately toward over-listing: a
// segment named here that has no routes just 307s to /signin as it did
// before, while one missing from here would render a page to a stranger only
// if the page itself also skipped its own auth check.
const GUARDED_SEGMENTS = new Set([
  // src/app/(app)
  "account",
  "ask",
  "chats",
  "contractors",
  "dashboard",
  "documents",
  "emergency",
  "feedback",
  "forecast",
  "home-details",
  "home-report",
  "inspection",
  "issues",
  "learn",
  "plus",
  "profile",
  "quote-check",
  "search",
  "taxes",
  "value",
  "walkthrough",
  // Signed-in-only routes at the root of src/app.
  "onboarding",
  "pro",
  "welcome",
  "join",
  // Everything not already named in isPublicPath: an unmatched API route must
  // 401/redirect, never fall through to an HTML 404.
  "api",
  "auth",
  // The PWA launch shell's segment. /open itself is public (isPublicPath runs
  // first and wins), but listing the segment here means a future routed page
  // under /open/ redirects to /signin instead of rendering to a signed-out
  // visitor, which is what the exact-match comment in isPublicPath promises.
  "open",
]);

// Does this path sit under a section that requires a session? First segment
// only: routing in Next is by segment, and a deeper miss (e.g. /account/nope)
// is still inside private territory.
export function isGuardedPath(path: string): boolean {
  const first = path.split("/")[1] ?? "";
  return GUARDED_SEGMENTS.has(first);
}

// Paths readable with no session. Hoisted out of updateSession so the check
// can run BEFORE any Supabase client is built: everything in this list is
// answered without an auth round trip.
export function isPublicPath(path: string): boolean {
  return (
    path === "/" ||
    // The root social-preview image (src/app/opengraph-image.tsx). Link
    // scrapers (iMessage, Slack, Facebook) fetch it with no cookies and no
    // account; without this entry they get a 307 to /signin and every share
    // of the root URL renders with a broken preview. The matcher's extension
    // exclusions never catch it because the route is extensionless.
    // startsWith, not exact: Next can serve metadata variants with generated
    // suffixes, and every path in that family is equally public.
    path.startsWith("/opengraph-image") ||
    // The iOS home-screen icon (src/app/apple-icon.tsx). Same shape as the
    // OG image: extensionless generated PNG, fetched by Safari with no
    // session when someone taps "Add to Home Screen", so it must not bounce
    // to /signin or the installed app gets a screenshot for an icon.
    path.startsWith("/apple-icon") ||
    // The PWA launch shell (src/app/open): the installed app's start_url in
    // the web manifest. It is a force-static branding screen that must render
    // with no session and no auth round trip, or a cold start puts the blank
    // white screen right back where the shell was built to remove it. Nothing
    // is exposed: the page reads no cookies and no data, and the /dashboard
    // it forwards to still does the /signin bounce for a signed-out visitor.
    // Exact match, not a prefix: only the shell itself is public, so a future
    // page under /open/ cannot inherit anonymity by accident.
    path === "/open" ||
    path.startsWith("/get-started") ||
    path.startsWith("/signin") ||
    // Password reset request page: a signed-out user is exactly who needs it,
    // so it must not bounce to /signin.
    path.startsWith("/reset-password") ||
    path.startsWith("/homeowner-signup") ||
    path.startsWith("/contractor-signup") ||
    path.startsWith("/auth") ||
    // Public, account-free emergency guidance (src/app/emergency-help): a
    // panicking homeowner (burst pipe, gas smell) must reach the life-safety
    // steps with no login and no claimed property. The in-app /emergency page
    // stays gated; this is the anonymous twin. A 307 to /signin here would be
    // exactly the wrong outcome in an emergency.
    path === "/emergency-help" ||
    path.startsWith("/emergency-help/") ||
    // A pro's shareable public page: readable with no account by design.
    path.startsWith("/p/") ||
    // Public pros landing page: /p/ pages link here ("Powered by Hearth"),
    // so logged-out visitors must not bounce to /signin. Exact match: the
    // signed-in pro app lives under /pro/ and must stay guarded.
    path === "/pros" ||
    // Public SEO guide pages (src/app/guides/...): informational content
    // meant to be read by anonymous search visitors, not gated behind login.
    path.startsWith("/guides") ||
    // Public pricing page (src/app/pricing): every homeowner in the audit
    // tried to see prices before signing up and hit the /signin wall, which
    // reads as bait. The page is read-only marketing; the actual subscribe
    // flow stays gated under /plus for signed-in users.
    path === "/pricing" ||
    path.startsWith("/pricing/") ||
    // City landing pages (src/app/fountain-valley, src/app/huntington-beach):
    // local SEO + Nextdoor/chamber citation targets, same reasoning as the
    // guide pages above. startsWith with the slash variant too: these pages
    // exist to receive EXTERNAL links (directories, QR codes) that sometimes
    // append a trailing slash, and an exact match would bounce those
    // visitors to /signin.
    path === "/fountain-valley" ||
    path.startsWith("/fountain-valley/") ||
    path === "/huntington-beach" ||
    path.startsWith("/huntington-beach/") ||
    // Privacy policy + Terms of Service + DMCA policy (src/app/privacy,
    // src/app/terms, src/app/dmca): legally need to be readable by anyone,
    // logged in or not, same reasoning as the guide and city pages above. The
    // DMCA page in particular is where a copyright owner with no Hearth
    // account finds the designated agent, so it must never bounce to /signin.
    path === "/privacy" ||
    path.startsWith("/privacy/") ||
    path === "/terms" ||
    path.startsWith("/terms/") ||
    // Contractor B2B terms (src/app/pro-terms): same reasoning as /terms
    // above - linked from the contractor sign-up checkbox, which a signed-out
    // visitor must be able to open before they have an account.
    path === "/pro-terms" ||
    path.startsWith("/pro-terms/") ||
    // AI disclosure (src/app/ai-disclosure): same reasoning as privacy/terms.
    // It is ALSO linked from the inline AI label inside the signed-in app
    // (src/components/AiNotice.tsx), so it has to resolve either way.
    path === "/ai-disclosure" ||
    path.startsWith("/ai-disclosure/") ||
    path === "/dmca" ||
    path.startsWith("/dmca/") ||
    // Public contact form (src/app/contact): the whole point is to give a
    // signed-out visitor a reachable channel now that the site no longer
    // publishes FOUNDER.email directly (see LegalContact.tsx). A signed-out
    // visitor is exactly who needs this - bouncing them to /signin to send a
    // message would defeat the point of building it.
    path === "/contact" ||
    path.startsWith("/contact/") ||
    // Email unsubscribe (src/app/unsubscribe): CAN-SPAM requires the opt-out
    // to work with no login, and it is opened straight from an email by a
    // recipient who usually has no session. The route authenticates via a
    // signed token, not a user session, so a 307 to /signin here would break
    // a legally required unsubscribe.
    path === "/unsubscribe" ||
    // SEO endpoints (src/app/sitemap.ts, robots.ts): crawlers have no
    // session, and a 307 to /signin here would hide the whole site from them.
    path === "/sitemap.xml" ||
    path === "/robots.txt" ||
    // Landing-page demo voiceover audio (public/demo-vo/*.mp3): fetched by
    // the anonymous landing page's demo player; a 307 to /signin here makes
    // the narration silently fail.
    path.startsWith("/demo-vo/") ||
    // Anonymous analytics beacons (src/app/api/track): the landing page fires
    // pre-auth events (hero_demo_play, signup_homeowner, post_job_from_chat)
    // from signed-out visitors via sendBeacon. WITHOUT this entry the
    // middleware 307s the POST to /signin AND converts it to GET, so every
    // anonymous beacon is silently dropped and never recorded. It must not
    // redirect. The route is built to be publicly reachable: it accepts only a
    // fixed client-event allowlist (server-only events like job_won are
    // refused), caps the body at 2048 chars, caps props at 1024, and
    // rate-limits per IP (60 / 5 min) before doing any work.
    path.startsWith("/api/track") ||
    // Cron routes authenticate via CRON_SECRET (Bearer/header/query), not a
    // user session. Vercel Cron sends no session cookie, so WITHOUT this
    // entry every scheduled job would 307 to /signin (an HTML 200!) before
    // its own secret check ever ran, and the platform would report the runs
    // as successful while nothing executed. The secret check inside each
    // route remains the real gate.
    path.startsWith("/api/cron/") ||
    // Uptime probe (src/app/api/health): fetched by an external monitor that
    // has no session and does not follow redirects meaningfully. WITHOUT this
    // entry the middleware 307s it to /signin, and a monitor that DOES follow
    // the redirect scores the sign-in page's HTML 200 as "healthy" while the
    // database is unreachable - the exact outage this endpoint exists to
    // catch. The route reads one anon-visible row and returns a status
    // category only; it exposes nothing a logged-out browser cannot already
    // see.
    path === "/api/health" ||
    // The embeddable rating widget is fetched by THIRD-PARTY sites (a pro's
    // own website embeds it), so there is never a session on the request. It
    // serves aggregate-only public data by design.
    path.startsWith("/api/pro-widget/") ||
    // Referral invite OG share card (src/app/api/invite-card/[code]): a PUBLIC,
    // unauthenticated image fetched by social scrapers when a homeowner shares
    // their invite link. WITHOUT this entry the middleware 307s the scraper to
    // /signin, so the referral card never renders. The route carries only
    // low-sensitivity public data (an inviter's first name + city/state) and
    // resolves the code with the admin client precisely because there is no
    // session. The other two share cards (win-card, review-card) deliberately
    // stay gated: they 401 without a session and are downloaded by the
    // authenticated pro, never fetched by a scraper.
    path.startsWith("/api/invite-card/") ||
    // Home Wins OG share card (src/app/api/wins-card/[code]): same public share
    // pattern as invite-card above - an unauthenticated image fetched by social
    // scrapers when a homeowner shares their wins link. WITHOUT this entry the
    // middleware 307s the scraper (and any logged-out recipient) to /signin, so
    // the card never renders. It carries only a first name + non-identifying
    // positive win counts (no address, value, or dollar figure - privacy
    // verified) and resolves the code with the admin client since there is no
    // session. Remove this line if the Home Wins feature is removed.
    path.startsWith("/api/wins-card/") ||
    // Stripe webhook authenticates via its signature, not a user session, and
    // must never be redirected: Stripe doesn't follow redirects and would treat
    // the 307 as a failed delivery, so deposits would never be credited.
    path.startsWith("/api/stripe/webhook") ||
    // Checkr webhook (0057): same reasoning as Stripe above - authenticates
    // via X-Checkr-Signature, not a user session, and a 307 here would read
    // as a failed delivery, so background check results would never land.
    path.startsWith("/api/checkr/webhook") ||
    // Twilio inbound SMS webhook: authenticates via Twilio's request
    // signature, not a user session, same reasoning as the Stripe/Checkr
    // webhooks above - a 307 here would read as a failed delivery and drop
    // inbound texts (e.g. SMS opt-out/STOP handling) silently.
    path === "/api/twilio/inbound" ||
    // Household QR join links (src/app/join/household/[token]): scanned by
    // a phone camera with no session of its own. The page itself (not this
    // middleware) has to show the sign-in-or-sign-up chooser when signed
    // out, so it must be reachable signed out in the first place - a bounce
    // to /signin here would only ever offer one of the two paths. The page
    // still requires a session before it will redeem the token; this only
    // controls whether the page renders at all.
    path.startsWith("/join/")
  );
}
