"use client";

import { useRef, useState } from "react";
import { startPlusCheckoutAction } from "./actions";
import SubmitButton from "@/components/SubmitButton";
import AutoRenewalTerms from "@/components/AutoRenewalTerms";
import {
  PLUS_PLAN,
  PLUS_ASK_PER_DAY,
  PLUS_INCLUDED_HOMES,
  TRIAL_ASK_PER_DAY,
  formatUsd,
  yearlySavings,
  yearlyAsMonthly,
} from "@/lib/constants";

// The three cadences Stripe can actually be sent. startPlusCheckoutAction reads
// the "plan" field through checkoutCadence(), which only ever resolves to one
// of these, so the hidden field below must never carry anything else.
type Plan = "weekly" | "monthly" | "yearly";
// What a card can be. "free" is a selectable card because it is a real answer
// to "which plan do you want", but it is not a checkout: selecting it disables
// the button rather than posting a fourth value.
type Choice = Plan | "free";

const CHOICES: Choice[] = ["weekly", "monthly", "yearly", "free"];

// Every figure below is computed from PLUS_PLAN, never typed in. The saving is
// twelve charges at the real monthly price minus the yearly price - the only
// honest anchor this page is allowed to use.
const WEEKLY_PRICE = formatUsd(PLUS_PLAN.weekly); // $1.99
const MONTHLY_PRICE = formatUsd(PLUS_PLAN.monthly); // $4.99
const YEARLY_PRICE = formatUsd(PLUS_PLAN.yearly); // $39.99
const YEARLY_SAVING = formatUsd(yearlySavings(PLUS_PLAN)); // $19.89
// The annual price re-read as a monthly figure, for the sub-line under the
// annual card's price. Kept distinct from YEARLY_SAVING on purpose: the badge
// above the price already says "Save $19.89", so the line under the price
// says the other true fact about the same plan instead of repeating it.
const YEARLY_AS_MONTHLY = formatUsd(yearlyAsMonthly(PLUS_PLAN)); // $3.33

// What Plus adds, in four lines that fit a 110px-wide column at 390px. The
// full row-by-row grid lives in the "See everything included" disclosure on
// the page, so the card never grows past four.
//
// The line carrying NUMBERS reads them from src/lib/constants.ts rather than
// stating them: a hand-typed "5 homes" or "15 asks a day" is a promise that
// goes stale the first time a limit moves, and nobody re-reads a bullet list
// when they change a cap.
//
// A function, not a constant, because ONE of those numbers is not the same on
// every card. The free days ride on the weekly plan, and the trial enforces
// TRIAL_ASK_PER_DAY, not PLUS_ASK_PER_DAY (see src/lib/aiUsage.ts): the weekly
// card and the phone panel were promising 15 asks a day to a buyer whose first
// three days give 8. Quoting the smaller number on the card that carries the
// trial is the version the product actually keeps on day one.
function plusBullets(asksPerDay: number): string[] {
  return [
    "Plan and forecast, in full",
    "Quote analyzer, home report",
    "Every alert, every channel",
    `${PLUS_INCLUDED_HOMES} homes, ${asksPerDay} asks a day`,
  ];
}

// What the free tier actually includes, so the third card reads as a plan
// somebody runs on rather than as a wall of dashes.
const FREE_BULLETS = [
  "Track 1 home",
  "Your first plan build",
  "One free quote check",
  "In-app alerts",
];

