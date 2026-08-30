import Link from "next/link";
import type { Metadata } from "next";
import {
  PLUS_PLAN,
  COLD_START_FREE_POSTING,
  FREE_ASK_PER_DAY,
  PLUS_INCLUDED_HOMES,
  formatUsd,
  yearlyAsMonthly,
  yearlyPerDay,
  yearlyRunRate,
  yearlySavings,
} from "@/lib/constants";

// Public top-level pricing page, same pattern as src/app/privacy/page.tsx:
// see the allowlist entry in src/lib/supabase/middleware.ts. A logged-out
// visitor can read the whole thing; the actual subscribe flow stays gated
// under /plus for signed-in users. Every price comes from PLUS_PLAN in
// src/lib/constants.ts (the one source of truth the /plus page and Stripe
// checkout also read), so nothing here can drift from what a card is charged.

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

// STATIC. This page reads no cookies, no headers, no searchParams, and no
// database: every number on it comes from PLUS_PLAN and the plan-math helpers,
// which are build-time constants. Now that the root layout no longer reads the
// flash cookie (see src/app/layout.tsx), nothing forces this route dynamic, so
// it is prerendered once and served from the edge cache.
//
// The explicit revalidate is a marker, not a requirement: with no data source
// there is nothing for a regeneration to pick up, and Next would prerender this
// page with or without it. It is here so the page's static intent is visible in
// the file and in `next build` output, and so a future data read gets ISR
// instead of silently dropping the route back to per-request rendering.
// Anything added here that reads cookies()/headers()/searchParams undoes it.
export const revalidate = 3600;

// Title/description held once so metadata.title, openGraph, and twitter
// can't drift from each other; the OG image at ./opengraph-image.tsx keeps
// its own literal copy of the title (see that file's comment for why).
const TITLE = "Pricing";
const DESCRIPTION =
  "Hearth pricing, in plain terms. Your first home is free with no card. Hearth Plus is optional, with an honest auto-renewing subscription you can cancel anytime.";
const CANONICAL = `${SITE_URL}/pricing`;

export const metadata: Metadata = {
  // The root layout's title template appends "| Hearth"; don't repeat it here.
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
    type: "website",
    // og:image comes from the colocated opengraph-image.tsx; Next wires it
    // up automatically for this segment.
  },
  twitter: {
    card: "summary_large_image",
    title: TITLE,
    description: DESCRIPTION,
  },
};

// Prices are rendered from PLUS_PLAN so a one-line edit in constants moves
// them everywhere, and formatUsd keeps $4.99 / $39.99 from ever showing as
// "4.9". The derived figures come from the shared plan-math helpers in
// constants, the same ones the /plus PlanToggle uses, so the two pages cannot
// drift: the saving is always twelve charges at the real monthly price minus
// the yearly price (never an invented list price), and the per-day figure is
// the yearly price over 365 days, rounded UP to the cent.
const WEEKLY = formatUsd(PLUS_PLAN.weekly); // $1.99
const MONTHLY = formatUsd(PLUS_PLAN.monthly); // $4.99
const YEARLY = formatUsd(PLUS_PLAN.yearly); // $39.99
const YEARLY_PER_MONTH = formatUsd(yearlyAsMonthly(PLUS_PLAN)); // about $3.33
const YEARLY_PER_DAY = formatUsd(yearlyPerDay(PLUS_PLAN)); // about $0.11
const MONTHLY_YEAR_TOTAL = formatUsd(yearlyRunRate(PLUS_PLAN)); // $59.88
const YEARLY_SAVING = formatUsd(yearlySavings(PLUS_PLAN)); // $19.89
const TRIAL_DAYS = PLUS_PLAN.trialDays;

// Free tier: what a homeowner gets with no card, forever. Mirrors the "Free"
// column of the /plus comparison so the two pages tell the same story.
const FREE_FEATURES = [
  "Track your first home: systems, ages, documents, and reminders",
  "Your first maintenance plan, built from your home's systems",
  "Your 10-year cost forecast total and the monthly amount to set aside",
  "A one-time free quote check to see whether a quote is fair",
  // Mirrors the two new /plus comparison rows. Storing documents is free and
  // uncapped; the numbers here are the AI READ of them, and they must match
  // FREE_DOC_READS / FREE_INSPECTION_READS in src/lib/freeAiTaste.ts.
  "Two free AI document reads and one free inspection report import",
  "Your home's value estimate and how much equity you have",
  COLD_START_FREE_POSTING
    ? "Post jobs and get quotes from local pros, unlimited while Hearth is new"
    : "Post up to 3 jobs at a time and get quotes from local pros",
  "Every alert, in the app",
];

// Plus tier: what the subscription unlocks on top of Free. Mirrors the
// Plus-exclusive rows of the /plus comparison.
const PLUS_FEATURES = [
  "A maintenance plan auto-built for your home and kept up to date",
  "The full per-system cost forecast and repair-fund breakdown",
  "Unlimited quote analyzer: it reads every quote, flags padding, and drafts the message back",
  "Unlimited AI document reads and inspection report imports",
  "A shareable home report for resale and insurance",
  "A monthly refresh of your home value, with the year-by-year trend",
  `Track up to ${PLUS_INCLUDED_HOMES} homes in one place`,
  "Every proactive alert, on every channel",
];

