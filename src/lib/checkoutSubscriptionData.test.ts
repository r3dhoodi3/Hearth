import { describe, expect, it } from "vitest";
import {
  checkoutCadence,
  subscriptionCheckoutData,
} from "@/lib/checkoutSubscriptionData";
import {
  billingTerms,
  billingTermsText,
  trialApplies,
} from "@/lib/billingTerms";
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

// startPlusCheckoutAction, exactly: the trial is gated through trialApplies,
// which grants it to the monthly plan only. Pass the plan so a test cannot
// assert a trial the real action would never send to Stripe.
const plusCheckout = (plan: "monthly" | "yearly", trialEligible: boolean) => {
  const trial = trialApplies(plan, trialEligible);
  return subscriptionCheckoutData({
    trialDays: trial ? PLUS_PLAN.trialDays : null,
    introStepUp: trial,
  });
};

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
    expect(plusCheckout("monthly", true).trial_period_days).toBe(
      PLUS_PLAN.trialDays
    );
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

describe("checkoutCadence", () => {
  // Both pricing cards preselect the yearly plan, so the server's fallback has
  // to agree with what the buyer was looking at. A form field that goes
  // missing must not silently swap the plan out from under a submission.
  it("defaults to yearly when the form field is missing or unreadable", () => {
    expect(checkoutCadence(null)).toBe("yearly");
    expect(checkoutCadence(undefined)).toBe("yearly");
    expect(checkoutCadence("")).toBe("yearly");
    expect(checkoutCadence("annual")).toBe("yearly");
    expect(checkoutCadence("weekly")).toBe("yearly");
  });

  it("honors an explicit monthly, the only way to opt out", () => {
    expect(checkoutCadence("monthly")).toBe("monthly");
  });

  it("reads what the plan toggles actually submit", () => {
    // The hidden <input name="plan"> on both toggles carries exactly these
    // two strings, and FormData.get returns them as strings.
    const form = new FormData();
    form.set("plan", "yearly");
    expect(checkoutCadence(form.get("plan"))).toBe("yearly");
    form.set("plan", "monthly");
    expect(checkoutCadence(form.get("plan"))).toBe("monthly");
    // Nothing set at all: the field never arrived.
    expect(checkoutCadence(new FormData().get("plan"))).toBe("yearly");
  });

  it("does not treat a case-variant or padded value as monthly", () => {
    // Better to fall back to the preselected plan than to guess at intent.
    expect(checkoutCadence("Monthly")).toBe("yearly");
    expect(checkoutCadence(" monthly ")).toBe("yearly");
  });
});

describe("the default cadence flowing into a disclosure", () => {
  // The checkout actions map checkoutCadence's result straight onto a
  // billingTerms plan key. This pins that the DEFAULT path quotes the yearly
  // price, so the auto-renewal disclosure can never promise a monthly charge
  // on a checkout that bills a year.
  const plusPlanFor = (raw: unknown) => checkoutCadence(raw);
  const proPlanFor = (raw: unknown) =>
    checkoutCadence(raw) === "monthly" ? "pro_monthly" : "pro_yearly";

  it("quotes the yearly Plus price when nothing was submitted", () => {
    const terms = billingTerms(plusPlanFor(null), true);
    expect(terms.recurring).toContain(`$${PLUS_PLAN.yearly.toFixed(2)}`);
    expect(terms.recurring).toContain("every 12 months");
    expect(terms.recurring).not.toContain(`$${PLUS_PLAN.monthly.toFixed(2)}`);
  });

  it("quotes the yearly Pro price when nothing was submitted", () => {
    const terms = billingTerms(proPlanFor(null), true);
    expect(terms.product).toBe("Hearth Pro");
    expect(terms.recurring).toContain(`$${PRO_PLAN.yearly.toFixed(2)}`);
    expect(terms.recurring).toContain("every 12 months");
  });

  it("still quotes the monthly price when monthly was explicitly picked", () => {
    expect(billingTerms(plusPlanFor("monthly"), true).recurring).toContain(
      `$${PLUS_PLAN.monthly.toFixed(2)} a month`
    );
    expect(billingTerms(proPlanFor("monthly"), true).recurring).toContain(
      `$${PRO_PLAN.monthly.toFixed(2)} a month`
    );
  });

  it("promises no trial on the default Plus cadence, which bills today", () => {
    // The Plus trial belongs to the monthly plan only, so the default (yearly)
    // path must never quote it - not in the copy, and not in the Stripe
    // session the same value builds.
    expect(billingTerms(plusPlanFor(null), true).stepUp).toBeNull();
    expect(billingTerms(plusPlanFor(null), true).summary).toBe(
      `$${PLUS_PLAN.yearly.toFixed(2)} today, and it renews every 12 months until you cancel.`
    );
    expect("trial_period_days" in plusCheckout("yearly", true)).toBe(false);
    // Pro is untouched: both its cadences still trial.
    expect(billingTerms(proPlanFor(null), true).stepUp).toContain(
      `Free for ${PRO_PLAN.trialDays} days`
    );
    expect(proCheckout(true).trial_period_days).toBe(PRO_PLAN.trialDays);
  });
});