// Four cards in the DOM - Weekly, Monthly, Annual, Free - but the Free card is
// `max-sm:hidden`: a reader on the pricing screen is already on Free, so
// showing it as a fourth choice next to three plans they would be paying for
// only repeats what they know. It stays in the markup (and in CHOICES, for
// the keyboard-roving group) because sm and up still shows all four in one
// row. On a phone the three paid cards alone sit in one row via
// `grid-cols-3`, about 110px each at 390px - tight enough that the bullet
// list moves out of the card (`max-sm:hidden` on bulletList) and into the
// description panel below the row instead. THE CARD IS THE SELECTOR - tapping
// one moves the accent outline to it and re-labels the single button
// underneath (and, on a phone, rewrites the panel below), so there is exactly
// one primary action on the page instead of a button per column.
//
// WEEKLY is preselected whenever the trial is on offer, so the picker agrees
// with the top "Start N free days" button above it instead of contradicting
// it - the two used to disagree (that button always means weekly, but the
// picker defaulted to Monthly), so tapping the top button and then glancing
// at the picker looked like two different plans. With no trial to offer,
// Monthly goes back to being the default: $4.99 is the anchor the whole page
// is priced around, with weekly above it per month and annual below it.
// startPlusCheckoutAction falls back to the same cadence, so the hidden field
// and the server can never disagree.
//
// THE 3 FREE DAYS ARE PART OF WEEKLY, not a plan of their own and not an offer
// on monthly or annual: those two bill at signup. `trialEligible` mirrors the
// "no existing homeowner subscription row" signal startPlusCheckoutAction
// checks; billingTerms() applies the weekly-only rule on top of it, in one
// place, so the disclosure, the consent record, and the Stripe trial cannot
// disagree.
export default function PlanToggle({
  trialEligible = true,
}: {
  trialEligible?: boolean;
}) {
  const [choice, setChoice] = useState<Choice>(
    trialEligible ? "weekly" : "monthly"
  );
  // The cadence the form posts. Free is not a cadence, so it falls back to the
  // anchor plan; the button is disabled in that state, so nothing can actually
  // be submitted while it is showing.
  const plan: Plan = choice === "free" ? "monthly" : choice;
  const weeklyTrial = trialEligible;
  const cardRefs = useRef<Array<HTMLButtonElement | null>>([]);

  // Two bullet lists, differing in one number: the weekly card starts on the
  // trial's smaller Ask ceiling when the trial is on offer, monthly and annual
  // bill on day one and get the full one. See plusBullets above.
  const WEEKLY_BULLETS = plusBullets(
    weeklyTrial ? TRIAL_ASK_PER_DAY : PLUS_ASK_PER_DAY
  );
  const PAID_BULLETS = plusBullets(PLUS_ASK_PER_DAY);
  // The phone panel shows the bullets for whichever card is selected, so it
  // follows the same split rather than always quoting the paid ceiling.
  const panelBullets = plan === "weekly" ? WEEKLY_BULLETS : PAID_BULLETS;

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
  // decoration on top of it. `wrapClassName` is the one thing that differs
  // between the two places this renders: inside a card it is `max-sm:hidden`
  // (the phone panel below carries the same list instead), inside the phone
  // panel it is always visible.
  const bulletList = (items: string[], wrapClassName: string) => (
    <span className={wrapClassName}>
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

  // One label per card. Weekly is the only one that can say "free", and only
  // while the trial is real: a returning subscriber is charged on day one, so
  // its button says what it does instead.
  const buttonLabel =
    choice === "free"
      ? "Keep Free"
      : choice === "yearly"
        ? "Get Annual"
        : choice === "monthly"
          ? "Get Monthly"
          : weeklyTrial
            ? `Start ${PLUS_PLAN.trialDays} days free`
            : "Start weekly";

  // The phone-only description panel below the row of cards. It reads `plan`,
  // not `choice`: `plan` is already the safe fallback to a real cadence (see
  // its definition above), so if the group's state is ever "free" on a phone
  // - which the hidden Free card should make impossible, see the layout
  // comment above CHOICES - the panel still shows a real plan instead of
  // rendering nothing or crashing.
  const PLAN_LABEL: Record<Plan, string> = {
    weekly: "Weekly",
    monthly: "Monthly",
    yearly: "Annual",
  };
  const PLAN_PRICE_LINE: Record<Plan, string> = {
    weekly: `${WEEKLY_PRICE} a week`,
    monthly: `${MONTHLY_PRICE} a month`,
    yearly: `${YEARLY_PRICE} a year`,
  };
  // One plain sentence per cadence, every number read from PLUS_PLAN /
  // formatUsd / yearlySavings above rather than typed. Weekly is the only one
  // that changes shape with the trial, for the same reason the button and the
  // AutoRenewalTerms summary do: the free days are a fact about weekly, not
  // about the picker in general.
  const panelBilling: Record<Plan, string> = {
    weekly: weeklyTrial
      ? `${PLUS_PLAN.trialDays} days free, then ${WEEKLY_PRICE} a week. Cancel before the trial ends and you pay nothing.`
      : `${WEEKLY_PRICE} a week, cancel anytime.`,
    monthly: `${MONTHLY_PRICE} a month, cancel anytime.`,
    yearly: `One payment of ${YEARLY_PRICE} a year, that is ${YEARLY_SAVING} less than paying monthly.`,
  };

  return (
    <div id="pricing" className="space-y-4">
      {/* The trial, offered once, at the top, as its own one-tap checkout. It
          posts plan=weekly because the free days belong to weekly and nothing
          else (see billingTerms.trialApplies), so the terms directly under the
          button are the terms of the plan the tap actually buys. Only rendered
          when the trial is real: a returning subscriber sees the cards below
          and nothing that promises free days they will not get. */}
      {trialEligible && (
        <form action={startPlusCheckoutAction} className="card-hero space-y-2">
          <input type="hidden" name="plan" value="weekly" />
          <SubmitButton
            className="btn-primary w-full py-3 text-base"
            pendingLabel="Starting…"
          >
            Start {PLUS_PLAN.trialDays} free days
          </SubmitButton>
          <p className="text-center text-sm text-stone-600 dark:text-stone-300">
            {PLUS_PLAN.trialDays} days free, then {WEEKLY_PRICE}/week. Cancel
            anytime before the trial ends.
          </p>
          {/* Same disclosure the plan picker below carries, for the same
              reason: this button starts a Stripe checkout, so the recurring
              terms have to be on screen next to it before any billing
              information is collected (ROSCA 15 U.S.C. 8403(1)) and in visual
              proximity to the request for consent (Cal. Bus. & Prof. Code
              17602(a)(1)). Hard-coded to "weekly" because the hidden field
              above is. */}
          <AutoRenewalTerms plan="weekly" introEligible={trialEligible} />
        </form>
      )}

      <form action={startPlusCheckoutAction} className="space-y-3">
        {/* The hidden field carries the selected cadence; startPlusCheckoutAction
            falls back to monthly, the same plan preselected below. */}
        <input type="hidden" name="plan" value={plan} />

        {/* The three paid cards in one row on a phone (Free is
            `max-sm:hidden` on its own button below); all four in one row from
            sm up. `grid-cols-3` on the phone width, not a fixed count that
            would leave a gap where Free used to sit. */}
        <div
          role="radiogroup"
          aria-label="Choose your plan"
          onKeyDown={onGroupKeyDown}
          className="grid grid-cols-3 items-stretch gap-1.5 sm:grid-cols-4 sm:gap-3"
        >
          {/* --- Weekly: the one cadence that carries the free days --- */}
          <button {...cardProps("weekly", 0, `Weekly, ${WEEKLY_PRICE} a week`)}>
            <span className="block min-h-4 text-[10px] font-medium uppercase tracking-wide text-bark-700 dark:text-bark-500">
              {weeklyTrial ? `${PLUS_PLAN.trialDays} days free` : ""}
            </span>
            <span className="block text-sm font-semibold text-stone-900 sm:text-base dark:text-stone-100">
              Weekly
            </span>
            <span className="mt-0.5 block min-h-10 sm:mt-1 sm:min-h-11">
              {/* text-sm on the phone, not text-base: at grid-cols-3 a card is
                  about 110px wide at 390px, and text-base pushed "$1.99/wk"
                  close enough to the edge to risk wrapping. sm:text-2xl is
                  unchanged, so desktop is untouched. */}
              <span className="block text-sm font-semibold text-stone-900 sm:text-2xl dark:text-stone-100">
                {WEEKLY_PRICE}
                <span className="text-[11px] font-normal text-stone-500 sm:text-sm dark:text-stone-400">
                  {/* Short unit on a phone so the price never wraps in a
                      110px column; the full word from sm up, where there is
                      room for it. */}
                  <span className="sm:hidden">/wk</span>
                  <span className="hidden sm:inline">/week</span>
                </span>
              </span>
              <span className="block text-[11px] font-medium leading-snug text-bark-700 sm:text-sm dark:text-stone-300">
                {weeklyTrial ? "Try it, then decide" : "Pay as you go"}
              </span>
            </span>
            {bulletList(
              WEEKLY_BULLETS,
              "mt-1.5 hidden space-y-0.5 sm:mt-2 sm:block sm:space-y-1"
            )}
          </button>

          {/* --- Monthly: the anchor, preselected --- */}
          <button {...cardProps("monthly", 1, `Monthly, ${MONTHLY_PRICE} a month`)}>
            <span className="block min-h-4 text-[10px] font-medium uppercase tracking-wide text-bark-700 dark:text-bark-500">
              Most popular
            </span>
            <span className="block text-sm font-semibold text-stone-900 sm:text-base dark:text-stone-100">
              Monthly
            </span>
            <span className="mt-0.5 block min-h-10 sm:mt-1 sm:min-h-11">
              <span className="block text-sm font-semibold text-stone-900 sm:text-2xl dark:text-stone-100">
                {MONTHLY_PRICE}
                <span className="text-[11px] font-normal text-stone-500 sm:text-sm dark:text-stone-400">
                  <span className="sm:hidden">/mo</span>
                  <span className="hidden sm:inline">/month</span>
                </span>
              </span>
              {/* No invented number: four weeks at the real weekly price is
                  more than the monthly price, and a month is longer than four
                  weeks, so this understates the gap rather than overstating
                  it. */}
              <span className="block text-[11px] font-medium leading-snug text-bark-700 sm:text-sm dark:text-stone-300">
                Cheaper than 4 weeks
              </span>
            </span>
            {bulletList(
              PAID_BULLETS,
              "mt-1.5 hidden space-y-0.5 sm:mt-2 sm:block sm:space-y-1"
            )}
          </button>

          {/* --- Annual: the cheapest per month --- */}
          <button
            {...cardProps("yearly", 2, `Annual, ${YEARLY_PRICE} a year`)}
            className={`${card("yearly")} shadow-card`}
          >
            {/* Was "Best value", next to Monthly's "Best for most" - the two
                said the same thing in different words. This badge instead
                states the number Monthly's card cannot: what choosing Annual
                over Monthly actually saves. */}
            <span className="block min-h-4 text-[10px] font-medium uppercase tracking-wide text-bark-700 dark:text-bark-500">
              Save {YEARLY_SAVING}
            </span>
            <span className="block text-sm font-semibold text-stone-900 sm:text-base dark:text-stone-100">
              Annual
            </span>
            <span className="mt-0.5 block min-h-10 sm:mt-1 sm:min-h-11">
              <span className="block text-sm font-semibold text-stone-900 sm:text-2xl dark:text-stone-100">
                {YEARLY_PRICE}
                <span className="text-[11px] font-normal text-stone-500 sm:text-sm dark:text-stone-400">
                  <span className="sm:hidden">/yr</span>
                  <span className="hidden sm:inline">/year</span>
                </span>
              </span>
              {/* The badge above already says "Save $19.89", so this line
                  says the other honest fact about the same plan instead of
                  restating it: the yearly price read back as a monthly
                  figure, computed, never invented. */}
              <span className="block text-[11px] font-medium leading-snug text-bark-700 sm:text-sm dark:text-stone-300">
                About {YEARLY_AS_MONTHLY} a month
              </span>
            </span>
            {bulletList(
              PAID_BULLETS,
              "mt-1.5 hidden space-y-0.5 sm:mt-2 sm:block sm:space-y-1"
            )}
          </button>

          {/* --- Free: the plan they are on today. Hidden on a phone
              (`max-sm:hidden`) - a reader on this screen is already on Free,
              so it does not need to compete with the three plans they would
              be paying for in a one-row phone layout. Still present and
              selectable from sm up, and still in CHOICES for the keyboard
              group below, which only matters on a desktop-width pointer/
              keyboard combination anyway. The initial `choice` state is
              always "weekly" or "monthly" (see useState above), never
              "free", so a phone reader can never load this screen with Free
              already selected. --- */}
          <button
            {...cardProps("free", 3, "Free, the plan you have now")}
            className={`${card("free")} max-sm:hidden`}
          >
            {/* Spacer matching the labelled cards' badge line, so all four
                plan names sit on the same line. */}
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
            {bulletList(FREE_BULLETS, "mt-1.5 hidden space-y-0.5 sm:mt-2 sm:block sm:space-y-1")}
          </button>
        </div>

        {/* Phone-only panel for "what you get" on the plan currently
            selected in the row above. sm and up already shows this in every
            card (the bullet list `bulletList` hides only below sm), so the
            panel would just repeat it there; on a phone it is the only place
            the bullets and the plain-English billing line for the selected
            plan live, and it has room neither card in a 110px column does.
            `aria-live="polite"` so a screen reader hears the update when a
            different card is tapped, without interrupting anything already
            being read. */}
        <div
          className="rounded-xl border border-stone-200 bg-white p-3 sm:hidden dark:border-white/10 dark:bg-stone-800"
          aria-live="polite"
        >
          <p className="text-sm font-semibold text-stone-900 dark:text-stone-100">
            {PLAN_LABEL[plan]}, {PLAN_PRICE_LINE[plan]}
          </p>
          <p className="mt-1 text-xs text-stone-600 dark:text-stone-300">
            {panelBilling[plan]}
          </p>
          {bulletList(panelBullets, "mt-2 block space-y-1")}
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
            stored and emailed, including the weekly-only trial.

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
