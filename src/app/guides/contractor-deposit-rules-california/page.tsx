import type { Metadata } from "next";
import Link from "next/link";
import GuideCta from "@/components/GuideCta";
import Breadcrumbs, { BreadcrumbJsonLd } from "@/components/Breadcrumbs";

// Public consumer-protection guide (not a cost guide). Statutes are stated
// with their exact conditions:
//  - Down payment cap: Business and Professions Code 7159.5(a)(3), a down
//    payment may not exceed $1,000 or 10 percent of the contract price,
//    whichever is less. Confirmed against FindLaw's copy of BPC 7159.5,
//    current as of Jan 1, 2026.
//  - Written home improvement contract required when the aggregate price
//    exceeds $500 (BPC 7159).
//  - CSLB license threshold: $1,000 or more in combined labor and materials
//    requires a licensed contractor as of Jan 1, 2025 (AB 2622), with the
//    no-permit, no-employees, and no contract-splitting carve-outs.

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
const TITLE = "How much can a contractor ask for up front in California?";
const DESCRIPTION =
  "California law caps the down payment a contractor can require on a home improvement job, requires a written contract over $500, and sets when a license is needed. What the rules are, how progress payments should work, and the red flags to watch.";
const CANONICAL = `${SITE_URL}/guides/contractor-deposit-rules-california`;

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
    q: "How much can a contractor legally ask for up front in California?",
    a: "For a home improvement contract, California law caps the down payment at $1,000 or 10 percent of the contract price, whichever is less. So on a $25,000 remodel the down payment is capped at $1,000, not 10 percent, because $1,000 is the smaller number. On a $6,000 job, 10 percent is $600, and that is the cap because it is smaller than $1,000. This comes from Business and Professions Code section 7159.5.",
  },
  {
    q: "Does the down payment cap apply to every contractor job?",
    a: "The cap applies to home improvement contracts, which are the residential repair and improvement jobs most homeowners hire for. There are limited exceptions in the law, and the rules can work differently for things like new home construction. If you are unsure whether your job qualifies, ask the contractor to point to where the down payment sits in the written contract, since the required contract language spells the cap out.",
  },
  {
    q: "Is a written contract required for home improvement work in California?",
    a: "Yes. A home improvement contract must be in writing and signed when the total price, including labor and materials, exceeds $500. A contractor who asks you to skip the written contract on a job over that amount is not following the law, and a written contract is your main protection if something goes wrong.",
  },
  {
    q: "When does a contractor in California need a license?",
    a: "As of January 1, 2025, a contractor's license is required for work where the combined labor and materials come to $1,000 or more. Below that, an unlicensed person can do the work only if it needs no building permit and they hire no employees or helpers, and a job cannot be split into smaller pieces to stay under the limit. Any advertisement by an unlicensed person has to say they are not licensed. This change came from Assembly Bill 2622.",
  },
  {
    q: "What should I do if a contractor demands a large cash deposit?",
    a: "Treat it as a warning sign. Pressure to pay a big deposit, to pay in cash, or to start before anything is in writing are all red flags. Slow down, get the scope and the payment schedule in writing, keep the down payment within the legal cap, and keep a record of every payment and message. If it still feels wrong, you are free to walk away and hire someone else.",
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

export default function ContractorDepositRulesGuide() {
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
          { label: "How much can a contractor ask for up front in California?" },
        ]}
      />
      <BreadcrumbJsonLd
        items={[
          { name: "Home", href: "/" },
          { name: "Guides", href: "/guides" },
          { name: "How much can a contractor ask for up front in California?" },
        ]}
        siteUrl={SITE_URL}
      />

      <h1 className="mt-3 text-2xl font-bold text-stone-900 sm:text-3xl dark:text-stone-100">
        How much can a contractor ask for up front in California?
      </h1>
      <p className="mt-3 text-sm text-stone-500 dark:text-stone-400">
        A plain-language guide to California&apos;s deposit and contract rules
        for homeowners. It is general information, not legal advice.
      </p>

      <div className="mt-6 rounded-2xl border border-bark-100 bg-bark-50 p-5 dark:border-bark-700 dark:bg-bark-700/20">
        <p className="text-sm font-medium text-stone-500 dark:text-stone-400">
          The short answer
        </p>
        <p className="mt-1 text-2xl font-bold text-stone-900 dark:text-stone-100">
          $1,000 or 10 percent, whichever is less
        </p>
        <p className="mt-2 text-sm leading-relaxed text-stone-600 dark:text-stone-300">
          On a California home improvement contract, the down payment may not
          exceed $1,000 or 10 percent of the contract price, whichever amount is
          smaller.
        </p>
      </div>

      <div className="mt-8 space-y-6 text-stone-700 dark:text-stone-300">
        <section>
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
            The down payment cap
          </h2>
          <p className="mt-2 leading-relaxed">
            California law caps the down payment on a home improvement contract.
            Under Business and Professions Code section 7159.5, the down payment
            may not exceed <strong>$1,000 or 10 percent of the contract price,
            whichever is less</strong>. The required contract language even
            spells this out in bold type. A couple of examples:
          </p>
          <ul className="mt-2 list-disc space-y-1.5 pl-5 leading-relaxed">
            <li>
              On a <strong>$25,000</strong> kitchen remodel, 10 percent would be
              $2,500, so the cap is the smaller number: <strong>$1,000</strong>.
            </li>
            <li>
              On a <strong>$6,000</strong> job, 10 percent is $600, which is
              less than $1,000, so the cap is <strong>$600</strong>.
            </li>
          </ul>
          <p className="mt-2 leading-relaxed">
            If a contractor asks for more than that up front on a home
            improvement job, they are asking for more than the law allows.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
            Progress payments should track the work
          </h2>
          <p className="mt-2 leading-relaxed">
            After the down payment, payments should follow the work, not run
            ahead of it. A fair payment schedule ties each payment to progress
            you can see, so what you have paid never gets far ahead of what has
            actually been built. The rule of thumb is simple: never pay the full
            price up front, and never let your payments outpace the completed
            work. Holding money back until the job is truly done is your
            leverage to get problems fixed.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
            What a home improvement contract must include
          </h2>
          <p className="mt-2 leading-relaxed">
            In California, a home improvement job over <strong>$500</strong> in
            combined labor and materials requires a written contract, signed
            before work begins. A proper contract generally includes:
          </p>
          <ul className="mt-2 list-disc space-y-1.5 pl-5 leading-relaxed">
            <li>The contractor&apos;s name, address, and license number.</li>
            <li>A clear description of the work and the materials to be used.</li>
            <li>The total contract price.</li>
            <li>The down payment and a payment schedule tied to progress.</li>
            <li>Start and expected completion dates.</li>
          </ul>
          <p className="mt-2 leading-relaxed">
            A signed, written contract is your main protection. Verbal deals are
            hard to enforce, and any later change to the work should go in
            writing too.
          </p>
        </section>

        <div className="rounded-xl border border-stone-200 bg-white p-5 text-center dark:border-stone-700 dark:bg-stone-800/40">
          <p className="text-sm leading-relaxed text-stone-600 dark:text-stone-300">
            Keeping the whole job in one place makes this easier. Hearth chat
            keeps your messages and payment trail with a pro in one record you
            can look back on.
          </p>
          <Link
            href="/homeowner-signup"
            className="btn-primary mt-3 inline-block px-5 py-2"
          >
            Keep your project record in one place
          </Link>
        </div>

        <section>
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
            Red flags to watch for
          </h2>
          <ul className="mt-2 list-disc space-y-1.5 pl-5 leading-relaxed">
            <li>
              <strong>Pressure to pay a large deposit</strong> above the legal
              cap, or to pay most of the job before work starts.
            </li>
            <li>
              <strong>A push to pay in cash</strong>, which leaves you without a
              clear record.
            </li>
            <li>
              <strong>No written contract</strong> on a job over $500, or a rush
              to start before anything is signed.
            </li>
            <li>
              <strong>No license number</strong> offered, or reluctance to give
              one you can look up.
            </li>
          </ul>
          <p className="mt-2 leading-relaxed">
            None of these on their own proves bad intent, but together they are
            a reason to slow down and get everything in writing before any money
            changes hands.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
            When a contractor needs a license
          </h2>
          <p className="mt-2 leading-relaxed">
            As of January 1, 2025, California requires a contractor&apos;s
            license for work where the combined labor and materials come to{" "}
            <strong>$1,000 or more</strong>. This came from Assembly Bill 2622,
            which raised the old $500 threshold. Below $1,000, an unlicensed
            person can do the work only if all of the following are true:
          </p>
          <ul className="mt-2 list-disc space-y-1.5 pl-5 leading-relaxed">
            <li>The work needs no building permit of any kind.</li>
            <li>They hire no employees or helpers to do it.</li>
            <li>
              The job is not split into smaller pieces to stay under the limit.
            </li>
          </ul>
          <p className="mt-2 leading-relaxed">
            An unlicensed person advertising for work also has to state that
            they are not licensed. You can verify any contractor&apos;s license
            through the California Contractors State License Board before you
            hire.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
            Keep your payment and message trail
          </h2>
          <p className="mt-2 leading-relaxed">
            Whatever you do, keep a record. Save the signed contract, every
            change order, receipts for each payment, and the messages where you
            agreed to things. If a dispute ever comes up, that trail is what
            settles it. Keeping your conversation and payment history with a pro
            in one place, rather than scattered across texts, email, and paper,
            makes it far easier to see what was agreed and when.
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
            Data as of July 2026. The down payment cap is stated in California
            Business and Professions Code section 7159.5; the written-contract
            threshold in section 7159; and the licensing threshold reflects
            Assembly Bill 2622, effective January 1, 2025. Laws change and
            individual situations differ, so this is general information, not
            legal advice. For your specific case, confirm the current rules with
            the California Contractors State License Board or a qualified
            attorney.
          </p>
        </section>
      </div>

      <GuideCta
        signedInHref="/contractors"
        signedInLabel="Find a licensed pro"
      />
    </main>
  );
}
