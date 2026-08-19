import { describe, expect, it } from "vitest";
import { subscriptionCheckoutData } from "@/lib/checkoutSubscriptionData";
import { billingTerms, billingTermsText } from "@/lib/billingTerms";
import { PLUS_PLAN, PRO_PLAN } from "@/lib/constants";

// What startProCheckoutAction and startPlusCheckoutAction each pass in. Kept
// here as small helpers so a test reads as "a brand-new pro's checkout" rather
// than as an options bag, and so the two call sites can't quietly drift into
// meaning different things.
const proCheckout = (trialEligible: boolean) =>
  subscriptionCheckoutData({
    trialDays: trialEligible ? PRO_PLAN.trialDays : null,
    introStepUp: trialEligible,
  });

const plusCheckout = (trialEligible: boolean) =>
  subscriptionCheckoutData({
    trialDays: trialEligible ? PLUS_PLAN.trialDays : null,
    introStepUp: trialEligible,
  });

describe("subscriptionCheckoutData", () => {
  it("puts a 3-day trial on a brand-new Pro checkout, on either cadence", () => {
    // The cadence never reaches this builder: monthly and yearly Pro carry the
    // same trial, so one assertion covers both by construction.
    expect(PRO_PLAN.trialDays).toBe(3);
    expect(proCheckout(true).trial_period_days).toBe(3);
  });

  it("omits the trial key entirely for a returning Pro subscriber", () => {
    const data = proCheckout(false);
    // Omitted, not set to 0 or undefined: Stripe rejects a 0, and an explicit
    // undefined would still serialize into the request.
    expect("trial_period_days" in data).toBe(false);
  });

  it("keeps the Pro trial length independent of the Plus one", () => {
    // Same length today, different constants on purpose: changing the Pro
    // trial must never move the homeowner Plus trial, or vice versa.
    expect(plusCheckout(true).trial_period_days).toBe(PLUS_PLAN.trialDays);
    expect(proCheckout(true).trial_period_days).toBe(PRO_PLAN.trialDays);
  });

  it("stamps the step-up flag so the renewal cron can read it", () => {
    expect(proCheckout(true).metadata.intro_step_up).toBe("true");
    expect(proCheckout(false).metadata.intro_step_up).toBe("false");
  });

  it("never emits a zero or negative trial", () => {
    expect("trial_period_days" in subscriptionCheckoutData({ trialDays: 0, introStepUp: false })).toBe(false);
    expect("trial_period_days" in subscriptionCheckoutData({ trialDays: -1, introStepUp: false })).toBe(false);
  });
});

describe("billingTerms for Hearth Pro", () => {
  it("leads with the free trial and charges nothing today", () => {
    const terms = billingTerms("pro_monthly", true);
    expect(terms.product).toBe("Hearth Pro");
    expect(terms.chargedToday).toContain("Nothing today");
    expect(terms.stepUp).toContain(`Free for ${PRO_PLAN.trialDays} days`);
    expect(terms.recurring).toContain(`$${PRO_PLAN.monthly.toFixed(2)}`);
    expect(terms.recurring).toContain("until you cancel");
    // The one sentence the trial exists to make true.
    expect(terms.cancel).toContain("you will not be charged anything");
    expect(terms.cancelPath).toBe("/pro/plus");
  });

  it("quotes the yearly price against the same trial", () => {
    const terms = billingTerms("pro_yearly", true);
    expect(terms.chargedToday).toContain("Nothing today");
    expect(terms.recurring).toContain(`$${PRO_PLAN.yearly.toFixed(2)}`);
    expect(terms.recurring).toContain("every 12 months");
  });

  it("promises no trial to a returning member", () => {
    const terms = billingTerms("pro_monthly", false);
    expect(terms.stepUp).toBeNull();
    expect(terms.chargedToday).toBe(`$${PRO_PLAN.monthly.toFixed(2)} today.`);
    expect(terms.cancel).not.toContain("trial");
  });

  it("never quotes the retired intro month", () => {
    // The intro coupon cannot coexist with a Stripe trial (it would be burned
    // on the $0 invoice a trial start finalizes), so no disclosure surface may
    // still be promising that price.
    for (const eligible of [true, false]) {
      const text = billingTermsText("pro_monthly", eligible);
      expect(text).not.toContain(`$${PRO_PLAN.introFirstMonth.toFixed(2)}`);
    }
  });

  it("leaves the homeowner Plus disclosure alone", () => {
    const terms = billingTerms("monthly", true);
    expect(terms.product).toBe("Hearth Plus");
    expect(terms.chargedToday).toContain(
      `Your first ${PLUS_PLAN.trialDays} days are free`
    );
    expect(terms.recurring).toContain(`$${PLUS_PLAN.monthly.toFixed(2)} a month`);
  });
});
