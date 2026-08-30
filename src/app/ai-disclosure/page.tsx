import { LegalContact } from "@/components/LegalContact";
import type { Metadata } from "next";
import Link from "next/link";

// Public top-level page, same pattern as src/app/terms/page.tsx and
// src/app/privacy/page.tsx: see src/lib/supabase/middleware.ts for the
// allowlist entry and src/app/sitemap.ts for the sitemap entry. Content is
// derived from the actual code paths rather than a generic template: /api/ask,
// /api/pro-ask, /api/analyze-quote, /api/pro-tools, /api/pro-past-jobs,
// /api/ingest-inspection, /api/extract-document, /api/confirm-system,
// /api/tax-appeal, /api/insurance-packet, /api/pro-compliance, /api/draft-apply
// and /api/draft-job all call Anthropic's Claude Sonnet models on Anthropic's
// paid API. Voice input is on-device browser speech recognition and sends no
// audio anywhere. The inline label under AI output
// (src/components/AiNotice.tsx) links here.

const SITE_URL =
  process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

// Same fallback reasoning as the privacy page: signed-out visitors can't reach
// the in-app Help page, so they still need a working contact channel.

export const metadata: Metadata = {
  // The root layout's title template appends "| Hearth"; don't repeat it here.
  title: "How Hearth Uses AI",
  description:
    "Which parts of Hearth are AI-generated, which models run them, what the output is and isn't good for, how we review it, and how to use Hearth without AI.",
  alternates: {
    canonical: `${SITE_URL}/ai-disclosure`,
  },
};

