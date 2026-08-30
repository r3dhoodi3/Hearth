import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentContractor } from "@/lib/contractor";
import { getUser } from "@/lib/auth";
import { LEAD_TIER_FEES, MAJOR_INTRO_FEE } from "@/lib/constants";
import { hasProPlan, getProSubscription } from "@/lib/subscription";
import { proCtaLabel, proTrialSubline } from "@/components/pro/ProUpgradeCta";
import ProSupportForm from "./ProSupportForm";
import ShowAppGuideButton from "@/components/ShowAppGuideButton";
import { FEEDBACK_CARD_TITLE } from "@/lib/proFeedback";
import { readFeedbackState } from "@/lib/proFeedbackServer";

// Support for pros. Every contractor can reach the team from here; messages
// from active Pro members are flagged priority so they get answered first.
// Support itself is never gated: only the place in line is a membership perk.
export default async function ProHelpPage(props: {
  searchParams?: Promise<{ sent?: string }>;
}) {
  const contractor = await getCurrentContractor();
  if (!contractor) redirect("/pro/onboarding");

  const member = await hasProPlan();
  // Only for the support form's email fallback when the company record has no
  // contact email of its own. Request-cached, so it costs nothing extra.
  const user = await getUser();
  // Trial-first wording only for a pro who will really get the trial: the
  // pro-side subscriptions row outlives a cancellation, so a lapsed member
  // sees the plain membership line. Request-cached, same rows hasProPlan read.
  const trialEligible = !member && !(await getProSubscription());
  // The feedback-credit row hides itself once the credit has been claimed.
  // Two indexed reads; fails soft to "not claimed", which only ever means the
  // row stays on offer and the grant refuses a second time.
  const { claimed: feedbackClaimed } = await readFeedbackState(
    contractor.id,
    contractor.user_id ?? ""
  );
  // Set by sendProSupportMessageAction's post-success redirect (./actions.ts)
  // so ProSupportForm can swap itself for a confirmation card instead of the
  // plain form on the reload.
  const searchParams = await props.searchParams;
  const sent = searchParams?.sent === "1";

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-stone-900 dark:text-stone-100">Help</h1>
        <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">
          Question about a lead, your wallet, or your account? Send us a
          message and we will get back to you.
        </p>
      </div>

      {/* Prefilled from the company record so support is one field to fill in,
          not four. Only name / contact email / contact phone are passed down. */}
      <div id="support-form">
        <ProSupportForm
          member={member}
          name={contractor.owner_name || contractor.name || ""}
          email={contractor.contact_email || user?.email || ""}
          phone={contractor.contact_phone || ""}
          sent={sent}
        />
      </div>

      {/* Lead pricing, in full. It used to live at the top of /pro/billing,
          where a three-row price table was the first thing a pro saw on the
          page they open to add money - it read as a bill before they had won
          anything. The numbers still have to exist somewhere a pro can find
          them, and this is that place; billing links straight here by this id.
          The price that actually binds is the one on the apply button, which
          prints the exact fee for that job before and after the tap. */}
      <div
        id="lead-pricing"
        className="scroll-mt-20 rounded-2xl border border-stone-200 bg-white p-6 shadow-sm dark:border-white/10 dark:bg-stone-800"
      >
        <h2 className="text-base font-semibold text-stone-900 dark:text-stone-100">
          How lead pricing works
        </h2>
        <p className="mt-1 text-sm text-stone-600 dark:text-stone-300">
          You pay once, per lead you apply to. The exact price for a job is on
          its apply button before you tap it, and again on the confirm step, so
          you never pay an amount you were not shown.
        </p>
        <table className="mt-3 w-full max-w-md text-sm">
          <tbody className="divide-y divide-stone-100 dark:divide-stone-800">
            <tr>
              <td className="py-1.5 pr-3 font-medium text-stone-700 dark:text-stone-300">
                Light jobs
              </td>
              <td className="py-1.5 pr-3 font-semibold text-stone-900 dark:text-stone-100">
                ${LEAD_TIER_FEES.light}
              </td>
              <td className="py-1.5 text-xs text-stone-500 dark:text-stone-400">
                cleaning, landscaping, painting, handyman
              </td>
            </tr>
            <tr>
              <td className="py-1.5 pr-3 font-medium text-stone-700 dark:text-stone-300">
                Skilled trades
              </td>
              <td className="py-1.5 pr-3 font-semibold text-stone-900 dark:text-stone-100">
                ${LEAD_TIER_FEES.skilled}
              </td>
              <td className="py-1.5 text-xs text-stone-500 dark:text-stone-400">
                plumbing, electrical, HVAC, windows
              </td>
            </tr>
            <tr>
              <td className="py-1.5 pr-3 font-medium text-stone-700 dark:text-stone-300">
                Big-ticket
              </td>
              <td className="py-1.5 pr-3 font-semibold text-stone-900 dark:text-stone-100">
                ${LEAD_TIER_FEES.major}
              </td>
              <td className="py-1.5 text-xs text-stone-500 dark:text-stone-400">
                roofing, structural, remodeling
              </td>
            </tr>
          </tbody>
        </table>
        <p className="mt-2 text-xs text-stone-500 dark:text-stone-400">
          Your first big-ticket lead ever is ${MAJOR_INTRO_FEE}. Jobs that sit
          unclaimed get cheaper, and the discounted price is what your wallet is
          charged.
        </p>
      </div>

      {/* Bug bounty, small and honest. Reports go through the support form on
          this page, same inbox as everything else - not a mailto link, which
          dumped people into whatever desktop mail app the OS picked. */}
      <div className="rounded-2xl border border-stone-200 bg-white p-6 shadow-sm dark:border-white/10 dark:bg-stone-800">
        <h2 className="text-base font-semibold text-stone-900 dark:text-stone-100">
          Found a bug?
        </h2>
        <p className="mt-1 text-sm text-stone-600 dark:text-stone-300">
          Tell us about it and get up to $15 in Hearth credit.
        </p>
        <a
          href="#support-form"
          className="mt-3 inline-block text-sm font-medium text-hearth-700 hover:underline dark:text-hearth-300"
        >
          Report a bug
        </a>
      </div>

      {/* Safety. Separate from the bug card above on purpose: someone being
          harassed should not have to work out whether that counts as a bug.
          Goes to the public /contact form rather than the support form on this
          page, so the same route works signed in or not. */}
      <div className="rounded-2xl border border-stone-200 bg-white p-6 shadow-sm dark:border-white/10 dark:bg-stone-800">
        <h2 className="text-base font-semibold text-stone-900 dark:text-stone-100">
          Safety
        </h2>
        <p className="mt-1 text-sm text-stone-600 dark:text-stone-300">
          You can report a message or a review from where you see it, and block
          a homeowner you do not want to hear from again.
        </p>
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2">
          <Link
            href="/contact?topic=abuse"
            className="text-sm font-medium text-hearth-700 hover:underline dark:text-hearth-300"
          >
            Report abuse or a safety concern
          </Link>
          <Link
            href="/pro/blocks"
            className="text-sm font-medium text-hearth-700 hover:underline dark:text-hearth-300"
          >
            Blocked accounts
          </Link>
        </div>
      </div>

      {/* "Tell us what you think, get $5 in lead credit." A private product
          feedback form, never a rating or a store review (see
          src/lib/proFeedback.ts). The row disappears once this business has
          claimed the credit, so a pro who already sent one is not asked again
          from here. */}
      {!feedbackClaimed && (
        <div className="rounded-2xl border border-stone-200 bg-white p-6 shadow-sm dark:border-white/10 dark:bg-stone-800">
          <h2 className="text-base font-semibold text-stone-900 dark:text-stone-100">
            {FEEDBACK_CARD_TITLE}
          </h2>
          <p className="mt-1 text-sm text-stone-600 dark:text-stone-300">
            Two questions, about a minute. We read every one.
          </p>
          <Link href="/pro/feedback" className="btn-secondary mt-3 inline-block">
            Tell us
          </Link>
        </div>
      )}

      {/* The four-card guide from your first sign-in, on demand. Reopens it in
          place (a window event, no navigation) - see
          src/components/ShowAppGuideButton.tsx. */}
      <div className="rounded-2xl border border-stone-200 bg-white p-6 shadow-sm dark:border-white/10 dark:bg-stone-800">
        <h2 className="text-base font-semibold text-stone-900 dark:text-stone-100">
          New to Hearth for Pros?
        </h2>
        <p className="mt-1 text-sm text-stone-600 dark:text-stone-300">
          A one-minute look at leads, your profile and reviews, your client
          list, and the copilot.
        </p>
        <div className="mt-2">
          <ShowAppGuideButton tone="pro" />
        </div>
      </div>

      {!member && (
        <p className="text-xs text-stone-500 dark:text-stone-400">
          Pro members get priority support.{" "}
          <Link href="/pro/plus" className="underline hover:text-stone-600 dark:hover:text-stone-300">
            {proCtaLabel(trialEligible)}
          </Link>
          {trialEligible ? ` ${proTrialSubline()}` : ""}
        </p>
      )}
    </div>
  );
}
