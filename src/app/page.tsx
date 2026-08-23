import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getSides, landingFor } from "@/lib/contractor";
import { FOUNDER, PLUS_PLAN } from "@/lib/constants";
import { LAUNCH_AREA_LABEL } from "@/lib/serviceArea";
import Link from "next/link";
import Image from "next/image";
import Logo from "@/components/Logo";
import HeroDemoPlayerLazy from "@/components/HeroDemoPlayerLazy";
import HeroPhotoCycler from "@/components/HeroPhotoCycler";
import ThemeToggle from "@/components/ThemeToggle";
import StructuredData from "@/components/StructuredData";
import { TrendingUp, Bell, MessageSquare, Wrench } from "lucide-react";

const SITE_URL =
  process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

// The root layout already sets the default title/description (both true of
// the landing page as-is) and openGraph.siteName/type/locale, which this page
// inherits unchanged. The one thing missing at the root is a canonical link -
// metadataBase alone doesn't emit one - so this only adds that.
export const metadata: Metadata = {
  alternates: {
    canonical: `${SITE_URL}/`,
  },
};

// The landing page's own structured data: the WebApplication/pricing facts an
// app-install search result can use, per Google's guidance for "software
// application" rich results. Organization deliberately is NOT repeated here -
// src/app/layout.tsx emits the single Organization node (name, url, logo,
// areaServed) on every page including this one, and publisher points at it by
// @id rather than restating the business a second time on the same page.
const landingJsonLd = [
  {
    "@context": "https://schema.org",
    "@type": "WebApplication",
    name: "Hearth",
    url: SITE_URL,
    applicationCategory: "LifestyleApplication",
    operatingSystem: "iOS, Android, Web",
    publisher: { "@id": `${SITE_URL}#organization` },
    offers: [
      {
        "@type": "Offer",
        name: "Hearth (first home)",
        price: "0",
        priceCurrency: "USD",
      },
      {
        "@type": "Offer",
        name: "Hearth Plus (yearly)",
        price: String(PLUS_PLAN.yearly),
        priceCurrency: "USD",
      },
    ],
  },
];

// Shared "all clear" pill: same green tone (.chip-ok) used by both the hero
// reassurance row and the trust strip below, so the two lists render off one
// component instead of two copies of the same markup drifting apart.
function CheckPill({ label }: { label: string }) {
  return (
    <span className="inline-flex min-h-[44px] items-center gap-1.5 rounded-full border border-green-200 bg-green-50 px-4 py-1.5 text-sm font-semibold text-green-700 sm:min-h-0 sm:px-3.5 dark:border-green-500/30 dark:bg-green-500/15 dark:text-green-300">
      <svg
        viewBox="0 0 20 20"
        className="h-4 w-4"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="m4 10.5 4 4 8-9" />
      </svg>
      {label}
    </span>
  );
}

