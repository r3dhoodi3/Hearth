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
// which grants it on any cadence to an eligible account. Pass the plan anyway
// so a test cannot assert a trial the real action would never send to Stripe.
const plusCheckout = (
  plan: "weekly" | "monthly" | "yearly",
  trialEligible: boolean
) => {
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
    expect(plusCheckout("weekly", true).trial_period_days).toBe(
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
  // The fallback is the caller's own preselected card, so the server agrees
  // with what the buyer was looking at. A form field that goes missing must
  // not silently swap the plan out from under a submission.
  it("falls back to yearly by default, which is what the Pro toggle preselects", () => {
    expect(checkoutCadence(null)).toBe("yearly");
    expect(checkoutCadence(undefined)).toBe("yearly");
    expect(checkoutCadence("")).toBe("yearly");
    expect(checkoutCadence("annual")).toBe("yearly");
  });

  // /plus preselects Monthly and passes it, so an unreadable field lands on
  // the anchor plan the buyer was looking at rather than on a cheaper or
  // dearer one. Every cadence trials now, so what this protects is the PRICE.
  it("falls back to monthly for the Plus picker, the cadence its card preselects", () => {
    expect(checkoutCadence(null, "monthly")).toBe("monthly");
    expect(checkoutCadence("", "monthly")).toBe("monthly");
    expect(checkoutCadence("week", "monthly")).toBe("monthly");
    expect(checkoutCadence("Weekly", "monthly")).toBe("monthly");
  });

  it("honors each of the three cadences when explicitly submitted", () => {
    expect(checkoutCadence("weekly")).toBe("weekly");
    expect(checkoutCadence("monthly")).toBe("monthly");
    expect(checkoutCadence("yearly")).toBe("yearly");
    // An explicit value wins over any fallback the caller passed.
    expect(checkoutCadence("weekly", "monthly")).toBe("weekly");
    expect(checkoutCadence("yearly", "monthly")).toBe("yearly");
  });

  it("reads what the plan toggles actually submit", () => {
    // The hidden <input name="plan"> on the toggles carries exactly these
    // strings, and FormData.get returns them as strings.
    const form = new FormData();
    for (const cadence of ["weekly", "monthly", "yearly"] as const) {
      form.set("plan", cadence);
      expect(checkoutCadence(form.get("plan"), "monthly")).toBe(cadence);
    }
    // Nothing set at all: the field never arrived.
    expect(checkoutCadence(new FormData().get("plan"), "monthly")).toBe(
      "monthly"
    );
  });

  it("does not treat a case-variant or padded value as a cadence", () => {
    // Better to fall back to the preselected plan than to guess at intent.
    expect(checkoutCadence("Monthly")).toBe("yearly");
    expect(checkoutCadence(" monthly ")).toBe("yearly");
    expect(checkoutCadence(" weekly ", "monthly")).toBe("monthly");
  });

  it("never hands the Pro side a weekly price", () => {
    // Pro maps this result by treating anything that is not "monthly" as
    // yearly, so a weekly value posted at a Pro form resolves the way any
    // other unrecognized value already did: to the pro yearly plan.
    const proPlanFor = (raw: unknown) =>
      checkoutCadence(raw) === "monthly" ? "pro_monthly" : "pro_yearly";
    expect(proPlanFor("weekly")).toBe("pro_yearly");
    expect(proPlanFor(null)).toBe("pro_yearly");
  });
});

describe("the default cadence flowing into a disclosure", () => {
  // The checkout actions map checkoutCadence's result straight onto a
  // billingTerms plan key. This pins that each FALLBACK path quotes the price
  // its own page preselected, so the auto-renewal disclosure can never promise
  // one cadence's charge on a checkout that bills another.
  const plusPlanFor = (raw: unknown) => checkoutCadence(raw, "monthly");
  const proPlanFor = (raw: unknown) =>
    checkoutCadence(raw) === "monthly" ? "pro_monthly" : "pro_yearly";

  it("quotes the monthly Plus price when nothing was submitted", () => {
    const terms = billingTerms(plusPlanFor(null), true);
    expect(terms.recurring).toContain(`$${PLUS_PLAN.monthly.toFixed(2)}`);
    expect(terms.recurring).toContain("every month");
    expect(terms.recurring).not.toContain(`$${PLUS_PLAN.yearly.toFixed(2)}`);
  });

  it("quotes the yearly Pro price when nothing was submitted", () => {
    const terms = billingTerms(proPlanFor(null), true);
    expect(terms.product).toBe("Hearth Pro");
    expect(terms.recurring).toContain(`$${PRO_PLAN.yearly.toFixed(2)}`);
    expect(terms.recurring).toContain("every 12 months");
  });

  it("still quotes the yearly price when annual was explicitly picked", () => {
    expect(billingTerms(plusPlanFor("yearly"), true).recurring).toContain(
      `$${PLUS_PLAN.yearly.toFixed(2)}`
    );
    expect(billingTerms(proPlanFor("monthly"), true).recurring).toContain(
      `$${PRO_PLAN.monthly.toFixed(2)} a month`
    );
  });

  it("quotes the weekly price and the trial when weekly was picked", () => {
    const terms = billingTerms(plusPlanFor("weekly"), true);
    expect(terms.recurring).toContain(`$${PLUS_PLAN.weekly.toFixed(2)} a week`);
    expect(terms.recurring).toContain("every week");
    expect(plusCheckout("weekly", true).trial_period_days).toBe(
      PLUS_PLAN.trialDays
    );
  });

  it("carries the trial onto the default Plus cadence too", () => {
    // The trial used to belong to weekly alone, so the fallback (monthly) path
    // quoted a charge today. Every cadence trials now, so the fallback quotes
    // the free days AND the monthly price they step up to - and the Stripe
    // session the same value builds carries trial_period_days.
    expect(billingTerms(plusPlanFor(null), true).summary).toBe(
      `Free for ${PLUS_PLAN.trialDays} days. After that it is $${PLUS_PLAN.monthly.toFixed(2)} a month, and it renews every month until you cancel.`
    );
    expect(plusCheckout("monthly", true).trial_period_days).toBe(
      PLUS_PLAN.trialDays
    );
    expect(plusCheckout("yearly", true).trial_period_days).toBe(
      PLUS_PLAN.trialDays
    );
    // A returning subscriber still bills on day one, on every cadence.
    expect(billingTerms(plusPlanFor(null), false).stepUp).toBeNull();
    expect(billingTerms(plusPlanFor(null), false).summary).toBe(
      `$${PLUS_PLAN.monthly.toFixed(2)} today, and it renews every month until you cancel.`
    );
    // Pro is untouched: both its cadences still trial.
    expect(billingTerms(proPlanFor(null), true).stepUp).toContain(
      `Free for ${PRO_PLAN.trialDays} days`
    );
    expect(proCheckout(true).trial_period_days).toBe(PRO_PLAN.trialDays);
  });
});

