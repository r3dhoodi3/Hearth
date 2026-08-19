"use client";

import { useState } from "react";
import { useFormStatus } from "react-dom";
import { startProCheckoutAction } from "./actions";
import AutoRenewalTerms from "@/components/AutoRenewalTerms";
import InlineSpinner from "@/components/InlineSpinner";
import { PRO_PLAN } from "@/lib/constants";

// Needs its own component because useFormStatus only reports pending state
// inside a descendant of the <form> it belongs to, not the component
// rendering the form itself.
function CheckoutButton({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button className="btn-primary w-full" disabled={pending}>
      {pending && <InlineSpinner />}
      {label}
    </button>
  );
}

const YEARLY_PER_MONTH = (PRO_PLAN.yearly / 12).toFixed(2);
const YEARLY_SAVING = Math.round(PRO_PLAN.monthly * 12 - PRO_PLAN.yearly);

const PLANS = {
  monthly: { label: "Monthly", price: `$${PRO_PLAN.monthly}/mo` },
  yearly: { label: "Yearly", price: `$${YEARLY_PER_MONTH}/mo` },
} as const;

// Monthly / yearly toggle for the Pro pricing card. Both cadences start on the
// same free trial, so the trial is the headline and the price is what it steps
// up to; yearly is $239.88 shown against the honest anchor of 12 months at the
// monthly rate (never an invented list price). Charged amounts live in the
// checkout action; PRO_PLAN keeps display and billing in sync.
//
// `trialEligible` mirrors the exact signal startProCheckoutAction uses to grant
// the trial (no existing Pro-side subscription row), so a returning member who
// churned and came back is never shown trial copy for a trial they will not
// get. It applies the same way to both cadences.
export default function ProPlanToggle({
  trialEligible = true,
}: {
  trialEligible?: boolean;
}) {
  const [plan, setPlan] = useState<"monthly" | "yearly">("monthly");
  const price = plan === "yearly" ? PRO_PLAN.yearly : PRO_PLAN.monthly;
  const unit = plan === "yearly" ? "/year" : "/month";

  return (
    <div id="pricing" className="card-hero space-y-4 text-center">
      <div className="mx-auto inline-flex rounded-full border border-stone-200 bg-stone-50 p-1 dark:border-white/10 dark:bg-stone-800">
        {(Object.keys(PLANS) as Array<keyof typeof PLANS>).map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => setPlan(key)}
            aria-pressed={plan === key}
            className={`relative rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
              plan === key
                ? "bg-hearth-600 text-white shadow-sm"
                : "text-stone-500 hover:text-stone-700 dark:text-stone-400 dark:hover:text-stone-200"
            }`}
          >
            <span className="block leading-tight">{PLANS[key].label}</span>
            <span
              className={`block text-[10px] font-normal leading-tight ${
                plan === key ? "text-hearth-100" : "text-stone-500 dark:text-stone-400"
              }`}
            >
              {PLANS[key].price}
            </span>
            {key === "yearly" && (
              <span className="absolute -top-3 right-0 rounded-full bg-hearth-600 px-1.5 py-0.5 text-[10px] font-medium text-white">
                Save ${YEARLY_SAVING}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* The trial IS the headline, and the price is the follow-through line
          directly under it, never the lead. Both numbers are real: nothing is
          charged for the first PRO_PLAN.trialDays days, and the price below is
          what the card is charged when the trial converts. */}
      <div className="space-y-0.5">
        {trialEligible && (
          <p className="text-sm font-medium text-hearth-700 dark:text-hearth-300">
            Free for {PRO_PLAN.trialDays} days
          </p>
        )}
        <p className="text-4xl font-semibold text-stone-900 dark:text-stone-100">
          ${price}
          <span className="text-base font-normal text-stone-500 dark:text-stone-400">
            {unit}
          </span>
        </p>
        {plan === "yearly" && (
          <p className="text-xs text-stone-500 dark:text-stone-400">
            about ${YEARLY_PER_MONTH}/month, save ${YEARLY_SAVING} vs paying
            monthly
          </p>
        )}
        <p className="text-xs text-stone-500 dark:text-stone-400">
          {trialEligible
            ? `Then $${price}${unit}. Auto-renews until you cancel.`
            : `$${price}${unit}. Auto-renews until you cancel.`}
        </p>
      </div>

      {/* The recurring terms sit INSIDE the checkout form, immediately above
          the button that starts the charge, so the disclosure and the act of
          consent are in visual proximity (see AutoRenewalTerms). Both cadences
          carry the same trial, so introEligible mirrors trialEligible directly
          instead of being plan-specific. */}
      <form action={startProCheckoutAction} className="space-y-3">
        <input type="hidden" name="plan" value={plan} />
        <AutoRenewalTerms
          plan={plan === "monthly" ? "pro_monthly" : "pro_yearly"}
          introEligible={trialEligible}
        />
        <CheckoutButton
          label={
            trialEligible
              ? `Try Pro free for ${PRO_PLAN.trialDays} days`
              : "Start my Pro membership"
          }
        />
        {/* Restates the auto-renewal and the cancellation right at the point of
            consent. The button label is the affirmative act; this line makes
            clear what is being agreed to. */}
        <p className="text-xs text-stone-500 dark:text-stone-400">
          {trialEligible
            ? `We take your card now and charge nothing today. Then $${price}${unit}, automatically, until you cancel. Cancel anytime before the trial ends and you won't be charged. Your lead access never changes either way.`
            : `By continuing you agree to the automatic renewal terms above. Cancel anytime. Your lead access never changes either way.`}
        </p>
      </form>
    </div>
  );
}
