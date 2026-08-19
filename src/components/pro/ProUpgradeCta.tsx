import Link from "next/link";
import { PRO_PLAN } from "@/lib/constants";

// One place for every "join Hearth Pro" call to action, so the same promise is
// made everywhere and no surface can drift out of sync with checkout.
//
// The free trial is for FIRST-TIME members only (see startProCheckoutAction):
// the pro-side subscriptions row survives a cancellation, so a pro who joined
// once and left will not get another trial. Callers pass trialEligible, and
// the only honest source for it is the canonical signal used on /pro/crm:
//
//   const trialEligible = !(await getProSubscription());
//
// Anything that renders trial copy has to be gated on that, so this file never
// promises a free trial to someone Stripe will bill on day one.
//
// Both helpers are plain functions with no server dependencies, so client
// components ("use client") can import them too.

// The button/link text: trial-first for a pro who will really get one, the
// neutral membership line for everyone else.
export function proCtaLabel(trialEligible: boolean): string {
  return trialEligible
    ? `Try Pro free for ${PRO_PLAN.trialDays} days`
    : "See Hearth Pro";
}

// What happens after the trial, in plain numbers. Only ever shown next to the
// trial label, never on its own.
export function proTrialSubline(): string {
  return `Then $${PRO_PLAN.monthly.toFixed(2)}/month. Cancel anytime.`;
}

// The standard button plus its price subline. Surfaces that need the CTA
// inside a sentence use proCtaLabel directly instead.
export default function ProUpgradeCta({
  trialEligible,
  className = "btn-primary inline-block",
  sublineClassName = "mt-2 text-xs text-stone-500 dark:text-stone-400",
}: {
  trialEligible: boolean;
  className?: string;
  sublineClassName?: string;
}) {
  return (
    <>
      <Link href="/pro/plus" className={className}>
        {proCtaLabel(trialEligible)}
      </Link>
      {trialEligible && <p className={sublineClassName}>{proTrialSubline()}</p>}
    </>
  );
}
