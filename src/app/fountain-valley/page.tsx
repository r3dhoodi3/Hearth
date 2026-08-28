import type { Metadata } from "next";
import CityLandingPage, {
  buildCityServiceJsonLd,
} from "@/components/CityLandingPage";

// Top-level city landing page for local SEO ("home maintenance Fountain
// Valley" type queries) and as the link target for Nextdoor/chamber
// citations. Follows the same public-page pattern as src/app/guides/: see
// src/lib/supabase/middleware.ts for the allowlist entry and
// src/app/sitemap.ts for the sitemap entry. Shell and value props live in
// CityLandingPage (shared with /huntington-beach); only the housing-stock
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
  title: "Home maintenance and local pros in Fountain Valley, CA",
  description:
    "A maintenance plan built for your Fountain Valley home, answers about your own systems, and license-checked local pros when something breaks. Free to start.",
  alternates: {
    canonical: `${SITE_URL}/fountain-valley`,
  },
};

const HOUSING_PARAGRAPH =
  "Fountain Valley is mostly single-family tract homes built in the 1960s and 1970s, so a lot of the housing stock is now 50-plus years old, with original plumbing runs and systems well into or past their expected lifespan.";

export default function FountainValleyPage() {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(
            buildCityServiceJsonLd("Fountain Valley", SITE_URL, "/fountain-valley")
          ).replace(/</g, "\\u003c"),
        }}
      />
      <CityLandingPage
        city="Fountain Valley"
        housingParagraph={HOUSING_PARAGRAPH}
      />
    </>
  );
}
