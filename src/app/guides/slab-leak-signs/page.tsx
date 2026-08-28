import type { Metadata } from "next";
import Link from "next/link";
import GuideCta from "@/components/GuideCta";

// Public SEO guide, written for the Fountain Valley / Huntington Beach launch
// market: 1960s-70s tract homes on slab foundations with copper supply lines
// run through the slab, which is exactly the construction pattern that makes
// slab leaks common there. No local prices are quoted; costs vary too much
// by leak location and access to state a number honestly.

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
  title: "Slab leak signs: how to spot one early",
  description:
    "The early warning signs of a slab leak, why older Orange County homes are prone to them, repair options, and when it's an emergency.",
  alternates: {
    canonical: `${SITE_URL}/guides/slab-leak-signs`,
  },
};

const FAQS = [
  {
    q: "What are the signs of a slab leak?",
    a: "The most common signs are a warm or hot spot on the floor, a water bill that jumps without a clear reason, the sound of running water when every faucet and appliance is off, and in more advanced cases, damp carpet, a musty smell, or cracks in the flooring or slab itself.",
  },
  {
    q: "How much does a slab leak repair cost?",
    a: "It depends mostly on where the leak sits and how it has to be accessed. A spot repair through a reachable section of slab is usually the cheapest option, a reroute costs more because it involves running new pipe through the attic or walls, and a full repipe is the biggest job since it replaces every supply line at once. Because access and pipe length vary so much from house to house, we don't quote a number here: a licensed plumber can give you one once they've located the leak.",
  },
  {
    q: "What are my repair options for a slab leak?",
    a: "At a high level, the main options are a spot repair (opening the slab at the leak to fix that one section of pipe), a reroute (abandoning the damaged line and running a new one through the attic or walls instead of back through the slab), or a full repipe (replacing all the home's supply lines at once, usually through the attic). A licensed plumber can tell you which fits your situation after locating the leak.",
  },
  {
    q: "Is a slab leak an emergency?",
    a: "Treat it as an emergency if you see active water pooling, water is coming up through the flooring, or you can't stop the flow at your main shutoff valve. A slow leak with just a warm spot and a rising water bill is worth addressing quickly, but it usually isn't a same-hour emergency the way active flooding is.",
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

export default function SlabLeakSignsGuide() {
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
        Slab leak signs: how to spot one early
      </h1>
      <p className="mt-3 text-sm text-stone-500 dark:text-stone-400">
        General guidance for homeowners, especially in older Orange County
        tract homes.
      </p>

      <div className="mt-8 space-y-6 text-stone-700 dark:text-stone-300">
        <section>
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
            What to look for
          </h2>
          <p className="mt-2 leading-relaxed">
            A slab leak is a leak in a water line running underneath your
            home&apos;s concrete foundation. Because the pipe is hidden, the signs
            tend to show up somewhere else first: a spot on the floor that&apos;s
            noticeably warm (usually a hot water line), a water bill that
            climbs without a clear explanation, or the sound of running water
            when every faucet, toilet, and appliance in the house is off. As
            a leak progresses, you may also notice damp or discolored carpet
            and flooring, a musty smell in one area, low water pressure, or
            cracks in the flooring or slab.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
            Why older Orange County homes are prone to this
          </h2>
          <p className="mt-2 leading-relaxed">
            Much of Orange County, from Fountain Valley and Huntington Beach
            to Garden Grove, Anaheim, and Santa Ana, was built out during
            the 1960s and 1970s, when it was standard practice to run copper
            water supply lines directly through the concrete slab rather than
            through walls or an attic. Copper pipe from that era is now well
            past a typical plumbing system&apos;s working life, and decades of
            direct contact with concrete and soil, along with the normal
            expansion and contraction of the pipe, make corrosion and
            pinhole leaks more likely than in homes with more accessible
            plumbing. It&apos;s a pattern of the era and construction method, not
            a reflection of how well any individual home has been cared for.
          </p>
          <p className="mt-2 text-sm text-stone-500 dark:text-stone-400">
            See what Hearth offers homeowners in{" "}
            <Link href="/fountain-valley" className="text-bark-700 hover:underline dark:text-stone-300">
              Fountain Valley
            </Link>{" "}
            or{" "}
            <Link href="/huntington-beach" className="text-bark-700 hover:underline dark:text-stone-300">
              Huntington Beach
            </Link>
            .
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
            Repair options, at a high level
          </h2>
          <p className="mt-2 leading-relaxed">
            Once a plumber locates the leak, the usual options are a{" "}
            <strong>spot repair</strong> (opening the slab just at the leak
            and fixing that section of pipe), a{" "}
            <strong>reroute</strong> (capping the damaged line and running a
            new one through the attic or walls instead of back through the
            slab), or a full <strong>repipe</strong> (replacing all of the
            home&apos;s supply lines at once, typically through the attic, which
            is often considered once a home has had more than one slab leak).
            Which one makes sense depends on the pipe&apos;s condition elsewhere
            in the home, not just the single leak that got noticed.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
            When it&apos;s an emergency
          </h2>
          <p className="mt-2 leading-relaxed">
            Active water pooling, water coming up through the flooring, or a
            leak you can&apos;t stop by closing the main shutoff valve are all
            reasons to call a plumber right away. A slow leak, where the only
            signs are a warm spot and a rising water bill, is still worth
            addressing promptly, since it can undermine flooring and drive up
            water costs over time, but it usually doesn&apos;t need a same-hour
            emergency response the way active flooding does.
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
