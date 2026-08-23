import { billingTerms, type PaidPlan } from "@/lib/billingTerms";

// The auto-renewal disclosure block, rendered directly above the button that
// starts a subscription checkout on both plan toggles.
//
// Placement is the point. ROSCA (15 U.S.C. 8403(1)) wants all material terms
// disclosed "before obtaining the consumer's billing information", and
// California's Automatic Renewal Law (Bus. & Prof. Code 17602(a)(1)) wants
// them "in visual proximity ... to the request for consent". Sitting inside
// the same form as the submit button, immediately above it, satisfies both
// readings; moving it into a footer, a tooltip, or behind a link would not.
//
// It is also deliberately plain: 17602(a)(4) forbids surrounding the consent
// with information that "interferes with, detracts from, contradicts, or
// otherwise undermines" it, so there is no marketing copy, no countdown, and
// no competing call to action inside this block.
// `variant` switches the same three facts between the two moments they are
// legally required. "checkout" is the pre-purchase disclosure; "acknowledgment"
// is the post-purchase one California requires under 17602(a)(3), which has to
// carry the renewal terms, the cancellation policy, and how to cancel.
export default function AutoRenewalTerms({
  plan,
  introEligible,
  variant = "checkout",
}: {
  plan: PaidPlan;
  introEligible: boolean;
  variant?: "checkout" | "acknowledgment";
}) {
  const terms = billingTerms(plan, introEligible);
  const acknowledgment = variant === "acknowledgment";

  return (
    <div className="rounded-xl border border-stone-200 bg-stone-50 p-3 text-left dark:border-white/10 dark:bg-stone-900">
      <p className="text-xs font-semibold uppercase tracking-wide text-stone-500 dark:text-stone-400">
        {acknowledgment
          ? `Your ${terms.product} renewal terms`
          : "This subscription renews automatically"}
      </p>
      {/* `terms.summary` is the whole commitment in one sentence: "Free for N
          days. After that it is $X a <cadence>, and it renews every <cadence>
          until you cancel." on a plan that carries the trial, and "$X today,
          and it renews every <cadence> until you cancel." on one that bills at
          signup. Leading with it, before the itemized list below, puts the
          fact ROSCA and the California Automatic Renewal Law most want up
          front in the first sentence a buyer reads rather than buried in a
          bullet - and it says it for the plan actually selected, so the
          monthly-only trial never leaks onto an annual checkout. */}
      <p className="mt-2 text-xs font-medium text-stone-900 dark:text-stone-100">
        {terms.summary}
      </p>
      <ul className="mt-2 space-y-1 text-xs text-stone-600 dark:text-stone-300">
        <li>
          <span className="font-medium text-stone-900 dark:text-stone-100">
            {acknowledgment ? "You paid:" : "You pay:"}
          </span>{" "}
          {terms.chargedToday}
        </li>
        <li>
          <span className="font-medium text-stone-900 dark:text-stone-100">
            Then:
          </span>{" "}
          {terms.recurring}
        </li>
        <li>
          <span className="font-medium text-stone-900 dark:text-stone-100">
            To cancel:
          </span>{" "}
          {terms.cancel}
        </li>
      </ul>
    </div>
  );
}