export default function PricingPage() {
  return (
    // Wider than the other public prose pages: the plan block below is three
    // real columns, and max-w-3xl squeezes them to the point of wrapping every
    // price line.
    <main className="mx-auto max-w-4xl px-6 pb-16 pt-10">
      <p className="text-base">
        {/* Same phone-only 44px tap target as the /contact back link: all
            added classes are max-sm:, so sm and up is unchanged. */}
        <Link
          href="/"
          className="text-stone-500 hover:text-bark-700 max-sm:inline-flex max-sm:min-h-11 max-sm:items-center max-sm:text-base dark:text-stone-400 dark:hover:text-stone-300"
        >
          ← Hearth
        </Link>
      </p>

      <h1 className="mt-4 text-3xl font-semibold text-stone-900 sm:text-4xl dark:text-stone-100">
        Simple pricing. Most of Hearth is free.
      </h1>
      <p className="mt-3 text-base leading-relaxed text-stone-600 dark:text-stone-300">
        Your first home is free to track, with no card. Hearth Plus is an
        optional subscription for the tools that save you real money on repairs.
        Here is exactly what each one costs and what you get.
      </p>

      {/* Three real reference points: Free, the yearly plan, the monthly
          plan. Nothing invented - Free is a plan people actually run on, and
          Monthly is the full price the yearly plan is measured against.
          Single column on phones with the yearly hero first, three across from
          md up. */}
      <div className="mt-8 grid items-stretch gap-4 md:grid-cols-3">
        {/* --- Free --- */}
        <div className="card order-2 flex flex-col md:order-1">
          <div>
            <span className="chip chip-muted">Free forever</span>
            <p className="mt-3 text-3xl font-semibold text-stone-900 dark:text-stone-100">
              $0
            </p>
            <p className="mt-1 text-sm text-stone-600 dark:text-stone-300">
              First home free. Yours forever, no card.
            </p>
          </div>
          <ul className="mt-5 space-y-2">
            {FREE_FEATURES.map((f) => (
              <li
                key={f}
                className="flex items-start gap-2 text-sm leading-relaxed text-stone-700 dark:text-stone-300"
              >
                <span className="mt-0.5 font-bold text-green-600" aria-hidden>
                  ✓
                </span>
                <span>{f}</span>
              </li>
            ))}
          </ul>
          {/* The real caps, named in the same column as the capabilities, so
              "free" is a plan rather than a teaser. */}
          <p className="mt-auto pt-4 text-sm text-stone-500 dark:text-stone-400">
            Caps: one home, one plan build, one quote check, one home value
            estimate, {FREE_ASK_PER_DAY} Ask Hearth questions a day (text
            only).
          </p>
        </div>

        {/* --- Yearly: the hero --- */}
        <div className="card-hero relative order-1 flex flex-col md:order-2">
          <span className="absolute -top-2.5 left-5 whitespace-nowrap rounded-full bg-bark-600 px-2.5 py-0.5 text-xs font-medium text-white">
            Best value
          </span>
          <div>
            <p className="text-xl font-semibold text-stone-900 dark:text-stone-100">
              Hearth Plus, yearly
            </p>
            <p className="mt-3 text-3xl font-semibold text-stone-900 dark:text-stone-100">
              {YEARLY}
              <span className="text-base font-normal text-stone-500 dark:text-stone-400">
                /year
              </span>
            </p>
            {/* Honest arithmetic, not a discount claim: the yearly price
                divided by 365, rounded up to the cent. */}
            <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">
              About {YEARLY_PER_DAY} a day.
            </p>
            <p className="mt-2 text-sm font-medium text-bark-700 dark:text-stone-200">
              Save {YEARLY_SAVING} vs monthly
            </p>
            <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">
              About {YEARLY_PER_MONTH} a month, billed once a year.
            </p>
            {/* The trial belongs to the weekly plan only, so this card says
                plainly what yearly does instead: it charges at signup. Saying
                nothing here would leave the trial line elsewhere on the page to
                be read as covering this plan too. */}
            <p className="mt-3 text-sm font-medium text-bark-700 dark:text-stone-300">
              {YEARLY} today, then every 12 months. No trial on yearly.
            </p>
          </div>
          <ul className="mt-5 space-y-2">
            <li className="text-sm font-medium text-stone-900 dark:text-stone-100">
              Everything in Free, plus:
            </li>
            {PLUS_FEATURES.map((f) => (
              <li
                key={f}
                className="flex items-start gap-2 text-sm leading-relaxed text-stone-700 dark:text-stone-300"
              >
                <span className="mt-0.5 font-bold text-green-600" aria-hidden>
                  ✓
                </span>
                <span>{f}</span>
              </li>
            ))}
          </ul>
        </div>

        {/* --- Monthly: the full-price reference --- */}
        <div className="card order-3 flex flex-col">
          <div>
            <p className="text-xl font-semibold text-stone-900 dark:text-stone-100">
              Hearth Plus, monthly
            </p>
            <p className="mt-3 text-3xl font-semibold text-stone-900 dark:text-stone-100">
              {MONTHLY}
              <span className="text-base font-normal text-stone-500 dark:text-stone-400">
                /month
              </span>
            </p>
            <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">
              = {MONTHLY_YEAR_TOTAL} a year.
            </p>
            <p className="mt-2 text-sm text-stone-700 dark:text-stone-300">
              The same Plus, month to month.
            </p>
            {/* Monthly is billed on day one. The {TRIAL_DAYS} free days ride on
                the weekly plan and nowhere else, so this card names the plan
                that has them rather than implying it has them itself. */}
            <p className="mt-3 text-sm font-medium text-bark-700 dark:text-stone-300">
              {MONTHLY} today, then every month. Want to try it first? The
              weekly plan is {WEEKLY} a week and starts with {TRIAL_DAYS} free
              days.
            </p>
          </div>
          {/* The page's one loss-framed line, and the loss is real today: the
              actual delta between the two plans on offer, not urgency or
              scarcity. */}
          <p className="mt-auto pt-5 text-sm text-stone-500 dark:text-stone-400">
            Monthly pays {YEARLY_SAVING} more for the same year.
          </p>
        </div>
      </div>

      {/* Plain disclosure of Ask Hearth's daily cap, so the AI features above
          never read as unlimited. The FREE number is READ from
          src/lib/constants.ts rather than typed: it mirrors ASK_DAILY_FREE in
          src/lib/aiUsage.ts, which is what /api/ask actually enforces (the tool
          routes run on a separate, larger budget), and src/lib/constants.test.ts
          fails the build if the mirror ever drifts. The Plus ceiling is stated
          as "higher", not as a figure: naming it made the upgrade read as a cap
          rather than a lift, and a printed number goes stale the first time the
          limit moves. The cap still gets said out loud, which is the part that
          has to be true, and the trial runs on the same ceiling as a paid
          plan. */}
      <p className="mt-4 text-sm text-stone-500 dark:text-stone-400">
        Ask Hearth, the AI assistant, is capped at {FREE_ASK_PER_DAY} text
        questions a day on Free, so it stays fast and available for everyone.
        Plus raises that limit and adds photo answers. The {TRIAL_DAYS} free
        days include everything Plus includes, at the same daily limit.
      </p>

      {/* The honest auto-renew disclosure, stated plainly. Same facts the
          checkout disclosure carries (src/components/AutoRenewalTerms.tsx),
          shown here before anyone signs up so it can't read as a surprise. */}
      <div className="mt-8 rounded-xl border border-stone-200 bg-stone-50 p-5 dark:border-white/10 dark:bg-stone-900">
        <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
          How the Plus trial and billing work
        </h2>
        <p className="mt-2 text-base leading-relaxed text-stone-700 dark:text-stone-300">
          The free trial is part of the weekly plan. If you start Plus weekly,
          your first {TRIAL_DAYS} days are free and nothing is charged, then it
          renews automatically at {WEEKLY} a week until you cancel.
        </p>
        <p className="mt-2 text-base leading-relaxed text-stone-700 dark:text-stone-300">
          The monthly and yearly plans have no trial: monthly charges {MONTHLY}
          {" "}
          today and renews every month, yearly charges {YEARLY} today and renews
          every 12 months, both until you cancel.
        </p>
        <p className="mt-2 text-base leading-relaxed text-stone-700 dark:text-stone-300">
          You can cancel anytime from your account with one button. There is
          nothing to call or email. If you cancel during the weekly plan&apos;s
          {" "}
          {TRIAL_DAYS}-day trial, you are never charged, and if you cancel later
          you keep Plus until the end of the period you already paid for.
        </p>
      </div>

      {/* What stays free forever, so "free" isn't a bait word. */}
      <div className="mt-6">
        <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
          What stays free, forever
        </h2>
        <p className="mt-2 text-base leading-relaxed text-stone-600 dark:text-stone-300">
          Tracking your first home, your reminders, your document vault (adding
          and storing anything you like, however much of it), your
          first maintenance plan, and posting jobs to local pros are free to use
          and always will be. You never need a card for any of it, and you can
          get a lot out of Hearth without ever paying a cent. Plus is there only
          if you want the money-saving tools on top.
        </p>
      </div>

      {/* Primary CTA into the public signup; Plus is explicitly optional. */}
      <div className="mt-10 text-center">
        <Link href="/homeowner-signup" className="btn-primary">
          Get started free
        </Link>
        <p className="mt-3 text-base text-stone-500 dark:text-stone-400">
          No card to start. Plus is optional, and you can add it later from
          inside the app.
        </p>
        <p className="mt-4 text-base text-stone-500 dark:text-stone-400">
          Already have an account?{" "}
          <Link
            href="/signin"
            className="text-bark-700 hover:underline dark:text-stone-300"
          >
            Sign in
          </Link>
          .
        </p>
      </div>
    </main>
  );
}
