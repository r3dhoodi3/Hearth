import { type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

export async function middleware(request: NextRequest) {
  return await updateSession(request);
}

export const config = {
  // Run on everything except Next internals and static assets. The extension
  // list covers everything served straight out of /public (images, the demo
  // audio, fonts, robots/sitemap/manifest), so those requests skip the whole
  // session-refresh round trip. Written as one literal string on purpose:
  // Next.js only accepts a statically analyzable matcher.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|mp3|woff|woff2|txt|xml|webmanifest)$).*)",
  ],
};