export default function AiDisclosurePage() {
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
        How Hearth Uses AI
      </h1>
      <p className="mt-3 text-sm text-stone-500 dark:text-stone-400">
        Last updated August 28, 2026. Plain English, and specific about what
        the software actually does.
      </p>

      <div className="mt-8 space-y-8 text-stone-700 dark:text-stone-300">
        <section>
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
            The short version
          </h2>
          <p className="mt-2 leading-relaxed">
            Several parts of Hearth are written by an AI model, not by a person
            and not by a licensed contractor. Those parts are labeled where you
            see them. AI text can be confidently wrong, including about prices,
            diagnoses, and what a document says. It is a starting point for your
            own judgment, never the final word, and it never decides anything on
            your behalf.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
            Which features use AI, and which model
          </h2>
          <p className="mt-2 leading-relaxed">
            There is one AI vendor. Every AI feature in Hearth runs on
            Anthropic&apos;s Claude, on the Claude Sonnet model family,
            through Anthropic&apos;s paid API. We do not train our own model,
            and we do not fine-tune one on your data.
          </p>
          <p className="mt-3 leading-relaxed">
            Because it is the paid API, what you send is not training data.
            Under Anthropic&apos;s{" "}
            <a
              href="https://www.anthropic.com/legal/commercial-terms"
              className="text-bark-700 hover:underline dark:text-stone-300"
              target="_blank"
              rel="noopener noreferrer"
            >
              commercial terms
            </a>
            , API inputs and outputs are not used to train Anthropic&apos;s
            models by default. Anthropic retains API data for up to 30 days
            for trust and safety purposes. Nothing you send is used to build
            an advertising profile of you, by us or by Anthropic.
          </p>
          <p className="mt-3 leading-relaxed">The features that call it are:</p>
          <ul className="mt-3 list-disc space-y-2 pl-5 leading-relaxed">
            <li>
              <span className="font-medium text-stone-900 dark:text-stone-100">
                Ask Hearth
              </span>{" "}
              (homeowner) and{" "}
              <span className="font-medium text-stone-900 dark:text-stone-100">
                Ask Hearth for Pros
              </span>
              : every answer, cost ballpark, and photo diagnosis is generated.
            </li>
            <li>
              <span className="font-medium text-stone-900 dark:text-stone-100">
                The quote analyzer
              </span>
              : the verdict, the summary, the line-item notes, the red flags,
              the &ldquo;what&apos;s missing&rdquo; list, and the negotiation
              script are all generated from the quote you upload.
            </li>
            <li>
              <span className="font-medium text-stone-900 dark:text-stone-100">
                The contractor back office
              </span>
              : drafted estimates, follow-ups, replies, job write-ups, and the
              compliance-document date reading.
            </li>
            <li>
              <span className="font-medium text-stone-900 dark:text-stone-100">
                Applying to a job
              </span>
              : when a pro applies to an open lead, the first-pass apply
              message is drafted for them. It fills the textarea, it doesn&apos;t
              send anything; the pro edits it before sending.
            </li>
            <li>
              <span className="font-medium text-stone-900 dark:text-stone-100">
                Drafting a job post from a photo
              </span>
              : when a homeowner attaches a photo of the problem while posting
              a job, a description, category, and severity are drafted from
              the photo. It fills the form, it doesn&apos;t post anything; the
              homeowner edits it before sending.
            </li>
            <li>
              <span className="font-medium text-stone-900 dark:text-stone-100">
                Document and inspection reading
              </span>
              : pulling systems, ages, issues, and warranty details out of a PDF
              or photo you upload, and confirming a system from a photo of its
              label.
            </li>
            <li>
              <span className="font-medium text-stone-900 dark:text-stone-100">
                Drafted letters and packets
              </span>
              : the property-tax appeal letter and the insurance requote packet.
            </li>
          </ul>
          <p className="mt-4 leading-relaxed">
            Voice input is not on that list any more. Dictation uses the
            speech recognition already built into your phone or browser, on
            the device itself, and only the text it produces reaches Hearth.
            No audio is sent to us or to any AI vendor.
          </p>
          <p className="mt-4 leading-relaxed">
            Ask Hearth has daily caps, because each question costs us money at
            the vendor and we would rather it stay up for everyone. On the free
            plan you get 3 text questions a day. Hearth Plus raises that limit
            and adds photo answers. There is also a short burst limit on both
            plans, so a script can&apos;t fire hundreds of questions in a row.
            When you hit a cap, the assistant tells you so.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
            AI output is generated, and it can be wrong
          </h2>
          <p className="mt-2 leading-relaxed">
            These features do not look up a verified answer in a database. They
            predict plausible text. That means they can state a wrong price,
            misread a number on a quote or an invoice, miss a line item that is
            actually there, invent a code requirement, misidentify equipment in
            a photo, or describe a problem your home does not have. This happens
            even when the answer sounds specific and confident. Treat anything
            labeled as AI-generated as a draft to check, not a fact to rely on.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
            Informational only, not professional or licensed advice
          </h2>
          <p className="mt-2 leading-relaxed">
            Nothing Hearth generates is licensed professional advice. It is not
            engineering, electrical, plumbing, structural, roofing, pest,
            insurance, tax, or legal advice, and no licensed professional has
            reviewed it before you see it. For anything safety-related,
            code-regulated, permit-requiring, or that you are unsure about, hire
            a licensed pro and rely on what they tell you. The tax appeal letter
            and insurance packet are drafts you file or send yourself; Hearth
            does not file, submit, or negotiate anything for you.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
            AI does not price, hire, or decide for you
          </h2>
          <p className="mt-2 leading-relaxed">
            The model does not set prices, accept or reject a quote, choose a
            contractor, book a job, spend your money, or send a message to
            anyone on your behalf. Every one of those is an action you take
            yourself, on a screen where you can see and edit what is about to
            happen. A cost figure from Ask Hearth or the quote analyzer is a
            ballpark for orientation, not an offer, an appraisal, or a promise
            of what any contractor will charge. Contractors set their own
            prices; whether a quote is fair is your call after you compare real
            quotes.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
            Human review: yours, and ours
          </h2>
          <p className="mt-2 leading-relaxed">
            Hearth does not have a person reviewing each AI answer before it
            reaches you. Answers are generated and shown in real time. You are
            the reviewer, which is why the app is built so you can correct it:
            extracted systems and issues arrive as checkboxes you confirm or
            uncheck before anything is saved to your home, quote-analyzer
            findings can be marked &ldquo;covered&rdquo; or added to, drafted
            text in the back office is editable before you copy or send it, and
            a compliance date the model misread can be typed in by hand. We do
            look at aggregate quality and failure reports to improve prompts and
            fix bad behavior, and you can report a bad answer to us using the
            contact below.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
            Using Hearth without AI
          </h2>
          <p className="mt-2 leading-relaxed">
            The AI features are optional and opt-in by use: nothing is sent to a
            model unless you ask a question, upload a quote or document, or
            press a generate or draft button. If you never touch
            those, the rest of Hearth still works, you can add your home,
            systems, ages, and maintenance history by hand, get reminders, browse
            and contact contractors, and manage jobs and messages, with no AI
            involved. Every AI-extracted detail can also be entered or edited
            manually, and your maintenance history is always your own entries,
            never generated.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
            What the AI sees of your data
          </h2>
          <p className="mt-2 leading-relaxed">
            When you use one of these features, your request and the relevant
            context (for example your systems, their ages, open issues, or the
            file you uploaded) are sent to Anthropic&apos;s API to generate the
            response.
          </p>
          <p className="mt-3 leading-relaxed">
            For contractors, Ask Hearth for Pros and the pro back office send
            Anthropic the contractor&apos;s own account context too: their
            wallet balance, license number and verification status, and
            background-check status when they use Ask Hearth for Pros, and
            their own past-job dollar totals, and the full image of an
            uploaded past invoice, quote, or receipt, when they use the
            estimate, invoice, or past-job tools. That is the
            contractor&apos;s own data, not a homeowner&apos;s.
          </p>
          <p className="mt-3 leading-relaxed">
            The{" "}
            <Link href="/privacy" className="text-bark-700 hover:underline dark:text-stone-300">
              Privacy Policy
            </Link>{" "}
            is the full account of what is collected, what gets sent where, how
            long chats are kept, and how to delete your data; it is not repeated
            here.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
            Questions or a bad answer to report
          </h2>
          <p className="mt-2 leading-relaxed">
            If an AI feature told you something wrong, or you have a question
            about how any of this works, reach us through{" "}
            <LegalContact />
            . If you have an account, you can also reach us from the Help page.
          </p>
          {/* TODO(legal): confirm the operating legal entity name and a mailing
              address for this page, and add them here if required. Left blank
              rather than invented. */}
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
            for what Hearth is and isn&apos;t responsible for, and the{" "}
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
