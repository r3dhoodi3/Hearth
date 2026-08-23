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
  // How to cancel, in the same medium the purchase happened in.
  cancel: string;
  // Where that cancel control lives, for links.
  cancelPath: string;
};

function money(amount: number): string {
  return `$${amount.toFixed(2)}`;
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

    if (introEligible) {
      return {
        product,
        chargedToday: `Nothing today. Your first ${trialDays} days are free.`,
        recurring: `After the ${trialDays}-day free trial, ${perCadence} is automatically charged to the payment method you enter now, and it renews ${recurEvery} until you cancel.`,
        stepUp: `Free for ${trialDays} days. After that it is ${perCadence}, and it renews ${recurEvery} until you cancel.`,
        cancel: `${cancel} If you cancel before the ${trialDays}-day trial ends, you will not be charged anything.`,
        cancelPath,
      };
    }

    return {
      product,
      chargedToday: `${price} today.`,
      recurring: `After that, ${price} is automatically charged to the same payment method ${recurEvery} until you cancel.`,
      stepUp: null,
      cancel,
      cancelPath,
    };
  }

  // Hearth Plus: weekly, monthly, or yearly. Every brand-new subscriber gets
  // the same free trial (a Stripe trial, so nothing is charged until it
  // ends) no matter which cadence they pick - `introEligible` mirrors the
  // exact "no existing Plus subscription" signal startPlusCheckoutAction
  // uses, so a returning subscriber never sees trial copy for a trial they
  // will not get.
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

  if (introEligible) {
    return {
      product,
      chargedToday: `Nothing today. Your first ${trialDays} days are free.`,
      recurring: `After the ${trialDays}-day free trial, ${perCadence} is automatically charged to your payment method, and it renews ${recurEvery} until you cancel.`,
      stepUp: `Free for ${trialDays} days. After that it is ${perCadence}, and it renews ${recurEvery} until you cancel.`,
      cancel: `${cancel} If you cancel before the ${trialDays}-day trial ends, you will not be charged anything.`,
      cancelPath,
    };
  }

  return {
    product,
    chargedToday: `${price} today.`,
    recurring: `After that, ${price} is automatically charged to the same payment method ${recurEvery} until you cancel.`,
    stepUp: null,
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
