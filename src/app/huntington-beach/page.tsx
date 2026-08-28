import type { Metadata } from "next";
import CityLandingPage, {
  buildCityServiceJsonLd,
} from "@/components/CityLandingPage";

// Top-level city landing page for local SEO ("home maintenance Huntington
// Beach" type queries) and as the link target for Nextdoor/chamber
// citations. Follows the same public-page pattern as src/app/guides/: see
// src/lib/supabase/middleware.ts for the allowlist entry and
// src/app/sitemap.ts for the sitemap entry. Shell and value props live in
// CityLandingPage (shared with /fountain-valley); only the housing-stock
// paragraph is city-specific.

const SITE_URL =
  process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

// STATIC (ISR marker). Nothing in this page or in CityLandingPage reads
// cookies(), headers(), searchParams or the database any more: the
// session-aware header and hero CTAs moved to the browser
// (src/components/SessionCta.tsx), as did the closing GuideCta, so this page
// is prerendered once and served from the edge cache. As on /pricing, the
// explicit revalidate is a marker rather than a requirement - it makes the
// static intent visible in `next build` output and gives a future data read
// ISR instead of silently dropping the route back to per-request rendering.
// Anything added here that reads cookies()/headers()/searchParams undoes it.
export const revalidate = 3600;

export const metadata: Metadata = {
  // The root layout's title template appends "| Hearth"; don't repeat it here.
  title: "Home maintenance and local pros in Huntington Beach, CA",
  description:
    "A maintenance plan built for your Huntington Beach home, answers about your own systems, and license-checked local pros when something breaks. Free to start.",
  alternates: {
    canonical: `${SITE_URL}/huntington-beach`,
  },
};

const HOUSING_PARAGRAPH =
  "Huntington Beach has a similar mix of 1960s and 1970s tract homes further inland, plus direct coastal exposure closer to the water. Salt air is hard on exteriors, so paint, metal fixtures, and roofing tend to wear faster near the coast than they would further inland.";

export default function HuntingtonBeachPage() {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(
            buildCityServiceJsonLd("Huntington Beach", SITE_URL, "/huntington-beach")
          ).replace(/</g, "\\u003c"),
        }}
      />
      <CityLandingPage
        city="Huntington Beach"
        housingParagraph={HOUSING_PARAGRAPH}
      />
    </>
  );
}
