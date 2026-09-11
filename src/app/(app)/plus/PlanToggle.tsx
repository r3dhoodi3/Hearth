"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronRight } from "lucide-react";
import { startPlusCheckoutAction } from "./actions";
import SubmitButton from "@/components/SubmitButton";
import AutoRenewalTerms from "@/components/AutoRenewalTerms";
import AutoRenewalConsentCheckbox from "@/components/AutoRenewalConsentCheckbox";
import BillingLegalLine from "@/components/BillingLegalLine";
import { isNativeApp } from "@/lib/platform";
import NativePlusCheckout from "./NativePlusCheckout";
import {
  PLUS_PLAN,
  formatUsd,
  yearlySavings,
  yearlyAsMonthly,
} from "@/lib/constants";

// The three cadences Stripe can actually be sent. startPlusCheckoutAction reads
// the "plan" field through checkoutCadence(), which only ever resolves to one
// of these, so the hidden field below must never carry anything else. The Free
// card was removed - what Plus includes now shows as perk boxes above this
// picker (PlusPerks.tsx), matching the pro pitch - so a card is always one of
// these three real cadences and the button always starts a real checkout.
type Plan = "weekly" | "monthly" | "yearly";

const CHOICES: Plan[] = ["weekly", "monthly", "yearly"];

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

