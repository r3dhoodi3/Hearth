import type { Metadata } from "next";
import Link from "next/link";
import GuideCta from "@/components/GuideCta";
import Breadcrumbs, { BreadcrumbJsonLd } from "@/components/Breadcrumbs";

// Public SEO guide. Orange County ADU cost ranges by type, aggregated from
// published contractor pricing and industry cost reports as of July 2026.
// All figures are typical ranges, never quotes. Deliberately avoids a single
// national "average ADU cost" because sources diverge roughly 2x. The
// signed-in CTA points at /contractors?category=remodeling (ADU work maps to
// the remodeling service category, see SERVICE_CATEGORIES in
// src/lib/constants.ts).

const SITE_URL =
  process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

// STATIC (ISR marker). Nothing in this page or in src/app/guides/layout.tsx
// reads cookies(), headers(), searchParams or the database: the session-aware
// CTA moved to the browser (src/components/SessionCta.tsx), so this page is
// prerendered once and served from the edge cache. As on /pricing, the
// explicit revalidate is a marker rather than a requirement - it makes the
// static intent visible in `next build` output and gives a future data read
// ISR instead of silently dropping the route back to per-request rendering.
// Anything added here that reads cookies()/headers()/searchParams undoes it.
export const revalidate = 3600;

// Title/description held once so metadata.title, openGraph, and twitter
// can't drift from each other; the OG image at ./opengraph-image.tsx keeps
// its own literal copy of the title (see that file's comment for why).
const TITLE = "ADU cost in Orange County: typical ranges by type (2026)";
const DESCRIPTION =
  "What an ADU typically costs in Orange County by type: garage conversion, attached, and detached, plus cost per square foot, what drives the price, California ADU rules, and how to save. Estimate ranges, not a quote.";
const CANONICAL = `${SITE_URL}/guides/adu-cost`;

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: {
    canonical: CANONICAL,
  },
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    url: CANONICAL,
    siteName: "Hearth",
    type: "article",
    // og:image comes from the colocated opengraph-image.tsx; Next wires it
    // up automatically for this segment.
  },
  twitter: {
    card: "summary_large_image",
    title: TITLE,
    description: DESCRIPTION,
  },
};

const FAQS = [
  {
    q: "How much does an ADU cost in Orange County?",
    a: "It depends heavily on the type. In Orange County, a garage conversion typically runs about $100,000 to $185,000, an attached ADU about $160,000 to $350,000, and a detached ADU about $200,000 to $450,000 or more. On a per-square-foot basis, OC ADUs commonly run around $300 to $400 per square foot. There is no reliable single national average, since published figures diverge widely.",
  },
  {
    q: "What is the cheapest type of ADU to build?",
    a: "Converting an existing garage is usually the cheapest path to an ADU, typically about $100,000 to $185,000 in Orange County. Because the walls, roof, and foundation already exist, you avoid the biggest costs of new construction. The main expenses become insulation, plumbing, electrical, and finishes to turn the shell into a livable unit.",
  },
  {
    q: "Do I need my city's approval and a hearing to build an ADU in California?",
    a: "California ADU approval is ministerial, which means no public hearings. The city reviews your application against the rules and must decide within 60 days. If it misses that deadline, the application is deemed approved. Cities also cannot cap ADU size below 850 square feet for a studio or one-bedroom, or 1,000 square feet for two or more bedrooms. These rules come from California Government Code sections 66310 through 66342.",
  },
  {
    q: "Do I have to live on the property to rent out an ADU in California?",
    a: "For standard ADUs, there is no statewide owner-occupancy requirement. That rule was made permanent in 2024 under AB 976, so you generally can build an ADU and rent it without living on site, though local rules and other permit conditions still apply. Check your city for any specifics.",
  },
  {
    q: "Is an ADU a good investment?",
    a: "If you are counting on resale, an ADU tends to recoup only a modest share of its cost, often around 41 percent, so resale alone is a weak case. The stronger case is usually rental income, commonly about $1,800 to $4,000 a month for a California ADU, or housing family without paying separate rent or a mortgage elsewhere. Framed as ongoing income or avoided housing cost, the math looks very different than resale.",
  },
];

function buildFaqJsonLd() {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: FAQS.map((f) => ({
      "@type": "Question",
      name: f.q,
      acceptedAnswer: {
        "@type": "Answer",
        text: f.a,
      },
    })),
  };
}

