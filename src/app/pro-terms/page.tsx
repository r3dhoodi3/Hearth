import { LegalContact } from "@/components/LegalContact";
import type { Metadata } from "next";
import Link from "next/link";

// Public top-level page, same pattern as src/app/terms/page.tsx:
// see src/lib/supabase/middleware.ts for the allowlist entry and
// src/app/sitemap.ts for the sitemap entry.
//
// This page is the B2B supplement to /terms for contractors using Hearth for
// Pros: license/insurance reps, independent-contractor status, the
// anti-circumvention fee-recovery clause, chargeback set-off, and a firmer
// limitation of liability. It does not replace /terms - a contractor account
// is still bound by the general Terms of Service and Privacy Policy for
// everything not specific to operating as a pro on the marketplace.

const SITE_URL =
  process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

export const metadata: Metadata = {
  // The root layout's title template appends "| Hearth"; don't repeat it here.
  title: "Contractor Terms",
  description:
    "The terms that apply specifically to contractors using Hearth for Pros: licensing and insurance, independent-contractor status, working with homeowners Hearth introduces you to, and payouts.",
  alternates: {
    canonical: `${SITE_URL}/pro-terms`,
  },
};

export default function ProTermsPage() {
  return (
    <main className="mx-auto max-w-2xl px-6 pb-16 pt-10">
      <p className="text-sm">
        {/* Same phone-only 44px tap target as the /contact back link: all
            added classes are max-sm:, so sm and up is unchanged. */}
        <Link href="/" className="text-stone-500 hover:text-bark-700 max-sm:inline-flex max-sm:min-h-11 max-sm:items-center max-sm:text-base dark:text-stone-400 dark:hover:text-stone-300">
          ← Hearth
        </Link>
      </p>

      <h1 className="mt-4 text-2xl font-bold text-stone-900 sm:text-3xl dark:text-stone-100">
        Contractor Terms
      </h1>
      <p className="mt-3 text-sm text-stone-500 dark:text-stone-400">
        Updated 2026-08-30. The plain-English basics, not legalese.
      </p>

      <div className="mt-8 space-y-8 text-stone-700 dark:text-stone-300">
        {/* TODO(legal): attorney review required — entity name and how these terms relate to the general Terms of Service as a matter of contract formation. */}
        <section>
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
            Who this applies to
          </h2>
          <p className="mt-2 leading-relaxed">
            These Contractor Terms apply to you if you use Hearth as a
            contractor, tradesperson, or company (&quot;pro&quot;) to receive
            leads, message homeowners, or get paid through Hearth for Pros.
            They supplement, and don&apos;t replace, the general{" "}
            <Link href="/terms" className="text-bark-700 hover:underline dark:text-stone-300">
              Terms of Service
            </Link>{" "}
            and{" "}
            <Link href="/privacy" className="text-bark-700 hover:underline dark:text-stone-300">
              Privacy Policy
            </Link>
            , which still govern everything about your account that isn&apos;t
            specific to operating as a pro. If something here conflicts with
            the general Terms of Service on a pro-specific point, these terms
            control.
          </p>
          <p className="mt-3 leading-relaxed">
            {/* TODO(legal): "Hearth LLC" is a PLACEHOLDER — the entity is NOT yet formed. Replace with the real registered entity name once the LLC exists. */}
            &quot;Hearth&quot; in these terms means Hearth LLC.
          </p>
        </section>

        {/* TODO(legal): attorney review required — licensing/insurance representations and the scope of the "notify us of a lapse" duty. */}
        <section>
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
            License and insurance
          </h2>
          <p className="mt-2 leading-relaxed">
            By using Hearth for Pros, you represent that any trade or
            contractor license you list (for example, a CSLB license number)
            is current and in good standing, and that you carry the insurance
            required by law for the work you take on Hearth, including
            general liability insurance and, if you have employees,
            workers&apos; compensation insurance as required by California
            Labor Code section 3700. You agree to tell us promptly if a
            license lapses, is suspended or revoked, or if required insurance
            lapses.
          </p>
          <p className="mt-3 leading-relaxed">
            Where Hearth shows your license as verified, that means we checked
            the license number against the CSLB public registry at that point
            in time, as described in the general{" "}
            <Link href="/terms" className="text-bark-700 hover:underline dark:text-stone-300">
              Terms of Service
            </Link>
            . It is a point-in-time public-records check, not an ongoing
            guarantee that your license or insurance stays valid, and it
            doesn&apos;t substitute for your own duty to keep both current.
          </p>
        </section>

        {/* TODO(legal): attorney review required — independent-contractor / non-agency language, keyed to AB5 / Dynamex (Cal. Sup. Ct. 2018) and any applicable ABC-test exemptions. This section is drafted to describe how the relationship is structured, not to declare the legal classification outcome, since that turns on facts a court or agency evaluates. */}
        <section>
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
            You run your own business
          </h2>
          <p className="mt-2 leading-relaxed">
            You use Hearth as an independent business, not as a Hearth
            employee or agent. Hearth doesn&apos;t set your hours, doesn&apos;t
            tell you how to perform your trade, and doesn&apos;t require you
            to accept, price, or schedule any particular job. You decide which
            leads to pursue, what to charge, how to do the work, and whether
            to use tools, subcontractors, or helpers of your own choosing.
            You&apos;re free to use other lead-generation platforms, advertise
            elsewhere, and take on work you find outside of Hearth entirely,
            including work from a homeowner you originally met through Hearth
            once that relationship falls outside the window described below.
          </p>
          <p className="mt-3 leading-relaxed">
            When a homeowner hires you, the service contract for that job is
            between you and the homeowner. Hearth is not a party to it, does
            not perform the work, and is not responsible for how you and the
            homeowner carry it out.
          </p>
          <p className="mt-3 leading-relaxed">
            This section describes how Hearth structures its relationship
            with you. It isn&apos;t a legal conclusion about your
            classification under any particular state or federal test (for
            example, California&apos;s ABC test) - that depends on the facts
            of your situation and is ultimately for a court or agency to
            decide, not something these terms can guarantee.
          </p>
        </section>

        {/* TODO(legal): attorney review required — senior review requested specifically on this clause. Scoped deliberately to the SPECIFIC Hearth-sourced introduction (not a blanket non-solicitation of the homeowner or a no-hire clause), to avoid Business & Professions Code section 16600 voidness as an unlawful restraint of trade. The fee owed on circumvention must be pegged to a reasonable pre-estimate of Hearth's actual lost fee, not a punitive amount, or it risks being an unenforceable penalty under Civil Code section 1671. The window (N months) and the fee formula both need counsel sign-off before this is enforceable language rather than a placeholder. */}
        <section>
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
            Working with a homeowner Hearth introduced you to
          </h2>
          <p className="mt-2 leading-relaxed">
            When Hearth sends you a lead or otherwise introduces you to a
            homeowner, and you go on to do paid work for that specific
            homeowner on that job, the lead fee (or another fee described
            in-app) is how Hearth gets paid for making the introduction. This
            doesn&apos;t restrict who you can work for generally - it only
            applies to that specific introduction.
          </p>
          <p className="mt-3 leading-relaxed">
            If, within{" "}
            <span className="text-stone-500 dark:text-stone-400">
              [N months — TODO(legal): reasonable window for a Hearth-sourced
              introduction]
            </span>{" "}
            of Hearth introducing you to a homeowner, you and that homeowner
            arrange payment for the same job outside of Hearth in order to
            avoid the lead fee, you owe Hearth the fee you would have paid had
            the job gone through Hearth. This is meant to be a reasonable
            estimate of the fee Hearth lost by being cut out of an
            introduction it made, not a penalty, and it doesn&apos;t apply to
            work for that homeowner that falls outside this window or that
            isn&apos;t connected to the introduction Hearth made.
          </p>
        </section>

        {/* TODO(legal): attorney review required — chargeback/set-off rights, and how this interacts with any state wage-and-hour or prompt-payment rules that might apply depending on classification. */}
        <section>
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
            Chargebacks and offsets
          </h2>
          <p className="mt-2 leading-relaxed">
            If you owe Hearth money, for example from a disputed or reversed
            payment, a chargeback, confirmed fraud, or a refund we&apos;ve had
            to make to a homeowner because of something you did, Hearth may
            offset or withhold that amount against your wallet balance or a
            future payout instead of, or in addition to, billing you directly.
          </p>
        </section>

        {/* TODO(legal): attorney review required — B2B limitation of liability, contractor indemnity, and contractually shortened limitations period. The Civ. Code 1668 carve-out (no disclaiming liability for fraud, willful injury, or violation of law) must stay regardless of how the cap language is finalized. The shortened claims period should not go below a reasonable floor (roughly 6-12 months) or it risks being found unconscionable / against public policy. */}
        <section>
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
            Liability, indemnity, and time to bring a claim
          </h2>
          <p className="mt-2 leading-relaxed">
            To the fullest extent the law allows, Hearth&apos;s total
            liability to you arising out of these terms or your use of
            Hearth for Pros is limited to the greater of{" "}
            <span className="text-stone-500 dark:text-stone-400">
              [amount to be provided — TODO(legal)]
            </span>{" "}
            or the fees you paid Hearth in the{" "}
            <span className="text-stone-500 dark:text-stone-400">
              [N months — TODO(legal)]
            </span>{" "}
            before the claim arose. Neither of us is liable to the other for
            lost profits or indirect, incidental, special, or consequential
            damages. Nothing in this section limits liability where the law
            doesn&apos;t allow it to be limited, including for fraud, willful
            injury to a person or property, or violation of law (California
            Civil Code section 1668).
          </p>
          <p className="mt-3 leading-relaxed">
            You agree to defend, indemnify, and hold Hearth harmless from any
            claim arising from your work, your license or insurance
            representations turning out to be false or lapsed, or your
            violation of these terms or the law, including reasonable
            attorneys&apos; fees. This covers your own conduct and work, not
            Hearth&apos;s.
          </p>
          <p className="mt-3 leading-relaxed">
            Any claim you have arising out of these terms or your use of
            Hearth for Pros must be brought within{" "}
            <span className="text-stone-500 dark:text-stone-400">
              [N months — TODO(legal): reasonable minimum, not less than
              roughly 6-12 months]
            </span>{" "}
            of when it arose, or it&apos;s permanently barred, to the extent
            the law allows shortening the claims period by agreement.
          </p>
          <p className="mt-3 leading-relaxed">
            Questions about this section? Reach us through{" "}
            <LegalContact topic="Contractor terms question" />.
          </p>
        </section>

        {/* TODO(legal): attorney review required — lead-fee and wallet-credit
            terms below, in particular whether the ghost-protection and
            expiring-bonus-credit language needs to sit alongside, or be
            reconciled with, the general Fees and refunds section in
            src/app/terms/page.tsx (which already covers the same non-cash
            credit rule at the account level). */}
        <section>
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
            Lead fees, wallet credit, and membership
          </h2>
          <p className="mt-2 leading-relaxed">
            Applying to a posted job costs a flat fee set by the job&apos;s
            category (never a percentage of the job&apos;s value), shown
            before you apply. You pay to apply, not to win: the fee is for
            the introduction Hearth makes, not a commission on the work. A
            posted job accepts a limited number of applicants at a time, so
            fees aren&apos;t spent competing against an unlimited field.
          </p>
          <p className="mt-3 leading-relaxed">
            If a homeowner never responds to your application, the fee comes
            back to you automatically after a set number of days, as Hearth
            wallet credit, never cash. Wallet deposits themselves are
            non-refundable and can only be spent on lead applications, and any
            promotional or bonus credit Hearth grants (including the
            ghost-protection credit above) can expire.
          </p>
          <p className="mt-3 leading-relaxed">
            Hearth Pro membership is a paid perk, not a requirement or a
            gate: every pro sees every open job and can apply to it, member or
            not. What membership buys is extras on top of that, such as a
            larger bonus on wallet deposits; it never buys access to leads
            other pros don&apos;t also have.
          </p>
        </section>

        {/* TODO(legal): attorney review required — the product feedback
            credit terms below (amount, one-per-account limit, and the
            explicit no-store-rating rule) haven't been reviewed by counsel. */}
        <section>
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
            Product feedback credit
          </h2>
          <p className="mt-2 leading-relaxed">
            Hearth may offer a one-time bonus wallet credit for sending us
            private feedback about the product through the in-app feedback
            form. It is non-cash lead-application credit, exactly like the
            wallet credit described above, capped at one claim per contractor
            account ever, and it may only be credited once your account is
            established (a verified license, or a first paid lead
            application). It is never tied to, and never paid for, a rating
            or review on the App Store, Google Play, or anywhere else; it is
            payment for a private note to us, nothing more.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
            Related reading
          </h2>
          <p className="mt-2 leading-relaxed">
            See the general{" "}
            <Link href="/terms" className="text-bark-700 hover:underline dark:text-stone-300">
              Terms of Service
            </Link>{" "}
            for account-level terms (acceptable use, content, disputes and
            arbitration, and governing law) that apply to every Hearth user,
            including pros, and the{" "}
            <Link href="/privacy" className="text-bark-700 hover:underline dark:text-stone-300">
              Privacy Policy
            </Link>{" "}
            for what we collect and how it&apos;s used.
          </p>
        </section>
      </div>
    </main>
  );
}
