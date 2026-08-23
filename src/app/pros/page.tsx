import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getSides } from "@/lib/contractor";
import {
  FOUNDER,
  LEAD_TIER_FEES,
  MAJOR_INTRO_FEE,
  COLD_START_FREE_ALERTS,
  PRO_PLAN,
} from "@/lib/constants";
import { AGING_LEAD_TIERS } from "@/lib/leadPricing";
import { LAUNCH_AREA_LABEL } from "@/lib/serviceArea";
import Link from "next/link";
import Image from "next/image";
import Logo from "@/components/Logo";
import ThemeToggle from "@/components/ThemeToggle";
import ProDemoPlayerLazy from "@/components/ProDemoPlayerLazy";
import {
  Tag,
  MousePointerClick,
  Hourglass,
  Zap,
  Ban,
  Globe,
  CalendarDays,
  Contact,
} from "lucide-react";

// Inline check mark. Emoji checks (✔️/✅) render differently per OS; one SVG
// keeps every check on this page identical. Color comes from text-green-700
// via currentColor.
function Check({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 20 20"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m4 10.5 4 4 8-9" />
    </svg>
  );
}

// Canonical first-application guarantee sentence. Used verbatim everywhere the
// guarantee is described on this page so the terms can never drift.
const FIRST_APPLICATION_GUARANTEE =
  "Not chosen on your first application? The fee comes back automatically as wallet credit you can spend on any job within 60 days. It's credit toward future leads, not cash back to your card.";

const SITE_URL =
  process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

export const metadata: Metadata = {
  title: "Hearth for Pros: real local leads, honest pricing",
  description:
    "Browse local jobs free and pay only when you apply, with the price on every card. No subscription required, no ghost leads, and free license-verified badges for California pros.",
  alternates: {
    canonical: `${SITE_URL}/pros`,
  },
};