// What Plus includes no longer lives on the cards: it is shown as perk boxes
// above this picker (PlusPerks.tsx), the twin of the pro pitch's PerksList
// grid. The cards below are the price picker only - cadence, price, and the
// free-trial line - so they carry no bullet list. The full row-by-row
// free-vs-Plus grid still lives in the "See everything included" disclosure on
// the page for anyone who wants it.
//
// Three cards - Weekly, Monthly, Annual - in one row at every width via
// `grid-cols-3`, about 110px each at 390px. THE CARD IS THE SELECTOR - tapping
// one moves the accent outline to it and re-labels the single button
// underneath (and, on a phone, rewrites the panel below), so there is exactly
// one primary action on the page instead of a button per column.
//
// MONTHLY is preselected in every state: $4.99 is the anchor the whole page is
// priced around, with weekly above it per month and annual below it, and
// startPlusCheckoutAction falls back to the same cadence, so the hidden field
// and the server can never disagree. It used to preselect Weekly whenever the
// trial was on offer, because the free days were weekly's and a separate
// "Start N free days" button at the top of this file posted weekly. Both are
// gone: the free days now come with whichever card is selected, so preselecting
// the cheapest cadence would just be steering.
//
// PHONE DISCLOSURE: TWO COPIES OF AutoRenewalTerms, ONE PER BREAKPOINT.
// The checkout form below renders the block twice - once inside a `sm:hidden`
// <details> that starts CLOSED, once inside a `max-sm:hidden` div that renders
// exactly as it always did. On a 390px screen the full block ran about a third
// of a screen and pushed the button it belongs to below the fold, which is the
// scrolling the owner asked us to stop.
//
// What is collapsed is the ITEMIZED version, never the material terms. The
// one-line summary (panelBilling[plan]: "3 days free, then $39.99/year. Cancel
// anytime before the trial ends." for an eligible buyer on annual) stays on
// screen
// unconditionally, directly beside the button, which is what ROSCA
// 15 U.S.C. 8403(1) and Cal. Bus. & Prof. Code 17602(a)(1) are about: material
// terms disclosed before billing information is collected, in visual proximity
// to the request for consent. One tap opens the rest, and it is inside the
// same form as the button either way.
//
// Two elements rather than one because `open` is a boolean attribute that no
// media query can drive, and flipping it from JS on mount would either flash
// or mismatch hydration.
//
// THE STORED CONSENT RECORD IS UNAFFECTED. billingTermsText in the Stripe
// metadata is built SERVER-SIDE by startPlusCheckoutAction from
// src/lib/billingTerms.ts, off the posted cadence, never from what this
// component rendered. AutoRenewalTerms reads that same module, so the screen
// and the record cannot disagree no matter which copy is on screen.
//
// THE 3 FREE DAYS COME WITH EVERY CADENCE, not with weekly alone. They are one
// per ACCOUNT (the promo_claims reservation in startPlusCheckoutAction is what
// enforces that), so an eligible buyer who wants the annual plan starts the
// same 3 free days and then renews annually, instead of having to buy weekly
// first and switch afterwards. This mirrors the Pro side, which has always
// trialed on both of its cadences. `trialEligible` mirrors the "no existing
// homeowner subscription row" signal startPlusCheckoutAction checks;
// billingTerms() is the one place the rule is applied, so the disclosure, the
// consent record, and the Stripe trial cannot disagree.
//
// THE PICKER IS THE WHOLE DECISION. There is one checkout form, one button, and
// one line of material terms, all following the selected card. A separate
// weekly-only "Start 3 free days" form used to sit above the cards; it made the
// free days look like a fourth plan and quietly meant weekly, which is the
// default nobody chose.
export default function PlanToggle({
  trialEligible = true,
}: {
  trialEligible?: boolean;
}) {
  const [choice, setChoice] = useState<Plan>("monthly");
  // The required auto-renewal consent checkbox (Cal. Bus. & Prof. Code
  // 17602(a)(2)): unchecked by default, gating the checkout button below
  // until it is checked. One state for the whole form, since the plan cards
  // change the price the disclosure quotes but never the fact of agreeing to
  // it.
  const [consent, setConsent] = useState(false);
  // Native app shell (Capacitor iOS/Android): starts false on every render
  // (server AND the client's first paint) and flips in an effect AFTER
  // mount, never read during render before that. This is the standard
  // "browser-only API, avoid a hydration mismatch" pattern - isNativeApp()
  // reads window.Capacitor synchronously, and Capacitor's bridge can already
  // exist by the time this component hydrates, so checking it during the
  // render itself would make the client's first render disagree with the
  // server-rendered HTML. A plain web visitor's isNativeApp() is always
  // false, so this state never moves for them and the web output is
  // unaffected either way.
  const [isNative, setIsNative] = useState(false);
  useEffect(() => {
    setIsNative(isNativeApp());
  }, []);
  // The cadence the form posts. Every card is a real cadence now, so this is
  // the selection directly.
  const plan: Plan = choice;
  const cardRefs = useRef<Array<HTMLButtonElement | null>>([]);

  // APPLE 3.1.1 / GOOGLE PLAY BILLING: inside the native app shell, OakTend
  // Plus is a StoreKit/Play Billing purchase, never a Stripe Checkout
  // redirect - see src/lib/nativeClientHeader.ts for the server-side twin of
  // this check. Every hook above still runs on every render (native or not),
  // so this early return is a plain conditional render, not a conditional
  // hook call.
  if (isNative) {
    return <NativePlusCheckout />;
  }

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
  const card = (key: Plan) =>
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
  const cardProps = (key: Plan, index: number, label: string) => ({
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

  // The free days, stated on every paid card while they are on offer, in the
  // same spot on all three: the row has to read as one offer with three prices,
  // not as one plan that trials and two that bill on day one, which is what the
  // single "3 days free" badge on the weekly card used to say. It sits under
  // the price rather than in the badge line above the plan name, because that
  // line already carries the two facts only one card each can claim ("Most
  // popular", "Save $19.89").
  const trialLine = trialEligible ? (
    <span className="block text-sm font-medium leading-snug text-bark-700 dark:text-bark-500">
      {PLUS_PLAN.trialDays} days free
    </span>
  ) : null;

  // ONE label for the one button, and it turns on the trial rather than on the
  // cadence: every card starts the same free days now, so "Start 3 free days"
  // is true whichever one is selected, and the line of terms directly above the
  // button says which price it steps up to. A returning subscriber is charged
  // on day one, so their button says what it does instead. The labels used to
  // name the cadence ("Get Annual", "Start weekly"), which repeated the card
  // the reader had just tapped and left the free days unmentioned on two of the
  // three.
  const buttonLabel = trialEligible
    ? `Start ${PLUS_PLAN.trialDays} free days`
    : "Start OakTend Plus";

  // The phone-only description panel below the row of cards. `plan` mirrors
  // `choice` directly now that every card is a real cadence, so the panel
  // always has a real plan to show.
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
  // formatUsd / yearlySavings above rather than typed. All three change shape
  // with the trial now, for the same reason the button does: the free days are
  // a fact about the account, not about weekly, so each card has to say what it
  // steps up to when they end. This is the material-terms line the law wants
  // beside the button (price, cadence, how to stop it), so it stays one
  // sentence and never folds away.
  const panelBilling: Record<Plan, string> = trialEligible
    ? {
        weekly: `${PLUS_PLAN.trialDays} days free, then ${WEEKLY_PRICE}/week. Cancel anytime before the trial ends.`,
        monthly: `${PLUS_PLAN.trialDays} days free, then ${MONTHLY_PRICE}/month. Cancel anytime before the trial ends.`,
        yearly: `${PLUS_PLAN.trialDays} days free, then ${YEARLY_PRICE}/year. Cancel anytime before the trial ends.`,
      }
    : {
        weekly: `${WEEKLY_PRICE} a week, cancel anytime.`,
        monthly: `${MONTHLY_PRICE} a month, cancel anytime.`,
        yearly: `One payment of ${YEARLY_PRICE} a year, that is ${YEARLY_SAVING} less than paying monthly.`,
      };

  return (
    <div id="pricing" className="space-y-4">
      {/* One checkout form for the whole page: the cards pick the cadence, the
          single button below starts it, and the one line of terms above that
          button follows the same selection. The weekly-only trial form that
          used to sit here is gone with the weekly-only trial. */}
      <form action={startPlusCheckoutAction} className="space-y-3">
        {/* The hidden field carries the selected cadence; startPlusCheckoutAction
            falls back to monthly, the same plan preselected below. */}
        <input type="hidden" name="plan" value={plan} />

        {/* The three cadence cards in one row at every width: Weekly, Monthly,
            Annual. `grid-cols-3` at both breakpoints now that the Free card is
            gone. */}
        <div
          role="radiogroup"
          aria-label="Choose your plan"
          onKeyDown={onGroupKeyDown}
          className="grid grid-cols-3 items-stretch gap-1.5 sm:gap-3"
        >
          {/* --- Weekly: the smallest commitment --- */}
          <button {...cardProps("weekly", 0, `Weekly, ${WEEKLY_PRICE} a week`)}>
            {/* Spacer only, matching the badge line on Monthly and Annual so
                all three plan names sit on one line. It used to hold the
                weekly-only "3 days free" badge; the free days are on every
                card now, stated under each price. */}
            <span className="block min-h-4 text-[10px] font-medium uppercase tracking-wide text-bark-700 max-sm:text-xs dark:text-bark-500" />
            <span className="block text-sm font-semibold text-stone-900 sm:text-base dark:text-stone-100">
              Weekly
            </span>
            {/* No max-sm:min-h floor here (CR3#9): a phone card carries no dead
                space, so the whole picker fits with less scroll. The sm:min-h-11
                keeps the three price blocks the same height from sm up. */}
            <span className="mt-0.5 block sm:mt-1 sm:min-h-11">
              {/* text-sm on the phone, not text-base: at grid-cols-3 a card is
                  about 110px wide at 390px, and text-base pushed "$1.99/wk"
                  close enough to the edge to risk wrapping. sm:text-2xl is
                  unchanged, so desktop is untouched. */}
              <span className="block text-sm font-semibold text-stone-900 sm:text-2xl dark:text-stone-100">
                {WEEKLY_PRICE}
                <span className="text-sm font-normal text-stone-500 dark:text-stone-400">
                  {/* Short unit on a phone so the price never wraps in a
                      110px column; the full word from sm up, where there is
                      room for it. */}
                  <span className="sm:hidden">/wk</span>
                  <span className="hidden sm:inline">/week</span>
                </span>
              </span>
              {/* "Try it, then decide" moved off this card with the
                  weekly-only trial: trying it first is what every card does
                  now, so weekly's own line states the thing only weekly can
                  claim. */}
              <span className="block text-sm font-medium leading-snug text-bark-700 dark:text-stone-300">
                Pay as you go
              </span>
              {trialLine}
            </span>
          </button>

          {/* --- Monthly: the anchor, preselected --- */}
          <button {...cardProps("monthly", 1, `Monthly, ${MONTHLY_PRICE} a month`)}>
            <span className="block min-h-4 text-[10px] font-medium uppercase tracking-wide text-bark-700 max-sm:text-xs dark:text-bark-500">
              {/* "Most popular" is the only badge of the three that cannot
                  hold one line at 12px in a ~92px phone column, and a wrapped
                  badge would drop this card's plan name a line below its
                  neighbours. Same meaning, one word, below sm only. */}
              <span className="sm:hidden">Popular</span>
              <span className="hidden sm:inline">Most popular</span>
            </span>
            <span className="block text-sm font-semibold text-stone-900 sm:text-base dark:text-stone-100">
              Monthly
            </span>
            {/* CR3#9: no phone min-h floor - see the note on the Weekly card
                above. */}
            <span className="mt-0.5 block sm:mt-1 sm:min-h-11">
              <span className="block text-sm font-semibold text-stone-900 sm:text-2xl dark:text-stone-100">
                {MONTHLY_PRICE}
                <span className="text-sm font-normal text-stone-500 dark:text-stone-400">
                  <span className="sm:hidden">/mo</span>
                  <span className="hidden sm:inline">/month</span>
                </span>
              </span>
              {/* No invented number: four weeks at the real weekly price is
                  more than the monthly price, and a month is longer than four
                  weeks, so this understates the gap rather than overstating
                  it. */}
              <span className="block text-sm font-medium leading-snug text-bark-700 dark:text-stone-300">
                Cheaper than 4 weeks
              </span>
              {trialLine}
            </span>
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
            <span className="block min-h-4 text-[10px] font-medium uppercase tracking-wide text-bark-700 max-sm:text-xs dark:text-bark-500">
              Save {YEARLY_SAVING}
            </span>
            <span className="block text-sm font-semibold text-stone-900 sm:text-base dark:text-stone-100">
              Annual
            </span>
            {/* CR3#9: no phone min-h floor - see the note on the Weekly card
                above. */}
            <span className="mt-0.5 block sm:mt-1 sm:min-h-11">
              <span className="block text-sm font-semibold text-stone-900 sm:text-2xl dark:text-stone-100">
                {YEARLY_PRICE}
                <span className="text-sm font-normal text-stone-500 dark:text-stone-400">
                  <span className="sm:hidden">/yr</span>
                  <span className="hidden sm:inline">/year</span>
                </span>
              </span>
              {/* The badge above already says "Save $19.89", so this line
                  says the other honest fact about the same plan instead of
                  restating it: the yearly price read back as a monthly
                  figure, computed, never invented. */}
              <span className="block text-sm font-medium leading-snug text-bark-700 dark:text-stone-300">
                About {YEARLY_AS_MONTHLY} a month
              </span>
              {trialLine}
            </span>
          </button>

        </div>

        {/* Phone-only recap of the plan currently selected in the row above:
            its cadence, price line, and the plain-English billing sentence,
            which the ~110px phone cards have no room for. What Plus includes is
            the perk boxes above the picker (PlusPerks.tsx), so the panel no
            longer repeats a bullet list. `aria-live="polite"` so a screen
            reader hears the update when a different card is tapped, without
            interrupting anything already being read. */}
        <div
          className="rounded-xl border border-stone-200 bg-white p-3 sm:hidden dark:border-white/10 dark:bg-stone-800"
          aria-live="polite"
        >
          <p className="text-sm font-semibold text-stone-900 dark:text-stone-100">
            {PLAN_LABEL[plan]}, {PLAN_PRICE_LINE[plan]}
          </p>
          {/* text-sm, not text-xs: this panel only exists below sm (the
              wrapper is sm:hidden), and 12px is under the readable floor on a
              phone. */}
          <p className="mt-1 text-sm text-stone-600 dark:text-stone-300">
            {panelBilling[plan]}
          </p>
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
            stored and emailed, including the free days and the price they
            step up to on whichever cadence is selected. */}
        {/* The one-line material-terms summary, always visible on a phone:
            what is charged, when, and how to stop it, for the selected plan.
            It is the same sentence billingTerms() puts in the consent record,
            so nothing behind the disclosure below is a fact the reader was not
            shown. sm and up already reads it as the first line of the block
            itself, so this copy is phone-only. */}
        <p className="text-center text-sm text-stone-600 sm:hidden dark:text-stone-300">
          {panelBilling[plan]}
        </p>
        {/* Collapsed on a phone, open on desktop. See PHONE DISCLOSURE
            at the top of this file. */}
        <details className="group sm:hidden">
          <summary className="focus-ring mx-auto flex min-h-11 w-fit cursor-pointer list-none items-center gap-1.5 text-sm font-medium text-stone-700 [&::-webkit-details-marker]:hidden dark:text-stone-300">
            <ChevronRight
              className="h-4 w-4 shrink-0 text-stone-400 transition-transform duration-150 group-open:rotate-90 dark:text-stone-500"
              aria-hidden="true"
            />
            Billing terms
          </summary>
          <div className="mt-2">
            <AutoRenewalTerms plan={plan} introEligible={trialEligible} />
          </div>
        </details>
        <div className="max-sm:hidden">
          <AutoRenewalTerms plan={plan} introEligible={trialEligible} />
        </div>
        <AutoRenewalConsentCheckbox id="plus-consent" checked={consent} onChange={setConsent} />

        {/* CR3#4: on a phone, the one thing every card selection is building
            toward stays a thumb's reach away instead of sliding further down
            the screen every time the billing-terms disclosure above opens.
            `choice` always starts on a real plan ("monthly"; see the useState
            above), so a plan is selected the instant this renders - there is
            no "nothing chosen yet" state where the bar would need to stay
            off. Positioned above the fixed bottom tab bar (Nav.tsx, <=48px
            plus its own safe-area padding), not doubled with the safe-area
            padding it already reserves. Desktop (sm and up) is unaffected:
            every max-sm: class here is a no-op there. */}
        <div className="max-sm:sticky max-sm:bottom-[calc(3rem+env(safe-area-inset-bottom))] max-sm:z-10 max-sm:rounded-xl max-sm:border max-sm:border-stone-200 max-sm:bg-white max-sm:p-3 max-sm:shadow-menu dark:max-sm:border-white/10 dark:max-sm:bg-stone-900">
          <SubmitButton
            className="btn-primary w-full py-3"
            pendingLabel="Starting…"
            disabled={!consent}
          >
            {buttonLabel}
          </SubmitButton>
        </div>
      </form>
      {/* Cal. Bus. & Prof. Code 17538: legal name, address, and a route to the
          refund policy, shown on the same screen as the checkout button
          before any charge happens. */}
      <BillingLegalLine className="text-center text-xs text-stone-500 max-sm:text-sm dark:text-stone-400" />
    </div>
  );
}
