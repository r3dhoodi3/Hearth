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
  yearlySavings,
} from "@/lib/constants";

type Plan = "monthly" | "yearly";

// Every figure below is computed from PLUS_PLAN, never typed in. The saving is
// twelve charges at the real monthly price minus the yearly price - the only
// honest anchor this page is allowed to use.
const MONTHLY_PRICE = formatUsd(PLUS_PLAN.monthly); // $4.99
const YEARLY_PRICE = formatUsd(PLUS_PLAN.yearly); // $39.99
const YEARLY_SAVING = formatUsd(yearlySavings(PLUS_PLAN)); // $19.89

// What Plus adds, collapsed from the seven-line list into four lines that fit a
// 110px-wide column at 390px. Deliberately free of the cold-start flags: every
// line is true whether or not job posting is capped. The full row-by-row grid
// lives in the "Compare everything" disclosure on the page.
//
// The line carrying NUMBERS reads them from src/lib/constants.ts rather than
// stating them: a hand-typed "5 homes" or "15 asks a day" is a promise that
// goes stale the first time a limit moves, and nobody re-reads a bullet list
// when they change a cap.
const PLUS_BULLETS = [
  // All seven of the old list's lines, in four: plan + forecast, the two
  // documents, alerts, then the two caps.
  "Plan and forecast, in full",
  "Quote analyzer, home report",
  "Every alert, every channel",
  `${PLUS_INCLUDED_HOMES} homes, ${PLUS_ASK_PER_DAY} asks a day`,
];

// What the free tier actually includes, so the third column reads as a plan
// somebody runs on rather than as a wall of dashes.
const FREE_BULLETS = [
  "Track 1 home",
  "Your first plan build",
  "One free quote check",
  "In-app alerts",
];

