import { PLUS_PLAN, PRO_PLAN } from "@/lib/constants";

// The ONE place the auto-renewal disclosure language lives, for both paid
// memberships. Five surfaces have to say the same thing about a recurring
// charge, and the law cares that they agree:
//
//   1. Pre-checkout, next to the button that starts the charge
//      (src/components/AutoRenewalTerms.tsx, rendered by both plan toggles).
//   2. The consent record stashed in Stripe Checkout session metadata by the
//      two checkout actions, so what the buyer agreed to is retrievable later.
//   3. The post-purchase acknowledgment on the welcome screens.
//   4. The acknowledgment notification the Stripe webhook sends, which is the
//      copy the buyer can actually keep.
//   5. The renewal-reminder cron (src/app/api/cron/renewal-reminders).
//
// Everything here is derived from PLUS_PLAN / PRO_PLAN, so a price edit in
// src/lib/constants.ts moves the disclosure with it and the two can't drift
// into quoting different numbers.
//
// Why this exists at all: an intro price that steps up to a higher recurring
// price is the exact pattern the FTC (ROSCA, 15 U.S.C. 8403) and the
// California Automatic Renewal Law (Bus. & Prof. Code 17600 et seq.) police.
// Both require the recurring terms up front, express consent, a retainable
// acknowledgment describing how to cancel, and a cancellation path at least
// as easy as signing up was.

export type PaidPlan = "weekly" | "monthly" | "yearly" | "pro_monthly" | "pro_yearly";

// Why a plan switch is refused while the free days are still running.
//
// A Stripe subscription schedule is how "switch at renewal" is built, and
// handing a TRIALING subscription to a schedule ends the trial at the moment
// the schedule takes over: live, a weekly member seven minutes into their
// 3 free days tapped "Switch to monthly at renewal" and Stripe drafted a $1.99
// invoice on the spot. Every word around that button ("Nothing changes today",
// the toast, the auto-renewal disclosure they consented to at checkout, which
// promises they pay nothing if they cancel before the trial ends) said the
// opposite - the exact promise ROSCA and California's Automatic Renewal Law
// police. So the switch is not offered, and not accepted, until the free days
// are over. It costs a trialing member a 3-day wait; the alternative charged
// them early against their own consent record.
//
// Lives here rather than in the server action because a "use server" module can
// only export async functions, and /plus renders the same sentence.
export const TRIAL_PLAN_SWITCH_MESSAGE =
  "You can switch plans once your free days end.";

export type BillingTerms = {
  // "Hearth Plus", "Hearth Pro" - the thing being bought.
  product: string;
  // What is charged right now, at checkout.
  chargedToday: string;
  // The recurring commitment: amount, interval, and that it repeats until
  // canceled. This is the sentence the law is really about.
  recurring: string;
  // Present only when the first period costs less than every period after it
  // (free month, intro month). Spells out the step-up in dollars.
  stepUp: string | null;
  // The whole commitment in ONE sentence, always present. It is `stepUp` when
  // this signup carries an intro period, and the "charged today, renews every
  // X until you cancel" sentence when it does not. The pre-checkout block
  // leads with it so the reader gets the material terms in the first line they
  // read, whichever plan they picked.
  summary: string;
  // How to cancel, in the same medium the purchase happened in.
  cancel: string;
  // Where that cancel control lives, for links.
  cancelPath: string;
};

