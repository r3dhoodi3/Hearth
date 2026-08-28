import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentContractor } from "@/lib/contractor";
import { hasProPlan, getProSubscription } from "@/lib/subscription";
import { proCtaLabel, proTrialSubline } from "@/components/pro/ProUpgradeCta";
import ProSupportForm from "./ProSupportForm";
import ShowAppGuideButton from "@/components/ShowAppGuideButton";

// Support for pros. Every contractor can reach the team from here; messages
// from active Pro members are flagged priority so they get answered first.
// Support itself is never gated: only the place in line is a membership perk.
export default async function ProHelpPage() {
  const contractor = await getCurrentContractor();
  if (!contractor) redirect("/pro/onboarding");

  const member = await hasProPlan();
  // Trial-first wording only for a pro who will really get the trial: the
  // pro-side subscriptions row outlives a cancellation, so a lapsed member
  // sees the plain membership line. Request-cached, same rows hasProPlan read.
  const trialEligible = !member && !(await getProSubscription());

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-stone-900 dark:text-stone-100">Help</h1>
        <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">
          Question about a lead, your wallet, or your account? Send us a
          message and we will get back to you.
        </p>
      </div>

      <div id="support-form">
        <ProSupportForm member={member} />
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