// The 3 free days come with EVERY Plus cadence for an eligible account, and the
// subscription then renews at the price of the cadence that was picked. Four
// things have to agree on that: the /plus copy, the Stripe trial, the consent
// record written into session metadata, and the acknowledgment sent afterwards.
// They all read trialApplies(), so these tests pin the one predicate plus the
// sentences it decides. It was weekly-only until 2026-08-30, which forced
// anyone who wanted to try the annual plan to buy weekly first and switch.
describe("the Plus trial rides on every cadence", () => {
  it("grants the trial to a brand-new checkout on any of the three", () => {
    for (const plan of ["weekly", "monthly", "yearly"] as const) {
      expect(trialApplies(plan, true)).toBe(true);
      const data = plusCheckout(plan, true);
      expect(data.trial_period_days).toBe(PLUS_PLAN.trialDays);
      // The step-up flag the renewal cron reads: the next charge is higher
      // than this one (nothing), on every cadence.
      expect(data.metadata.intro_step_up).toBe("true");
    }
  });

  it("renews at the picked cadence's own price after the free days", () => {
    // The case the weekly-only rule could not express: free days on annual,
    // then the annual charge on the annual cycle.
    const yearly = billingTerms("yearly", true);
    expect(yearly.summary).toBe(
      `Free for ${PLUS_PLAN.trialDays} days. After that it is $${PLUS_PLAN.yearly.toFixed(2)}, and it renews every 12 months until you cancel.`
    );
    expect(yearly.chargedToday).toContain("Nothing today");
    const monthly = billingTerms("monthly", true);
    expect(monthly.summary).toBe(
      `Free for ${PLUS_PLAN.trialDays} days. After that it is $${PLUS_PLAN.monthly.toFixed(2)} a month, and it renews every month until you cancel.`
    );
    const weekly = billingTerms("weekly", true);
    expect(weekly.summary).toBe(
      `Free for ${PLUS_PLAN.trialDays} days. After that it is $${PLUS_PLAN.weekly.toFixed(2)} a week, and it renews every week until you cancel.`
    );
  });

  it("never grants it to a returning subscriber on any cadence", () => {
    for (const plan of ["weekly", "monthly", "yearly"] as const) {
      expect(trialApplies(plan, false)).toBe(false);
      const data = plusCheckout(plan, false);
      // Omitted, not zero: Stripe rejects a 0, and the step-up flag the
      // renewal cron reads has to say there is no step-up coming.
      expect("trial_period_days" in data).toBe(false);
      expect(data.metadata.intro_step_up).toBe("false");
    }
  });

  it("charges a returning subscriber today, in one sentence, on every cadence", () => {
    expect(billingTerms("monthly", false).summary).toBe(
      `$${PLUS_PLAN.monthly.toFixed(2)} today, and it renews every month until you cancel.`
    );
    expect(billingTerms("yearly", false).summary).toBe(
      `$${PLUS_PLAN.yearly.toFixed(2)} today, and it renews every 12 months until you cancel.`
    );
    // No trial anywhere in those disclosures, including the cancellation
    // sentence, which gains a trial clause only when a trial exists.
    for (const plan of ["weekly", "monthly", "yearly"] as const) {
      expect(billingTermsText(plan, false)).not.toContain("trial");
      expect(billingTermsText(plan, false)).not.toContain("free");
    }
  });

  it("leaves both Pro cadences trialing", () => {
    expect(trialApplies("pro_monthly", true)).toBe(true);
    expect(trialApplies("pro_yearly", true)).toBe(true);
  });

  it("keeps the consent record the checkout stores in step with the trial", () => {
    // What startPlusCheckoutAction writes into Stripe session metadata, built
    // from the same predicate that decides trial_period_days.
    for (const plan of ["weekly", "monthly", "yearly"] as const) {
      for (const eligible of [true, false]) {
        const trial = trialApplies(plan, eligible);
        const text = billingTermsText(plan, eligible);
        expect(
          text.includes(`first ${PLUS_PLAN.trialDays} days are free`)
        ).toBe(trial);
        expect("trial_period_days" in plusCheckout(plan, eligible)).toBe(trial);
      }
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
    const terms = billingTerms("weekly", true);
    expect(terms.product).toBe("Hearth Plus");
    expect(terms.chargedToday).toContain(
      `Your first ${PLUS_PLAN.trialDays} days are free`
    );
    expect(terms.recurring).toContain(`$${PLUS_PLAN.weekly.toFixed(2)} a week`);
    expect(terms.cancelPath).toBe("/plus");
  });
});
