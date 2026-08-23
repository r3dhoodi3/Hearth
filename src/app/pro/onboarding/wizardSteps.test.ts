import { describe, expect, it } from "vitest";
import {
  PRO_ONBOARDING_STEPS,
  PRO_ONBOARDING_STEP_COUNT,
  firstInvalidProOnboardingStep,
  resumeProOnboardingStep,
  validateProOnboardingStep,
  type ProOnboardingValues,
} from "./wizardSteps";

const complete: ProOnboardingValues = {
  name: "Acme Home Services",
  phone: "(555) 123-4567",
  cities: ["Huntington Beach"],
  categories: ["plumbing"],
};

function values(overrides: Partial<ProOnboardingValues>): ProOnboardingValues {
  return { ...complete, ...overrides };
}

// The wizard keeps every panel mounted and hidden so one form still posts every
// field, which means native `required` cannot be the gate (see wizardSteps.ts).
// This is that gate.
describe("validateProOnboardingStep", () => {
  it("passes every step for a fully filled form", () => {
    for (let i = 0; i < PRO_ONBOARDING_STEP_COUNT; i++) {
      expect(validateProOnboardingStep(i, complete)).toBeNull();
    }
  });

  it("has three steps with the titles the wizard shows", () => {
    expect(PRO_ONBOARDING_STEPS.map((s) => s.title)).toEqual([
      "About your business",
      "Where and what",
      "Almost done",
    ]);
  });

  it("blocks step 1 on a blank or whitespace-only company name", () => {
    expect(validateProOnboardingStep(0, values({ name: "" }))).toMatch(/company name/i);
    expect(validateProOnboardingStep(0, values({ name: "   " }))).toMatch(/company name/i);
  });

  it("blocks step 1 on a missing or partial phone number", () => {
    expect(validateProOnboardingStep(0, values({ phone: "" }))).toMatch(/phone/i);
    expect(validateProOnboardingStep(0, values({ phone: "(555) 12" }))).toMatch(/10-digit/i);
  });

  it("accepts a phone number in any punctuation as long as it has ten digits", () => {
    expect(validateProOnboardingStep(0, values({ phone: "5551234567" }))).toBeNull();
    expect(validateProOnboardingStep(0, values({ phone: "555-123-4567" }))).toBeNull();
  });

  it("blocks step 2 until a launch city is checked", () => {
    expect(validateProOnboardingStep(1, values({ cities: [] }))).toMatch(/city/i);
    expect(validateProOnboardingStep(1, values({ cities: ["Santa Ana"] }))).toBeNull();
  });

  it("blocks step 2 until a category or an Other service is picked", () => {
    expect(validateProOnboardingStep(1, values({ categories: [] }))).toMatch(/work/i);
    // A blank "Other" box posts nothing, but an all-whitespace one must not count.
    expect(validateProOnboardingStep(1, values({ categories: ["  "] }))).toMatch(/work/i);
    expect(
      validateProOnboardingStep(1, values({ categories: ["Koi pond upkeep"] }))
    ).toBeNull();
  });

  it("checks the city gap before the category gap on step 2", () => {
    expect(
      validateProOnboardingStep(1, values({ cities: [], categories: [] }))
    ).toMatch(/city/i);
  });

  it("never blocks the last step, since both of its fields are optional", () => {
    expect(validateProOnboardingStep(2, values({ name: "", cities: [] }))).toBeNull();
  });

  it("treats an out-of-range index as complete", () => {
    expect(validateProOnboardingStep(-1, values({ name: "" }))).toBeNull();
    expect(validateProOnboardingStep(99, values({ name: "" }))).toBeNull();
  });
});

describe("firstInvalidProOnboardingStep", () => {
  it("returns null when the whole form is ready to submit", () => {
    expect(firstInvalidProOnboardingStep(complete)).toBeNull();
  });

  it("reports the earliest gap, not the last one", () => {
    expect(
      firstInvalidProOnboardingStep(values({ name: "", categories: [] }))
    ).toBe(0);
    expect(firstInvalidProOnboardingStep(values({ categories: [] }))).toBe(1);
  });
});

describe("resumeProOnboardingStep", () => {
  it("restores the saved step when the saved values support it", () => {
    expect(resumeProOnboardingStep(2, complete)).toBe(2);
  });

  it("never resumes past the first step that is still incomplete", () => {
    expect(resumeProOnboardingStep(2, values({ cities: [] }))).toBe(1);
  });

  it("clamps a junk or out-of-range saved step", () => {
    expect(resumeProOnboardingStep(-5, complete)).toBe(0);
    expect(resumeProOnboardingStep(42, complete)).toBe(PRO_ONBOARDING_STEP_COUNT - 1);
    expect(resumeProOnboardingStep("2", complete)).toBe(0);
    expect(resumeProOnboardingStep(undefined, complete)).toBe(0);
    expect(resumeProOnboardingStep(Number.NaN, complete)).toBe(0);
  });
});
