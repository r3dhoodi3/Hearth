import type { Metadata } from "next";
import Link from "next/link";

// Public top-level page, same pattern as src/app/terms/page.tsx and
// src/app/privacy/page.tsx: see src/lib/supabase/middleware.ts for the
// allowlist entry and src/app/sitemap.ts for the sitemap entry. The list of
// what users can upload is derived from the actual upload surfaces in the
// code (the home-photos, pro-logos and pro-docs Supabase buckets) rather than
// a generic template.

const SITE_URL =
  process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

export const metadata: Metadata = {
  // The root layout's title template appends "| Hearth"; don't repeat it here.
  title: "Copyright / DMCA Policy",
  description:
    "How to report copyrighted material on Hearth, what a valid DMCA takedown notice must include, how to file a counter-notice, and our repeat infringer policy.",
  alternates: {
    canonical: `${SITE_URL}/dmca`,
  },
};

export default function DmcaPage() {
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
        Copyright / DMCA Policy
      </h1>
      <p className="mt-3 text-sm text-stone-500 dark:text-stone-400">
        Last updated July 2026. Plain English, with the exact wording the law
        actually requires where it matters.
      </p>

      <div className="mt-8 space-y-8 text-stone-700 dark:text-stone-300">
        <section>
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
            The short version
          </h2>
          <p className="mt-2 leading-relaxed">
            Hearth respects copyright. If something you own the copyright to
            was uploaded to Hearth without your permission, send us a takedown
            notice with the six items listed below and we&apos;ll remove or
            disable access to it. If your content was removed by mistake, you
            can send a counter-notice and we&apos;ll put it back. We terminate
            accounts of users who repeatedly infringe.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
            What users upload to Hearth
          </h2>
          <p className="mt-2 leading-relaxed">
            Hearth is a marketplace, so most of what appears on it is uploaded
            by users, not by us. Homeowners upload photos of their home,
            systems, and issues, and documents such as warranties and
            inspection reports. Contractors upload company logos, profile and
            portfolio (before/after project) photos, quotes, and compliance
            documents like licenses and insurance certificates. Photos also
            get attached to messages between a homeowner and a pro. We
            don&apos;t review this material before it&apos;s uploaded, which
            is why this notice-and-takedown process exists.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
            Sending a takedown notice
          </h2>
          <p className="mt-2 leading-relaxed">
            To be effective under the Digital Millennium Copyright Act, 17
            U.S.C. § 512(c)(3), a written notice sent to our designated agent
            must include substantially all six of the following:
          </p>
          <ol className="mt-3 list-decimal space-y-2 pl-5 leading-relaxed">
            <li>
              A physical or electronic signature of a person authorized to act
              on behalf of the owner of an exclusive right that is allegedly
              infringed.
            </li>
            <li>
              Identification of the copyrighted work claimed to have been
              infringed, or, if multiple works at a single site are covered by
              one notice, a representative list of those works.
            </li>
            <li>
              Identification of the material that is claimed to be infringing
              or to be the subject of infringing activity and that is to be
              removed or access to which is to be disabled, and information
              reasonably sufficient to let us locate it. A direct URL to the
              Hearth page or image is the most useful form of this.
            </li>
            <li>
              Information reasonably sufficient to let us contact you: your
              address, telephone number, and, if available, an email address.
            </li>
            <li>
              A statement that you have a good faith belief that use of the
              material in the manner complained of is not authorized by the
              copyright owner, its agent, or the law.
            </li>
            <li>
              A statement that the information in the notification is
              accurate, and <em>under penalty of perjury</em>, that you are
              authorized to act on behalf of the owner of an exclusive right
              that is allegedly infringed.
            </li>
          </ol>
          <p className="mt-3 leading-relaxed">
            A notice missing these elements may not be treated as valid
            notice, so please include all six.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
            Where to send it
          </h2>
          <p className="mt-2 leading-relaxed">
            Send your notice to Hearth&apos;s designated copyright agent:
          </p>
          {/*
            TODO(legal): fill in the designated agent's real name, physical
            mailing address, telephone number, and email address, and register
            the same agent with the U.S. Copyright Office DMCA Designated Agent
            Directory (dmca.copyright.gov). The safe harbor under 17 U.S.C.
            § 512(c) is NOT available until an agent is designated both here
            and with the Copyright Office, and the registration must be renewed
            every three years. Do not ship this page publicly with placeholders.
          */}
          {/*
            NOTE(legal): once that registration happens, 17 U.S.C. § 512(c)(2)
            requires the agent's real, public name, address, phone number, and
            email to be posted on the service in a location accessible to the
            public (this page) - a contact form is not a substitute for that
            posted email address once an agent is designated. Until
            registration happens, /contact below is only an interim reachable
            channel for anyone who can't wait on the TODOs above; it is not
            itself a designated-agent address.
          */}
          <div className="mt-3 rounded-lg border border-stone-200 bg-stone-50 p-4 text-sm leading-relaxed dark:border-stone-700 dark:bg-stone-800/50">
            <p className="font-semibold text-stone-900 dark:text-stone-100">
              Designated Copyright Agent
            </p>
            <p className="mt-2 text-stone-600 dark:text-stone-400">
              [TODO(legal): agent name]
              <br />
              [TODO(legal): mailing address]
              <br />
              [TODO(legal): phone number]
              <br />
              [TODO(legal): email address]
            </p>
          </div>
          <p className="mt-3 leading-relaxed">
            Please send copyright notices only to this address once it&apos;s
            filled in. Notices sent elsewhere may be delayed.
          </p>
          <p className="mt-3 leading-relaxed">
            In the meantime, you can reach us through{" "}
            <Link href="/contact" className="text-bark-700 hover:underline dark:text-stone-300">
              our contact form
            </Link>
            . Note that this does not replace the designated-agent process
            above once it&apos;s complete.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
            What happens after we receive a valid notice
          </h2>
          <p className="mt-2 leading-relaxed">
            We remove or disable access to the material identified in the
            notice, and we take reasonable steps to tell the user who uploaded
            it that we did so. We generally forward a copy of the notice,
            including the contact information you provided, to that user.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
            Counter-notices
          </h2>
          <p className="mt-2 leading-relaxed">
            If your material was removed and you believe it was a mistake or a
            misidentification, you can send a counter-notice to the same agent
            above. Under 17 U.S.C. § 512(g)(3), it must include:
          </p>
          <ol className="mt-3 list-decimal space-y-2 pl-5 leading-relaxed">
            <li>Your physical or electronic signature.</li>
            <li>
              Identification of the material that was removed or disabled and
              the location at which it appeared before it was removed or
              disabled.
            </li>
            <li>
              A statement <em>under penalty of perjury</em> that you have a
              good faith belief the material was removed or disabled as a
              result of mistake or misidentification.
            </li>
            <li>
              Your name, address, and telephone number, and a statement that
              you consent to the jurisdiction of the Federal District Court
              for the judicial district in which your address is located (or,
              if your address is outside the United States, any judicial
              district in which Hearth may be found), and that you will accept
              service of process from the person who filed the notice or an
              agent of that person.
            </li>
          </ol>
          <p className="mt-3 leading-relaxed">
            If we receive a valid counter-notice, we forward it to the person
            who sent the original notice and tell them we will restore the
            material in not less than 10 and not more than 14 business days.
            We restore it within that window unless our designated agent first
            receives notice that the original complainant has filed a court
            action seeking to restrain the user from infringing activity
            relating to the material on Hearth.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
            Repeat infringers
          </h2>
          <p className="mt-2 leading-relaxed">
            Hearth has adopted and reasonably implements a policy of
            terminating, in appropriate circumstances, the accounts of
            homeowners or contractors who are repeat infringers. That means an
            account may be suspended or permanently terminated, and a
            contractor&apos;s public page taken down, after repeated valid
            takedown notices. This is in addition to the account termination
            rights described in the{" "}
            <Link href="/terms" className="text-bark-700 hover:underline dark:text-stone-300">
              Terms of Service
            </Link>
            .
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
            Don&apos;t send a notice in bad faith
          </h2>
          <p className="mt-2 leading-relaxed">
            Under 17 U.S.C. § 512(f), anyone who knowingly materially
            misrepresents that material is infringing, or that material was
            removed or disabled by mistake or misidentification, can be held
            liable for damages, including costs and attorneys&apos; fees,
            incurred by the alleged infringer, by any copyright owner or
            licensee, or by us. This applies to takedown notices and to
            counter-notices alike. If you are not sure whether a use is
            actually infringing (fair use, for example, or a photo you
            licensed to a contractor), talk to a lawyer before filing.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
            Related reading
          </h2>
          <p className="mt-2 leading-relaxed">
            See the{" "}
            <Link href="/terms" className="text-bark-700 hover:underline dark:text-stone-300">
              Terms of Service
            </Link>{" "}
            for the rules on using Hearth, and the{" "}
            <Link href="/privacy" className="text-bark-700 hover:underline dark:text-stone-300">
              Privacy Policy
            </Link>{" "}
            for what we collect and how uploaded photos and documents are
            stored.
          </p>
        </section>
      </div>
    </main>
  );
}