function money(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

// Does THIS checkout actually carry the free trial?
//
// The answer is now the eligibility signal alone, on BOTH memberships and on
// every cadence. The 3 free days used to ride on the Plus weekly plan and
// nothing else, which made the picker lie by omission: somebody who wanted the
// annual plan and wanted to try it first had to buy weekly to get the free
// days, then switch. Free days are a property of the ACCOUNT (one per account,
// enforced by the promo_claims reservation in startPlusCheckoutAction), not of
// a cadence, so an eligible buyer gets them on whichever plan they picked and
// Stripe renews at that plan's price when they end. Pro already worked this
// way; this is the homeowner side catching up.
//
// It lives here, next to the disclosure it governs, because four surfaces have
// to agree on the answer: the copy on /plus, the Stripe trial itself, the
// consent record written into session metadata, and the acknowledgment sent
// afterwards. One exported predicate is the only way they cannot drift.
//
// `plan` is kept in the signature deliberately: every caller already has it,
// and a cadence-specific rule (a longer trial on annual, say) has to land here
// rather than in one of the four surfaces.
export function trialApplies(plan: PaidPlan, introEligible: boolean): boolean {
  return introEligible;
}

// Terms for a specific plan. `introEligible` must mirror the exact signal the
// checkout action uses to grant the intro offer (no existing subscription row
// on that side), so a returning subscriber is never shown step-up copy for a
// discount they will not receive.
export function billingTerms(
  plan: PaidPlan,
  introEligible: boolean
): BillingTerms {
  const pro = plan === "pro_monthly" || plan === "pro_yearly";
  const product = pro ? "Hearth Pro" : "Hearth Plus";
  const cancelPath = pro ? "/pro/plus" : "/plus";
  // Named in plain language rather than as a URL path: this sentence is read
  // aloud in an email and inside a Stripe consent record as often as it is
  // read on screen, and "/plus" is not a place anyone can follow there. The
  // page it names is the one cancelPath links to, so the fact is identical.
  const cancel = `Cancel anytime from your ${product} page using the Cancel membership button. Cancelling takes effect at the end of the period you have already paid for, and there is nothing to call or email.`;

  // Hearth Pro: every brand-new member, on either cadence, starts on the same
  // free trial (a Stripe trial, so the card is collected at checkout but
  // nothing is charged until it ends). `introEligible` mirrors the exact "no
  // existing Pro subscription" signal startProCheckoutAction uses, so a
  // returning member who churned and came back never sees trial copy for a
  // trial they will not get. The old intro-month coupon is retired here: it
  // cannot coexist with a trial (see PRO_PLAN.introFirstMonth), so no branch
  // quotes it anymore.
  if (pro) {
    const yearly = plan === "pro_yearly";
    const price = money(yearly ? PRO_PLAN.yearly : PRO_PLAN.monthly);
    // Yearly bills on a 12-month cycle, not a calendar year, so the recurring
    // disclosure says "every 12 months" rather than "every year".
    const recurEvery = yearly ? "every 12 months" : "every month";
    const perCadence = yearly ? price : `${price} a month`;
    const trialDays = PRO_PLAN.trialDays;

    if (trialApplies(plan, introEligible)) {
      const stepUp = `Free for ${trialDays} days. After that it is ${perCadence}, and it renews ${recurEvery} until you cancel.`;
      return {
        product,
        chargedToday: `Nothing today. Your first ${trialDays} days are free.`,
        recurring: `After the ${trialDays}-day free trial, ${perCadence} is automatically charged to the payment method you enter now, and it renews ${recurEvery} until you cancel.`,
        stepUp,
        summary: stepUp,
        cancel: `${cancel} If you cancel before the ${trialDays}-day trial ends, you will not be charged anything.`,
        cancelPath,
      };
    }

    return {
      product,
      chargedToday: `${price} today.`,
      recurring: `After that, ${price} is automatically charged to the same payment method ${recurEvery} until you cancel.`,
      stepUp: null,
      summary: `${price} today, and it renews ${recurEvery} until you cancel.`,
      cancel,
      cancelPath,
    };
  }

  // Hearth Plus: weekly, monthly, or yearly. Every one of the three carries the
  // same 3 free days for an eligible account (see trialApplies above), and
  // Stripe then renews at the cadence the buyer picked, so the step-up sentence
  // below is built per cadence rather than hard-coded to weekly.
  // `introEligible` mirrors the exact "no existing Plus subscription" signal
  // startPlusCheckoutAction uses, so a returning subscriber never sees trial
  // copy for a trial they will not get either.
  const cadenceNoun =
    plan === "weekly" ? "week" : plan === "yearly" ? "year" : "month";
  // Yearly is billed on a 12-month cycle, not a calendar year, so the
  // recurring disclosure says "every 12 months" rather than "every year" to
  // stay precise about when the charge actually lands.
  const recurEvery = plan === "yearly" ? "every 12 months" : `every ${cadenceNoun}`;
  const price = money(
    plan === "weekly"
      ? PLUS_PLAN.weekly
      : plan === "yearly"
        ? PLUS_PLAN.yearly
        : PLUS_PLAN.monthly
  );
  const trialDays = PLUS_PLAN.trialDays;
  // "$1.99 a week" / "$4.99 a month", but yearly reads better as a bare price
  // since recurEvery already spells out "every 12 months" right after it.
  const perCadence = plan === "yearly" ? price : `${price} a ${cadenceNoun}`;

  if (trialApplies(plan, introEligible)) {
    const stepUp = `Free for ${trialDays} days. After that it is ${perCadence}, and it renews ${recurEvery} until you cancel.`;
    return {
      product,
      chargedToday: `Nothing today. Your first ${trialDays} days are free.`,
      recurring: `After the ${trialDays}-day free trial, ${perCadence} is automatically charged to your payment method, and it renews ${recurEvery} until you cancel.`,
      stepUp,
      summary: stepUp,
      cancel: `${cancel} If you cancel before the ${trialDays}-day trial ends, you will not be charged anything.`,
      cancelPath,
    };
  }

  return {
    product,
    chargedToday: `${price} today.`,
    recurring: `After that, ${price} is automatically charged to the same payment method ${recurEvery} until you cancel.`,
    stepUp: null,
    // Annual reads "$39.99 today, and it renews every 12 months until you
    // cancel." - the whole commitment in one sentence, no trial promised.
    summary: `${price} today, and it renews ${recurEvery} until you cancel.`,
    cancel,
    cancelPath,
  };
}

// The disclosure flattened to one plain-text block. Used where there is no
// markup to work with: the consent record written into Stripe metadata, and
// the acknowledgment notification sent after purchase.
export function billingTermsText(
  plan: PaidPlan,
  introEligible: boolean
): string {
  const t = billingTerms(plan, introEligible);
  return [
    `${t.product} renews automatically.`,
    t.chargedToday,
    t.recurring,
    t.cancel,
  ].join(" ");
}
