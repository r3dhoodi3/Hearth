import type { Metadata } from "next";
import Link from "next/link";
import GuideCta from "@/components/GuideCta";
import Breadcrumbs, { BreadcrumbJsonLd } from "@/components/Breadcrumbs";

// Public SEO guide. The national range and the "why" copy are pulled from the
// same REPLACEMENT_INFO.roof entry the signed-in app uses on the Home Health
// Score (src/lib/health.ts), so the national number here matches the number a
// homeowner sees after signing up. Lifespan mirrors DEFAULT_LIFESPANS.roof
// (22 years) in the same file. The Orange County / SoCal ranges below are
// local, per-square-foot planning figures and are clearly labeled as such so
// they never get confused with the national baseline.

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
const TITLE = "Roof replacement cost in Orange County: what to expect";
const DESCRIPTION =
  "The typical national cost to replace a roof, plus realistic Orange County ranges for asphalt shingle and tile roofs, what drives the price, when a repair makes more sense, permits, and fire hardening.";
const CANONICAL = `${SITE_URL}/guides/roof-replacement-cost`;

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
    q: "How much does it cost to replace a roof?",
    a: "Nationally, a roof replacement typically runs about $8,000 to $18,000. In Orange County the numbers tend to run higher. An asphalt shingle roof on a typical 2,000 square foot home commonly estimates around $13,000 to $28,000, and a tile roof often estimates $22,000 to $50,000 or more. Where you land depends on the roof's size and pitch, the material, tearing off the old roof, and repairing any rotted decking underneath.",
  },
  {
    q: "Asphalt shingle or tile, which is better in Southern California?",
    a: "This is the real Orange County decision. Asphalt shingles cost less upfront and are faster to install, and a quality architectural shingle holds up well here. Tile costs much more but lasts far longer and suits the Spanish and Mediterranean styles common across the county. Tile is also heavier, so the roof structure has to be able to carry it. Many homeowners weigh the lower upfront cost of shingle against the longer life of tile.",
  },
  {
    q: "When is a roof repair enough instead of a full replacement?",
    a: "A repair usually makes sense when the roof is still well within its expected life and the problem is contained, like a few damaged or lifted shingles, some cracked tiles, or flashing that has pulled away around a vent or chimney. A full replacement tends to make more sense once the roof is near or past its expected life, leaks show up in more than one spot, or the decking underneath has started to rot.",
  },
  {
    q: "Do I need a permit to re-roof my house in Orange County?",
    a: "Re-roofing generally requires a building permit in Orange County cities, and the specifics vary by city. Your contractor usually pulls it, but you should confirm one is being pulled. Check with your city's building department for the exact requirement and any fire-related roofing rules that apply to your address.",
  },
  {
    q: "How long should a new roof last?",
    a: "It depends heavily on the material. Asphalt shingles commonly last around 20 to 25 years, and premium architectural shingles can go longer. Concrete and clay tile roofs can last 50 years or more, though the underlayment beneath the tile usually needs replacing well before the tile itself does. Sun exposure, ventilation, and maintenance all affect where a given roof actually lands.",
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

export default function RoofReplacementCostGuide() {
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
          { label: "Roof replacement cost in Orange County: what to expect" },
        ]}
      />
      <BreadcrumbJsonLd
        items={[
          { name: "Home", href: "/" },
          { name: "Guides", href: "/guides" },
          { name: "Roof replacement cost in Orange County: what to expect" },
        ]}
        siteUrl={SITE_URL}
      />

      <h1 className="mt-3 text-2xl font-bold text-stone-900 sm:text-3xl dark:text-stone-100">
        Roof replacement cost in Orange County: what to expect
      </h1>
      <p className="mt-3 text-sm text-stone-500 dark:text-stone-400">
        A general planning guide with national and Orange County ranges. It is
        an estimate, not a quote for your home. Prices vary.
      </p>

      <div className="mt-6 rounded-2xl border border-bark-100 bg-bark-50 p-5 dark:border-bark-700 dark:bg-bark-700/20">
        <p className="text-sm font-medium text-stone-500 dark:text-stone-400">
          Typical roof replacement estimate
        </p>
        <p className="mt-1 text-2xl font-bold text-stone-900 dark:text-stone-100">
          $8,000 to $18,000 nationally
        </p>
        <p className="mt-2 text-sm leading-relaxed text-stone-600 dark:text-stone-300">
          In Orange County, plan higher: roughly $13,000 to $28,000 for asphalt
          shingle on a typical 2,000 square foot home, and $22,000 to $50,000 or
          more for tile.
        </p>
      </div>

      <div className="mt-8 space-y-6 text-stone-700 dark:text-stone-300">
        <section>
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
            The national baseline
          </h2>
          <p className="mt-2 leading-relaxed">
            Nationally, replacing a roof typically costs about{" "}
            <strong>$8,000 to $18,000</strong>, including materials and labor.
            The main drivers are the size and pitch of the roof, the material,
            tearing off the old roof, and repairing any rotted decking
            underneath. That national figure is a useful starting point, but
            Orange County labor and material costs tend to push local prices
            above it.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
            What it actually runs in Orange County
          </h2>
          <p className="mt-2 leading-relaxed">
            A common way to estimate a roof locally is by the square foot of
            roof surface. On a typical 2,000 square foot home in Southern
            California:
          </p>
          <ul className="mt-2 list-disc space-y-1.5 pl-5 leading-relaxed">
            <li>
              <strong>Asphalt shingle:</strong> roughly $5 to $9.50 per square
              foot, which tends to estimate around{" "}
              <strong>$13,000 to $28,000</strong>.
            </li>
            <li>
              <strong>Tile:</strong> roughly $10 to $20 per square foot, which
              tends to estimate around <strong>$22,000 to $50,000 or more</strong>.
            </li>
          </ul>
          <p className="mt-2 leading-relaxed">
            These are planning ranges, not quotes. A steep or complex roof, a
            second story, extensive decking repair, or a heavier tile system
            all push toward the top of the range or past it.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
            Asphalt vs. tile: the real SoCal decision
          </h2>
          <p className="mt-2 leading-relaxed">
            In Orange County the choice usually comes down to asphalt shingle
            versus tile. Asphalt shingle costs less upfront, installs faster,
            and a quality architectural shingle performs well in this climate.
            Tile costs considerably more, but it lasts far longer and fits the
            Spanish and Mediterranean styles that are so common here.
          </p>
          <p className="mt-2 leading-relaxed">
            Tile is also heavy, so the roof structure has to be built or rated
            to carry it. If you are switching from shingle to tile, a contractor
            may need to confirm the framing can take the added weight. Many
            homeowners end up weighing the lower upfront cost of shingle against
            the longer life of tile.
          </p>
        </section>

        <div className="rounded-xl border border-stone-200 bg-white p-5 text-center dark:border-stone-700 dark:bg-stone-800/40">
          <p className="text-sm leading-relaxed text-stone-600 dark:text-stone-300">
            Want a range tied to your roof&apos;s actual size, age, and
            material instead of a general one?
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
            When a repair beats a replacement
          </h2>
          <p className="mt-2 leading-relaxed">
            You do not always need a whole new roof. A repair is usually the
            right call when the roof is still well within its expected life and
            the problem is contained, such as a handful of lifted or damaged
            shingles, a few cracked tiles, or flashing that has pulled away
            around a vent or chimney. Replacement tends to make more sense once
            the roof is near or past its expected life, water shows up in more
            than one area, or the decking underneath has begun to rot. A leak in
            one spot is a repair question; widespread wear is a replacement
            question.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
            Permits in Orange County
          </h2>
          <p className="mt-2 leading-relaxed">
            Re-roofing generally requires a building permit in Orange County
            cities. The details, fees, and any inspections vary from city to
            city. In most cases the roofing contractor pulls the permit, but it
            is worth confirming a permit is actually being pulled for your job,
            since a permitted roof leaves a clean record for a future sale.
            Check with your city&apos;s building department for the exact
            requirement at your address.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
            Insurance and fire hardening
          </h2>
          <p className="mt-2 leading-relaxed">
            Roofing carries extra weight in Southern California because of
            wildfire risk. The roof is one of the most important parts of a
            fire-hardened home, and many insurers look closely at roof age,
            material, and condition when they write or renew a policy. Class A
            fire-rated roofing, which includes most tile and many modern asphalt
            shingle systems, is the standard many homeowners aim for. If your
            home is in or near a high fire hazard area, ask your contractor
            about fire-rated materials and ask your insurer whether the roof
            affects your coverage or premium. Rules and insurer requirements
            change, so confirm the current specifics for your address.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
            Lifespan by material
          </h2>
          <ul className="mt-2 list-disc space-y-1.5 pl-5 leading-relaxed">
            <li>
              <strong>Asphalt shingle:</strong> commonly around 20 to 25 years,
              longer for premium architectural shingles.
            </li>
            <li>
              <strong>Concrete or clay tile:</strong> often 50 years or more,
              though the underlayment beneath usually needs replacing well
              before the tile does.
            </li>
          </ul>
          <p className="mt-2 leading-relaxed">
            Sun exposure, attic ventilation, and upkeep all shift where a real
            roof lands. Hearth uses a 22-year default for planning a roof&apos;s
            replacement timeline unless it knows more about yours.
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
            Data as of July 2026. The national range reflects Hearth&apos;s
            in-app planning figure for a roof replacement; the Orange County
            ranges are drawn from typical local per-square-foot pricing for a
            2,000 square foot home. All figures are general estimates, not
            quotes, and actual prices vary by home, material, and contractor.
            Hearth does not set or guarantee prices and is not a contractor.
          </p>
        </section>
      </div>

      <GuideCta
        signedInHref="/contractors?category=roof"
        signedInLabel="Find a roofer for your home"
      />
    </main>
  );
}