// Root: route signed-in users into the app, everyone else to the marketing-lite
// landing. Kept server-side so there's no flash of the wrong screen.
//
// STAYS DYNAMIC, on its own merits rather than the root layout's (that no
// longer reads cookies - see src/app/layout.tsx). Two per-request reads sit
// above the markup and both are routing decisions, not decoration:
// searchParams.code catches a magic link that landed here instead of
// /auth/callback and forwards it, and auth.getUser() + getSides() sends a
// signed-in visitor to /pro or /dashboard. No per-request DATA feeds the
// landing markup itself - every list below is a plain in-function constant -
// so if those two redirects ever move (the code hand-off into middleware, the
// signed-in bounce into a client-side check), this page prerenders with no
// other work. Until then a revalidate export would be a no-op and force-static
// would silently break both redirects.
export default async function Home(props: {
  searchParams: Promise<{ code?: string }>;
}) {
  const searchParams = await props.searchParams;
  // Safety net: if a magic link lands here (e.g. Supabase fell back to the Site
  // URL instead of /auth/callback), forward the code to the handler that
  // exchanges it for a session.
  if (searchParams.code) {
    redirect(
      `/auth/callback?code=${encodeURIComponent(searchParams.code)}&next=/dashboard`
    );
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (user) {
    // Their preferred side when they actually have it, otherwise whichever
    // side they do have. An account can hold both, so this is never a guess
    // off the role stamp alone.
    redirect(landingFor(await getSides()));
  }

  const VALUE = [
    {
      icon: TrendingUp,
      title: "No surprise repair bills",
      body: "See what may need replacing soon and how much to save each month. A big repair becomes a plan, not a panic.",
    },
    {
      icon: Bell,
      title: "Know before it breaks",
      body: "Hearth watches for storms, recalls, and aging systems like your water heater or furnace, then sends the alert. You never have to check.",
    },
    {
      icon: MessageSquare,
      title: "Answers about your home",
      body: "Ask Hearth anything. It knows what's in your home, how old each thing is, and its history.",
    },
    {
      icon: Wrench,
      title: "The right pro, fast",
      body: "Post the job once and Hearth fills in your home's details for you, so local pros can quote it fast.",
    },
  ];

  // Backs both the visible FAQ cards below and the FAQPage JSON-LD: one list,
  // so the structured data can never drift from what a visitor actually
  // reads. `a` is the plain-text answer (what JSON-LD gets); `node`, when
  // present, is the richer JSX version rendered on the page (for the one
  // answer that links out to the privacy policy).
  const FAQ_ITEMS: { q: string; a: string; node?: React.ReactNode }[] = [
    {
      q: "Is it really free?",
      a: "Yes. Your first home is free, no card needed. Hearth makes money two ways: an optional Plus plan, and a fee pros pay when they apply to a job.",
    },
    {
      q: "What do you do with my data?",
      a: "Your home details are stored in our database and used to run Hearth: reminders, alerts, and answers about your house. We don't sell your personal data, and we don't let ad companies track what you do here. When you post a job, a pro sees only what's needed to quote it. The full details are in the privacy policy.",
      node: (
        <>
          Your home details are stored in our database and used to run
          Hearth: reminders, alerts, and answers about your house. We
          don&apos;t sell your personal data, and we don&apos;t let ad
          companies track what you do here. When you post a job, a pro sees only
          what&apos;s needed to quote it. The full details are in the{" "}
          <Link
            href="/privacy"
            className="text-bark-700 hover:underline dark:text-stone-300"
          >
            privacy policy
          </Link>
          .
        </>
      ),
    },
    {
      q: "Who are the pros?",
      a: "Local pros who set up their own Hearth profiles. If a pro has a California license number, we check it live with the state's contractor license board (the CSLB) and show the result. Some trades, like handyman work or cleaning, don't require a license, so not every pro will have that badge. Pros can also complete an optional background check, which shows on their profile if they do. You always see exactly what's been verified and what hasn't.",
    },
    {
      q: "Will I get flooded with calls once I post a job?",
      a: "No. Your contact info stays private until you pick a pro yourself, and at most three pros can apply to any job. Until you choose someone, the conversation happens inside Hearth, not on your phone.",
    },
    {
      q: "Where is Hearth available?",
      a: "We're serving Huntington Beach, Fountain Valley, Seal Beach, Westminster, Midway City, Garden Grove, Santa Ana, Costa Mesa, and Newport Beach right now, with local pros there. Don't see your city yet? You will soon. If you're outside those cities you can still sign up and join the waitlist, which is how we decide where Hearth goes next.",
    },
    {
      q: "What does Plus cost?",
      a: "Hearth itself stays free for your first home. Hearth Plus is optional: $4.99/mo with your first 3 days free, or $39.99/yr (about $3.33/mo), whichever you pick. After the free days on monthly we charge your card automatically unless you cancel, and you can cancel anytime.",
      node: (
        <>
          Hearth itself stays free for your first home. Hearth Plus is
          optional: $4.99/mo with your first 3 days free, or $39.99/yr (about
          $3.33/mo) billed today, whichever you pick. After the free days on
          monthly we charge your card automatically unless you cancel, and
          you can cancel anytime.{" "}
          <Link
            href="/pricing"
            className="text-bark-700 hover:underline dark:text-stone-300"
          >
            See what Plus costs
          </Link>
          .
        </>
      ),
    },
    {
      q: "Where does my home's info come from?",
      a: "When you enter your address, we look it up against public county records to pre-fill your home's year built, size, and other facts. You can correct anything that's off once you're in.",
    },
    {
      q: "What happens if I cancel or delete my account?",
      a: "Canceling Hearth Plus just stops the subscription: you keep your account and home data, and lose the Plus tools. Deleting your account is separate and permanent: it removes your data from Hearth. One thing to know: if you already shared details with a pro through a job or message, they may keep their own copy in their own business records.",
    },
  ];

  const faqJsonLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: FAQ_ITEMS.map((f) => ({
      "@type": "Question",
      name: f.q,
      acceptedAnswer: { "@type": "Answer", text: f.a },
    })),
  };

  const STEPS = [
    { n: "1", text: "Type your address." },
    {
      n: "2",
      text: "Add a few home details, or skip them and fill them in later.",
    },
    {
      n: "3",
      text: "Once you've added a few details, Hearth works out what needs attention and what it should cost, automatically.",
    },
  ];

  // Service-scent chips: the jobs people most often come here for. `value` is
  // the JOB_CATEGORIES key; each chip drops into homeowner signup with the
  // category riding along in ?next= so /contractors (which reads ?category=)
  // lands on a pre-filled post-a-job form. `label` is the friendlier public
  // wording (e.g. "Roofing" for the "roof" category).
  const SERVICE_SCENT = [
    { value: "plumbing", label: "Plumbing" },
    { value: "electrical", label: "Electrical" },
    { value: "hvac", label: "HVAC" },
    { value: "roof", label: "Roofing" },
    { value: "painting", label: "Painting" },
    { value: "landscaping", label: "Landscaping" },
    { value: "handyman", label: "Handyman" },
    { value: "remodeling", label: "Remodeling" },
  ];

  // Trust strip: three signals that are already true today, no invented
  // numbers. Reuses the same green "all clear" pill as the hero reassurance
  // row (.chip-ok tone).
  const TRUST_SIGNALS = [
    "State contractor license (CSLB) checks",
    "County-records ownership match (we confirm the poster owns the home)",
    "Your contact info stays private",
  ];

  // Hero photo set for the crossfading cycler: the warm home leads (it paints
  // first, server-visible), then a run of licensed trade photos, closing on a
  // second warm home. Each alt names the trade or scene shown. The roofer
  // photo is deliberately absent: it already anchors the "How it works"
  // section below, and repeating it in the cycler read as a mistake.
  const HERO_PHOTOS = [
    {
      src: "/photos/craftsman-home-dusk.jpg",
      alt: "A warm craftsman home with glowing windows at dusk",
    },
    {
      src: "/photos/plumber-pipe-fittings.jpg",
      alt: "A plumber's hands tightening pipe fittings",
    },
    {
      src: "/photos/electrician-switchboard.jpg",
      alt: "An electrician working on a breaker panel",
    },
    {
      src: "/photos/painter-undercoating-wall.jpg",
      alt: "A painter prepping and undercoating a bright wall",
    },
    {
      src: "/photos/hvac-technician-gauges.jpg",
      alt: "An HVAC technician holding refrigerant manifold gauges",
    },
    {
      src: "/photos/landscaper-mowing-lawn.jpg",
      alt: "A landscaper mowing a green lawn at golden hour",
    },
    {
      src: "/photos/handyman-cordless-drill.jpg",
      alt: "A handyman drilling into a wood board with a cordless drill",
    },
    {
      src: "/photos/flooring-installation-planks.jpg",
      alt: "A flooring installer fitting hardwood planks together",
    },
    {
      src: "/photos/tiling-backsplash.jpg",
      alt: "A tiler setting mosaic tile onto a kitchen backsplash",
    },
    {
      src: "/photos/concrete-finishing-float.jpg",
      alt: "A worker finishing a fresh concrete slab with a float",
    },
    {
      src: "/photos/window-installation-drill.jpg",
      alt: "A window installer driving a screw into a window frame",
    },
    {
      src: "/photos/suburban-home-sunset.jpg",
      alt: "A suburban home at dusk with warm glowing windows",
    },
  ];

  return (
    <main className="pb-16">
      <StructuredData data={landingJsonLd} />
      {/* Warm band wraps header, hero, and the product preview: a single
          flat fill, hearth-50 in light and stone-900 in dark (matching the
          body), no gradient. */}
      <div className="bg-hearth-50 dark:bg-stone-900">
        <div className="mx-auto max-w-5xl px-6 pt-6">
          {/* Slim header: wordmark left, theme switch + quiet pro door right */}
          <header className="flex items-center justify-between">
            <span className="inline-flex items-center gap-2 font-semibold text-stone-900 dark:text-stone-100">
              <Logo className="h-6 w-6 text-bark-700 dark:text-stone-400" /> Hearth
            </span>
            <div className="flex items-center gap-2">
              <ThemeToggle />
              <Link
                href="/emergency-help"
                className="px-2 py-1.5 text-sm font-medium text-stone-600 hover:text-bark-700 dark:text-stone-400 dark:hover:text-stone-200"
              >
                {/* Compact label on mobile (header space is tight), full
                    wording from sm up - desktop text/appearance unchanged. */}
                <span className="sm:hidden">Emergency</span>
                <span className="hidden sm:inline">Emergency help</span>
              </Link>
              <Link
                href="/pros"
                className="whitespace-nowrap rounded-lg border border-stone-300 px-3 py-1.5 text-sm font-medium text-stone-700 hover:border-bark-500 hover:text-bark-700 dark:border-white/10 dark:text-stone-300 dark:hover:border-bark-500 dark:hover:text-stone-300"
              >
                {/* At 390px the full label wrapped to two lines and made the
                    header two rows tall. Short label on mobile, unchanged
                    wording from sm up. */}
                <span className="sm:hidden">For Pros</span>
                <span className="hidden sm:inline">Hearth for Pros</span>
              </Link>
            </div>
          </header>

          {/* Hero: split layout. Copy and CTA on the left, a flat photo of a
              warm home on the right. Below lg it collapses to one column and
              the photo stacks under the copy, so mobile keeps the old
              centered read. */}
          <div className="mt-14 grid items-center gap-10 sm:mt-20 lg:grid-cols-2 lg:gap-12">
            <div className="flex flex-col items-center text-center lg:items-start lg:text-left">
              <h1 className="max-w-2xl text-4xl font-semibold tracking-tight text-stone-900 dark:text-stone-100 sm:text-6xl sm:tracking-[-0.03em] [text-wrap:balance]">
                Know what your home needs before it costs you
              </h1>
              <p className="mt-5 max-w-xl text-lg leading-relaxed text-stone-600 dark:text-stone-400">
                Hearth checks on your home for you and warns you before things
                break. When you need a pro, post the job once and the quotes
                come to you.
              </p>
              {/* Straight to homeowner signup: this page is homeowner-targeted
                  and pros have two dedicated doors (header link + pro band), so
                  the "Who are you?" fork on /get-started only cost a click. */}
              <Link
                href="/homeowner-signup"
                className="btn-primary mt-8 px-6 py-3 text-base shadow-lift"
              >
                Get started free
              </Link>
              {/* Reassurance as pills, not fine print: these facts (fast, free,
                  no strings) are what get someone to actually click, so they get
                  the same visual weight as a real UI element, not a footnote.
                  Green is the success tone everywhere else in the app (.chip-ok),
                  so it reads as "all clear" here too. This exact trio is the
                  founder's pick. */}
              <div className="mt-5 flex flex-wrap items-center justify-center gap-2 lg:justify-start">
                {["About 30 seconds", "No card needed", "Cancel anytime"].map((label) => (
                  <CheckPill key={label} label={label} />
                ))}
              </div>
              <p className="mt-4 text-sm text-stone-500 dark:text-stone-400">
                Serving {LAUNCH_AREA_LABEL}
              </p>
              <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">
                Don&apos;t see your city yet? You will soon.
              </p>
              <div className="mt-4 flex justify-center text-sm lg:justify-start">
                <Link href="/signin" className="text-bark-700 hover:underline dark:text-stone-300">
                  Already have an account? Sign in
                </Link>
              </div>
            </div>
            {/* Flat hero photo: no gradient, no glass, no text-over-image
                scrim - just a licensed photo in a rounded frame. The cycler's
                aspect-[3/2] box reserves the space so it never shifts layout,
                and the first frame loads with priority since it's above the
                fold. */}
            <div className="overflow-hidden rounded-xl border border-stone-200 dark:border-white/10">
              <HeroPhotoCycler photos={HERO_PHOTOS} />
            </div>
          </div>

          {/* The demo replaces what used to be a static Health Score mockup:
              same content, but now it actually plays. Click to play, inline,
              never a takeover, see HeroDemoPlayer.tsx. Loaded through
              HeroDemoPlayerLazy so the player's chunk stays out of this
              page's first-load JS; the poster paints at the same size either
              way, so there is no shift when it arrives. */}
          <section className="mt-16 flex flex-col items-center sm:mt-20">
            <div className="w-full max-w-xl">
              <HeroDemoPlayerLazy />
            </div>
          </section>
        </div>
      </div>

      <div className="mx-auto max-w-3xl px-6">
      {/* Service scent: the common jobs, as flat clickable chips. Each drops
          into homeowner signup with the category preset in ?next= so the
          post-a-job form on /contractors lands pre-filled (it reads
          ?category=). Chips reuse the header link's neutral outline shape,
          rounded full, and stay plain text labels - no trade pictograms. */}
      <section className="mt-12 sm:mt-16">
        <h2 className="text-center text-sm font-semibold uppercase tracking-wide text-stone-500 dark:text-stone-400">
          Find a pro for
        </h2>
        <ul className="mx-auto mt-4 flex max-w-2xl flex-wrap justify-center gap-2">
          {SERVICE_SCENT.map((s) => (
            <li key={s.value}>
              <Link
                href={`/homeowner-signup?next=${encodeURIComponent(
                  `/contractors?category=${s.value}`
                )}`}
                className="inline-flex min-h-[44px] items-center rounded-full border border-stone-300 bg-white px-4 py-1.5 text-sm font-medium text-stone-700 hover:border-bark-500 hover:text-bark-700 sm:min-h-0 sm:px-3.5 dark:border-white/10 dark:bg-stone-800 dark:text-stone-300 dark:hover:border-bark-500 dark:hover:text-stone-100"
              >
                {s.label}
              </Link>
            </li>
          ))}
        </ul>
      </section>

      {/* Trust strip: three already-true signals in the green "all clear"
          pill, the same tone as the hero reassurance row. No invented
          numbers - only what Hearth actually does today. */}
      <section className="mt-8">
        <h2 className="text-center text-sm font-semibold uppercase tracking-wide text-stone-500 dark:text-stone-400">
          What we check
        </h2>
        <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
          {TRUST_SIGNALS.map((label) => (
            <CheckPill key={label} label={label} />
          ))}
        </div>
      </section>

      {/* How it works: steps on the left, a flat photo of real work on the
          right. Collapses to one column below lg (steps, then photo). */}
      <section className="mt-16 sm:mt-24">
        <div className="grid items-center gap-8 lg:grid-cols-2 lg:gap-12">
          <div>
            <h2 className="text-center text-2xl font-semibold text-stone-900 dark:text-stone-100 [text-wrap:balance] lg:text-left">
              How it works
            </h2>
            <ol className="mx-auto mt-6 max-w-md space-y-4 lg:mx-0">
              {STEPS.map((s) => (
                <li key={s.n} className="flex items-start gap-3">
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-bark-600 text-sm font-semibold text-white">
                    {s.n}
                  </span>
                  <p className="pt-0.5 text-stone-600 dark:text-stone-400">{s.text}</p>
                </li>
              ))}
            </ol>
          </div>
          {/* Flat trade photo, same framed treatment as the hero. Not
              priority - it sits below the fold. */}
          <div className="overflow-hidden rounded-xl border border-stone-200 dark:border-white/10">
            <Image
              src="/photos/roofer-installing-shingles.jpg"
              alt="A roofer installing asphalt shingles on a home"
              width={1600}
              height={1067}
              sizes="(min-width: 1024px) 22rem, 100vw"
              className="h-auto w-full object-cover"
            />
          </div>
        </div>
      </section>

      {/* Value */}
      <section className="mt-16 sm:mt-24">
        <h2 className="text-center text-2xl font-semibold text-stone-900 dark:text-stone-100 [text-wrap:balance]">
          What Hearth watches for you
        </h2>
        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          {VALUE.map((v) => (
            <div key={v.title} className="card">
              <div className="icon-chip" aria-hidden>
                <v.icon className="h-5 w-5" />
              </div>
              <h3 className="mt-3 font-semibold text-stone-900 dark:text-stone-100">{v.title}</h3>
              <p className="mt-1 text-sm leading-relaxed text-stone-600 dark:text-stone-400">{v.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Trust band, same as the /pros version. */}
      <section className="mt-16 rounded-2xl bg-stone-900 px-6 py-8 dark:bg-stone-950 text-center sm:mt-24">
        <h2 className="text-2xl font-semibold text-white [text-wrap:balance]">
          Real people, real answers
        </h2>
        <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-stone-300">
          Message us and a real person on our team will answer. Pros see only
          what you choose to share.
        </p>
        <p className="mx-auto mt-3 max-w-md text-sm leading-relaxed text-stone-300">
          Hearth started close to home. We serve{" "}
          <Link
            href="/fountain-valley"
            className="text-bark-500 hover:underline"
          >
            Fountain Valley
          </Link>
          ,{" "}
          <Link
            href="/huntington-beach"
            className="text-bark-500 hover:underline"
          >
            Huntington Beach
          </Link>
          , and nearby Orange County homeowners. Don&apos;t see your city yet?
          You will soon.
        </p>
        {/* Contact form works with no session and no owner-fillable fields,
            unlike the old mailto/tel here, so it's always shown - see
            src/app/contact/page.tsx and the note in LegalContact.tsx for why
            this changed. The cell-phone line is still owner-fillable and
            still drops out entirely when blank. */}
        <Link
          href="/contact"
          className="mt-4 inline-block text-sm text-bark-500 hover:underline"
        >
          Questions? Contact us →
        </Link>
        {FOUNDER.cellPhone && (
          <a
            href={`tel:${FOUNDER.cellPhone.replace(/[^\d+]/g, "")}`}
            className="mt-1 block text-sm text-bark-500 hover:underline"
          >
            Or call or text {FOUNDER.cellPhone} →
          </a>
        )}
      </section>

      {/* FAQ: the questions people actually ask, answered from what the
          product really does. No invented stats, no "vetted" claims.
          FAQ_ITEMS also backs the FAQPage JSON-LD below, so the structured
          data can't say something these cards don't. */}
      <section className="mt-16 sm:mt-24">
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(faqJsonLd) }}
        />
        <h2 className="text-center text-2xl font-semibold text-stone-900 dark:text-stone-100 [text-wrap:balance]">
          Quick questions
        </h2>
        <div className="mx-auto mt-6 max-w-xl space-y-4">
          {FAQ_ITEMS.map((f) => (
            <div key={f.q} className="card">
              <h3 className="font-semibold text-stone-900 dark:text-stone-100">{f.q}</h3>
              <p className="mt-1 text-sm leading-relaxed text-stone-600 dark:text-stone-400">
                {f.node ?? f.a}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* Closing CTA: one more clear door in before the pro band switches
          audience. The only other filled primary button is the hero's. */}
      <section className="mt-16 text-center sm:mt-24">
        <h2 className="mx-auto max-w-xl text-2xl font-semibold text-stone-900 dark:text-stone-100 [text-wrap:balance]">
          Know what your home needs before it costs you
        </h2>
        <Link
          href="/homeowner-signup"
          className="btn-primary mt-6 inline-block px-6 py-3 text-base shadow-lift"
        >
          Get started free
        </Link>
        <p className="mt-3 text-sm text-stone-500 dark:text-stone-400">
          Free for your first home. About 30 seconds to sign up. No card
          needed.
        </p>
      </section>

      {/* Pro band: the supply-side door gets its own pitch, not a whisper
          link. Outline button on purpose: the filled primary on this page is
          reserved for the homeowner CTAs. */}
      <section className="mt-16 rounded-2xl bg-stone-900 px-6 py-8 dark:bg-stone-950 text-center sm:mt-24">
        {/* stone-400 in BOTH modes: this band's fill is always dark (stone-900
            / stone-950), so the light-mode stone-500 the other eyebrows use
            would sit too dark against it. */}
        <h2 className="text-center text-sm font-semibold uppercase tracking-wide text-stone-400">
          For contractors
        </h2>
        <h3 className="mt-2 text-xl font-semibold text-white">
          Fix homes for a living? Real local leads, honest pricing.
        </h3>
        <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-stone-300">
          The fee is on every job before you pay, and if the homeowner never
          responds, it comes back automatically as wallet credit. No
          subscription. You pay only when you apply.
        </p>
        <Link
          href="/pros"
          className="mt-5 inline-block rounded-lg border border-stone-500 px-6 py-2.5 font-medium text-white hover:border-white hover:bg-white/10"
        >
          Explore Hearth for Pros
        </Link>
      </section>

      <footer className="mt-16 border-t border-stone-200 pt-8 sm:mt-24 dark:border-white/10">
        <div className="grid gap-8 text-left sm:grid-cols-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-stone-500 dark:text-stone-400">
              Guides
            </p>
            <ul className="mt-2 space-y-1.5 text-sm text-stone-600 dark:text-stone-400">
              <li>
                <Link href="/guides" className="hover:text-bark-700 hover:underline dark:hover:text-stone-300">
                  All guides
                </Link>
              </li>
              <li>
                <Link
                  href="/guides/water-heater-replacement-cost"
                  className="hover:text-bark-700 hover:underline dark:hover:text-stone-300"
                >
                  Water heater replacement cost
                </Link>
              </li>
              <li>
                <Link
                  href="/guides/hvac-replacement-cost"
                  className="hover:text-bark-700 hover:underline dark:hover:text-stone-300"
                >
                  HVAC replacement cost
                </Link>
              </li>
              <li>
                <Link
                  href="/guides/socal-home-maintenance-calendar"
                  className="hover:text-bark-700 hover:underline dark:hover:text-stone-300"
                >
                  SoCal maintenance calendar
                </Link>
              </li>
            </ul>
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-stone-500 dark:text-stone-400">
              Cities
            </p>
            <ul className="mt-2 space-y-1.5 text-sm text-stone-600 dark:text-stone-400">
              <li>
                <Link
                  href="/fountain-valley"
                  className="hover:text-bark-700 hover:underline dark:hover:text-stone-300"
                >
                  Fountain Valley
                </Link>
              </li>
              <li>
                <Link
                  href="/huntington-beach"
                  className="hover:text-bark-700 hover:underline dark:hover:text-stone-300"
                >
                  Huntington Beach
                </Link>
              </li>
            </ul>
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-stone-500 dark:text-stone-400">
              Hearth
            </p>
            <ul className="mt-2 space-y-1.5 text-sm text-stone-600 dark:text-stone-400">
              <li>
                <Link href="/pricing" className="hover:text-bark-700 hover:underline dark:hover:text-stone-300">
                  Pricing
                </Link>
              </li>
              <li>
                <Link href="/emergency-help" className="hover:text-bark-700 hover:underline dark:hover:text-stone-300">
                  Emergency help
                </Link>
              </li>
              <li>
                <Link href="/pros" className="hover:text-bark-700 hover:underline dark:hover:text-stone-300">
                  For Pros
                </Link>
              </li>
              <li>
                <Link href="/signin" className="hover:text-bark-700 hover:underline dark:hover:text-stone-300">
                  Sign in
                </Link>
              </li>
            </ul>
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-stone-500 dark:text-stone-400">
              Fine print
            </p>
            <ul className="mt-2 space-y-1.5 text-sm text-stone-600 dark:text-stone-400">
              <li>
                <Link href="/privacy" className="hover:text-bark-700 hover:underline dark:hover:text-stone-300">
                  Privacy
                </Link>
              </li>
              <li>
                <Link href="/terms" className="hover:text-bark-700 hover:underline dark:hover:text-stone-300">
                  Terms
                </Link>
              </li>
              <li>
                <Link href="/ai-disclosure" className="hover:text-bark-700 hover:underline dark:hover:text-stone-300">
                  How we use AI
                </Link>
              </li>
              {/* Was a mailto: to FOUNDER.email; a raw address in a
                  site-wide footer is exactly the kind of thing spam
                  scrapers find first. Always rendered now, unlike the old
                  conditional, since the contact form needs no owner-fillable
                  field to work. */}
              <li>
                <Link
                  href="/contact"
                  className="hover:text-bark-700 hover:underline dark:hover:text-stone-300"
                >
                  Contact us
                </Link>
              </li>
            </ul>
          </div>
        </div>
        <p className="mt-8 inline-flex w-full items-center justify-center gap-2 pb-2 text-xs text-stone-500 dark:text-stone-400">
          <Logo className="h-6 w-6 text-bark-700 dark:text-stone-400" /> Hearth · Your home,
          looked after
        </p>
      </footer>
      </div>
    </main>
  );
}
