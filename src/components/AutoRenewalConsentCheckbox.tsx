"use client";

import { AUTO_RENEWAL_CHECKBOX_LABEL } from "@/lib/billingTerms";

// The required auto-renewal consent checkbox (Cal. Bus. & Prof. Code
// 17602(a)(2), as amended by AB 2863, effective July 1, 2025): unchecked by
// default, sitting directly under the disclosure block it confirms, on every
// subscription checkout screen: homeowner Plus
// (src/app/(app)/plus/PlanToggle.tsx), OakTend Pro
// (src/app/pro/plus/ProPlanToggle.tsx), and the Pro trial takeover
// (src/components/pro/ProTrialNudge.tsx). One component so the label, the
// posted field name, and the hint text can never drift between the three.
//
// Posts `name="consent_checkbox" value="true"` only while checked (an
// unchecked checkbox posts nothing at all), which is exactly what
// startPlusCheckoutAction / startProCheckoutAction require in the form body
// before they will create a Stripe Checkout session - see the consent guard
// in each. `required` is a native fallback for a no-JS submit; the checkout
// button's own `disabled` state, driven by the same `checked` value in the
// parent, is what actually stops the submit before it starts.
//
// Same checkbox styling as the 18+/Terms attestation on the two signup pages
// (src/app/homeowner-signup/page.tsx, src/app/contractor-signup/page.tsx):
// no custom accent color, so it reads the same on a bark-accented homeowner
// page and an oaktend-accented Pro one, and a 24px box on a phone so the one
// control gating checkout is never a fingertip miss.
export default function AutoRenewalConsentCheckbox({
  id,
  checked,
  onChange,
}: {
  // Unique per rendered instance - the mobile/desktop pair of the same form,
  // or two separate checkout forms on one page - so the <label htmlFor>
  // pairing is never ambiguous and no two checkboxes share an id.
  id: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div>
      <label
        htmlFor={id}
        className="flex items-start gap-2 text-xs text-stone-600 max-sm:min-h-11 max-sm:py-1 max-sm:text-sm dark:text-stone-300"
      >
        <input
          id={id}
          type="checkbox"
          name="consent_checkbox"
          value="true"
          required
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          className="mt-0.5 max-sm:h-6 max-sm:w-6 max-sm:shrink-0"
        />
        <span>{AUTO_RENEWAL_CHECKBOX_LABEL}</span>
      </label>
      {/* Always present while unchecked, not only after a failed submit
          attempt: the checkout button is genuinely disabled until this is
          checked, so a reader who reaches for it needs to already know why. */}
      {!checked && (
        <p
          role="alert"
          className="mt-1 text-xs text-red-600 max-sm:text-sm dark:text-red-400"
        >
          Check the box above to continue.
        </p>
      )}
    </div>
  );
}
