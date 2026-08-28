import type { Metadata } from "next";
import Link from "next/link";
import {
  Droplet,
  Thermometer,
  Wrench,
  CalendarDays,
  ClipboardList,
  ScanSearch,
  Home,
  Zap,
  ChefHat,
  Bath,
  Building2,
  ShieldCheck,
} from "lucide-react";

// Index for the public guide pages. Kept as a plain list: this section is
// meant to stay small and good rather than grow into thin programmatic pages.
const GUIDES = [
  {
    href: "/guides/water-heater-replacement-cost",
    icon: Droplet,
    title: "Water heater replacement cost",
    blurb:
      "Typical national price range, what drives it up or down, and when a repair is the smarter call.",
  },
  {
    href: "/guides/hvac-replacement-cost",
    icon: Thermometer,
    title: "HVAC replacement cost",
    blurb:
      "Typical national price range for a new heating and cooling system, and how to tell if yours can be repaired instead.",
  },
  {
    href: "/guides/roof-replacement-cost",
    icon: Home,
    title: "Roof replacement cost",
    blurb:
      "The typical national range plus realistic Orange County numbers for shingle and tile, when a repair beats a replacement, and permits.",
  },
  {
    href: "/guides/electrical-panel-upgrade-cost",
    icon: Zap,
    title: "Electrical panel upgrade cost",
    blurb:
      "The typical range, when an upgrade is actually needed, 100 vs 200 amp, and why permits and a licensed electrician matter.",
  },
  {
    href: "/guides/kitchen-remodel-cost",
    icon: ChefHat,
    title: "Kitchen remodel cost",
    blurb:
      "What a kitchen remodel runs in Orange County by tier, cost per square foot, what drives the price, and how to save.",
  },
  {
    href: "/guides/bathroom-remodel-cost",
    icon: Bath,
    title: "Bathroom remodel cost",
    blurb:
      "Typical Orange County bathroom remodel ranges by tier, cost per square foot, what affects the price, and where to save.",
  },
  {
    href: "/guides/adu-cost",
    icon: Building2,
    title: "ADU cost",
    blurb:
      "What an ADU costs in Orange County by type, garage conversion vs attached vs detached, California ADU rules, and how to save.",
  },
  {
    href: "/guides/slab-leak-signs",
    icon: Wrench,
    title: "Slab leak signs",
    blurb:
      "How to spot a slab leak early, why older Orange County homes are prone to them, and what the repair options look like.",
  },
  {
    href: "/guides/home-maintenance-schedule",
    icon: CalendarDays,
    title: "Home maintenance schedule",
    blurb:
      "How often to actually change filters, flush the water heater, service the AC, and clean the gutters.",
  },
  {
    href: "/guides/is-my-contractor-quote-fair",
    icon: ClipboardList,
    title: "Is my contractor's quote fair?",
    blurb:
      "How to read a quote line by line, red flags to watch for, and what a fair bidding process looks like.",
  },
  {
    href: "/guides/contractor-deposit-rules-california",
    icon: ShieldCheck,
    title: "How much can a contractor ask for up front?",
    blurb:
      "California's deposit cap, the written-contract rule, when a license is required, and the red flags that mean you should slow down.",
  },
  {
    href: "/guides/socal-home-maintenance-calendar",
    icon: CalendarDays,
    title: "SoCal home maintenance calendar",
    blurb:
      "A month-by-month calendar for coastal Southern California: AC strain, termite swarm season, Santa Ana wind prep, and first-rain checks.",
  },
];

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
  // The root layout's title template appends "| Hearth"; don't repeat it here.
  title: "Home maintenance guides",
  description:
    "Plain-English guides to common home maintenance questions: replacement costs, slab leak warning signs, maintenance schedules, and how to read a contractor's quote.",
  alternates: {
    canonical: `${SITE_URL}/guides`,
  },
};

export default function GuidesIndex() {
  return (
    <main className="mx-auto max-w-2xl px-6 pb-16 pt-10">
      <h1 className="text-2xl font-bold text-stone-900 dark:text-stone-100">
        Home maintenance guides
      </h1>
      <p className="mt-2 text-sm text-stone-600 dark:text-stone-300">
        Plain-English answers to the questions homeowners search for most,
        with no login required.
      </p>

      <ul className="mt-8 space-y-4">
        {GUIDES.map((g) => (
          <li key={g.href}>
            <Link
              href={g.href}
              className="card block transition hover:border-bark-500 hover:shadow-md"
            >
              <div className="flex items-start gap-3">
                <span className="icon-chip" aria-hidden>
                  <g.icon className="h-5 w-5" />
                </span>
                <div>
                  <h2 className="font-semibold text-stone-900 dark:text-stone-100">{g.title}</h2>
                  <p className="mt-1 text-sm text-stone-600 dark:text-stone-300">{g.blurb}</p>
                </div>
              </div>
            </Link>
          </li>
        ))}
      </ul>

      <h2 className="mt-10 text-lg font-bold text-stone-900 dark:text-stone-100">
        Have a quote in hand?
      </h2>
      <div className="mt-4">
        <Link
          href="/homeowner-signup?next=/quote-check"
          className="card block transition hover:border-bark-500 hover:shadow-md"
        >
          <div className="flex items-start gap-3">
            <span className="icon-chip" aria-hidden>
              <ScanSearch className="h-5 w-5" />
            </span>
            <div>
              <h3 className="font-semibold text-stone-900 dark:text-stone-100">
                Quote analyzer
              </h3>
              <p className="mt-1 text-sm text-stone-600 dark:text-stone-300">
                Paste a contractor&apos;s quote and see if the price is fair.
                Your first check is free.
              </p>
            </div>
          </div>
        </Link>
      </div>
    </main>
  );
}
