import type { MetadataRoute } from "next";

// robots.txt: everything public is crawlable; the signed-in app surfaces and
// API routes are not useful to crawlers and are disallowed. Points at the
// generated sitemap (src/app/sitemap.ts).
//
// THIS LIST MIRRORS GUARDED_SEGMENTS in src/lib/supabase/middleware.ts, and
// src/app/robots.test.ts fails if it drifts. It used to name six segments out
// of the twenty-eight that are private, so a crawler was invited to walk
// /chats, /documents, /issues, /taxes, /value, /profile and the rest. Nothing
// leaked - middleware 307s every one of them to /signin - but every crawl
// spent server time on redirects, and the signin URLs those redirects produce
// carry a `next=` parameter that ends up in search indexes and referer
// headers. /join is on the list even though it is deliberately readable
// without a session: a household invite URL contains a token, and a token in
// a search index is a token that has been published.
//
// The disallowed paths have no trailing-slash suffix except where the segment
// is a prefix of a public route, because robots.txt matches by prefix: bare
// "/account" also covers "/account/blocks".

const SITE_URL =
  process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

// One entry per private top-level segment. Alphabetical, so a new one is easy
// to slot in and easy to spot as missing.
export const DISALLOWED_PATHS = [
  "/account",
  "/api/",
  "/ask",
  "/auth",
  "/chats",
  "/contractors",
  "/dashboard",
  "/documents",
  "/emergency",
  "/feedback",
  "/forecast",
  "/home-details",
  "/home-report",
  "/inspection",
  "/issues",
  "/join",
  "/learn",
  "/onboarding",
  // The PWA launch shell. Publicly readable (it is the installed app's
  // start_url and must paint with no session), but it is a branding screen
  // that immediately forwards to the dashboard: there is nothing for a search
  // index to show, and indexing it would only hand searchers a page that
  // bounces them to /signin.
  "/open",
  "/plus",
  "/pro/",
  "/profile",
  "/quote-check",
  "/search",
  "/taxes",
  "/value",
  "/walkthrough",
  "/welcome",
];

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: DISALLOWED_PATHS,
      },
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
