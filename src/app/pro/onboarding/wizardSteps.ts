// The step model and validation rules for the pro onboarding wizard.
//
// Kept pure and separate from the form component because the wizard keeps every
// step's inputs mounted inside ONE <form action={saveCompanyAction}> (hidden
// panels still submit, which is what lets the server action, its hidden markers
// and its server-side floors stay exactly as they were). Native `required`
// cannot police that layout - a `required` input inside a `hidden` panel blocks
// the submit with a validation message the browser cannot focus or show - so
// the per-step gate lives here instead, where it is testable on its own.
//
// Server-side floors in ../actions.ts (empty name, zero cities) still stand
// underneath all of this. Nothing here is a security boundary; it is the
// difference between a helpful inline message and a dead submit button.

import { JOB_CATEGORIES } from "@/lib/constants";
import { isAllowedValue } from "@/lib/formFields";
import {
  isAcceptableCustomCategory,
  CUSTOM_CATEGORY_REJECTED,
} from "@/lib/customCategory";

export type ProOnboardingStep = {
  /** Stable key, used for React keys and the sessionStorage shape. */
  id: string;
  /** The heading shown at the top of the panel. */
  title: string;
  /** One plain line under the heading. */
  blurb: string;
};

export const PRO_ONBOARDING_STEPS: readonly ProOnboardingStep[] = [
  {
    id: "business",
    title: "About your business",
    blurb: "The basics a homeowner sees when you apply to their job.",
  },
  {
    id: "area-trades",
    title: "Where and what",
    blurb: "Check every city you cover and every type of work you do.",
  },
  {
    id: "finish",
    title: "Almost done",
    blurb: "Both of these are optional. Skip them if they do not apply.",
  },
];

export const PRO_ONBOARDING_STEP_COUNT = PRO_ONBOARDING_STEPS.length;

/** Everything the gate looks at, read off the live form at click time. */
export type ProOnboardingValues = {
  name: string;
  /** The business owner's own name, migration 0141. */
  ownerName: string;
  phone: string;
  /** Checked launch cities. */
  cities: readonly string[];
  /** Canonical category values plus any typed "Other" service. */
  categories: readonly string[];
};

// A US number, the only shape PhoneInput can produce (it caps input at ten
// digits and formats them as (000) 000-0000).
const PHONE_DIGITS = 10;

/**
 * The message to show for a step, or null when the step is complete.
 * An out-of-range index is treated as complete so a bad stored index can never
 * strand someone on a step that cannot be passed.
 */
export function validateProOnboardingStep(
  index: number,
  values: ProOnboardingValues
): string | null {
  switch (index) {
    case 0: {
      if (!values.name.trim()) return "Enter your company name.";
      // The company name is the business; this is the person a homeowner ends
      // up talking to, and the public profile now shows it, so it is asked for
      // here rather than left to be filled in later or never.
      if (values.ownerName.trim().length < 2) {
        return "Enter the owner's name.";
      }
      const digits = values.phone.replace(/\D/g, "");
      if (digits.length === 0) {
        return "Add a phone number so homeowners can reach you.";
      }
      if (digits.length < PHONE_DIGITS) {
        return "Enter a full 10-digit phone number.";
      }
      return null;
    }
    case 1: {
      if (values.cities.length === 0) return "Pick at least one city you serve.";
      const picked = values.categories.map((c) => c.trim()).filter(Boolean);
      if (picked.length === 0) {
        return "Pick at least one type of work, or describe it under Other.";
      }
      // Mirrors saveCompanyAction's own split (../actions.ts): anything not a
      // canonical checkbox value is the free-text "Other" service, and it has
      // to clear the same moderation gate the server applies before Finish -
      // otherwise a junk "Other" box passes Next here, only to be silently
      // dropped after the final submit, with the pro finding out via a flash
      // on the page it already redirected away from.
      const custom = picked.filter((c) => !isAllowedValue(JOB_CATEGORIES, c));
      if (custom.length > 0 && !custom.some((c) => isAcceptableCustomCategory(c))) {
        return CUSTOM_CATEGORY_REJECTED;
      }
      return null;
    }
    default:
      return null;
  }
}

/**
 * The first step that is not complete, or null when every step is.
 * Used on the final submit so someone who went back and cleared a field lands
 * on the step that needs them rather than on a silent no-op.
 */
export function firstInvalidProOnboardingStep(
  values: ProOnboardingValues
): number | null {
  for (let i = 0; i < PRO_ONBOARDING_STEP_COUNT; i++) {
    if (validateProOnboardingStep(i, values) !== null) return i;
  }
  return null;
}

/**
 * The step a restored session may resume on: never past the first incomplete
 * step, never outside the wizard. Restored values are a tab's own
 * sessionStorage, so this is about a half-typed form, not about trust.
 */
export function resumeProOnboardingStep(
  savedStep: unknown,
  values: ProOnboardingValues
): number {
  const raw =
    typeof savedStep === "number" && Number.isFinite(savedStep)
      ? Math.floor(savedStep)
      : 0;
  const clamped = Math.min(Math.max(raw, 0), PRO_ONBOARDING_STEP_COUNT - 1);
  const firstInvalid = firstInvalidProOnboardingStep(values);
  const furthest =
    firstInvalid === null ? PRO_ONBOARDING_STEP_COUNT - 1 : firstInvalid;
  return Math.min(clamped, furthest);
}
