import type { Metadata } from "next";
import GuideCta from "@/components/GuideCta";
import Breadcrumbs, { BreadcrumbJsonLd } from "@/components/Breadcrumbs";

// Public SEO guide and the intended shareable asset for the launch market:
// this is the page a Facebook group admin links to and the page a
// door-hanger QR code points at. Written coastal-SoCal-generic on purpose
// (it needs to read as honest and useful in any coastal SoCal city, not just
// the launch market) with Fountain Valley / Huntington Beach mentioned once
// as Hearth's home market rather than framing the whole page around them.
// Cadence claims mirror src/app/guides/home-maintenance-schedule/page.tsx;
// the climate-specific timing (AC strain, termite swarms, Santa Ana winds,
// first rain) is standard, widely published Southern California guidance,
// not a local statistic.

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
  "Coastal Southern California home maintenance calendar, month by month";
const DESCRIPTION =
  "A month-by-month maintenance calendar for coastal Southern California homes: AC filters, termite swarm season, Santa Ana wind prep, first-rain checks.";
const CANONICAL = `${SITE_URL}/guides/socal-home-maintenance-calendar`;

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

interface MonthBlock {
  month: string;
  theme: string;
  tasks: { task: string; why: string }[];
}

const CALENDAR: MonthBlock[] = [
  {
    month: "January",
    theme: "Winter watch",
    tasks: [
      {
        task: "Check the water heater base for rust or pooling water",
        why: "Winter's heavier hot-water use is when an aging unit is most likely to finally fail.",
      },
      {
        task: "Look under sinks for slow leaks",
        why: "Holiday guests mean more use of fixtures that otherwise sit untouched most of the year.",
      },
      {
        task: "Walk the attic or top-floor ceilings after any rain",
        why: "A stain now is cheap to trace; the same leak found in summer has had months to spread.",
      },
    ],
  },
  {
    month: "February",
    theme: "Storm follow-up",
    tasks: [
      {
        task: "Inspect roof flashing and any spots where a recent storm left debris",
        why: "Still rain season here, so a small gap found now can be patched before the next storm finds it first.",
      },
      {
        task: "Test smoke and CO detectors and GFCI outlets",
        why: "A twice-a-year habit is the only reliable way this doesn't get forgotten.",
      },
    ],
  },
  {
    month: "March",
    theme: "Spring reset",
    tasks: [
      {
        task: "Check sprinkler heads and irrigation timer settings",
        why: "Watering season is starting back up; a broken head wastes water for months if it goes unnoticed.",
      },
      {
        task: "Walk the exterior for cracked caulk, peeling paint, or stucco cracks",
        why: "Winter is usually what causes these; spring is the easiest time to see and fix them.",
      },
      {
        task: "Clean gutters and downspouts",
        why: "Clears out whatever the winter storms left behind before things dry out and bake in.",
      },
    ],
  },
  {
    month: "April",
    theme: "Get ahead of summer",
    tasks: [
      {
        task: "Schedule an HVAC tune-up",
        why: "Booking before the first heat wave beats competing for an appointment once every AC in the neighborhood is struggling.",
      },
      {
        task: "Clean the dryer vent and refrigerator coils",
        why: "Both work harder once the house is warmer and everything else in it is running more.",
      },
    ],
  },
  {
    month: "May",
    theme: "Pre-heat check",
    tasks: [
      {
        task: "Check exterior faucets and hose bibs for weeping or drips",
        why: "Irrigation use is ramping up, so a small drip now becomes a real water loss over a hot summer.",
      },
      {
        task: "Inspect the roof for any damage winter left behind",
        why: "Easier to spot and fix before summer heat bakes a small issue into a bigger one.",
      },
    ],
  },
  {
    month: "June",
    theme: "Heat is close",
    tasks: [
      {
        task: "Check the HVAC filter and switch to monthly checks",
        why: "The system is about to run daily; a clogged filter makes it work harder for less cooling.",
      },
      {
        task: "Check attic ventilation isn't blocked",
        why: "Good airflow up there is what keeps summer heat from soaking straight through into the living space.",
      },
    ],
  },
  {
    month: "July",
    theme: "Peak AC strain",
    tasks: [
      {
        task: "Change the HVAC filter",
        why: "The system is running daily now; this is the single cheapest thing that protects it.",
      },
      {
        task: "Watch for slab leak signs: a warm spot on the floor or a water bill that jumps for no reason",
        why: "Older slab-foundation homes are prone to this, and it's far cheaper caught early than found late.",
      },
      {
        task: "Check eaves and attic vents for discarded insect wings",
        why: "Early sign of drywood termite swarmers, which start showing up around now.",
      },
    ],
  },
  {
    month: "August",
    theme: "Termite swarm watch",
    tasks: [
      {
        task: "Check the HVAC filter again and book service if it's been skipped",
        why: "This is typically the hardest month on a coastal SoCal AC system.",
      },
      {
        task: "Look for termite swarmers near eaves and windowsills",
        why: "Flying ant-like insects around the eaves this time of year are usually drywood termites, not ants; small discarded wings on a sill are the telltale sign.",
      },
    ],
  },
  {
    month: "September",
    theme: "Santa Ana wind prep",
    tasks: [
      {
        task: "Trim dead or overhanging tree limbs",
        why: "The first offshore wind events of the season turn a dead branch into either roof damage or a fire risk.",
      },
      {
        task: "Secure or store patio furniture and umbrellas",
        why: "Santa Ana gusts are strong enough to turn loose furniture into a projectile.",
      },
      {
        task: "Check the roof for loose tiles or shingles",
        why: "Anything already loose is what wind season finds first.",
      },
      {
        task: "Keep watching eaves for termite swarmers",
        why: "Swarm season typically runs into October, so it's still worth a look.",
      },
    ],
  },
  {
    month: "October",
    theme: "First-rain prep begins",
    tasks: [
      {
        task: "Clean gutters and downspouts",
        why: "The first rain of the season carries a summer's worth of dust and debris off the roof; clogged gutters can't handle it.",
      },
      {
        task: "Inspect the roof and flashing while it's still dry",
        why: "Any repair is easier and cheaper before the first storm tests it.",
      },
      {
        task: "Check that soil grading still slopes away from the foundation",
        why: "The single biggest factor in whether the first rain drains away or pools against the house.",
      },
    ],
  },
  {
    month: "November",
    theme: "Finish first-rain prep",
    tasks: [
      {
        task: "Clear yard drains and check any sump pump still works",
        why: "The parts of the drainage system that are invisible until the first real storm proves they don't work.",
      },
      {
        task: "Flush the water heater",
        why: "Once-a-year maintenance that clears sediment before the unit works harder through winter.",
      },
      {
        task: "Check weatherstripping around doors and windows",
        why: "The first cold, wet weather is what makes a bad seal obvious, so it's worth catching before then.",
      },
    ],
  },
  {
    month: "December",
    theme: "Close out the year",
    tasks: [
      {
        task: "Test smoke and CO detectors and replace batteries",
        why: "The other half of the twice-a-year test habit, and a good one to anchor to a specific month.",
      },
      {
        task: "Check the attic and ceilings after any early storms",
        why: "Catches a new leak while it's still a stain instead of a repair.",
      },
      {
        task: "Check space heater and holiday light cords and outlets",
        why: "Both add real electrical load to circuits that sit unused the rest of the year.",
      },
    ],
  },
];

