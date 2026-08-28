import { LegalContact } from "@/components/LegalContact";
import type { Metadata } from "next";
import Link from "next/link";

// Public top-level page, same pattern as src/app/fountain-valley/page.tsx:
// see src/lib/supabase/middleware.ts for the allowlist entry and
// src/app/sitemap.ts for the sitemap entry.

const SITE_URL =
  process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";


export const metadata: Metadata = {
  // The root layout's title template appends "| Hearth"; don't repeat it here.
  title: "Terms of Service",
  description:
    "The plain-English basics of using Hearth: what the marketplace is, what Ask Hearth's answers are (and aren't), and how accounts and fees work.",
  alternates: {
    canonical: `${SITE_URL}/terms`,
  },
};

export default function TermsPage() {
  return (
    <main className="mx-auto max-w-2xl px-6 pb-16 pt-10">
      <p className="text-sm">
        <Link href="/" className="text-stone-500 hover:text-bark-700 dark:text-stone-400 dark:hover:text-stone-300">
          ← Hearth
        </Link>
      </p>

      <h1 className="mt-4 text-2xl font-bold text-stone-900 sm:text-3xl dark:text-stone-100">
        Terms of Service
      </h1>
      <p className="mt-3 text-sm text-stone-500 dark:text-stone-400">
        Last updated August 28, 2026. The plain-English basics, not legalese.
      </p>

      <div className="mt-8 space-y-8 text-stone-700 dark:text-stone-300">
        {/* TODO(legal): attorney review required — change-of-terms notice mechanics (Douglas v. Talk America, 9th Cir. 2007 requires actual notice, not just posting, for material changes). */}
        <section>
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
            Changes to these terms
          </h2>
          <p className="mt-2 leading-relaxed">
            We may update these terms as Hearth changes. For a material
            change, we&apos;ll give you actual notice, such as an email to the
            address on your account or a notice inside the app, before the
            change takes effect, and we&apos;ll update the &quot;Last
            updated&quot; date above. Continuing to use Hearth after a
            material change takes effect means you accept it. We may make
            non-material changes, like clarifications or fixing a typo,
            without separate notice.
          </p>
          <p className="mt-3 leading-relaxed">
            If a change affects the Disputes and arbitration section below,
            you get a fresh 30-day window to opt out of arbitration, measured
            from when we give you notice of that change, on the same terms as
            the opt-out described there.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
            What Hearth is
          </h2>
          <p className="mt-2 leading-relaxed">
            Hearth is a marketplace and home-tracking tool that connects
            homeowners with independent contractors. Hearth is not the
            contractor, does not perform the work, and does not guarantee the
            quality, safety, timeliness, or price of any job. Contractors are
            independent businesses, not Hearth employees or agents.
          </p>
        </section>

        {/* TODO(legal): attorney review required — assumption-of-risk / release for contractor work; confirm enforceability limits (e.g., Cal. Civ. Code 1668) on releasing gross negligence or statutory claims. */}
        <section>
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
            Contractor work happens at your home
          </h2>
          <p className="mt-2 leading-relaxed">
            Work you book through Hearth is between you and an independent
            contractor. Hearth doesn&apos;t employ, supervise, or control that
            contractor, and doesn&apos;t direct how the work gets done. Home
            improvement and repair work carries inherent risks, including
            property damage and physical injury, that exist independent of
            anything Hearth does.
          </p>
          <p className="mt-3 leading-relaxed">
            To the extent the law allows, you release Hearth from claims
            arising out of a contractor&apos;s work or conduct, including
            property damage, injury, delay, or a job done poorly. That
            release doesn&apos;t cover Hearth&apos;s own gross negligence,
            recklessness, or willful misconduct, and it doesn&apos;t release
            the contractor&apos;s own conduct, which is between you and them.
          </p>
        </section>

        {/* TODO(legal): attorney review required — user-to-user release scope; must not purport to waive bodily-injury claims between users. */}
        <section>
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
            Disputes between users
          </h2>
          <p className="mt-2 rounded-md border border-stone-300 bg-stone-50 p-4 font-semibold leading-relaxed text-stone-900 dark:border-stone-700 dark:bg-stone-800 dark:text-stone-100">
            To the extent the law allows, if you have a dispute with another
            Hearth user (for example, over property or a wallet balance)
            arising out of your use of Hearth, you release Hearth from claims
            related to that dispute, except claims arising from Hearth&apos;s
            own gross negligence, recklessness, or willful misconduct. This
            release does not waive, and does not apply to, any claim for
            bodily injury between users; those claims aren&apos;t released by
            these terms.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
            Ask Hearth is informational, not professional advice
          </h2>
          <p className="mt-2 leading-relaxed">
            Answers from Ask Hearth (including cost estimates, diagnoses from
            photos, and maintenance guidance) are generated to be genuinely
            useful, but they are informational only, not licensed
            professional, engineering, electrical, structural, or legal
            advice. For anything safety-related, code-regulated, or you are
            unsure about, hire a licensed pro.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
            License verification
          </h2>
          <p className="mt-2 leading-relaxed">
            Where Hearth shows a contractor&apos;s license as verified, that
            means we checked the license number against the CSLB public
            registry at that point in time. It is a point-in-time
            public-records check, not an ongoing guarantee, warranty, or
            endorsement of that contractor&apos;s work.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
            Fees and refunds
          </h2>
          <p className="mt-2 leading-relaxed">
            Homeowner features, contractor lead fees, and any subscription
            pricing are described where you encounter them in the app (for
            example, on a job card or the Hearth Plus page) before you pay.
            Where Hearth gives a lead fee back to a contractor, for example
            when a homeowner never responds or picks another pro, it is
            returned as Hearth wallet credit that can only be spent on future
            lead applications. It is not cash, a payout, or a refund to the
            card or account you paid from. Those rules are described in-app at
            the same point. Pro wallet deposits are non-refundable and can only
            be spent on lead applications, and promotional or bonus credit can
            expire.
          </p>
          {/* TODO(legal): attorney review required — discretionary
              credit-not-cash remedy, and how it reads against the dispute and
              chargeback handling in the sections below (which it does not
              replace or limit). */}
          <p className="mt-3 leading-relaxed">
            More generally, payments you make to Hearth are not refundable as
            cash. Where Hearth decides to make something right, it does so as
            Hearth account credit, which can only be spent inside Hearth and
            never becomes cash or a payout. Whether to do that at all is
            Hearth&apos;s decision in each case, and doing it once does not
            commit Hearth to doing it again. Nothing in this paragraph limits
            any refund you are entitled to under the law that applies to you,
            and it does not change how payment disputes and chargebacks are
            handled.
          </p>
          <p className="mt-3 leading-relaxed">
            Paid memberships that start with a free trial are described in full
            at checkout before you enter a payment method. Your card is
            collected when you sign up, nothing is charged during the free
            trial, and the membership renews automatically at the price shown
            once the trial ends unless you cancel first. Cancel before the trial
            ends and you are not charged. You can cancel at any time from the
            membership page in the app.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
            Acceptable use
          </h2>
          <p className="mt-2 leading-relaxed">
            Use Hearth honestly: don&apos;t misrepresent who you are or your
            license status, don&apos;t use the app to harass another user,
            and don&apos;t try to scrape, abuse, or overload the service
            (including running up Ask Hearth usage beyond normal, personal
            use of your own home).
          </p>
          {/* LAWYER: check */}
          <p className="mt-3 leading-relaxed">
            You can block another account, and you can report one. Blocking
            stops new messages and new job matches between the two accounts;
            it does not cancel a job either of you has already agreed to, and
            it does not refund anything. Reports come to Hearth for review, so
            they are not anonymous to us and they are not a message to the
            other person. Using reports to harass someone, or filing ones you
            know are false, can get your own account restricted.
          </p>
        </section>

        {/* TODO(legal): attorney review required — user-generated content, license grant, and indemnity. */}
        <section>
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
            Content you upload
          </h2>
          <p className="mt-2 leading-relaxed">
            You keep ownership of everything you upload to Hearth: photos of
            your home, job descriptions, documents, messages, reviews, and
            anything else. It stays yours.
          </p>
          <p className="mt-3 leading-relaxed">
            To actually run the service, we need your permission to use it.
            By uploading, you grant Hearth a non-exclusive, worldwide,
            royalty-free license to host, store, copy, reformat, and display
            your content, and to share it with the people the feature is meant
            to reach (for example, showing your job photos to contractors you
            invite to bid, or publishing a review you chose to post). That
            license exists only to operate, secure, and improve Hearth, and it
            ends when you delete the content or your account, except for
            copies we&apos;re required to keep in backups or for legal reasons,
            and except where someone else already relied on it (a published
            review, or a photo already sent to a contractor).
          </p>
          <p className="mt-3 leading-relaxed">
            You&apos;re telling us you have the right to upload what you
            upload. Don&apos;t upload someone else&apos;s copyrighted photos,
            trademarks, or private information without permission, and
            don&apos;t upload anything illegal, deceptive, or that
            you&apos;re contractually barred from sharing.
          </p>
          <p className="mt-3 leading-relaxed">
            No person reads your content before it goes up. Some of it does go
            through an automatic check first: business names, profile
            descriptions, review comments, and custom service names are
            screened for slurs and for off-platform contact details, and a save
            that trips the check is refused with a reason. Chat messages have
            slurs and profanity masked before they are stored. Those checks are
            word and pattern matching, not a human reviewer and not a judgment
            about whether something is true. We may also remove or restrict any
            content, at any time, if we believe it violates these terms or the
            law, but we&apos;re not obligated to monitor, and we&apos;re not
            responsible for content other users post. Content from other users
            is theirs, not ours, and we don&apos;t endorse it.{" "}
            {/* TODO(legal): attorney review required — confirm this tracks the Section 230 and DMCA safe-harbor posture we intend to rely on. */}
            {/* LAWYER: check that describing the automatic slur/contact screening above does not undercut the "not obligated to monitor" posture or the Section 230 / DMCA safe harbor. */}
          </p>
          <p className="mt-3 leading-relaxed">
            Reviews have one rule on top of that: you can only review a job on
            your own property that a pro was actually hired for, one review per
            job, and you can&apos;t review your own company or a company tied
            to another account of yours. We don&apos;t require the pro to mark
            the job finished first, because that would let a pro avoid a bad
            review by never marking anything finished. We don&apos;t pay for
            reviews, we don&apos;t write them, and we don&apos;t delete a
            review for being negative.{" "}
            {/* LAWYER: check this against the FTC Rule on Consumer Reviews and Testimonials (16 CFR 465), in particular the review-suppression and insider-review provisions, and confirm we can say "we don't delete a review for being negative" given the moderation gate above can refuse one at submission time. */}
          </p>
          <p className="mt-3 leading-relaxed">
            If someone brings a claim against Hearth because of something you
            uploaded, you agree to defend, indemnify, and hold Hearth harmless
            from that claim, including reasonable attorneys&apos; fees. This
            covers your content only, not our own conduct.
          </p>
          <p className="mt-3 leading-relaxed">
            Think content on Hearth infringes your copyright? Use our{" "}
            <Link href="/dmca" className="text-bark-700 hover:underline dark:text-stone-300">
              DMCA takedown process
            </Link>
            .
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
            Account termination
          </h2>
          <p className="mt-2 leading-relaxed">
            You can delete your own account at any time under Account &gt;
            Account security. We may suspend or terminate an account that
            violates these terms or misuses the platform.
          </p>
        </section>

        {/* TODO(legal): attorney review required — arbitration, class waiver, opt-out, and mass-arbitration terms. Enforceability turns on state law and on the AAA Consumer Rules in effect at filing. */}
        <section>
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
            Disputes and arbitration
          </h2>
          <p className="mt-2 leading-relaxed">
            Read this section carefully. It changes how disputes between you
            and Hearth get resolved: most of them go to an individual
            arbitrator instead of a judge or jury, and not to a class action.
            It binds both of us equally. You can opt out within 30 days, and
            opting out costs you nothing else.
          </p>

          <h3 className="mt-5 font-semibold text-stone-900 dark:text-stone-100">
            First, let&apos;s just try to fix it
          </h3>
          <p className="mt-2 leading-relaxed">
            Before either of us starts an arbitration, the side with the
            complaint sends the other a written notice describing the problem
            and what would resolve it. Send yours through{" "}
            <LegalContact />
            . {/* TODO(legal): confirm the contact-form submission satisfies the notice-of-dispute requirement and whether a mailing address must also be accepted. */}
            We&apos;ll do the same for you, at the email on your account. Both
            sides then have 30 days to work it out in good faith. Only after
            those 30 days can either side file. This step is required of
            Hearth too, not just you, and any deadline to file is paused while
            it runs.
          </p>

          <h3 className="mt-5 font-semibold text-stone-900 dark:text-stone-100">
            Binding individual arbitration
          </h3>
          <p className="mt-2 leading-relaxed">
            {/* TODO(legal): attorney review required — delegation clause (arbitrator decides arbitrability, except a challenge aimed specifically at this delegation sentence goes to court; Rent-A-Center v. Jackson, 2010). */}
            If we can&apos;t resolve it informally, you and Hearth each agree
            that the dispute will be settled by binding individual
            arbitration, not in court. This covers disputes about these terms,
            your account, fees and wallet balances, Ask Hearth, content, and
            your use of Hearth generally, whatever the legal theory. The
            arbitration is administered by the American Arbitration
            Association under its Consumer Arbitration Rules, in effect when
            the claim is filed. The Federal Arbitration Act governs whether
            this section is enforceable. The arbitrator decides the merits,
            and also decides questions about whether this arbitration
            agreement itself is valid, applicable, or enforceable. The one
            exception: a challenge aimed specifically at this delegation
            sentence, not at the arbitration agreement as a whole, goes to a
            court, not the arbitrator.
          </p>
          <p className="mt-3 leading-relaxed">
            AAA&apos;s consumer fee schedule caps what a consumer pays to
            file. Small cases are usually decided on the documents, and you can
            ask for a hearing by phone or video, or in person near where you
            live. The arbitrator can award you anything a court could have,
            and the award is final and enforceable in court.
          </p>

          <h3 className="mt-5 font-semibold text-stone-900 dark:text-stone-100">
            What is not covered
          </h3>
          <p className="mt-2 leading-relaxed">
            Two carve-outs, and both run in both directions:
          </p>
          <ul className="mt-3 list-disc space-y-2 pl-5 leading-relaxed">
            <li>
              <strong className="font-semibold text-stone-900 dark:text-stone-100">
                Small claims.
              </strong>{" "}
              Either of us can bring a qualifying claim in small claims court
              instead, as long as it stays there and stays individual.
            </li>
            <li>
              <strong className="font-semibold text-stone-900 dark:text-stone-100">
                Injunctions for IP and abuse.
              </strong>{" "}
              Either of us can go to court for an injunction or other
              equitable relief over misuse of intellectual property, or over
              unauthorized access to, scraping of, or abuse of the service.
            </li>
          </ul>

          <h3 className="mt-5 font-semibold text-stone-900 dark:text-stone-100">
            No class actions
          </h3>
          <p className="mt-2 leading-relaxed">
            Claims are brought individually. Neither you nor Hearth may bring
            a class, collective, consolidated, or representative action, and
            the arbitrator may not preside over one or award relief to anyone
            who isn&apos;t a party. Arbitrations can&apos;t be joined without
            everyone&apos;s consent.
          </p>
          <p className="mt-3 leading-relaxed">
            If a court finds this class-action waiver unenforceable as to a
            particular claim, then that claim, and only that claim, leaves
            arbitration and goes to court. Everything else stays in
            arbitration.
          </p>
          <p className="mt-3 leading-relaxed">
            {/* TODO(legal): attorney review required — public injunctive relief carve-out (McGill v. Citibank, Cal. 2017); confirm against the chosen governing law and venue below. */}
            A claim for public injunctive relief (relief whose primary
            purpose is stopping unlawful conduct that threatens the general
            public, not obtaining relief for you individually) is not subject
            to this arbitration agreement. That claim proceeds in the court
            named in Governing law and venue below, even while the rest of
            your dispute proceeds in arbitration.
          </p>

          {/* TODO(legal): batching clause removed — rely on AAA's Mass Arbitration Supplementary Rules by default (Heckman v. Live Nation, 9th Cir. 2024). */}

          <h3 className="mt-5 font-semibold text-stone-900 dark:text-stone-100">
            How to opt out
          </h3>
          <p className="mt-2 leading-relaxed">
            You can opt out of this entire arbitration section. You have 30
            days from whichever is later: the day you first accept these
            terms, or the day we tell you we&apos;ve changed this section.
          </p>
          <p className="mt-3 leading-relaxed">
            To opt out, send us a written notice that says you&apos;re opting
            out of arbitration and includes your name, the email address on
            your Hearth account, and your signature. Send it through{" "}
            <LegalContact topic="Arbitration opt-out" />{" "}
            or mail it to{" "}
            {/* TODO(legal): opt-out mailing address — insert the registered entity name and full mailing address for arbitration opt-out notices. */}
            <span className="text-stone-500 dark:text-stone-400">
              [mailing address to be provided]
            </span>
            . {/* TODO(legal): confirm the contact-form submission is monitored and retained, and whether a typed name in a web form satisfies the "signature" requirement above or an actual e-signature/wet signature is needed; a missed opt-out is treated as no opt-out. */}
          </p>
          <p className="mt-3 leading-relaxed">
            That&apos;s all it takes. Opting out doesn&apos;t affect your
            account, your pricing, or anything else in these terms, and we
            won&apos;t treat you differently for it. If you opt out, disputes
            go to court under the governing law and venue below.
          </p>

          <h3 className="mt-5 font-semibold text-stone-900 dark:text-stone-100">
            Survival
          </h3>
          <p className="mt-2 leading-relaxed">
            This section survives the end of your account and of these terms.
          </p>
        </section>

        {/* TODO(legal): attorney review required — limitation of liability, including the liability cap and the mandatory carve-out for fraud, willful injury, and violations of law (Cal. Civ. Code 1668). */}
        <section>
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
            Limitation of liability
          </h2>
          <p className="mt-2 leading-relaxed">
            To the extent the law allows, Hearth isn&apos;t liable for
            indirect, incidental, consequential, special, exemplary, or
            punitive damages, or for lost profits, lost data, or loss of
            goodwill, even if we were told those losses were possible.
          </p>
          <p className="mt-3 leading-relaxed">
            Also to the extent the law allows, Hearth&apos;s total liability
            for any claim arising out of your use of Hearth is capped at{" "}
            <span className="text-stone-500 dark:text-stone-400">
              [the greater of $100 or the fees you paid Hearth in the 12
              months before the claim arose; TODO(legal): business decision]
            </span>
            .
          </p>
          <p className="mt-3 leading-relaxed">
            Nothing in this section limits Hearth&apos;s liability for its own
            fraud, for willfully injuring you, or for violating the law in a
            way California law (Civil Code section 1668) doesn&apos;t let us
            limit. If a court finds any part of this section unenforceable as
            to a particular claim, only that part is limited or removed for
            that claim, and the rest of this section still applies.
          </p>
        </section>

        {/* TODO(legal): attorney review required — warranty disclaimers (UCC 2-316 conspicuousness requirement for excluding implied warranties). */}
        <section>
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
            Warranty disclaimers
          </h2>
          <p className="mt-2 font-semibold uppercase leading-relaxed text-stone-900 dark:text-stone-100">
            Hearth provides the service on an &quot;as is&quot; and &quot;as
            available&quot; basis, and disclaims all implied warranties,
            including the implied warranties of merchantability, fitness for
            a particular purpose, and non-infringement.
          </p>
          <p className="mt-3 leading-relaxed">
            That doesn&apos;t mean nothing is promised: it means we&apos;re
            not promising the service will be uninterrupted, error-free, or
            fully secure, and that answers from Ask Hearth, including cost
            estimates and diagnoses from photos, may be inaccurate or
            incomplete. Some states don&apos;t allow the exclusion of implied
            warranties, so parts of this section may not apply to you.
          </p>
        </section>

        {/* TODO(legal): attorney review required — severability. */}
        <section>
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
            Severability
          </h2>
          <p className="mt-2 leading-relaxed">
            If any part of these terms is found unenforceable or invalid,
            that part is limited or removed to the minimum extent necessary,
            and the rest of these terms stays in full effect. The Disputes
            and arbitration section above has its own, narrower severability
            rule for what happens if a piece of the arbitration agreement
            itself is found unenforceable; where the two overlap, that
            narrower rule controls for arbitration questions.
          </p>
        </section>

        {/* TODO(legal): attorney review required — governing law and venue. */}
        <section>
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
            Governing law and venue
          </h2>
          <p className="mt-2 leading-relaxed">
            {/* TODO(legal): governing law — California is carried over from the
                previous version of this page, not a fresh choice. Counsel should
                confirm it against the entity's state of formation and principal
                place of business. Note California's McGill rule interacts with
                the public-injunctive-relief handling in the arbitration section
                above; if this state changes, revisit that clause too. */}
            These terms are governed by the laws of the State of California,
            without regard to conflict-of-law rules, except that the Federal
            Arbitration Act governs the arbitration section above.
          </p>
          <p className="mt-3 leading-relaxed">
            {/* TODO(legal): venue — California is inferred from the governing-law
                choice above, but the specific county was never chosen. Counsel
                should set the county (normally the entity's principal place of
                business) and name the specific state and federal courts. */}
            For any dispute that isn&apos;t going to arbitration, you and
            Hearth agree the case belongs in the state and federal courts
            located in{" "}
            <span className="text-stone-500 dark:text-stone-400">
              California [county to be confirmed]
            </span>
            , and we each consent to those courts&apos; jurisdiction. Nothing
            here takes away a right you have under the consumer-protection law
            of the state you live in, where that law says it can&apos;t be
            waived.
          </p>
          <p className="mt-3 leading-relaxed">
            {/* TODO(legal): "Hearth LLC" is a PLACEHOLDER — the entity is NOT yet formed. Replace with the real registered entity name once the LLC exists. */}
            &quot;Hearth&quot; in these terms means Hearth LLC.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
            Related reading
          </h2>
          <p className="mt-2 leading-relaxed">
            See the{" "}
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