// Three columns, shoulder to shoulder at every width: Monthly, Annual (the
// middle one, emphasised), Free. Annual is preselected because it is the plan
// worth recommending, and startPlusCheckoutAction defaults to the same cadence,
// so the hidden field and the server can never disagree.
//
// Weekly was retired as a new-checkout option (existing weekly subscribers keep
// their plan), so it is not offered here.
//
// THE 3 FREE DAYS ARE PART OF MONTHLY, not a plan of their own and not an offer
// on annual: annual bills $39.99 at signup. `trialEligible` mirrors the "no
// existing homeowner subscription row" signal startPlusCheckoutAction checks;
// billingTerms() applies the monthly-only rule on top of it, in one place, so
// the disclosure, the consent record, and the Stripe trial cannot disagree.
export default function PlanToggle({
  trialEligible = true,
}: {
  trialEligible?: boolean;
}) {
  const [plan, setPlan] = useState<Plan>("yearly");
  const monthlyTrial = trialEligible;

  // Shared column shell. Selection changes colors only, never sizes, so a tap
  // cannot reflow the page under the reader's thumb.
  const column = (selected: boolean) =>
    `flex min-w-0 flex-col rounded-xl border p-2 text-left sm:p-4 ${
      selected
        ? "border-bark-600 bg-bark-50 dark:border-bark-500 dark:bg-bark-700/25"
        : "border-stone-200 bg-white dark:border-white/10 dark:bg-stone-800"
    }`;

  const bulletList = (items: string[]) => (
    <ul className="mt-1.5 space-y-0.5 sm:mt-2 sm:space-y-1">
      {items.map((f) => (
        <li
          key={f}
          className="flex items-start gap-1 text-[11px] leading-snug text-stone-700 sm:text-sm dark:text-stone-300"
        >
          <span className="font-bold text-bark-600 dark:text-bark-500" aria-hidden>
            ✓
          </span>
          <span className="min-w-0">{f}</span>
        </li>
      ))}
    </ul>
  );

  // Buttons live in their own grid row under the columns, so the auto-renewal
  // disclosure can sit full width immediately above all three of them (see the
  // note on the form below) while each button stays under its own column.
  const buttonCls = "w-full min-w-0 whitespace-normal px-1 text-center text-xs leading-tight sm:text-sm";

  return (
    <div id="pricing" className="space-y-3">
      <form action={startPlusCheckoutAction} className="space-y-3">
        {/* The hidden field carries the selected cadence; startPlusCheckoutAction
            defaults to yearly, the same plan preselected above. */}
        <input type="hidden" name="plan" value={plan} />

        <div className="grid grid-cols-3 items-stretch gap-1.5 sm:gap-4">
          {/* --- Monthly --- */}
          <div className={column(plan === "monthly")}>
            {/* Spacer matching the annual column's "Best value" label, so all
                three plan names sit on the same line. */}
            <p className="min-h-4" aria-hidden />
            <p className="text-sm font-semibold text-stone-900 sm:text-base dark:text-stone-100">
              Monthly
            </p>
            <div className="mt-0.5 min-h-10 sm:mt-1 sm:min-h-11">
              <p className="text-base font-semibold text-stone-900 sm:text-2xl dark:text-stone-100">
                {MONTHLY_PRICE}
                <span className="text-[11px] font-normal text-stone-500 sm:text-sm dark:text-stone-400">
                  /month
                </span>
              </p>
              {monthlyTrial && (
                <p className="text-[11px] font-medium leading-snug text-bark-700 sm:text-sm dark:text-stone-300">
                  {PLUS_PLAN.trialDays} days free first
                </p>
              )}
            </div>
            <p className="mt-2 text-[11px] font-medium leading-snug text-stone-900 sm:text-sm dark:text-stone-100">
              Everything in Free, plus:
            </p>
            {bulletList(PLUS_BULLETS)}
          </div>

          {/* --- Annual: the middle column, emphasised --- */}
          <div className={`${column(plan === "yearly")} shadow-card`}>
            <p className="min-h-4 text-[10px] font-medium uppercase tracking-wide text-bark-700 dark:text-bark-500">
              Best value
            </p>
            <p className="text-sm font-semibold text-stone-900 sm:text-base dark:text-stone-100">
              Annual
            </p>
            <div className="mt-0.5 min-h-10 sm:mt-1 sm:min-h-11">
              <p className="text-base font-semibold text-stone-900 sm:text-2xl dark:text-stone-100">
                {YEARLY_PRICE}
                <span className="text-[11px] font-normal text-stone-500 sm:text-sm dark:text-stone-400">
                  /year
                </span>
              </p>
              {/* An honest anchor: twelve charges at the real monthly price
                  minus the yearly price, computed, never invented. */}
              <p className="text-[11px] font-medium leading-snug text-bark-700 sm:text-sm dark:text-stone-300">
                Save {YEARLY_SAVING}
              </p>
            </div>
            <p className="mt-2 text-[11px] font-medium leading-snug text-stone-900 sm:text-sm dark:text-stone-100">
              Everything in Free, plus:
            </p>
            {bulletList(PLUS_BULLETS)}
          </div>

          {/* --- Free: the plan they are on today --- */}
          <div className={column(false)}>
            {/* Spacer matching the annual column's "Best value" label, so all
                three plan names sit on the same line. */}
            <p className="min-h-4" aria-hidden />
            <p className="text-sm font-semibold text-stone-900 sm:text-base dark:text-stone-100">
              Free
            </p>
            <div className="mt-0.5 min-h-10 sm:mt-1 sm:min-h-11">
              <p className="text-base font-semibold text-stone-900 sm:text-2xl dark:text-stone-100">
                $0
              </p>
              <p className="text-[11px] leading-snug text-stone-500 sm:text-sm dark:text-stone-400">
                No card, ever
              </p>
            </div>
            <p className="mt-2 text-[11px] font-medium leading-snug text-stone-900 sm:text-sm dark:text-stone-100">
              What you have now:
            </p>
            {bulletList(FREE_BULLETS)}
          </div>
        </div>

        {/* The recurring terms sit INSIDE the checkout form, immediately ABOVE
            the row of buttons, so the disclosure is read before the act of
            consent and both land before any billing information is collected
            (Stripe's page comes after these buttons). ROSCA (15 U.S.C.
            8403(1)) wants all material terms disclosed before billing
            information is obtained; California's Automatic Renewal Law (Bus. &
            Prof. Code 17602(a)(1)) wants them in visual proximity to the
            request for consent. It renders ONCE, for the SELECTED plan, which
            is why the unselected paid column's button says "Choose" and
            selects rather than checking out: a one-tap checkout from the other
            column would start a charge whose terms were never the ones on
            screen. AutoRenewalTerms reads src/lib/billingTerms.ts - the same
            source as the consent record stashed in Stripe metadata and the
            acknowledgment sent afterwards - so the sentences here are word for
            word what gets stored and emailed, including the monthly-only
            trial. */}
        <AutoRenewalTerms plan={plan} introEligible={trialEligible} />

        {/* One button per column, aligned under it by the matching 3-column
            grid. */}
        <div className="grid grid-cols-3 items-start gap-1.5 sm:gap-4">
          {plan === "monthly" ? (
            <SubmitButton
              className={`btn-primary ${buttonCls}`}
              pendingLabel="Starting…"
            >
              {monthlyTrial ? `Start ${PLUS_PLAN.trialDays} days free` : "Start monthly"}
            </SubmitButton>
          ) : (
            <button
              type="button"
              onClick={() => setPlan("monthly")}
              aria-label="Choose the monthly plan"
              className={`btn-secondary ${buttonCls}`}
            >
              {/* Room for the full label from sm up; a 110px column at 390px
                  only has room for the verb, and the column above it is the
                  noun. */}
              <span className="sm:hidden">Choose</span>
              <span className="hidden sm:inline">Choose monthly</span>
            </button>
          )}

          {plan === "yearly" ? (
            <SubmitButton
              className={`btn-primary ${buttonCls}`}
              pendingLabel="Starting…"
            >
              Get annual
            </SubmitButton>
          ) : (
            <button
              type="button"
              onClick={() => setPlan("yearly")}
              aria-label="Choose the annual plan"
              className={`btn-secondary ${buttonCls}`}
            >
              {/* Room for the full label from sm up; a 110px column at 390px
                  only has room for the verb, and the column above it is the
                  noun. */}
              <span className="sm:hidden">Choose</span>
              <span className="hidden sm:inline">Choose annual</span>
            </button>
          )}

          {/* This card only renders for someone who is NOT on Plus, so Free is
              always the plan they are on: the button states it and stays
              disabled rather than pretending to be a choice. */}
          <button type="button" disabled className={`btn-secondary ${buttonCls}`}>
            Current plan
          </button>
        </div>
      </form>
    </div>
  );
}
