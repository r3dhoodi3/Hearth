import type { Metadata } from "next";
import Link from "next/link";
import GuideCta from "@/components/GuideCta";

// Public SEO guide. Orange County bathroom remodel cost ranges, aggregated
// from published contractor pricing and industry cost reports as of July
// 2026. All figures are typical ranges, never quotes. The signed-in CTA
// points at /contractors?category=remodeling (bathroom work maps to the
// remodeling service category, see SERVICE_CATEGORIES in src/lib/constants.ts).

const SITE_URL =
  process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

export const metadata: Metadata = {
  title: "Bathroom remodel cost in Orange County: typical ranges (2026)",
  description:
    "What a bathroom remodel typically costs in Orange County, broken down by budget, mid-range, and premium tiers, cost per square foot, what drives the price, and how to save. Estimate ranges, not a quote.",
  alternates: {
    canonical: `${SITE_URL}/guides/bathroom-remodel-cost`,
  },
};

const FAQS = [
  {
    q: "How much does a bathroom remodel cost in Orange County?",
    a: "In Orange County, a full bathroom remodel typically runs about $25,000 to $60,000. A guest or hall bath that keeps its existing layout tends to land lower, while a master bathroom usually falls around $40,000 to $50,000, and a luxury remodel with moved plumbing and custom finishes can run $60,000 and up. That is roughly double the national average of around $12,000, mostly because of California labor, permitting, and material costs.",
  },
  {
    q: "What is the cost per square foot to remodel a bathroom in OC?",
    a: "A standard Orange County bathroom remodel typically runs about $150 to $200 per square foot. Premium work with custom tile, higher-end fixtures, and layout changes can push past $300 per square foot. Because bathrooms are small, a high per-square-foot figure still adds up quickly given how much plumbing and tile work fits into a compact space.",
  },
  {
    q: "Do I need a permit to remodel a bathroom in Orange County?",
    a: "It depends on the work. Purely cosmetic updates like paint, a new vanity that reuses the existing plumbing, or new flooring generally do not need a permit. Once you move or add plumbing, change electrical, or alter the layout, most OC cities generally require one. Thresholds vary by city, so check with your local building department before work starts.",
  },
  {
    q: "Does a contractor need a license for a bathroom remodel in California?",
    a: "In California, a contractor needs a CSLB license for any job of $1,000 or more, counting labor and materials combined, as of January 1, 2025. The under-$1,000 exemption does not apply if the job needs any permit, if the person hires helpers, or if a larger job is split into smaller contracts. Most bathroom remodels clear $1,000 easily, so you should confirm a valid license.",
  },
  {
    q: "Is a bathroom remodel worth it at resale?",
    a: "A mid-range bathroom remodel tends to return a larger share of its cost at resale than a high-end one, though neither typically pays for itself dollar for dollar. The stronger case is usually daily use and not deferring a bathroom that is leaking or failing, since those problems only get more expensive the longer they wait.",
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

export default function BathroomRemodelCostGuide() {
  return (
    <main className="mx-auto max-w-2xl px-6 pb-16 pt-10">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(buildFaqJsonLd()).replace(/</g, "\\u003c"),
        }}
      />

      <p className="text-sm">
        <Link href="/guides" className="text-stone-500 hover:text-bark-700 dark:text-stone-400 dark:hover:text-stone-300">
          ← All guides
        </Link>
      </p>

      <h1 className="mt-3 text-2xl font-bold text-stone-900 sm:text-3xl dark:text-stone-100">
        Bathroom remodel cost in Orange County
      </h1>
      <p className="mt-3 text-sm text-stone-500 dark:text-stone-400">
        Typical estimate ranges for OC homeowners, not a quote for your home.
        Prices vary. Data as of July 2026.
      </p>

      {/* Hero cost callout: OC range above the fold, before any national number. */}
      <div className="mt-6 rounded-2xl border border-bark-100 bg-bark-50 p-6 dark:border-bark-700 dark:bg-bark-700/20">
        <p className="text-sm font-medium text-stone-600 dark:text-stone-300">
          Typical Orange County bathroom remodel
        </p>
        <p className="mt-1 text-3xl font-bold text-stone-900 dark:text-stone-100">
          $25,000 to $60,000
        </p>
        <p className="mt-2 text-sm leading-relaxed text-stone-600 dark:text-stone-300">
          A master bath usually lands around $40,000 to $50,000. Luxury
          remodels with moved plumbing and custom finishes run $60,000 and up.
          That is roughly double the national average of about $12,000.
        </p>
      </div>

      <div className="mt-8 space-y-6 text-stone-700 dark:text-stone-300">
        <section>
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
            Cost by tier
          </h2>
          <ul className="mt-2 list-disc space-y-1.5 pl-5 leading-relaxed">
            <li>
              <strong>Budget: about $15,000 to $25,000.</strong> A guest or
              hall bath that keeps the existing layout, with a new vanity,
              toilet, fixtures, and standard tile over the same footprint.
            </li>
            <li>
              <strong>Mid-range: about $25,000 to $45,000.</strong> A full
              remodel with new tile, a larger vanity, updated lighting, and
              minor layout tweaks that do not relocate the main plumbing.
            </li>
            <li>
              <strong>Premium: about $50,000 to $60,000 and up.</strong> A
              master bath or luxury remodel with moved plumbing, custom tile
              work, a walk-in shower, and higher-end fixtures.
            </li>
          </ul>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
            Cost per square foot
          </h2>
          <p className="mt-2 leading-relaxed">
            A standard Orange County bathroom remodel typically runs about{" "}
            <strong>$150 to $200 per square foot</strong>. Premium work with
            custom tile and layout changes can push past{" "}
            <strong>$300 per square foot</strong>. Bathrooms are small, so
            even a modest-looking per-foot figure adds up fast once you fit in
            the plumbing, waterproofing, and tile that a bathroom needs.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
            What affects the price
          </h2>
          <ul className="mt-2 list-disc space-y-1.5 pl-5 leading-relaxed">
            <li>
              <strong>Layout changes.</strong> Moving the toilet, shower, or
              sink means new plumbing runs, which is one of the biggest cost
              jumps.
            </li>
            <li>
              <strong>Tile and materials.</strong> Standard porcelain costs
              far less than custom stone or intricate patterns that take more
              labor to set.
            </li>
            <li>
              <strong>Fixtures and finishes.</strong> The vanity, faucets,
              shower system, and lighting span a wide price range.
            </li>
            <li>
              <strong>Size and condition.</strong> A larger bath, or one
              hiding water damage or old plumbing behind the walls, costs
              more.
            </li>
            <li>
              <strong>Labor.</strong> In a California bathroom budget, labor
              often runs about 40 to 65 percent of the total.
            </li>
          </ul>
        </section>

        {/* Mid-page get-quotes CTA. Cost numbers are never gated; this is an
            optional next step for a reader ready to price their own project. */}
        <section>
          <p className="leading-relaxed">
            Ready to see real numbers for your bathroom?{" "}
            <Link
              href="/contractors?category=remodeling"
              className="font-medium text-bark-700 hover:underline dark:text-stone-300"
            >
              Get quotes from local remodeling pros →
            </Link>
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
            Hiring in California: what to check
          </h2>
          <p className="mt-2 leading-relaxed">
            California requires a CSLB contractor license for any job of{" "}
            <strong>$1,000 or more</strong>, counting labor and materials
            together, as of January 1, 2025. That number went up from $500,
            so many sites still quote the old figure. The under-$1,000
            exemption does not apply if the job needs any permit, if the
            person hires helpers, or if a larger job is split into smaller
            contracts. Most bathroom remodels clear $1,000, so confirm a valid
            license before signing.
          </p>
          <p className="mt-2 leading-relaxed">
            On permits, purely cosmetic work like paint, flooring, or a
            like-for-like vanity swap generally does not need one. Once you
            change plumbing, electrical, or the layout, most OC cities
            generally require a permit. Swapping lighting or a bath fan can
            also trigger California energy-code (Title 24) compliance, while
            simple like-for-like repairs generally do not. Thresholds vary by
            city, so check with your local building department before work
            starts.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
            How to save money
          </h2>
          <ul className="mt-2 list-disc space-y-1.5 pl-5 leading-relaxed">
            <li>
              <strong>Keep the existing layout.</strong> Leaving the toilet,
              shower, and sink where they are avoids the priciest plumbing
              work.
            </li>
            <li>
              <strong>Refinish instead of replace.</strong> Reglazing a tub or
              refacing a vanity can look fresh for a fraction of replacement.
            </li>
            <li>
              <strong>Choose mid-tier tile and fixtures.</strong> The jump
              from standard to custom finishes is where budgets balloon.
            </li>
            <li>
              <strong>Get more than one itemized bid.</strong> Comparing
              detailed quotes protects you more than any single low number.
            </li>
          </ul>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
            A note on resale value
          </h2>
          <p className="mt-2 leading-relaxed">
            A mid-range bathroom remodel tends to return a larger share of its
            cost at resale than a high-end one, though neither typically pays
            for itself dollar for dollar. The stronger reasons are usually
            daily comfort and not putting off a bathroom that is leaking or
            failing, since those problems only get more expensive the longer
            they sit.
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
            Prices vary by home and project. Data as of July 2026, aggregated
            from published contractor pricing and industry cost reports.
            Hearth does not set, guarantee, or bid these prices and is not a
            contractor.
          </p>
        </section>
      </div>

      <GuideCta
        signedInHref="/contractors?category=remodeling"
        signedInLabel="Get bathroom remodel quotes"
      />
    </main>
  );
}