// The 3 free days are part of the MONTHLY plan and nothing else. Four things
// have to agree on that: the /plus copy, the Stripe trial, the consent record
// written into session metadata, and the acknowledgment sent afterwards. They
// all read trialApplies(), so these tests pin the one predicate plus the
// sentences it decides.
describe("the Plus trial is monthly-only", () => {
  it("grants the trial to a brand-new monthly checkout", () => {
    expect(trialApplies("monthly", true)).toBe(true);
    expect(plusCheckout("monthly", true).trial_period_days).toBe(
      PLUS_PLAN.trialDays
    );
    expect(plusCheckout("monthly", true).metadata.intro_step_up).toBe("true");
  });

  it("never grants it on yearly, however eligible the buyer is", () => {
    expect(trialApplies("yearly", true)).toBe(false);
    const data = plusCheckout("yearly", true);
    // Omitted, not zero: Stripe rejects a 0, and the step-up flag the renewal
    // cron reads has to say there is no step-up coming.
    expect("trial_period_days" in data).toBe(false);
    expect(data.metadata.intro_step_up).toBe("false");
  });

  it("never grants it to a returning subscriber on either cadence", () => {
    expect(trialApplies("monthly", false)).toBe(false);
    expect(trialApplies("yearly", false)).toBe(false);
  });

  it("leaves both Pro cadences trialing", () => {
    expect(trialApplies("pro_monthly", true)).toBe(true);
    expect(trialApplies("pro_yearly", true)).toBe(true);
  });

  it("says the monthly step-up in one sentence", () => {
    const terms = billingTerms("monthly", true);
    expect(terms.summary).toBe(
      `Free for ${PLUS_PLAN.trialDays} days. After that it is $${PLUS_PLAN.monthly.toFixed(2)} a month, and it renews every month until you cancel.`
    );
    expect(terms.chargedToday).toContain("Nothing today");
  });

  it("says the yearly charge lands today, in one sentence", () => {
    const terms = billingTerms("yearly", true);
    expect(terms.summary).toBe(
      `$${PLUS_PLAN.yearly.toFixed(2)} today, and it renews every 12 months until you cancel.`
    );
    expect(terms.chargedToday).toBe(`$${PLUS_PLAN.yearly.toFixed(2)} today.`);
    // No trial anywhere in the yearly disclosure, including the cancellation
    // sentence, which gains a trial clause only when a trial exists.
    expect(billingTermsText("yearly", true)).not.toContain("trial");
    expect(billingTermsText("yearly", true)).not.toContain("free");
  });

  it("keeps the consent record the checkout stores in step with the trial", () => {
    // What startPlusCheckoutAction writes into Stripe session metadata, built
    // from the same predicate that decides trial_period_days.
    for (const plan of ["monthly", "yearly"] as const) {
      const trial = trialApplies(plan, true);
      const text = billingTermsText(plan, true);
      expect(text.includes(`first ${PLUS_PLAN.trialDays} days are free`)).toBe(
        trial
      );
    }
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
