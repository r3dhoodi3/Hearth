import type { MetadataRoute } from "next";

// robots.txt: everything public is crawlable; the signed-in app surfaces and
// API routes are not useful to crawlers and are disallowed. Points at the
// generated sitemap (src/app/sitemap.ts).

const SITE_URL =
  process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: [
          "/api/",
          "/dashboard",
          "/pro/",
          "/account",
          "/onboarding",
          "/auth",
        ],
      },
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
