import { type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";
import { attachDeviceCookie } from "@/lib/risk/cookies";

// Opt-in stopwatch for the middleware itself, off unless HEARTH_MW_TIMING=1 is
// set on the server. It exists because the middleware runs before Next starts
// rendering, so its cost is invisible in every page-level measurement: the only
// honest way to answer "how long does the auth path take per request" is to
// time it here. Off by default so production never pays for the header, and it
// never carries anything but a duration.
const TIMING = process.env.HEARTH_MW_TIMING === "1";

export async function middleware(request: NextRequest) {
  const startedAt = TIMING ? performance.now() : 0;

  // updateSession owns the auth decision, exactly as before: it decides whether
  // this path is public, whether to refresh the session, and whether to bounce
  // to /signin. Nothing below reads or changes that.
  const response = await updateSession(request);

  // Plant the first-party device cookie if the browser has not got one yet
  // (src/lib/risk/cookies.ts). It is used for one thing only - noticing that
  // several accounts were created or paid for from the same browser, so the
  // 3-day free trial cannot be farmed forever - and it is applied to whatever
  // updateSession returned, including a redirect. See the matcher note below:
  // this does not change which paths are guarded, only what rides along on the
  // response.
  const withDevice = attachDeviceCookie(request, response);

  if (TIMING) {
    withDevice.headers.set(
      "Server-Timing",
      `mw;dur=${(performance.now() - startedAt).toFixed(2)}`
    );
  }
  return withDevice;
}

export const config = {
  // Run on everything except Next internals and the real /public asset
  // folders. Written as one literal string on purpose: Next.js only accepts a
  // statically analyzable matcher.
  //
  // The exclusions are PREFIXES, deliberately. This used to end with an
  // open-ended `|.*\.(?:svg|png|...|xml)$` alternation, which tested the
  // whole path rather than a directory, so ANY route whose URL happened to
  // end in an asset extension skipped the middleware entirely - including
  // /pro/crm/<uuid>.png and /api/win-card/<id>.png, both of which sit behind
  // a session in the app but were being waved past the guard by a filename.
  // Nothing about a trailing ".png" makes a path public, so the rule now
  // names the directories that actually hold static files:
  //
  //   _next/static, _next/image  - Next's own build output.
  //   favicon.ico                - the one asset Next serves from the root.
  //   demo-vo/, photos/, sw.js, warming.html - everything in /public. The
  //   warming screen must be fetchable with no session: the service worker
  //   precaches it for every user, signed in or not, and a 307 to /signin
  //   here would poison the cache with a redirect instead of the screen.
  //
  // Then the root asset and metadata routes generated out of src/app:
  // /icon.svg, /icon-192.png, /icon-512.png, /apple-icon, /opengraph-image,
  // /manifest.webmanifest, /robots.txt, /sitemap.xml. Every one of them was
  // already answered with no session (each is named in isPublicPath or falls
  // through the unrouted-GET path in src/lib/supabase/middleware.ts) and none
  // of them ever got a device cookie either (attachDeviceCookie skips the
  // metadata prefixes and anything that looks like a file), so nothing about
  // the response changes - the request simply stops paying for a middleware
  // invocation it could never use. An icon fetched by the OS and a robots.txt
  // fetched by a crawler are not navigations, and there is nothing to guard.
  //
  // These are EXACT names, not an extension pattern. The open-ended
  // `.*\.(?:svg|png|...)$` alternation this file used to end with is what let
  // /pro/crm/<uuid>.png and /api/win-card/<id>.png skip the guard, so the rule
  // stays: name the file, never the extension.
  matcher: [
    "/((?!_next/static|_next/image|favicon\\.ico|demo-vo/|photos/|sw\\.js|warming\\.html|robots\\.txt|sitemap\\.xml|manifest\\.webmanifest|icon\\.svg|icon-192\\.png|icon-512\\.png|apple-icon|opengraph-image).*)",
  ],
};
