import type { Metadata } from "next";
import Link from "next/link";
import GuideCta from "@/components/GuideCta";

// Public SEO guide. Orange County kitchen remodel cost ranges, aggregated
// from published contractor pricing and industry cost reports as of July
// 2026. All figures are typical ranges, never quotes. The signed-in CTA
// points at /contractors?category=remodeling (kitchen work maps to the
// remodeling service category, see SERVICE_CATEGORIES in src/lib/constants.ts).

const SITE_URL =
  process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

export const metadata: Metadata = {
  title: "Kitchen remodel cost in Orange County: typical ranges (2026)",
  description:
    "What a kitchen remodel typically costs in Orange County and Southern California, broken down by budget, mid-range, and premium tiers, cost per square foot, what drives the price, and how to save. Estimate ranges, not a quote.",
  alternates: {
    canonical: `${SITE_URL}/guides/kitchen-remodel-cost`,
  },
};

const FAQS = [
  {
    q: "How much does a kitchen remodel cost in Orange County?",
    a: "In Orange County and Southern California, a kitchen remodel typically runs about $50,000 to $75,000 for a full project. The wider range across SoCal spans roughly $35,000 for a budget refresh up to $170,000 or more for a high-end custom kitchen. California labor and permitting tend to add roughly 10 to 20 percent over comparable national costs.",
  },
  {
    q: "What is the cost per square foot for a kitchen remodel?",
    a: "A kitchen remodel typically runs about $75 to $250 per square foot, depending on the level of finish. Stock cabinets and mid-range appliances sit toward the lower end, while custom cabinetry, stone counters, and professional-grade appliances push toward the top.",
  },
  {
    q: "What is the most expensive part of a kitchen remodel?",
    a: "Cabinets are usually the single biggest line item. Custom cabinetry can run around $600 per linear foot, and countertops add up quickly too, with high-end stone reaching $550 or more per square foot installed. Together, cabinets and counters often make up the largest share of a kitchen budget.",
  },
  {
    q: "Do I need a permit and a licensed contractor for a kitchen remodel in California?",
    a: "California requires a CSLB contractor license for any job of $1,000 or more, counting labor and materials combined, as of January 1, 2025. The under-$1,000 exemption does not apply if the job needs any permit, if the person hires helpers, or if a big job is split into smaller contracts. On permits, moving electrical, plumbing, or gas, or taking down a wall, generally requires one in OC cities, while purely cosmetic updates like paint or new cabinet fronts generally do not. Check with your local building department.",
  },
  {
    q: "Does a kitchen remodel add value at resale?",
    a: "Minor and mid-range kitchen remodels tend to recoup a larger share of their cost at resale than upscale ones, though neither usually returns the full amount. Beyond resale, an updated, functional kitchen is one of the rooms buyers and daily users notice most, which is part of why it stays a popular project.",
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

export default function KitchenRemodelCostGuide() {
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
        Kitchen remodel cost in Orange County
      </h1>
      <p className="mt-3 text-sm text-stone-500 dark:text-stone-400">
        Typical estimate ranges for OC and SoCal homeowners, not a quote for
        your home. Prices vary. Data as of July 2026.
      </p>

      {/* Hero cost callout: OC/SoCal range above the fold. */}
      <div className="mt-6 rounded-2xl border border-bark-100 bg-bark-50 p-6 dark:border-bark-700 dark:bg-bark-700/20">
        <p className="text-sm font-medium text-stone-600 dark:text-stone-300">
          Typical Orange County kitchen remodel
        </p>
        <p className="mt-1 text-3xl font-bold text-stone-900 dark:text-stone-100">
          $50,000 to $75,000
        </p>
        <p className="mt-2 text-sm leading-relaxed text-stone-600 dark:text-stone-300">
          Across Southern California the full range runs from about $35,000 for
          a budget refresh to $170,000 or more for a high-end custom kitchen.
          California labor and permits tend to add roughly 10 to 20 percent
          over comparable national costs.
        </p>
      </div>

      <div className="mt-8 space-y-6 text-stone-700 dark:text-stone-300">
        <section>
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
            Cost by tier
          </h2>
          <ul className="mt-2 list-disc space-y-1.5 pl-5 leading-relaxed">
            <li>
              <strong>Budget: about $35,000 to $50,000.</strong> Keeps the
              existing layout, with refaced or stock cabinets, entry-level
              stone or laminate counters, and mid-range appliances.
            </li>
            <li>
              <strong>Mid-range: about $50,000 to $75,000.</strong>{" "}
              Semi-custom cabinets, stone countertops, new appliances, updated
              lighting, and some layout changes.
            </li>
            <li>
              <strong>Premium: about $100,000 to $170,000 and up.</strong>{" "}
              Custom cabinetry, high-end stone, professional-grade appliances,
              and structural changes like moving or removing walls.
            </li>
          </ul>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
            Cost per square foot
          </h2>
          <p className="mt-2 leading-relaxed">
            A kitchen remodel typically runs about{" "}
            <strong>$75 to $250 per square foot</strong>. Where you land
            depends mostly on the finish level: stock cabinets and mid-range
            appliances sit near the bottom, while custom cabinetry, stone
            counters, and pro appliances push toward the top.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
            What affects the price
          </h2>
          <ul className="mt-2 list-disc space-y-1.5 pl-5 leading-relaxed">
            <li>
              <strong>Cabinets.</strong> Usually the biggest line item.
              Custom cabinetry can run around $600 per linear foot, several
              times the cost of stock.
            </li>
            <li>
              <strong>Countertops.</strong> Quartz and standard granite are
              mid-range, while high-end stone can reach $550 or more per
              square foot installed.
            </li>
            <li>
              <strong>Appliances.</strong> A basic suite versus
              professional-grade ranges and built-ins is a wide gap.
            </li>
            <li>
              <strong>Layout changes.</strong> Moving plumbing, gas, or
              electrical, or taking out a wall, adds labor and often a permit.
            </li>
            <li>
              <strong>California labor and permits.</strong> These tend to add
              roughly 10 to 20 percent over comparable national costs.
            </li>
          </ul>
        </section>

        {/* Mid-page get-quotes CTA. Cost numbers are never gated. */}
        <section>
          <p className="leading-relaxed">
            Ready to see real numbers for your kitchen?{" "}
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
            together, as of January 1, 2025. That number rose from $500, so
            many sites still cite the old figure. The under-$1,000 exemption
            does not apply if the job needs any permit, if the person hires
            helpers, or if a larger job is split into smaller contracts. A
            kitchen remodel is well past $1,000, so confirm a valid license
            before signing.
          </p>
          <p className="mt-2 leading-relaxed">
            On permits, moving electrical, plumbing, or gas, or removing a
            wall, generally requires one in OC cities. Purely cosmetic updates
            like paint or new cabinet fronts without wiring or plumbing
            changes generally do not. New lighting, appliances, or windows can
            also trigger California energy-code (Title 24) compliance, while
            like-for-like repairs generally do not. Thresholds vary by city,
            so check with your local building department before work starts.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
            How to save money
          </h2>
          <ul className="mt-2 list-disc space-y-1.5 pl-5 leading-relaxed">
            <li>
              <strong>Keep the existing layout.</strong> Leaving plumbing,
              gas, and walls where they are avoids the costliest structural
              work.
            </li>
            <li>
              <strong>Reface instead of replacing cabinets.</strong> New
              fronts and hardware on sound cabinet boxes cost far less than
              full custom.
            </li>
            <li>
              <strong>Choose semi-custom and quartz.</strong> The jump to full
              custom cabinetry and exotic stone is where budgets climb
              fastest.
            </li>
            <li>
              <strong>Keep appliances you can.</strong> Reusing a recent
              fridge or range trims a big chunk without hurting the result.
            </li>
          </ul>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
            A note on resale value
          </h2>
          <p className="mt-2 leading-relaxed">
            Minor and mid-range kitchen remodels tend to recoup a larger share
            of their cost at resale than upscale ones, though neither usually
            returns the full amount. Beyond resale, the kitchen is one of the
            rooms buyers and daily users notice most, which is part of why it
            stays such a common project even when the numbers do not fully pay
            back.
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
        signedInLabel="Get kitchen remodel quotes"
      />
    </main>
  );
}
