"use client";

import { useRef, useState } from "react";
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

// The two cadences Stripe can actually be sent. startPlusCheckoutAction reads
// the "plan" field through checkoutCadence(), which only ever resolves to one
// of these, so the hidden field below must never carry anything else.
type Plan = "monthly" | "yearly";
// What a card can be. "free" is a selectable card because it is a real answer
// to "which plan do you want", but it is not a checkout: selecting it disables
// the button rather than posting a third value.
type Choice = Plan | "free";

const CHOICES: Choice[] = ["monthly", "yearly", "free"];

// Every figure below is computed from PLUS_PLAN, never typed in. The saving is
// twelve charges at the real monthly price minus the yearly price - the only
// honest anchor this page is allowed to use.
const MONTHLY_PRICE = formatUsd(PLUS_PLAN.monthly); // $4.99
const YEARLY_PRICE = formatUsd(PLUS_PLAN.yearly); // $39.99
const YEARLY_SAVING = formatUsd(yearlySavings(PLUS_PLAN)); // $19.89

// What Plus adds, in four lines that fit a 110px-wide column at 390px. The
// full row-by-row grid lives in the "See everything included" disclosure on
// the page, so the card never grows past four.
//
// The line carrying NUMBERS reads them from src/lib/constants.ts rather than
// stating them: a hand-typed "5 homes" or "15 asks a day" is a promise that
// goes stale the first time a limit moves, and nobody re-reads a bullet list
// when they change a cap.
const PLUS_BULLETS = [
  "Plan and forecast, in full",
  "Quote analyzer, home report",
  "Every alert, every channel",
  `${PLUS_INCLUDED_HOMES} homes, ${PLUS_ASK_PER_DAY} asks a day`,
];

// What the free tier actually includes, so the third card reads as a plan
// somebody runs on rather than as a wall of dashes.
const FREE_BULLETS = [
  "Track 1 home",
  "Your first plan build",
  "One free quote check",
  "In-app alerts",
];

