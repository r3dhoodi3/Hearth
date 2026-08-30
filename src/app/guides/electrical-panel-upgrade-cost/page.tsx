import type { Metadata } from "next";
import Link from "next/link";
import GuideCta from "@/components/GuideCta";
import Breadcrumbs, { BreadcrumbJsonLd } from "@/components/Breadcrumbs";

// Public SEO guide. The cost range and the "why" copy are pulled from the same
// REPLACEMENT_INFO.electrical_panel entry the signed-in app uses on the Home
// Health Score (src/lib/health.ts), so the number here matches the number a
// homeowner sees after signing up. Lifespan context mirrors
// DEFAULT_LIFESPANS.electrical_panel (35 years) in the same file.

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
  "Electrical panel upgrade cost: typical range and when you need one";
const DESCRIPTION =
  "The typical cost to upgrade a home electrical panel, when an upgrade is actually needed, 100 vs 200 amp, why permits and a licensed electrician matter, and Orange County specifics.";
const CANONICAL = `${SITE_URL}/guides/electrical-panel-upgrade-cost`;

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
    q: "How much does an electrical panel upgrade cost?",
    a: "An electrical panel upgrade typically runs about $1,500 to $4,000. Where you land depends mostly on the amperage you move to, whether the meter or service wiring also needs upgrading, the permit and inspection, and the electrician's labor. Moving from 100 amp to 200 amp service costs more than a straight like-for-like panel swap.",
  },
  {
    q: "When do I actually need a panel upgrade?",
    a: "Common triggers are adding an EV charger, building an ADU, going solar, or running an aging or overloaded panel that trips often. Older 100-amp panels can run short on capacity for a modern home with a heat pump, EV charger, and other large loads. Some older panels from brands with known safety problems are also frequently recommended for replacement. A licensed electrician can tell you whether your current service can carry what you want to add.",
  },
  {
    q: "Should I go with 100 amp or 200 amp?",
    a: "Most modern homes are served by 200-amp panels, and 200 amp is the common target when you are upgrading, especially if you plan to add an EV charger, heat pump, or solar. A 100-amp service can be fine for a smaller home with modest electrical needs, but it can run short once you stack several large loads. An electrician sizes the service to your home's real and planned loads.",
  },
  {
    q: "Do I need a permit to upgrade my electrical panel?",
    a: "Electrical work like a panel or service upgrade generally requires a permit and an inspection, and the utility usually has to coordinate disconnecting and reconnecting the service. Your electrician typically handles the permit. Confirm one is being pulled, since a permitted, inspected upgrade leaves a clean record. Check with your city's building department for the exact requirement.",
  },
  {
    q: "Why does hiring a licensed electrician matter for panel work?",
    a: "A panel upgrade involves the main service connection and carries real shock and fire risk if it is done wrong. A licensed electrician is trained and accountable for the work, pulls the required permit, and gets it inspected. In California, electrical work at or above the licensing threshold must be done by a licensed contractor, and a permitted job protects you at resale and with your insurer.",
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

export default function ElectricalPanelUpgradeCostGuide() {
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
          { label: "Electrical panel upgrade cost: typical range and when you need one" },
        ]}
      />
      <BreadcrumbJsonLd
        items={[
          { name: "Home", href: "/" },
          { name: "Guides", href: "/guides" },
          { name: "Electrical panel upgrade cost: typical range and when you need one" },
        ]}
        siteUrl={SITE_URL}
      />

      <h1 className="mt-3 text-2xl font-bold text-stone-900 sm:text-3xl dark:text-stone-100">
        Electrical panel upgrade cost: typical range and when you need one
      </h1>
      <p className="mt-3 text-sm text-stone-500 dark:text-stone-400">
        A general planning guide. It is an estimate, not a quote for your home.
        Prices vary.
      </p>

      <div className="mt-6 rounded-2xl border border-bark-100 bg-bark-50 p-5 dark:border-bark-700 dark:bg-bark-700/20">
        <p className="text-sm font-medium text-stone-500 dark:text-stone-400">
          Typical panel upgrade estimate
        </p>
        <p className="mt-1 text-2xl font-bold text-stone-900 dark:text-stone-100">
          $1,500 to $4,000
        </p>
        <p className="mt-2 text-sm leading-relaxed text-stone-600 dark:text-stone-300">
          Moving to 200-amp service, or upgrading the meter and service wiring
          at the same time, tends to land toward the higher end.
        </p>
      </div>

      <div className="mt-8 space-y-6 text-stone-700 dark:text-stone-300">
        <section>
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
            The typical range
          </h2>
          <p className="mt-2 leading-relaxed">
            Upgrading a home electrical panel typically costs about{" "}
            <strong>$1,500 to $4,000</strong>, including the panel, labor, and
            permit. The price is driven mostly by the amperage you move to (200
            amp costs more than 100 amp), whether the meter or service wiring
            also needs upgrading, the permit and inspection, and the
            electrician&apos;s labor. A straightforward like-for-like swap sits
            lower in the range; a full service upgrade with new wiring sits
            higher.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
            When a panel upgrade is actually needed
          </h2>
          <p className="mt-2 leading-relaxed">
            You do not upgrade a panel for its own sake. The common triggers
            are:
          </p>
          <ul className="mt-2 list-disc space-y-1.5 pl-5 leading-relaxed">
            <li>
              <strong>Adding an EV charger.</strong> A Level 2 charger is a
              large, steady load that an older panel may not have room for.
            </li>
            <li>
              <strong>Building an ADU.</strong> A second unit adds significant
              demand and often needs more service capacity.
            </li>
            <li>
              <strong>Going solar.</strong> Some solar and battery installs
              require a 200-amp panel or a specific bus rating.
            </li>
            <li>
              <strong>An aging or overloaded panel.</strong> Older 100-amp
              panels can run short for a modern home, and panels that trip
              often or come from brands with known safety problems are
              frequently recommended for replacement.
            </li>
          </ul>
          <p className="mt-2 leading-relaxed">
            A licensed electrician can do a load calculation and tell you
            whether your current service can carry what you want to add before
            you commit to an upgrade.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
            100 amp vs. 200 amp
          </h2>
          <p className="mt-2 leading-relaxed">
            Amperage is the size of your home&apos;s electrical service. Many
            older homes have 100-amp service, which can be fine for a smaller
            home with modest needs. Most modern homes run 200-amp service, and
            200 amp is the usual target when you upgrade, especially if you are
            planning an EV charger, a heat pump, or solar. The right answer is
            not automatic; an electrician sizes the service to your home&apos;s
            real and planned loads rather than to a rule of thumb.
          </p>
        </section>

        <div className="rounded-xl border border-stone-200 bg-white p-5 text-center dark:border-stone-700 dark:bg-stone-800/40">
          <p className="text-sm leading-relaxed text-stone-600 dark:text-stone-300">
            Not sure whether your panel is due? Hearth can track your
            panel&apos;s age alongside the rest of your home&apos;s systems.
          </p>
          <Link
            href="/homeowner-signup"
            className="btn-primary mt-3 inline-block px-5 py-2"
          >
            Get a home-specific estimate free
          </Link>
        </div>

        <section>
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
            Permits and why licensed matters
          </h2>
          <p className="mt-2 leading-relaxed">
            Electrical work like a panel or service upgrade generally requires a
            permit and an inspection, and the utility usually has to coordinate
            disconnecting and reconnecting the service. This is not a job to
            hand to an unlicensed handyperson. The work touches the main service
            connection and carries real shock and fire risk if it is done
            wrong.
          </p>
          <p className="mt-2 leading-relaxed">
            A licensed electrician is trained and accountable for the work,
            pulls the required permit, and gets it inspected. In California,
            electrical work at or above the state licensing threshold has to be
            done by a licensed contractor, and a permitted, inspected upgrade
            leaves a clean record that protects you at resale and with your
            insurer. Confirm your electrician is pulling the permit, and check
            with your city&apos;s building department for the exact requirement.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
            An Orange County note
          </h2>
          <p className="mt-2 leading-relaxed">
            Orange County homeowners are upgrading panels more often lately,
            largely because of EV chargers, ADUs, and solar plus battery
            installs. Many neighborhoods have older housing stock still on
            100-amp service, so a panel upgrade is a common first step before
            adding any of those. Permit specifics and utility coordination vary
            by city and by whether Southern California Edison or your local
            utility serves your address, so confirm the process locally before
            you schedule work.
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
          <p className="text-xs leading-relaxed text-stone-500 dark:text-stone-500">
            Data as of July 2026. The cost range reflects Hearth&apos;s in-app
            planning figure for an electrical panel upgrade. All figures are
            general estimates, not quotes, and actual prices vary by home,
            scope, and contractor. Hearth does not set or guarantee prices and
            is not a contractor. For safety and permit requirements, rely on a
            licensed electrician and your local building department.
          </p>
        </section>
      </div>

      <GuideCta
        signedInHref="/contractors?category=electrical"
        signedInLabel="Find an electrician for your home"
      />
    </main>
  );
}
