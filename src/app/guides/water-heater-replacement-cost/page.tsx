import type { Metadata } from "next";
import Link from "next/link";
import GuideCta from "@/components/GuideCta";
import Breadcrumbs, { BreadcrumbJsonLd } from "@/components/Breadcrumbs";

// Public SEO guide. Cost range and "why" copy are pulled from the same
// REPLACEMENT_INFO.water_heater entry the signed-in app uses on the Home
// Health Score (src/lib/health.ts), so the number a search visitor sees here
// matches the number a homeowner sees after signing up. Lifespan (11 years)
// mirrors DEFAULT_LIFESPANS.water_heater in the same file.

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
const TITLE =
  "Water heater replacement cost: typical range and what changes it";
const DESCRIPTION =
  "The typical national cost to replace a water heater, what drives the price up or down, tank vs. tankless, and when a repair makes more sense than a full replacement.";
const CANONICAL = `${SITE_URL}/guides/water-heater-replacement-cost`;

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
  },
  twitter: {
    card: "summary_large_image",
    title: TITLE,
    description: DESCRIPTION,
  },
};

const FAQS = [
  {
    q: "How much does it cost to replace a water heater?",
    a: "Nationally, a typical water heater replacement runs about $1,200 to $3,500. Where you land in that range depends mostly on whether you're replacing like-for-like or switching to tankless, gas vs. electric, the tank's capacity, and whether venting or plumbing needs to change.",
  },
  {
    q: "Is a tankless water heater worth the extra cost?",
    a: "It depends on how long you'll stay in the home and how much hot water you use. Tankless units cost more upfront and often need bigger gas or electrical service, but they last longer and heat water only on demand. A standard tank costs less to install and is simpler to service, which is why most replacements are still tank-for-tank.",
  },
  {
    q: "When should I repair instead of replace a water heater?",
    a: "Repair usually makes sense for a younger unit with one clear problem, such as a bad thermostat, heating element, or pilot assembly. Replacement usually makes more sense once the tank itself is leaking, the unit is near or past its typical 11-year lifespan, or you're already paying for more than one repair.",
  },
  {
    q: "Does hard water affect a water heater in Orange County?",
    a: "Much of Orange County has moderately hard water, and hard water speeds up sediment buildup inside a tank. That sediment layer sits between the burner or element and the water, so the unit works harder and can wear out sooner than the typical range above. Flushing the tank on a regular schedule helps slow that buildup.",
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

export default function WaterHeaterReplacementCostGuide() {
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
          { label: "Water heater replacement cost: typical range and what changes it" },
        ]}
      />
      <BreadcrumbJsonLd
        items={[
          { name: "Home", href: "/" },
          { name: "Guides", href: "/guides" },
          { name: "Water heater replacement cost: typical range and what changes it" },
        ]}
        siteUrl={SITE_URL}
      />

      <h1 className="mt-3 text-2xl font-bold text-stone-900 sm:text-3xl dark:text-stone-100">
        Water heater replacement cost: typical range and what changes it
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
            Nationally, replacing a water heater typically costs about{" "}
            <strong>$1,200 to $3,500</strong>, including the unit and
            installation. Most tank-style, like-for-like replacements land
            toward the lower end of that range; tankless units, larger
            capacities, or jobs that need new venting or plumbing tend to land
            higher.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
            What actually drives the price
          </h2>
          <p className="mt-2 leading-relaxed">The biggest factors:</p>
          <ul className="mt-2 list-disc space-y-1.5 pl-5 leading-relaxed">
            <li>
              <strong>Tank vs. tankless.</strong> Tankless costs more upfront.
            </li>
            <li>
              <strong>Fuel type.</strong> Gas vs. electric.
            </li>
            <li>
              <strong>Capacity.</strong> The tank&apos;s size.
            </li>
            <li>
              <strong>Venting or plumbing changes.</strong> Anything needed
              to fit the new unit in.
            </li>
          </ul>
          <p className="mt-2 leading-relaxed">
            A straightforward swap, same fuel type and similar size, in the
            same spot, is the cheapest version of this job. Anything that
            touches the vent, gas line, or electrical circuit adds labor and
            often a permit.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
            Tank vs. tankless
          </h2>
          <p className="mt-2 leading-relaxed">
            A standard tank water heater keeps a set volume of hot water ready
            to go, costs less to buy and install, and is the simplest to
            service, but it takes up a closet&apos;s worth of space and can run out
            of hot water during heavy use. A tankless unit heats water only as
            you use it, takes up far less room, and typically lasts longer,
            but it costs more upfront, sometimes needs bigger gas or
            electrical service to keep up with demand, and is a bit more
            involved to install and maintain.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
            When repair beats replacement
          </h2>
          <p className="mt-2 leading-relaxed">
            A water heater has a typical working life of about 11 years. If
            yours is younger than that and the problem is something specific,
            like a faulty thermostat, heating element, or pilot assembly, a
            repair is usually the cheaper and faster fix. Replacement tends to
            make more sense once the tank itself is leaking (tanks don&apos;t
            get patched), the unit is at or past its typical lifespan, or
            you&apos;re facing a second repair on the same unit within a short
            span.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
            An Orange County note
          </h2>
          <p className="mt-2 leading-relaxed">
            Much of Orange County has moderately hard water, and hard water
            speeds up mineral and sediment buildup inside a tank. That layer
            of sediment sits between the burner or heating element and the
            water, so the unit works harder to do the same job, which can
            shorten its working life below the typical range above. Flushing
            the tank on a regular schedule (see our{" "}
            <Link
              href="/guides/home-maintenance-schedule"
              className="text-bark-700 hover:underline dark:text-stone-300"
            >
              home maintenance schedule guide
            </Link>
            ) helps slow that buildup, though it doesn&apos;t undo it entirely.
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
        signedInLabel="Check your water heater's actual age"
      />
    </main>
  );
}