const FAQS = [
  {
    q: "What's the most important home maintenance task in coastal Southern California?",
    a: "There isn't one single task, but the HVAC filter is the easiest to skip and one of the cheapest ways to protect an expensive system, especially July through September when the AC is running daily. Right behind it: watching for drywood termite swarmers in late summer and clearing gutters before the first rain in fall.",
  },
  {
    q: "What are drywood termite swarmers?",
    a: "Winged termites that leave a colony to start a new one, usually flying around eaves, attic vents, and windowsills from roughly August through October in Southern California. They look like flying ants at a glance; a pile of small discarded wings on a windowsill is the clearest sign it was actually termites.",
  },
  {
    q: "What is Santa Ana wind prep?",
    a: "Getting ahead of the strong, dry offshore wind events that typically start in September: trimming dead or overhanging tree limbs, securing or storing patio furniture, and checking for loose roof tiles or shingles before the wind finds them.",
  },
  {
    q: "Why does first-rain prep matter so much in Southern California?",
    a: "Homes here go dry for months at a time, so gutters fill with dust and debris, soil compacts, and grading issues go unnoticed until the season's first real storm. Cleaning gutters, checking the roof, and confirming the yard still slopes away from the foundation in October and November is what keeps that first storm from causing damage.",
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

export default function SocalHomeMaintenanceCalendarGuide() {
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
          { label: "Coastal Southern California home maintenance calendar" },
        ]}
      />
      <BreadcrumbJsonLd
        items={[
          { name: "Home", href: "/" },
          { name: "Guides", href: "/guides" },
          { name: "Coastal Southern California home maintenance calendar" },
        ]}
        siteUrl={SITE_URL}
      />

      <h1 className="mt-3 text-2xl font-bold text-stone-900 sm:text-3xl dark:text-stone-100">
        Coastal Southern California home maintenance calendar
      </h1>
      <p className="mt-3 text-sm text-stone-500 dark:text-stone-400">
        Month by month, built around the coastal SoCal climate: AC strain in
        late summer, drywood termite swarm season, Santa Ana winds, and the
        first fall rain. Written for coastal Southern California generally,
        including all of Orange County, where Hearth serves homeowners.
      </p>

      <div className="mt-8 grid gap-4 sm:grid-cols-2">
        {CALENDAR.map((m) => (
          <section key={m.month} className="card">
            <div className="flex items-baseline justify-between">
              <h2 className="font-semibold text-stone-900 dark:text-stone-100">{m.month}</h2>
              <span className="text-xs font-medium text-bark-700 dark:text-stone-300">
                {m.theme}
              </span>
            </div>
            <ul className="mt-3 space-y-2.5">
              {m.tasks.map((t) => (
                <li key={t.task} className="text-sm">
                  <p className="font-medium text-stone-800 dark:text-stone-200">{t.task}</p>
                  <p className="mt-0.5 text-stone-500 dark:text-stone-400">{t.why}</p>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>

      <div className="mt-8 space-y-6 text-stone-700 dark:text-stone-300">
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

      <GuideCta />
    </main>
  );
}
