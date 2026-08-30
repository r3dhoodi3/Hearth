"use client";

import { useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import { ChevronRight } from "lucide-react";
import { startProCheckoutAction } from "./actions";
import AutoRenewalTerms from "@/components/AutoRenewalTerms";
import InlineSpinner from "@/components/InlineSpinner";
import {
  PRO_PLAN,
  PRO_DEPOSIT_BOOST_PTS,
  COLD_START_FREE_ALERTS,
  formatUsd,
  yearlyAsMonthly,
  yearlyPerDay,
  yearlyRunRate,
  yearlySavings,
} from "@/lib/constants";

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

type Plan = "monthly" | "yearly";

// Every figure below is computed from PRO_PLAN. The saving is twelve charges
// at the real monthly price minus the yearly price (never an invented list
// price), and the per-day lines are an annual total over 365 days, rounded UP
// to the cent so neither ever quotes less than the plan costs.
const YEARLY_PER_MONTH = formatUsd(yearlyAsMonthly(PRO_PLAN)); // exactly $19.99
const YEARLY_PER_DAY = formatUsd(yearlyPerDay(PRO_PLAN)); // about $0.66
const MONTHLY_YEAR_TOTAL = formatUsd(yearlyRunRate(PRO_PLAN)); // $359.88
const YEARLY_SAVING = formatUsd(yearlySavings(PRO_PLAN)); // $120.00

// What a pro gets without paying a cent. This is a real column, not a foil:
// membership is perks only and never touches lead access, so the free side
// keeps the whole marketplace.
const FREE_INCLUDES = [
  "Every job in your trades and area, same as members",
  "Pay per application, no membership required",
  "A public page with your services, reviews, and contact info",
  "Up to 3 showcase projects",
  ...(COLD_START_FREE_ALERTS
    ? ["Instant job alerts, free for every pro while Hearth is new"]
    : []),
];

const PLAN_COPY: Record<
  Plan,
  { label: string; price: string; unit: string; billed: string }
> = {
  monthly: {
    label: "Monthly",
    price: formatUsd(PRO_PLAN.monthly),
    unit: "/month",
    billed: "billed every month",
  },
  yearly: {
    label: "Yearly",
    price: formatUsd(PRO_PLAN.yearly),
    unit: "/year",
    billed: "billed once every 12 months",
  },
};

// Three real reference points in one row: Free, Yearly, Monthly. Nothing here
// is invented - Free is what every non-member already has, and Monthly is the
// full price the yearly plan is measured against. Yearly sits in the middle as
// the hero and is preselected.
//
// Both cadences start on the same free trial, so the trial stays the headline
// on the checkout block below and the price is what it steps up to. Charged
// amounts live in the checkout action; PRO_PLAN keeps display and billing in
// sync.
//
// `trialEligible` mirrors the exact signal startProCheckoutAction uses to grant
// the trial (no existing Pro-side subscription row), so a returning member who
// churned and came back is never shown trial copy for a trial they will not
// get. It applies the same way to both cadences.
//
// PHONE DISCLOSURE: TWO COPIES OF AutoRenewalTerms, ONE PER BREAKPOINT.
// (The full reasoning lives here rather than beside each block: a long comment
// wedged between the disclosure and the button it belongs to is exactly what
// the autoRenewalPlacement test refuses, and rightly - the two must stay
// within a screenful of each other in the source as well as on the page.)
// Every checkout form here starts a Stripe checkout, so the recurring terms
// must be on screen next to its button before any billing information is
// collected (ROSCA 15 U.S.C. 8403(1)) and in visual proximity to the request
// for consent (Cal. Bus. and Prof. Code 17602(a)(1)).
// Same treatment the homeowner PlanToggle got: each checkout form renders the
// block twice, once inside a `sm:hidden` <details> that starts CLOSED and once
// inside a `max-sm:hidden` div that renders exactly as it always did. On a
// 390px screen the full block ran about a third of a screen and pushed the
// button it belongs to below the fold.
//
// What is collapsed is the ITEMIZED version, never the material terms. The
// one-line summary (PLAN_BILLING below, and the trial recap on the top form)
// stays on screen unconditionally, directly beside the button, which is what
// ROSCA 15 U.S.C. 8403(1) and Cal. Bus. & Prof. Code 17602(a)(1) are about:
// material terms disclosed before billing information is collected, in visual
// proximity to the request for consent. One tap opens the rest, and it is
// inside the same form as the button either way.
//
// Two elements rather than one because `open` is a boolean attribute no media
// query can drive, and flipping it from JS on mount would either flash or
// mismatch hydration.
//
// THE STORED CONSENT RECORD IS UNAFFECTED. The billing-terms text in the
// Stripe metadata is built SERVER-SIDE by startProCheckoutAction from
// src/lib/billingTerms.ts, off the posted cadence, never from what this
// component rendered.
//
// PHONE TEXT SIZES. Every 10px and 11px line below carries a `max-sm:`
// override up to 12px or 14px. Desktop keeps the original class, so sm and up
// renders byte-identical to before.

// One plain sentence per cadence: what is charged, when, and how to stop it.
// Every number read from PRO_PLAN / formatUsd / yearlySavings above rather
// than typed. This is the line that stays visible on a phone while the
// itemized block folds away.
function planBilling(plan: Plan, trialEligible: boolean): string {
  if (plan === "monthly") {
    return trialEligible
      ? `${PRO_PLAN.trialDays} days free, then ${PLAN_COPY.monthly.price} a month. Cancel before the trial ends and you pay nothing.`
      : `${PLAN_COPY.monthly.price} a month, cancel anytime.`;
  }
  return trialEligible
    ? `${PRO_PLAN.trialDays} days free, then ${PLAN_COPY.yearly.price} for the year. Cancel before the trial ends and you pay nothing.`
    : `One payment of ${PLAN_COPY.yearly.price} a year, that is ${YEARLY_SAVING} less than paying monthly.`;
}

export default function ProPlanToggle({
  trialEligible = true,
}: {
  trialEligible?: boolean;
}) {
  const [plan, setPlan] = useState<Plan>("yearly");
  const copy = PLAN_COPY[plan];
  // Arrow-key order for the radio group below. Visual order differs by
  // breakpoint (the yearly hero comes first on a phone), so the keyboard walks
  // the plans in cadence order and stays predictable at every width.
  const ORDER: Plan[] = ["yearly", "monthly"];
  const cardRefs = useRef<Record<Plan, HTMLButtonElement | null>>({
    yearly: null,
    monthly: null,
  });

  // Roving tabindex: one tab stop for the whole group, arrows move the
  // selection the way a native radio group does. Space and Enter are already
  // handled by the underlying <button>, which fires onClick and selects.
  function onGroupKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    const forward = e.key === "ArrowRight" || e.key === "ArrowDown";
    const back = e.key === "ArrowLeft" || e.key === "ArrowUp";
    if (!forward && !back) return;
    e.preventDefault();
    const at = ORDER.indexOf(plan);
    const next =
      (at + (forward ? 1 : ORDER.length - 1) + ORDER.length) % ORDER.length;
    setPlan(ORDER[next]);
    cardRefs.current[ORDER[next]]?.focus();
  }

  // Radio semantics written once, so the two cards cannot drift apart.
  const radioProps = (key: Plan, label: string) => ({
    type: "button" as const,
    role: "radio",
    "aria-checked": plan === key,
    "aria-label": label,
    tabIndex: plan === key ? 0 : -1,
    ref: (el: HTMLButtonElement | null) => {
      cardRefs.current[key] = el;
    },
    onClick: () => setPlan(key),
  });

  // Shared shell for the two selectable columns. The hero keeps its elevated
  // look whether or not it is the current selection; the ring tracks selection,
  // so "recommended" and "chosen" read as separate facts.
  const columnClass = (key: Plan) =>
    [
      "flex h-full flex-col rounded-xl border p-4 text-left transition-colors",
      plan === key
        ? "border-hearth-600 ring-2 ring-hearth-600 ring-offset-1 ring-offset-hearth-50 dark:ring-offset-stone-900"
        : "border-stone-200 hover:border-stone-300 dark:border-white/10 dark:hover:border-white/20",
      key === "yearly"
        ? "bg-hearth-50 shadow-lift dark:bg-hearth-900/30"
        : "bg-white dark:bg-stone-800",
    ].join(" ");

  return (
    <div id="pricing" className="space-y-4">
      {/* The trial, offered once, at the top, as its own one-tap checkout. It
          posts plan=monthly: both Pro cadences trial, so the tap that only
          wants "free days" gets the smaller commitment behind it, and the
          cards below still let a pro pick yearly. The terms directly under the
          button are the terms of the plan this button actually buys. Only
          rendered when the trial is real, so a returning member never sees
          free days they will not get. */}
      {trialEligible && (
        <form action={startProCheckoutAction} className="card-hero space-y-2">
          <input type="hidden" name="plan" value="monthly" />
          <CheckoutButton label={`Start ${PRO_PLAN.trialDays} free days`} />
          <p className="text-center text-sm text-stone-600 dark:text-stone-300">
            {PRO_PLAN.trialDays} days free, then {PLAN_COPY.monthly.price}
            /month. Cancel anytime before the trial ends.
          </p>
          {/* Hard-coded to pro_monthly because the hidden field above is.
              Phone copy collapsed, desktop copy open, recap line above never
              folds: see PHONE DISCLOSURE at the top of this file. */}
          <details className="group sm:hidden">
            <summary className="focus-ring flex min-h-11 w-fit cursor-pointer list-none items-center gap-1.5 text-sm font-medium text-stone-700 [&::-webkit-details-marker]:hidden dark:text-stone-300">
              <ChevronRight
                className="h-4 w-4 shrink-0 text-stone-400 transition-transform duration-150 group-open:rotate-90 dark:text-stone-500"
                aria-hidden="true"
              />
              Billing terms
            </summary>
            <div className="mt-2">
              <AutoRenewalTerms plan="pro_monthly" introEligible={trialEligible} />
            </div>
          </details>
          <div className="max-sm:hidden">
            <AutoRenewalTerms plan="pro_monthly" introEligible={trialEligible} />
          </div>
        </form>
      )}

      {/* One row, three columns from sm up. On a phone they stack with the
          yearly hero first (order-1), then Free, then Monthly. The two paid
          columns ARE the selector (role=radio), so there is one primary button
          for the whole page, in the checkout block below. */}
      <div
        role="radiogroup"
        aria-label="Choose your membership"
        onKeyDown={onGroupKeyDown}
        className="grid items-stretch gap-3 sm:grid-cols-3"
      >
        {/* --- Free: a real column --- */}
        <div className="order-2 flex h-full flex-col rounded-xl border border-stone-200 bg-white p-4 text-left sm:order-1 dark:border-white/10 dark:bg-stone-800">
          <p className="text-sm font-medium text-stone-700 dark:text-stone-300">
            No membership
          </p>
          <p className="mt-0.5 text-2xl font-semibold text-stone-900 dark:text-stone-100">
            $0
          </p>
          {/* 11px is under the readable floor on a phone; 14px below sm, the
              original class from sm up so desktop is untouched. Same rule on
              every 10/11px line in this file. */}
          <p className="mt-0.5 text-[11px] text-stone-500 max-sm:text-sm dark:text-stone-400">
            Yours forever, no card.
          </p>
          <ul className="mt-3 space-y-1.5">
            {FREE_INCLUDES.map((f) => (
              <li
                key={f}
                className="flex items-start gap-1.5 text-xs text-stone-600 max-sm:text-sm dark:text-stone-300"
              >
                <span className="mt-px font-bold text-green-600" aria-hidden>
                  ✓
                </span>
                <span>{f}</span>
              </li>
            ))}
          </ul>
          <p className="mt-auto pt-3 text-[11px] text-stone-500 max-sm:text-sm dark:text-stone-400">
            No monthly lead credit, no +{PRO_DEPOSIT_BOOST_PTS}% deposit match,
            no AI back office, no win-rate analytics, and a plain public page.
          </p>
        </div>

        {/* --- Yearly: the hero, preselected --- */}
        <button
          {...radioProps(
            "yearly",
            `Yearly, ${PLAN_COPY.yearly.price} a year, best value`
          )}
          className={`relative order-1 sm:order-2 ${columnClass("yearly")}`}
        >
          <span className="absolute -top-2.5 left-4 whitespace-nowrap rounded-full bg-hearth-600 px-2 py-0.5 text-[10px] font-medium text-white max-sm:text-xs">
            Best value
          </span>
          <span className="text-sm font-medium text-stone-700 dark:text-stone-300">
            {PLAN_COPY.yearly.label}
          </span>
          <span className="mt-0.5 block text-2xl font-semibold text-stone-900 dark:text-stone-100">
            {PLAN_COPY.yearly.price}
            <span className="text-xs font-normal text-stone-500 max-sm:text-sm dark:text-stone-400">
              {PLAN_COPY.yearly.unit}
            </span>
          </span>
          {/* Honest arithmetic, not a discount claim: the yearly price divided
              by 365, rounded up to the cent. */}
          <span className="mt-0.5 block text-[11px] text-stone-500 max-sm:text-sm dark:text-stone-400">
            About {YEARLY_PER_DAY} a day
          </span>
          <span className="mt-2 block text-xs font-medium text-hearth-700 max-sm:text-sm dark:text-hearth-300">
            Save {YEARLY_SAVING} vs monthly
          </span>
          <span className="mt-0.5 block text-[11px] text-stone-500 max-sm:text-sm dark:text-stone-400">
            {YEARLY_PER_MONTH} a month, billed once a year.
          </span>
          <span className="mt-auto pt-3 text-[11px] text-stone-500 max-sm:text-sm dark:text-stone-400">
            {/* Mirrors grant_membership_credit in the Stripe webhook: the
                yearly plan's $120 of bonus lead credit lands in one grant with
                a 400-day expiry, so it outlives the year. */}
            Every perk, and the whole $120 of lead credit lands up front,
            spendable across your entire year.
          </span>
        </button>

        {/* --- Monthly: the full-price reference --- */}
        <button
          {...radioProps(
            "monthly",
            `Monthly, ${PLAN_COPY.monthly.price} a month`
          )}
          className={`order-3 ${columnClass("monthly")}`}
        >
          <span className="text-sm font-medium text-stone-700 dark:text-stone-300">
            {PLAN_COPY.monthly.label}
          </span>
          <span className="mt-0.5 block text-2xl font-semibold text-stone-900 dark:text-stone-100">
            {PLAN_COPY.monthly.price}
            <span className="text-xs font-normal text-stone-500 max-sm:text-sm dark:text-stone-400">
              {PLAN_COPY.monthly.unit}
            </span>
          </span>
          <span className="mt-0.5 block text-[11px] text-stone-500 max-sm:text-sm dark:text-stone-400">
            = {MONTHLY_YEAR_TOTAL} a year
          </span>
          <span className="mt-2 block text-xs text-stone-600 max-sm:text-sm dark:text-stone-300">
            The same perks, month to month. $10 of lead credit each cycle,
            good for 60 days.
          </span>
          {/* The page's one loss-framed line, and the loss is real today: the
              actual delta between the two plans on offer, not urgency or
              scarcity. */}
          <span className="mt-auto pt-3 text-[11px] text-stone-500 max-sm:text-sm dark:text-stone-400">
            Monthly pays {YEARLY_SAVING} more for the same year.
          </span>
        </button>
      </div>

      {/* The trial IS the headline, and the price recap directly under it is
          the only other line here - AutoRenewalTerms below already carries
          every fact (what's charged today, what it becomes, how to cancel),
          so this block used to restate the same terms in prose twice more
          (once above the form, once again after the button), which was pure
          duplication padding out the page. One recap line, one disclosure,
          one button. */}
      <div className="card-hero space-y-4 text-center">
        <div className="space-y-0.5">
          {trialEligible && (
            <p className="text-sm font-medium text-hearth-700 dark:text-hearth-300">
              Free for {PRO_PLAN.trialDays} days
            </p>
          )}
          <p className="text-2xl font-semibold text-stone-900 dark:text-stone-100">
            {copy.price}
            <span className="text-sm font-normal text-stone-500 dark:text-stone-400">
              {copy.unit}
            </span>
          </p>
        </div>

        {/* The recurring terms sit INSIDE the checkout form, immediately above
            the button that starts the charge, so the disclosure and the act of
            consent are in visual proximity (see AutoRenewalTerms). Both cadences
            carry the same trial, so introEligible mirrors trialEligible directly
            instead of being plan-specific. The hidden field carries the selected
            cadence; startProCheckoutAction defaults to yearly, the same plan
            preselected above, so the two can never disagree. This is the ONE
            checkout button on the page below the top trial shortcut - its label
            and its AutoRenewalTerms both follow whichever cadence card is
            selected, so they can never say two different things. */}
        <form action={startProCheckoutAction} className="space-y-3">
          <input type="hidden" name="plan" value={plan} />
          {/* The one-line material-terms summary, always visible on a phone:
              what is charged, when, and how to stop it, for the SELECTED
              cadence. sm and up already reads it as the first line of the
              block itself, so this copy is phone-only. */}
          <p className="text-sm text-stone-600 sm:hidden dark:text-stone-300">
            {planBilling(plan, trialEligible)}
          </p>
          {/* Collapsed on a phone, open on desktop. See PHONE DISCLOSURE at
              the top of this file. */}
          <details className="group sm:hidden">
            <summary className="focus-ring mx-auto flex min-h-11 w-fit cursor-pointer list-none items-center gap-1.5 text-sm font-medium text-stone-700 [&::-webkit-details-marker]:hidden dark:text-stone-300">
              <ChevronRight
                className="h-4 w-4 shrink-0 text-stone-400 transition-transform duration-150 group-open:rotate-90 dark:text-stone-500"
                aria-hidden="true"
              />
              Billing terms
            </summary>
            <div className="mt-2">
              <AutoRenewalTerms
                plan={plan === "monthly" ? "pro_monthly" : "pro_yearly"}
                introEligible={trialEligible}
              />
            </div>
          </details>
          <div className="max-sm:hidden">
            <AutoRenewalTerms
              plan={plan === "monthly" ? "pro_monthly" : "pro_yearly"}
              introEligible={trialEligible}
            />
          </div>
          <CheckoutButton
            label={
              trialEligible
                ? `Try Pro free for ${PRO_PLAN.trialDays} days`
                : "Start my Pro membership"
            }
          />
        </form>
      </div>
    </div>
  );
}