// Three cards, shoulder to shoulder at every width: Monthly, Annual (the
// middle one, emphasised), Free. THE CARD IS THE SELECTOR - tapping one moves
// the accent outline to it and re-labels the single button underneath, so
// there is exactly one primary action on the page instead of a button per
// column. Annual is preselected because it is the plan worth recommending, and
// startPlusCheckoutAction defaults to the same cadence, so the hidden field
// and the server can never disagree.
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
  const [choice, setChoice] = useState<Choice>("yearly");
  // The cadence the form posts. Free is not a cadence, so it falls back to the
  // recommended one; the button is disabled in that state, so nothing can
  // actually be submitted while it is showing.
  const plan: Plan = choice === "free" ? "yearly" : choice;
  const monthlyTrial = trialEligible;
  const cardRefs = useRef<Array<HTMLButtonElement | null>>([]);

  // Roving tabindex: one stop for the whole group, arrows move the selection
  // the way a native radio group does. Space and Enter are already handled by
  // the underlying <button>, which fires onClick and selects.
  function onGroupKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    const forward = e.key === "ArrowRight" || e.key === "ArrowDown";
    const back = e.key === "ArrowLeft" || e.key === "ArrowUp";
    if (!forward && !back) return;
    e.preventDefault();
    const at = CHOICES.indexOf(choice);
    const next =
      (at + (forward ? 1 : CHOICES.length - 1) + CHOICES.length) %
      CHOICES.length;
    setChoice(CHOICES[next]);
    cardRefs.current[next]?.focus();
  }

  // Shared card shell. Selection changes colors only, never sizes, so a tap
  // cannot reflow the page under the reader's thumb.
  const card = (key: Choice) =>
    // The focus ring is spelled out rather than borrowed from .focus-ring,
    // which carries its own `rounded` and would fight rounded-xl here. Only
    // the selected card is in the tab order, so this is the marker that shows
    // a keyboard user where they are.
    `flex min-w-0 flex-col rounded-xl border p-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bark-600 focus-visible:ring-offset-1 dark:focus-visible:ring-bark-500 dark:focus-visible:ring-offset-stone-900 sm:p-4 ${
      choice === key
        ? "border-bark-600 bg-bark-50 dark:border-bark-500 dark:bg-bark-700/25"
        : "border-stone-200 bg-white hover:border-stone-300 dark:border-white/10 dark:bg-stone-800 dark:hover:border-white/20"
    }`;

  // Props every card shares, so the radio semantics are written once and
  // cannot drift between the three.
  const cardProps = (key: Choice, index: number, label: string) => ({
    type: "button" as const,
    role: "radio",
    "aria-checked": choice === key,
    "aria-label": label,
    tabIndex: choice === key ? 0 : -1,
    ref: (el: HTMLButtonElement | null) => {
      cardRefs.current[index] = el;
    },
    onClick: () => setChoice(key),
    className: card(key),
  });

  // Spans, not a <ul>: these sit inside a <button>, whose content model is
  // phrasing content only, so a real list here would be invalid markup. The
  // card carries an aria-label with the plan and price, and the bullets are
  // decoration on top of it.
  const bulletList = (items: string[]) => (
    <span className="mt-1.5 block space-y-0.5 sm:mt-2 sm:space-y-1">
      {items.map((f) => (
        <span
          key={f}
          className="flex items-start gap-1 text-[11px] leading-snug text-stone-700 sm:text-sm dark:text-stone-300"
        >
          <span className="font-bold text-bark-600 dark:text-bark-500" aria-hidden>
            ✓
          </span>
          <span className="min-w-0">{f}</span>
        </span>
      ))}
    </span>
  );

  const buttonLabel =
    choice === "free"
      ? "Keep Free"
      : choice === "yearly"
        ? "Get Annual"
        : monthlyTrial
          ? `Start ${PLUS_PLAN.trialDays} days free`
          : "Start monthly";

  return (
    <div id="pricing" className="space-y-4">
      {/* The trial, offered once, at the top, as its own one-tap checkout. It
          posts plan=monthly because the free days belong to monthly and
          nothing else (see billingTerms.trialApplies), so the terms directly
          under the button are the terms of the plan the tap actually buys.
          Only rendered when the trial is real: a returning subscriber sees the
          cards below and nothing that promises free days they will not get. */}
      {trialEligible && (
        <form action={startPlusCheckoutAction} className="card-hero space-y-2">
          <input type="hidden" name="plan" value="monthly" />
          <SubmitButton
            className="btn-primary w-full py-3 text-base"
            pendingLabel="Starting…"
          >
            Start {PLUS_PLAN.trialDays} free days
          </SubmitButton>
          <p className="text-center text-sm text-stone-600 dark:text-stone-300">
            {PLUS_PLAN.trialDays} days free, then {MONTHLY_PRICE}/month. Cancel
            anytime before the trial ends.
          </p>
          {/* Same disclosure the plan picker below carries, for the same
              reason: this button starts a Stripe checkout, so the recurring
              terms have to be on screen next to it before any billing
              information is collected (ROSCA 15 U.S.C. 8403(1)) and in visual
              proximity to the request for consent (Cal. Bus. & Prof. Code
              17602(a)(1)). Hard-coded to "monthly" because the hidden field
              above is. */}
          <AutoRenewalTerms plan="monthly" introEligible={trialEligible} />
        </form>
      )}

      <form action={startPlusCheckoutAction} className="space-y-3">
        {/* The hidden field carries the selected cadence; startPlusCheckoutAction
            defaults to yearly, the same plan preselected below. */}
        <input type="hidden" name="plan" value={plan} />

        <div
          role="radiogroup"
          aria-label="Choose your plan"
          onKeyDown={onGroupKeyDown}
          className="grid grid-cols-3 items-stretch gap-1.5 sm:gap-4"
        >
          {/* --- Monthly --- */}
          <button {...cardProps("monthly", 0, `Monthly, ${MONTHLY_PRICE} a month`)}>
            {/* Spacer matching the annual card's "Best value" label, so all
                three plan names sit on the same line. */}
            <span className="block min-h-4" aria-hidden />
            <span className="block text-sm font-semibold text-stone-900 sm:text-base dark:text-stone-100">
              Monthly
            </span>
            <span className="mt-0.5 block min-h-10 sm:mt-1 sm:min-h-11">
              <span className="block text-base font-semibold text-stone-900 sm:text-2xl dark:text-stone-100">
                {MONTHLY_PRICE}
                <span className="text-[11px] font-normal text-stone-500 sm:text-sm dark:text-stone-400">
                  /month
                </span>
              </span>
              {monthlyTrial && (
                <span className="block text-[11px] font-medium leading-snug text-bark-700 sm:text-sm dark:text-stone-300">
                  {PLUS_PLAN.trialDays} days free first
                </span>
              )}
            </span>
            {bulletList(PLUS_BULLETS)}
          </button>

          {/* --- Annual: the middle card, emphasised --- */}
          <button
            {...cardProps("yearly", 1, `Annual, ${YEARLY_PRICE} a year`)}
            className={`${card("yearly")} shadow-card`}
          >
            <span className="block min-h-4 text-[10px] font-medium uppercase tracking-wide text-bark-700 dark:text-bark-500">
              Best value
            </span>
            <span className="block text-sm font-semibold text-stone-900 sm:text-base dark:text-stone-100">
              Annual
            </span>
            <span className="mt-0.5 block min-h-10 sm:mt-1 sm:min-h-11">
              <span className="block text-base font-semibold text-stone-900 sm:text-2xl dark:text-stone-100">
                {YEARLY_PRICE}
                <span className="text-[11px] font-normal text-stone-500 sm:text-sm dark:text-stone-400">
                  /year
                </span>
              </span>
              {/* An honest anchor: twelve charges at the real monthly price
                  minus the yearly price, computed, never invented. */}
              <span className="block text-[11px] font-medium leading-snug text-bark-700 sm:text-sm dark:text-stone-300">
                Save {YEARLY_SAVING}
              </span>
            </span>
            {bulletList(PLUS_BULLETS)}
          </button>

          {/* --- Free: the plan they are on today --- */}
          <button {...cardProps("free", 2, "Free, the plan you have now")}>
            {/* Spacer matching the annual card's "Best value" label, so all
                three plan names sit on the same line. */}
            <span className="block min-h-4" aria-hidden />
            <span className="block text-sm font-semibold text-stone-900 sm:text-base dark:text-stone-100">
              Free
            </span>
            <span className="mt-0.5 block min-h-10 sm:mt-1 sm:min-h-11">
              <span className="block text-base font-semibold text-stone-900 sm:text-2xl dark:text-stone-100">
                $0
              </span>
              <span className="block text-[11px] leading-snug text-stone-500 sm:text-sm dark:text-stone-400">
                No card, ever
              </span>
            </span>
            {bulletList(FREE_BULLETS)}
          </button>
        </div>

        {/* The recurring terms sit INSIDE the checkout form, immediately ABOVE
            the button, so the disclosure is read before the act of consent and
            both land before any billing information is collected (Stripe's
            page comes after this button). ROSCA (15 U.S.C. 8403(1)) wants all
            material terms disclosed before billing information is obtained;
            California's Automatic Renewal Law (Bus. & Prof. Code 17602(a)(1))
            wants them in visual proximity to the request for consent. It
            renders ONCE, for the SELECTED plan, which is why the card is the
            selector and the button is single: the terms on screen are always
            the terms of the plan the button would charge. AutoRenewalTerms
            reads src/lib/billingTerms.ts - the same source as the consent
            record stashed in Stripe metadata and the acknowledgment sent
            afterwards - so the sentences here are word for word what gets
            stored and emailed, including the monthly-only trial.

            Free is the one card with no terms block, because selecting it
            charges nothing and the button below is disabled. */}
        {choice === "free" ? (
          <p className="text-center text-sm text-stone-500 dark:text-stone-400">
            Free is the plan you are on now.
          </p>
        ) : (
          <AutoRenewalTerms plan={plan} introEligible={trialEligible} />
        )}

        {choice === "free" ? (
          <button type="button" disabled className="btn-secondary w-full py-3">
            {buttonLabel}
          </button>
        ) : (
          <SubmitButton
            className="btn-primary w-full py-3"
            pendingLabel="Starting…"
          >
            {buttonLabel}
          </SubmitButton>
        )}
      </form>
    </div>
  );
}
