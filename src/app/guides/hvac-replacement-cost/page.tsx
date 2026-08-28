import type { Metadata } from "next";
import Link from "next/link";
import GuideCta from "@/components/GuideCta";

// Public SEO guide. Cost range and "why" copy are pulled from the same
// REPLACEMENT_INFO.hvac entry the signed-in app uses on the Home Health
// Score (src/lib/health.ts), so the number here matches the number a
// homeowner sees after signing up. Lifespan (18 years) mirrors
// DEFAULT_LIFESPANS.hvac in the same file.

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

export const metadata: Metadata = {
  title: "HVAC replacement cost: typical range and what changes it",
  description:
    "The typical national cost to replace a home HVAC system, what drives the price up or down, central AC vs. heat pump, and when a repair makes more sense than replacement.",
  alternates: {
    canonical: `${SITE_URL}/guides/hvac-replacement-cost`,
  },
};

const FAQS = [
  {
    q: "How much does it cost to replace an HVAC system?",
    a: "Nationally, replacing a home HVAC system typically runs about $5,000 to $10,000. Where you land in that range depends mostly on the size of unit your home needs, its efficiency rating, whether the ductwork needs work, and the labor to install it and charge the refrigerant.",
  },
  {
    q: "Should I get a heat pump instead of central AC?",
    a: "A standard central air conditioner only cools, so you still need a separate furnace for heat. A heat pump does both jobs with one outdoor unit, moving heat in or out depending on the season, and tends to be more efficient in mild climates. It usually costs more upfront than a straight AC swap, but replaces two systems with one.",
  },
  {
    q: "When should I repair my HVAC instead of replacing it?",
    a: "Repair usually makes sense for a system that is still well within its typical 18-year lifespan and has one clear, contained problem, like a failed capacitor or a refrigerant leak in an otherwise sound unit. Replacement tends to make more sense once the system is at or past that typical age, needs a major component like the compressor or heat exchanger, or keeps coming back for repeat repairs.",
  },
  {
    q: "Does living near the coast in Orange County affect my HVAC system?",
    a: "Coastal Orange County communities generally run milder and see less extreme heat than inland areas, so an AC system there often runs fewer hours per year. Less run time is generally easier on a system, though your specific unit's age, install quality, and maintenance history still matter more than location alone.",
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

export default function HvacReplacementCostGuide() {
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
        HVAC replacement cost: typical range and what changes it
      </h1>
      <p className="mt-3 text-sm text-stone-500 dark:text-stone-400">
        A general, national planning guide. It is not a quote for your home.
      </p>

      <div className="mt-8 space-y-6 text-stone-700 dark:text-stone-300">
        <section>
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
            The typical range
          </h2>
          <p className="mt-2 leading-relaxed">
            Nationally, replacing a home HVAC system typically costs about{" "}
            <strong>$5,000 to $10,000</strong>, including equipment and
            installation. A straightforward, similarly sized system in an
            average home tends to land toward the lower end; larger homes,
            higher-efficiency equipment, or a system that needs ductwork
            changes tend to land higher.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
            What actually drives the price
          </h2>
          <p className="mt-2 leading-relaxed">
            Four things mostly decide where you land in that range:
          </p>
          <ul className="mt-2 list-disc space-y-1.5 pl-5 leading-relaxed">
            <li>
              <strong>Size.</strong> The unit your home actually needs.
              Bigger is not always better, an oversized system cycles
              inefficiently.
            </li>
            <li>
              <strong>Efficiency rating.</strong> Higher-efficiency equipment
              costs more upfront.
            </li>
            <li>
              <strong>Ductwork.</strong> Whether the existing ducts need
              repair or replacement.
            </li>
            <li>
              <strong>Labor.</strong> Installing the system and charging the
              refrigerant.
            </li>
          </ul>
          <p className="mt-2 leading-relaxed">
            Homes that need duct work done at the same time see the biggest
            jump above the typical range.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
            Central AC vs. heat pump
          </h2>
          <p className="mt-2 leading-relaxed">
            A standard central air conditioner only cools your home, so you
            still need a separate furnace for heat. A heat pump handles both
            heating and cooling with one outdoor unit, moving heat in during
            winter and out during summer, and tends to be more efficient in
            milder climates where temperatures rarely swing to extremes. It
            typically costs more upfront than a plain AC swap, but it is
            replacing what would otherwise be two separate systems.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
            When repair beats replacement
          </h2>
          <p className="mt-2 leading-relaxed">
            An HVAC system has a typical working life of about 18 years. If
            yours is well under that and the issue is a single, contained
            part, like a capacitor, blower motor, or a refrigerant leak in an
            otherwise sound system, a repair is usually the faster and
            cheaper path. Replacement tends to make more sense once the
            system is at or past its typical lifespan, needs a major part
            like the compressor or heat exchanger, or has needed more than
            one repair recently.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
            A coastal Orange County note
          </h2>
          <p className="mt-2 leading-relaxed">
            Coastal Orange County communities generally run milder than
            inland Southern California, with less extreme heat, so an AC
            system there often runs fewer hours in a typical year than the
            same system further inland. Less run time is generally easier on
            equipment, though a system&apos;s age, install quality, and
            maintenance history still matter more than location on their
            own.
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
      </div>

      <GuideCta
        signedInHref="/walkthrough"
        signedInLabel="Check your HVAC's actual age"
      />
    </main>
  );
}
