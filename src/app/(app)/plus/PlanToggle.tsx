"use client";

import { useState } from "react";
import { startPlusCheckoutAction } from "./actions";
import SubmitButton from "@/components/SubmitButton";
import AutoRenewalTerms from "@/components/AutoRenewalTerms";
import {
  PLUS_PLAN,
  PLUS_ASK_PER_DAY,
  PLUS_INCLUDED_HOMES,
  formatUsd,
  yearlyRunRate,
  yearlySavings,
} from "@/lib/constants";

type Plan = "monthly" | "yearly";

// Every figure below is computed from PLUS_PLAN, never typed in. The saving is
// twelve charges at the real monthly price minus the yearly price - the only
// honest anchor this page is allowed to use.
const MONTHLY_YEAR_TOTAL = formatUsd(yearlyRunRate(PLUS_PLAN)); // $59.88
const YEARLY_SAVING = formatUsd(yearlySavings(PLUS_PLAN)); // $19.89

const PLAN_COPY: Record<
  Plan,
  { label: string; price: string; unit: string; note: string }
> = {
  yearly: {
    label: "Yearly",
    price: formatUsd(PLUS_PLAN.yearly),
    unit: "/year",
    note: `Best value, save ${YEARLY_SAVING}`,
  },
  monthly: {
    label: "Monthly",
    price: formatUsd(PLUS_PLAN.monthly),
    unit: "/month",
    note: `${MONTHLY_YEAR_TOTAL} a year`,
  },
};

// What Plus actually adds, stated as capabilities. Deliberately free of the
// cold-start flags: every line here is true whether or not job posting is
// capped, so the card never promises a perk the app isn't gating yet. The full
// Free-vs-Plus grid lives in the "Compare everything" disclosure on the page.
// Each line is kept short enough to sit on one row at 390px, so the list reads
// as seven short facts rather than a paragraph.
//
// The two lines carrying a NUMBER read it from src/lib/constants.ts rather
// than stating it: a hand-typed "5 homes" or "15 questions a day" is a promise
// that goes stale the first time a limit moves, and nobody re-reads a bullet
// list when they change a cap.
const INCLUDES = [
  "A maintenance plan built for your home",
  "Full cost forecast and repair fund",
  "Quote analyzer on every quote",
  "Home report for resale and insurance",
  `Up to ${PLUS_INCLUDED_HOMES} homes, household included`,
  "Every proactive alert, every channel",
  `Ask Hearth: ${PLUS_ASK_PER_DAY} questions a day with photo answers`,
];

// ONE plan card, with a Yearly/Monthly segmented toggle. Yearly is preselected
// because it is the plan worth recommending, and startPlusCheckoutAction
// defaults to the same cadence, so the hidden field and the server can never
// disagree.
//
// Weekly was retired as a new-checkout option (existing weekly subscribers keep
// their plan), so it is not offered here.
//
// `trialEligible` mirrors the exact signal startPlusCheckoutAction uses to grant
// the 3-day trial (no existing homeowner subscription row), and applies the same
// way to both cadences.
export default function PlanToggle({
  trialEligible = true,
}: {
  trialEligible?: boolean;
}) {
  const [plan, setPlan] = useState<Plan>("yearly");
  const copy = PLAN_COPY[plan];

  return (
    <div id="pricing" className="card mx-auto max-w-md space-y-4">
      {/* Cadence switcher. Two segments, full width, each at the 44px thumb
          minimum. Plain buttons with aria-pressed, not role="tab": we don't
          implement the tab keyboard contract (arrow keys move between tabs),
          so aria-pressed is the honest description of what these are - the
          same pattern QuoteAnalyzer's two mode buttons use. */}
      <div
        role="group"
        aria-label="Billing cadence"
        className="grid grid-cols-2 gap-1 rounded-xl border border-stone-200 bg-stone-100 p-1 dark:border-white/10 dark:bg-stone-900"
      >
        {(["yearly", "monthly"] as const).map((key) => (
          <button
            key={key}
            type="button"
            aria-pressed={plan === key}
            onClick={() => setPlan(key)}
            className={`min-h-11 rounded-lg px-3 text-sm font-medium transition-colors ${
              plan === key
                ? "bg-white text-stone-900 shadow-sm dark:bg-stone-700 dark:text-stone-100"
                : "text-stone-500 hover:text-stone-700 dark:text-stone-400 dark:hover:text-stone-200"
            }`}
          >
            {PLAN_COPY[key].label}
          </button>
        ))}
      </div>

      {/* The chosen plan's price, stated once. */}
      <div>
        <p className="text-3xl font-semibold text-stone-900 dark:text-stone-100">
          {copy.price}
          <span className="text-sm font-normal text-stone-500 dark:text-stone-400">
            {copy.unit}
          </span>
        </p>
        <p className="mt-1 text-xs font-medium text-bark-700 dark:text-stone-300">
          {copy.note}
        </p>
      </div>

      <ul className="space-y-1.5 border-t border-stone-100 pt-4 dark:border-white/10">
        {INCLUDES.map((f) => (
          <li
            key={f}
            className="flex items-start gap-2 text-sm text-stone-700 dark:text-stone-300"
          >
            <span className="mt-px font-bold text-bark-600 dark:text-bark-500" aria-hidden>
              ✓
            </span>
            <span>{f}</span>
          </li>
        ))}
      </ul>

      {/* The hidden field carries the selected cadence; startPlusCheckoutAction
          defaults to yearly, the same plan preselected above. */}
      <form action={startPlusCheckoutAction} className="space-y-3">
        <input type="hidden" name="plan" value={plan} />

        {/* The recurring terms sit INSIDE the checkout form, immediately ABOVE
            the button that starts the charge, so the disclosure is read before
            the act of consent and both land before any billing information is
            collected (Stripe's page comes after this button). ROSCA (15
            U.S.C. 8403(1)) wants all material terms disclosed before billing
            information is obtained; California's Automatic Renewal Law (Bus. &
            Prof. Code 17602(a)(1)) wants them in visual proximity to the
            request for consent. AutoRenewalTerms is the ONE component both
            plan toggles render, reading src/lib/billingTerms.ts - the same
            source as the consent record stashed in Stripe metadata and the
            acknowledgment sent afterwards - so the step-up sentence and the
            three facts here are word for word what gets stored and emailed. */}
        <AutoRenewalTerms plan={plan} introEligible={trialEligible} />

        <SubmitButton className="btn-primary w-full" pendingLabel="Starting checkout…">
          {trialEligible ? `Start ${PLUS_PLAN.trialDays} days free` : "Subscribe"}
        </SubmitButton>
      </form>
    </div>
  );
}