export default function AduCostGuide() {
  return (
    <main className="mx-auto max-w-2xl px-6 pb-16 pt-10">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(buildFaqJsonLd()).replace(/</g, "\\u003c"),
        }}
      />

      {/* Breadcrumb replaces the old "All guides" back link: it still links
          back to /guides, and adds the Home > Guides context the bare back
          link didn't have. Don't render both. */}
      <Breadcrumbs
        items={[
          { label: "Home", href: "/" },
          { label: "Guides", href: "/guides" },
          { label: "ADU cost in Orange County" },
        ]}
      />
      <BreadcrumbJsonLd
        items={[
          { name: "Home", href: "/" },
          { name: "Guides", href: "/guides" },
          { name: "ADU cost in Orange County" },
        ]}
        siteUrl={SITE_URL}
      />

      <h1 className="mt-3 text-2xl font-bold text-stone-900 sm:text-3xl dark:text-stone-100">
        ADU cost in Orange County
      </h1>
      <p className="mt-3 text-sm text-stone-500 dark:text-stone-400">
        Typical estimate ranges for OC homeowners, not a quote for your home.
        Prices vary. Data as of July 2026.
      </p>

      {/* Hero cost callout: OC ranges by type above the fold. No single
          national "average" because published sources diverge roughly 2x. */}
      <div className="mt-6 rounded-2xl border border-bark-100 bg-bark-50 p-6 dark:border-bark-700 dark:bg-bark-700/20">
        <p className="text-sm font-medium text-stone-600 dark:text-stone-300">
          Typical Orange County ADU cost by type
        </p>
        <ul className="mt-2 space-y-1 text-stone-900 dark:text-stone-100">
          <li className="flex items-baseline justify-between gap-3">
            <span>Garage conversion</span>
            <span className="font-bold">$100,000 to $185,000</span>
          </li>
          <li className="flex items-baseline justify-between gap-3">
            <span>Attached ADU</span>
            <span className="font-bold">$160,000 to $350,000</span>
          </li>
          <li className="flex items-baseline justify-between gap-3">
            <span>Detached ADU</span>
            <span className="font-bold">$200,000 to $450,000+</span>
          </li>
        </ul>
        <p className="mt-3 text-sm leading-relaxed text-stone-600 dark:text-stone-300">
          On a per-square-foot basis, OC ADUs commonly run about $300 to $400
          per square foot. We do not quote a single national average, since
          published figures diverge widely.
        </p>
      </div>

      <div className="mt-8 space-y-6 text-stone-700 dark:text-stone-300">
        <section>
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
            Cost by type
          </h2>
          <p className="mt-2 leading-relaxed">
            With ADUs, the type matters more than a budget-versus-premium
            label, because the type decides how much new structure you are
            building from scratch.
          </p>
          <ul className="mt-2 list-disc space-y-1.5 pl-5 leading-relaxed">
            <li>
              <strong>Garage conversion: about $100,000 to $185,000.</strong>{" "}
              The lowest-cost path, since the shell already exists.
            </li>
            <li>
              <strong>Attached ADU: about $160,000 to $350,000.</strong> A new
              unit built onto the existing home, sharing at least one wall.
            </li>
            <li>
              <strong>Detached ADU: about $200,000 to $450,000 and up.</strong>{" "}
              A standalone new building, with its own foundation, roof, and
              utility connections.
            </li>
          </ul>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
            Garage conversion: the cheapest path to an ADU
          </h2>
          <p className="mt-2 leading-relaxed">
            Converting an existing garage is usually the most affordable way
            to add an ADU, typically about $100,000 to $185,000 in Orange
            County. The reason is simple: the walls, roof, and foundation are
            already there, so you skip the largest costs of new construction.
            The budget instead goes toward insulation, drywall, plumbing,
            electrical, a kitchen and bathroom, windows, and finishes to turn
            a bare shell into a comfortable, code-compliant living space.
          </p>
          <p className="mt-2 leading-relaxed">
            The main variables are how much plumbing and electrical the garage
            needs, whether the slab and roof are sound, and how far the
            existing utilities reach. A garage close to the main home&apos;s water,
            sewer, and panel converts more cheaply than one that needs long
            new utility runs.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
            Cost per square foot
          </h2>
          <p className="mt-2 leading-relaxed">
            Orange County ADUs commonly run about{" "}
            <strong>$300 to $400 per square foot</strong>. Detached new builds
            tend toward the higher end because they include a full foundation,
            roof, and separate utility connections, while conversions of
            existing space tend to run lower per foot.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
            What affects the price
          </h2>
          <ul className="mt-2 list-disc space-y-1.5 pl-5 leading-relaxed">
            <li>
              <strong>Type.</strong> Conversion, attached, or detached, in
              rising order of cost.
            </li>
            <li>
              <strong>Size.</strong> More square footage means more materials
              and labor.
            </li>
            <li>
              <strong>Site work and utilities.</strong> New foundation,
              grading, and running water, sewer, gas, and electrical to the
              unit can be a large share of a detached build.
            </li>
            <li>
              <strong>Finishes.</strong> Basic versus high-end kitchens,
              baths, and flooring shift the total meaningfully.
            </li>
            <li>
              <strong>Permits and fees.</strong> Plan check, permit, and any
              local fees vary by city.
            </li>
          </ul>
        </section>

        {/* Mid-page get-quotes CTA. Cost numbers are never gated. */}
        <section>
          <p className="leading-relaxed">
            Ready to see real numbers for your property?{" "}
            <Link
              href="/contractors?category=remodeling"
              className="font-medium text-bark-700 hover:underline dark:text-stone-300"
            >
              Get quotes from local ADU builders →
            </Link>
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
            California ADU rules worth knowing
          </h2>
          <p className="mt-2 leading-relaxed">
            California has made ADUs far easier to build than most homeowners
            expect. Approval is <strong>ministerial</strong>, which means no
            public hearings: the city reviews your application against the
            rules and must decide within <strong>60 days</strong>. If it
            misses that deadline, the application is deemed approved. Cities
            also cannot cap ADU size below 850 square feet for a studio or
            one-bedroom, or 1,000 square feet for two or more bedrooms. For
            standard ADUs there is no statewide owner-occupancy requirement,
            made permanent in 2024 under AB 976, so you generally can build and
            rent without living on site. These rules come from California
            Government Code sections 66310 through 66342.
          </p>
          <p className="mt-2 leading-relaxed">
            An ADU is a structural project, so it needs permits and a licensed
            contractor. California requires a CSLB contractor license for any
            job of <strong>$1,000 or more</strong>, counting labor and
            materials together, as of January 1, 2025. The under-$1,000
            exemption does not apply if the job needs any permit, if the person
            hires helpers, or if a larger job is split into smaller contracts,
            all of which describe an ADU. Structural, electrical, plumbing, and
            gas work generally requires permits in OC cities, and changes to
            lighting, HVAC, windows, or the building envelope can trigger
            California energy-code (Title 24) compliance. Rules vary by city,
            so check with your local building department.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
            How to save money
          </h2>
          <ul className="mt-2 list-disc space-y-1.5 pl-5 leading-relaxed">
            <li>
              <strong>Convert instead of building new.</strong> A garage
              conversion reuses the existing shell and is the cheapest path.
            </li>
            <li>
              <strong>Stay near existing utilities.</strong> Building close to
              the main home&apos;s water, sewer, and panel shortens costly utility
              runs.
            </li>
            <li>
              <strong>Use standard or pre-approved plans.</strong> Many OC
              cities offer pre-approved ADU designs that cut plan-check time
              and design fees.
            </li>
            <li>
              <strong>Keep it single story on the existing slab.</strong>{" "}
              Avoiding a new foundation or second story trims some of the
              biggest structural costs.
            </li>
          </ul>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
            A note on value: think income, not resale
          </h2>
          <p className="mt-2 leading-relaxed">
            If you are counting on resale to justify the cost, an ADU tends to
            recoup only a modest share, often around 41 percent, so resale
            alone is a weak case. The stronger case is ongoing value. A
            California ADU commonly rents for about $1,800 to $4,000 a month,
            which can offset a meaningful part of a mortgage over time. Housing
            a family member is the other common motivation, replacing separate
            rent or a mortgage elsewhere. Framed as monthly income or avoided
            housing cost rather than a resale bump, the math looks very
            different.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
            Frequently asked questions
          </h2>
          <div className="mt-2 space-y-4">
            {FAQS.map((f) => (
              <div key={f.q}>
                <h3 className="font-medium text-stone-900 dark:text-stone-100">{f.q}</h3>
                <p className="mt-1 text-sm leading-relaxed text-stone-600 dark:text-stone-400">
                  {f.a}
                </p>
              </div>
            ))}
          </div>
        </section>

        <section>
          <p className="text-xs leading-relaxed text-stone-500 dark:text-stone-400">
            Prices vary by property and project. Data as of July 2026,
            aggregated from published contractor pricing and industry cost
            reports. Hearth does not set, guarantee, or bid these prices and is
            not a contractor.
          </p>
        </section>
      </div>

      <GuideCta
        signedInHref="/contractors?category=remodeling"
        signedInLabel="Get ADU build quotes"
      />
    </main>
  );
}
