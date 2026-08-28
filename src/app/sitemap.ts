import type { MetadataRoute } from "next";
import { createAdminClient } from "@/lib/supabase/admin";

// Sitemap for crawlers: the public landing pages, the two city landing pages
// (src/app/fountain-valley, src/app/huntington-beach), the Privacy/Terms/DMCA
// pages (src/app/privacy, src/app/terms, src/app/pro-terms, src/app/dmca),
// the AI disclosure (src/app/ai-disclosure), the public contact form
// (src/app/contact - the replacement for the FOUNDER.email mailto links
// those legal pages used to show), the public guide pages
// (src/app/guides/..., anon-readable, see the middleware allowlist), plus
// every pro's public page (/p/..., anon-readable by design). The contractors
// table is NOT publicly readable, so the list comes from the service-role
// admin client; only id/slug ever leave the query, both of which are already
// public via the /p/ pages themselves. That client bypasses RLS, so the pro
// query below has to re-state browse_pros()'s own visibility filters by hand
// (claimed row + launch-market gate) or the sitemap advertises pros the
// directory hides. Slug URLs are preferred (0043); rows without a slug
// (pre-migration) fall back to their UUID URL.

const SITE_URL =
  process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

// Regenerate at most once an hour, and serve the cached XML in between.
//
// This file is read by crawlers, never by a signed-in person: it touches no
// cookies and no request headers, and its one query runs through the
// service-role admin client, so every visitor gets byte-identical output.
// Without this, the admin-client fetch underneath opts the route out of Next's
// data cache and every crawler hit re-runs the pro query and rebuilds the whole
// document. An hour is well inside how often a crawler re-reads a sitemap, and
// a pro who claims a page is picked up on the next regeneration rather than the
// next request - which is the same day either way, and Google's own recrawl
// latency dwarfs it.
export const revalidate = 3600;

// Keep in sync with src/app/guides/page.tsx (GUIDES) - every guide listed
// there needs an entry here or it's unreachable by crawlers with no
// sitemap signal.
const GUIDE_PATHS = [
  "/guides",
  "/guides/water-heater-replacement-cost",
  "/guides/hvac-replacement-cost",
  "/guides/roof-replacement-cost",
  "/guides/electrical-panel-upgrade-cost",
  "/guides/kitchen-remodel-cost",
  "/guides/bathroom-remodel-cost",
  "/guides/adu-cost",
  "/guides/slab-leak-signs",
  "/guides/home-maintenance-schedule",
  "/guides/is-my-contractor-quote-fair",
  "/guides/contractor-deposit-rules-california",
  "/guides/socal-home-maintenance-calendar",
];

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const entries: MetadataRoute.Sitemap = [
    {
      url: `${SITE_URL}/`,
      changeFrequency: "weekly",
      priority: 1,
    },
    {
      url: `${SITE_URL}/pros`,
      changeFrequency: "weekly",
      priority: 0.8,
    },
    // Public and account-free (see isPublicPath in
    // src/lib/supabase/middleware.ts), each with its own metadata and
    // canonical, and each a real entry point: /pricing is where a homeowner
    // checks the cost before signing up, and /emergency-help is the anonymous
    // burst-pipe/gas-smell page someone reaches by searching mid-panic.
    // Neither was listed here, so crawlers had no sitemap signal for them.
    {
      url: `${SITE_URL}/pricing`,
      changeFrequency: "monthly",
      priority: 0.8,
    },
    {
      url: `${SITE_URL}/emergency-help`,
      changeFrequency: "monthly",
      priority: 0.8,
    },
    {
      url: `${SITE_URL}/fountain-valley`,
      changeFrequency: "monthly",
      priority: 0.8,
    },
    {
      url: `${SITE_URL}/huntington-beach`,
      changeFrequency: "monthly",
      priority: 0.8,
    },
    {
      url: `${SITE_URL}/privacy`,
      changeFrequency: "monthly",
      priority: 0.3,
    },
    {
      url: `${SITE_URL}/terms`,
      changeFrequency: "monthly",
      priority: 0.3,
    },
    {
      url: `${SITE_URL}/pro-terms`,
      changeFrequency: "monthly",
      priority: 0.3,
    },
    {
      url: `${SITE_URL}/ai-disclosure`,
      changeFrequency: "monthly",
      priority: 0.3,
    },
    {
      url: `${SITE_URL}/dmca`,
      changeFrequency: "monthly",
      priority: 0.3,
    },
    {
      url: `${SITE_URL}/contact`,
      changeFrequency: "monthly",
      priority: 0.3,
    },
    ...GUIDE_PATHS.map((path) => ({
      url: `${SITE_URL}${path}`,
      changeFrequency: "monthly" as const,
      priority: 0.7,
    })),
  ];

  try {
    const admin = createAdminClient();
    // Cast: the generated types predate the slug column (0043) and
    // database.types.ts is not regenerated here.
    // Same two hard filters browse_pros() applies (0112:189-193), so the
    // sitemap can never advertise a pro the directory itself refuses to show:
    //
    //   user_id is not null   - an unclaimed/seeded row has no owner behind
    //                           it, so /p/<id> is a page nobody stands behind.
    //   serves_orange_county  - the launch-market gate. A pro outside it is
    //                           unreachable through the product, so listing
    //                           them in the sitemap is a crawlable dead end.
    //
    // Without these, the service-role read here bypassed both (RLS does not
    // apply to the admin client) and published rows the homeowner-facing
    // browse list hides.
    const { data, error } = await (admin.from("contractors") as any)
      .select("id, slug")
      .not("user_id", "is", null)
      .eq("serves_orange_county", true)
      .order("created_at", { ascending: true })
      .limit(5000);
    if (!error && Array.isArray(data)) {
      for (const row of data as { id: string; slug: string | null }[]) {
        entries.push({
          url: `${SITE_URL}/p/${row.slug ?? row.id}`,
          changeFrequency: "weekly",
          priority: 0.6,
        });
      }
    }
  } catch {
    // Env/DB hiccup: still serve the static entries rather than 500 the
    // sitemap route.
  }

  return entries;
}
