import type { Metadata } from "next";
import Link from "next/link";
import GuideCta from "@/components/GuideCta";

// Public SEO guide. The task list below mirrors the tasks Hearth's own
// maintenance plan generator tracks (ALWAYS_SCHEDULE / SYSTEM_SCHEDULE in
// src/lib/maintenancePlan.ts), so the "what to do" side of this page matches
// the app exactly. The "how often" side intentionally does NOT quote that
// file's dueInDays numbers: those are one-time staggering offsets used when
// a plan is first generated (so ten tasks don't all land on day one), not
// real-world recurrence intervals, and presenting them as such would be
// dishonest. Instead each cadence below is standard, widely published
// maintenance guidance for that same task.

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
  title: "Home maintenance schedule: how often to do everything",
  description:
    "How often to change HVAC filters, flush the water heater, service the AC, clean gutters, and handle the rest of a home's regular upkeep.",
  alternates: {
    canonical: `${SITE_URL}/guides/home-maintenance-schedule`,
  },
};

const SCHEDULE = [
  {
    task: "Smoke and CO detectors",
    cadence: "Test monthly. Replace batteries at least once a year, and the units themselves every 10 years.",
  },
  {
    task: "HVAC air filter",
    cadence: "Check monthly. Replace every 1 to 3 months depending on the filter type and how much the system runs.",
  },
  {
    task: "HVAC tune-up",
    cadence: "Once a year, ideally right before the season you rely on it most.",
  },
  {
    task: "Water heater flush",
    cadence: "Once a year, to clear out mineral and sediment buildup.",
  },
  {
    task: "Gutters and downspouts",
    cadence: "Twice a year, spring and fall. More often if trees overhang the roof.",
  },
  {
    task: "Roof and flashing inspection",
    cadence: "Twice a year, plus a check after any major storm.",
  },
  {
    task: "Under-sink and toilet leak check",
    cadence: "A few times a year, since small leaks are easy to miss until they've caused damage.",
  },
  {
    task: "GFCI outlets and breakers",
    cadence: "Monthly, using the outlet's built-in test button.",
  },
  {
    task: "Dryer vent and refrigerator coils",
    cadence: "Twice a year, to keep airflow clear and appliances running efficiently.",
  },
  {
    task: "Window caulk and weatherstripping",
    cadence: "Once a year, before the extreme part of the season arrives.",
  },
  {
    task: "Foundation and grading walk",
    cadence: "Once or twice a year, checking for new cracks or water pooling near the house.",
  },
  {
    task: "Sewer line check",
    cadence: "Watch for slow drains year-round. In an older home, consider a camera scope every few years or before buying.",
  },
];

const FAQS = [
  {
    q: "How often should I change my HVAC filter?",
    a: "Check it monthly and replace it every 1 to 3 months depending on the filter type and how much the system runs. Homes with pets or allergy concerns usually land at the shorter end of that range.",
  },
  {
    q: "How often should I flush my water heater?",
    a: "Once a year is the standard recommendation. It clears out mineral and sediment buildup that otherwise makes the unit work harder and can shorten its life.",
  },
  {
    q: "How often should I get my AC serviced?",
    a: "Once a year, ideally scheduled before the season you'll rely on it most, so a technician can catch small issues before they turn into a breakdown during the first heat wave.",
  },
  {
    q: "How often should I clean my gutters?",
    a: "Twice a year, in spring and fall, covers most homes. If trees overhang the roof, check more often, since leaves and debris build up faster.",
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

export default function HomeMaintenanceScheduleGuide() {
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
        Home maintenance schedule: how often to do everything
      </h1>
      <p className="mt-3 text-sm text-stone-500 dark:text-stone-400">
        General guidance that fits most homes. Your own systems and their
        ages can shift the right timing.
      </p>

      <div className="mt-8 space-y-6 text-stone-700 dark:text-stone-300">
        <section>
          <p className="leading-relaxed">
            Most home maintenance isn&apos;t complicated, it&apos;s just easy to lose
            track of. Below is a plain schedule covering the tasks that come
            up on nearly every home, in roughly the order they tend to matter.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
            The schedule
          </h2>
          <div className="mt-3 overflow-hidden rounded-xl border border-stone-200 dark:border-white/10">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="bg-stone-50 text-left dark:bg-stone-800">
                  <th className="px-4 py-2.5 font-semibold text-stone-700 dark:text-stone-300">
                    Task
                  </th>
                  <th className="px-4 py-2.5 font-semibold text-stone-700 dark:text-stone-300">
                    How often
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100 dark:divide-white/10">
                {SCHEDULE.map((row) => (
                  <tr key={row.task}>
                    <td className="px-4 py-2.5 align-top font-medium text-stone-900 dark:text-stone-100">
                      {row.task}
                    </td>
                    <td className="px-4 py-2.5 align-top text-stone-600 dark:text-stone-400">
                      {row.cadence}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
            The four that matter most
          </h2>
          <p className="mt-2 leading-relaxed">
            <strong>HVAC filters</strong> are the easiest task to skip and one
            of the cheapest ways to protect an expensive system: check monthly,
            replace every 1 to 3 months depending on the filter and household.{" "}
            <strong>Water heater flushes</strong>, once a year, clear out the
            sediment that otherwise makes the unit work harder and wear out
            sooner.{" "}
            <strong>AC service</strong>, once a year and ideally before the
            season you need it most, catches small problems, like a low
            refrigerant charge or a failing capacitor, while they&apos;re still
            cheap to fix.{" "}
            <strong>Gutter cleaning</strong>, twice a year, keeps water moving
            away from the roofline and foundation instead of backing up and
            causing damage somewhere it&apos;s expensive to fix.
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

      <GuideCta />
    </main>
  );
}
