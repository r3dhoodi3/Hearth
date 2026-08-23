import { type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

export async function middleware(request: NextRequest) {
  return await updateSession(request);
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
  //   demo-vo/, photos/          - the only two folders in /public.
  //
  // Everything else runs the middleware, which is fine for the extensionless
  // and file-named routes generated out of src/app (/apple-icon,
  // /opengraph-image, /icon.svg, /icon-192.png, /icon-512.png,
  // /manifest.webmanifest, /robots.txt, /sitemap.xml): each is either named
  // in isPublicPath or falls through the unrouted-GET path in
  // src/lib/supabase/middleware.ts, so all of them still answer 200 with no
  // session and none pays an auth round trip.
  matcher: [
    "/((?!_next/static|_next/image|favicon\\.ico|demo-vo/|photos/).*)",
  ],
};