// Marketing front door for contractors. Every claim here is a real product
// behavior (lead fee shown up front, aging markdowns, pay-per-apply wallet),
// so keep copy in sync with /pro and leadPricing.ts if those change.
//
// STAYS DYNAMIC, and not because of the root layout (that no longer reads
// cookies - see src/app/layout.tsx). Three independent per-request reads live
// in the body below: auth.getUser() plus getSides() to bounce a signed-in
// contractor straight to /pro, and searchParams.ref to thread a referral code
// into the signup link. The redirect is the important one: prerendering this
// page would land contractors on the marketing pitch instead of their leads.
// No revalidate export here - it would be a no-op against those reads, and
// force-static would silently break the redirect rather than fail loudly.
export default async function ProsLanding(props: {
  searchParams?: Promise<{ ref?: string }>;
}) {
  const searchParams = await props.searchParams;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Pros go straight to their leads. Everyone else, including signed-in
  // homeowners, can read the pitch: bouncing them to the dashboard made this
  // page look like it demanded an account before showing anything. Keyed on a
  // company row, not the role stamp - someone whose preferred side is
  // contractor but who never finished setup should read the pitch, not be
  // thrown into an empty /pro.
  if (user && (await getSides()).hasPro) {
    redirect("/pro");
  }

  // Referral threading: a ?ref=CODE on this page rides the sign-up CTA into
  // /contractor-signup, which carries it on to /pro/onboarding (the page that
  // actually redeems it). Trimmed and URL-encoded; nothing else changes here.
  const ref =
    typeof searchParams?.ref === "string" && searchParams.ref.trim()
      ? searchParams.ref.trim()
      : null;
  const signupHref = ref
    ? `/contractor-signup?ref=${encodeURIComponent(ref)}`
    : "/contractor-signup";

  // Aging discount sentence, built from the real tiers instead of a hardcoded
  // string, so a change to leadPricing.ts can never drift out of sync here.
  const agingCopy = [...AGING_LEAD_TIERS]
    .sort((a, b) => a.days - b.days)
    .map((t) => `${t.days}+ days old, ${t.off}% off`)
    .join("; ");

  const PROMISES = [
    {
      icon: <Tag className="h-5 w-5" />,
      title: "The price is on the job card",
      body: "Every open job shows its fee before you pay a cent. No blind bidding, no mystery invoices.",
    },
    {
      icon: <MousePointerClick className="h-5 w-5" />,
      title: "You only pay when you apply",
      body: "Browse everything for free. Your wallet is only charged for the jobs you choose to go after.",
    },
    {
      icon: <Hourglass className="h-5 w-5" />,
      title: "Older jobs get cheaper",
      body: "Jobs that sit unclaimed are automatically marked down 15-30%, so pros willing to wait pay less.",
    },
    {
      icon: <Zap className="h-5 w-5" />,
      // COLD START: while COLD_START_FREE_ALERTS is on, every pro gets these
      // alerts free, worded the same as the perk on /pro/plus so the two
      // pages never contradict each other. Title flips with the flag so it
      // can never say "free" while the body says "membership perk".
      title: COLD_START_FREE_ALERTS
        ? "Instant job alerts, free for now"
        : "Instant job alerts",
      body:
        "The moment a job posts in your trades and area, we send you an email and a phone alert right away." +
        (COLD_START_FREE_ALERTS
          ? " Free for every pro while Hearth is new. Later, a Pro membership perk."
          : " A Pro membership perk."),
    },
    {
      icon: <Check className="h-5 w-5 text-green-700 dark:text-green-400" />,
      title: "Free license verification",
      body: "We check your CSLB number against the state's public database and show homeowners a verified badge on your profile. Free, no membership needed.",
    },
    {
      icon: <Ban className="h-5 w-5" />,
      title: "No subscription required",
      body: "Load your wallet with deposits from $5 and pay per application. An optional Pro membership adds perks like bonus credit and an AI back office, but it never changes which jobs you can see or apply to.",
    },
  ];

  const STEPS = [
    { n: "1", text: "Set up your company in about a minute." },
    { n: "2", text: "Browse open jobs with the fee shown on every card." },
    { n: "3", text: "Apply only to the ones you want." },
  ];

  return (
    <main className="pb-16">
      {/* Warm band wraps header and hero: a single flat fill, hearth-50 in
          light and stone-900 in dark (matching the body), no gradient. */}
      <div className="bg-bark-50 dark:bg-stone-900">
        <div className="mx-auto max-w-3xl px-6 pt-6">
          <header className="flex items-center justify-between">
            <Link
              href="/"
              className="inline-flex items-center gap-2 font-semibold text-stone-900 dark:text-stone-100"
            >
              <Logo className="h-6 w-6 text-bark-700 dark:text-stone-400" /> Hearth
            </Link>
            {/* Theme switch + bordered cross-link, mirroring the landing
                page's header exactly so the two doors read as one system. */}
            <div className="flex items-center gap-2">
              <ThemeToggle />
              <Link
                href="/"
                className="inline-flex min-h-11 items-center whitespace-nowrap rounded-lg border border-stone-300 px-3 py-1.5 text-sm font-medium text-stone-700 hover:border-bark-500 hover:text-bark-700 sm:min-h-0 dark:border-white/10 dark:text-stone-300 dark:hover:border-bark-500 dark:hover:text-stone-300"
              >
                {/* Mirrors the landing header's "For Pros" / "Hearth for
                    Pros" pair: short label on a phone, full wording from sm
                    up, and never wrapping to a second line. */}
                <span className="sm:hidden">Homeowners</span>
                <span className="hidden sm:inline">For Homeowners</span>
              </Link>
            </div>
          </header>

          {/* Hero */}
          <div className="mt-14 flex flex-col items-center pb-4 text-center">
            <h1 className="max-w-2xl text-5xl font-semibold tracking-tight text-stone-900 sm:text-6xl dark:text-stone-100">
              Real local leads, honest pricing
            </h1>
            <p className="mt-5 max-w-xl text-lg text-stone-600 dark:text-stone-400">
              Other sites charge you for leads you didn&apos;t ask for and that
              other pros already have. On Hearth you see the price first and
              only pay when you choose to apply.
            </p>
            <Link
              href={signupHref}
              className="btn-primary mt-8 px-6 py-3 text-base shadow-md"
            >
              Create your pro account
            </Link>
            <Link
              href="/signin"
              className="mt-3 text-sm text-bark-700 hover:underline dark:text-stone-300"
            >
              Already have an account? Sign in
            </Link>
            <p className="mt-4 text-sm text-stone-500 dark:text-stone-400">
              Serving {LAUNCH_AREA_LABEL}
            </p>
            <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">
              Don&apos;t see your city yet? You will soon.
            </p>
          </div>
        </div>
      </div>

      {/* Pro-side click-to-play demo, the contractor sibling of the homeowner
          hero video. Sits right after the warm band, mirroring how the
          landing page mounts its player: through a lazy wrapper, so the
          ~2,800-line component loads as its own chunk after hydration
          instead of riding along in this page's first-load JS. */}
      <section className="mx-auto mt-16 flex max-w-3xl flex-col items-center px-6 sm:mt-20">
        <div className="w-full max-w-xl">
          <ProDemoPlayerLazy />
        </div>
      </section>

      <div className="mx-auto max-w-3xl px-6">
      {/* Ghost protection and the first-application guarantee get top
          billing, side by side: they are the two promises no lead-platform
          competitor keeps. */}
      <div className="mt-14 grid gap-4 sm:grid-cols-2">
        <section className="rounded-2xl border border-bark-100 bg-bark-50 p-6 text-center shadow-sm dark:border-bark-700 dark:bg-bark-700/20">
          <h2 className="text-xl font-semibold text-stone-900 dark:text-stone-100">
            Ghost protection: if the lead is dead, your fee comes back as
            credit.
          </h2>
          <p className="mx-auto mt-2 max-w-md text-sm text-stone-600 dark:text-stone-400">
            If a homeowner doesn&apos;t respond within 7 days, your apply fee
            comes back to your wallet automatically as credit toward your next
            application. You don&apos;t have to fill out a form, open a support
            ticket, or argue with anyone. It&apos;s credit, not cash back to
            your card.
          </p>
        </section>
        <section className="rounded-2xl border border-bark-100 bg-bark-50 p-6 text-center shadow-sm dark:border-bark-700 dark:bg-bark-700/20">
          <h2 className="text-xl font-semibold text-stone-900 dark:text-stone-100">
            Your first application is protected.
          </h2>
          <p className="mx-auto mt-2 max-w-md text-sm text-stone-600 dark:text-stone-400">
            {FIRST_APPLICATION_GUARANTEE} Licensed pros get this once.
          </p>
        </section>
      </div>

      {/* Trust band: a real reachable team is the trust signal a national
          lead platform can never offer. */}
      <section className="mt-6 rounded-2xl bg-stone-900 px-6 py-8 text-center dark:bg-stone-950 dark:border dark:border-white/10">
        <h2 className="text-xl font-semibold text-white">
          Real people, real answers
        </h2>
        <p className="mx-auto mt-2 max-w-md text-sm text-stone-300">
          Message us and a real person on our team will answer.
        </p>
        {FOUNDER.name && FOUNDER.cellPhone && (
          <p className="mt-1 text-sm text-stone-300">
            Cell: {FOUNDER.cellPhone}
          </p>
        )}
        {/* The in-app help page requires an onboarded contractor account, so
            it is exactly wrong for the signed-out prospective pros this page
            targets. Contact form needs no session and no owner-fillable
            fields, unlike the old mailto/tel here, so it's always shown - see
            src/app/contact/page.tsx. The cell-phone line above is still
            owner-fillable and still drops out entirely when blank. */}
        <Link
          href="/contact"
          className="mt-4 inline-block text-sm text-bark-500 hover:underline"
        >
          Questions? Contact us →
        </Link>
      </section>

      {/* The promises */}
      <section className="mt-6 grid gap-4 sm:grid-cols-2">
        {PROMISES.map((p) => (
          <div key={p.title} className="card">
            <div className="icon-chip" aria-hidden>
              {p.icon}
            </div>
            <h2 className="mt-3 font-semibold text-stone-900 dark:text-stone-100">{p.title}</h2>
            <p className="mt-1 text-sm text-stone-600 dark:text-stone-400">{p.body}</p>
          </div>
        ))}
      </section>

      {/* Flat trade photo, same framed treatment as the landing page.
          Not priority - well below the fold. */}
      <div className="mt-16 overflow-hidden rounded-xl border border-stone-200 dark:border-white/10">
        <Image
          src="/photos/painter-undercoating-wall.jpg"
          alt="A painter prepping and undercoating a bright wall"
          width={1600}
          height={1068}
          sizes="(min-width: 768px) 48rem, 100vw"
          className="h-auto w-full object-cover"
        />
      </div>

      {/* Single-player value: worth having even before the first job comes
          in. Every item here is verified against the shipped feature, and
          the AI back office is labeled honestly as a Pro membership perk
          rather than lumped in as free. */}
      <section className="mt-16">
        <h2 className="text-center text-2xl font-semibold text-stone-900 dark:text-stone-100">
          Worth it even before your first job
        </h2>
        <div className="mx-auto mt-6 grid max-w-2xl gap-4 sm:grid-cols-2">
          <div className="card">
            <div className="icon-chip" aria-hidden>
              <Globe className="h-5 w-5" />
            </div>
            <h3 className="mt-3 font-semibold text-stone-900 dark:text-stone-100">
              A free public profile page
            </h3>
            <p className="mt-1 text-sm text-stone-600 dark:text-stone-400">
              Your own shareable page with your services and real Hearth
              reviews, built to rank on Google. Every pro gets one, free, no
              membership required.
            </p>
          </div>
          <div className="card">
            <div className="icon-chip" aria-hidden>
              <Check className="h-5 w-5 text-green-700 dark:text-green-400" />
            </div>
            <h3 className="mt-3 font-semibold text-stone-900 dark:text-stone-100">
              A free CSLB-verified badge
            </h3>
            <p className="mt-1 text-sm text-stone-600 dark:text-stone-400">
              We check your license number against the state database and
              show a verified badge on your public profile page. Free, not a
              membership perk.
            </p>
          </div>
          <div className="card">
            <div className="icon-chip" aria-hidden>
              <CalendarDays className="h-5 w-5" />
            </div>
            <h3 className="mt-3 font-semibold text-stone-900 dark:text-stone-100">
              A compliance calendar
            </h3>
            <p className="mt-1 text-sm text-stone-600 dark:text-stone-400">
              Upload your license and insurance once and get a heads-up
              before either one expires. Free for every pro.
            </p>
          </div>
          <div className="card">
            <div className="icon-chip" aria-hidden>
              <Contact className="h-5 w-5" />
            </div>
            <h3 className="mt-3 font-semibold text-stone-900 dark:text-stone-100">
              A simple CRM
            </h3>
            <p className="mt-1 text-sm text-stone-600 dark:text-stone-400">
              Track every lead through quoted, won, and lost, with notes and
              a follow-up date. Free for every pro.
            </p>
          </div>
        </div>
        <p className="mx-auto mt-6 max-w-md text-center text-sm text-stone-500 dark:text-stone-400">
          A Pro membership adds an AI back office on top: draft estimates,
          invoices, follow-up messages, review replies, and overdue-invoice
          reminders in seconds. New pros try Pro free for {PRO_PLAN.trialDays}{" "}
          days, then it is ${PRO_PLAN.monthly.toFixed(2)} a month, cancel
          anytime.{" "}
          <Link href="/pro/plus" className="text-bark-700 hover:underline dark:text-stone-300">
            See what&apos;s included
          </Link>
          .
        </p>
      </section>

      {/* Flat trade photo break before the steps, mirroring how the landing
          page pairs the roofer shot with its how-it-works block. */}
      <div className="mt-16 overflow-hidden rounded-xl border border-stone-200 dark:border-white/10">
        <Image
          src="/photos/roofer-installing-shingles.jpg"
          alt="A roofer installing asphalt shingles on a home"
          width={1600}
          height={1067}
          sizes="(min-width: 768px) 48rem, 100vw"
          className="h-auto w-full object-cover"
        />
      </div>

      {/* How it works */}
      <section className="mt-12">
        <h2 className="text-center text-2xl font-semibold text-stone-900 dark:text-stone-100">
          How it works
        </h2>
        <ol className="mx-auto mt-6 max-w-md space-y-4">
          {STEPS.map((s) => (
            <li key={s.n} className="flex items-start gap-3">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-bark-600 text-sm font-semibold text-white">
                {s.n}
              </span>
              <p className="pt-0.5 text-stone-600 dark:text-stone-400">{s.text}</p>
            </li>
          ))}
        </ol>
        {/* The honest deal: every line here is a real, shipped product rule
            (3-spot cap, ghost-protection credit, first-apply guarantee, aging tiers,
            pay-per-apply). Restyled from claims elsewhere on this page; add
            nothing here that isn't true in code. */}
        <div className="mx-auto mt-8 max-w-md rounded-2xl border border-stone-200 bg-stone-50 p-5 dark:border-white/10 dark:bg-stone-800">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-stone-500 dark:text-stone-400">
            The honest deal
          </h3>
          <ul className="mt-3 space-y-2 text-sm text-stone-600 dark:text-stone-400">
            <li className="flex items-start gap-2">
              <Check className="mt-0.5 h-4 w-4 shrink-0 text-green-700 dark:text-green-400" />
              <span>
                Max 3 pros per job, so you&apos;re never competing against a crowd
                of other pros. You never lose
                money on a job you didn&apos;t get: if the homeowner picks
                someone else, your fee comes back on its own as wallet credit,
                good for 60 days.
              </span>
            </li>
            <li className="flex items-start gap-2">
              <Check className="mt-0.5 h-4 w-4 shrink-0 text-green-700 dark:text-green-400" />
              <span>
                Ghost protection: if the homeowner doesn&apos;t respond
                within 7 days, your fee comes back automatically as wallet
                credit for your next application.
              </span>
            </li>
            <li className="flex items-start gap-2">
              <Check className="mt-0.5 h-4 w-4 shrink-0 text-green-700 dark:text-green-400" />
              <span>
                {FIRST_APPLICATION_GUARANTEE} Licensed pros get this once.
              </span>
            </li>
            <li className="flex items-start gap-2">
              <Check className="mt-0.5 h-4 w-4 shrink-0 text-green-700 dark:text-green-400" />
              <span>Jobs that sit unclaimed get marked down 15-30%.</span>
            </li>
            <li className="flex items-start gap-2">
              <Check className="mt-0.5 h-4 w-4 shrink-0 text-green-700 dark:text-green-400" />
              <span>No subscription required. You pay per application.</span>
            </li>
          </ul>
        </div>
      </section>

      {/* Honesty line: this matches the wallet's actual bonus terms */}
      <p className="mx-auto mt-12 max-w-md text-center text-xs text-stone-500 dark:text-stone-400">
        Deposits of $200 or more earn bonus credit on top. Bonus credit
        expires 60 days after you get it. The money you deposited never
        expires.
      </p>

      <footer className="mt-16 border-t border-stone-200 pt-6 text-center dark:border-white/10">
        <Link href="/" className="text-sm text-stone-500 hover:text-bark-700 dark:text-stone-400 dark:hover:text-stone-300">
          Looking after your own home instead? Hearth for Homeowners →
        </Link>
        <p className="mt-2 text-xs text-stone-500 dark:text-stone-400">
          <Link href="/privacy" className="hover:text-bark-700 hover:underline dark:hover:text-stone-300">
            Privacy
          </Link>{" "}
          ·{" "}
          <Link href="/terms" className="hover:text-bark-700 hover:underline dark:hover:text-stone-300">
            Terms
          </Link>
        </p>
      </footer>
      </div>
    </main>
  );
}
