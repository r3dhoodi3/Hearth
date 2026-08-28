"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  PartyPopper,
  TrendingUp,
  Search,
  ClipboardList,
  CalendarDays,
  Home,
  Bell,
  type LucideIcon,
} from "lucide-react";
import AutoRenewalTerms from "@/components/AutoRenewalTerms";
import type { PaidPlan } from "@/lib/billingTerms";

type Step = {
  icon: LucideIcon;
  title: string;
  benefit: string;
  href?: string;
  cta?: string;
};

const STEPS: Step[] = [
  {
    icon: PartyPopper,
    title: "You're on Hearth Plus",
    benefit: "Here's everything you just unlocked.",
  },
  {
    icon: TrendingUp,
    title: "Cost forecast",
    benefit:
      "See what will need replacing and how much to set aside each month.",
    href: "/forecast",
    cta: "Try it",
  },
  {
    icon: Search,
    title: "Quote analyzer",
    benefit: "Snap a contractor's quote and check if the price is fair.",
    href: "/quote-check",
    cta: "Try it",
  },
  {
    icon: ClipboardList,
    title: "Home report",
    benefit: "A shareable record of your home for insurance and resale.",
    href: "/home-report",
    cta: "Try it",
  },
  {
    icon: CalendarDays,
    title: "Maintenance plan",
    benefit:
      "A maintenance plan built for your home, a few tasks at a time so it never piles up.",
    href: "/dashboard",
    cta: "Try it",
  },
  {
    icon: Home,
    title: "Up to 5 homes, unlimited jobs",
    benefit:
      "Track every property and post as many jobs as you need, matched first.",
  },
  {
    icon: Bell,
    title: "Every proactive alert",
    benefit:
      "Storms, recalls, and aging systems, before they become emergencies.",
  },
];

// Animated stepped tour shown right after checkout, off the ?welcome=1 flag.
// Client-side so Next/Back/dots can advance instantly with no round trip.
// Each step re-mounts on `key={step}` so the fade/slide-in transition replays.
//
// The tour also carries the post-purchase acknowledgment California requires
// (Bus. & Prof. Code 17602(a)(3)): the renewal terms, the cancellation policy,
// and how to cancel. It sits on the LAST step rather than the first so it is
// the thing still on screen when the celebration ends, and it never competes
// with the confirmation itself.
//
// `plan` is undefined until the Stripe webhook writes the subscription row,
// which races this screen. When that happens the block degrades to the parts
// that are true regardless (how to cancel) and points at the emailed
// acknowledgment, which the webhook sends with the exact billed terms.
export default function PlusWelcome({
  plan,
  introEligible = false,
}: {
  plan?: PaidPlan;
  introEligible?: boolean;
}) {
  const [step, setStep] = useState(0);
  const [visible, setVisible] = useState(false);
  const last = step === STEPS.length - 1;
  const current = STEPS[step];

  // Drive the fade/slide-in transition: drop back to the "entering" position
  // the instant the step changes, then flip to visible a tick later so the
  // motion-safe transition classes actually have something to animate.
  useEffect(() => {
    setVisible(false);
    const id = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(id);
  }, [step]);

  return (
    <div className="mx-auto max-w-lg space-y-6 py-6 text-center">
      {/* min-h keeps the progress dots and Next/Back/Skip row at the same
          vertical spot on every step: each step's title + benefit copy (and
          the optional "Try it" link, present on some steps but not others)
          is a different height, so without a floor here the button row
          would jump up and down as the tour advances. The steps are all
          short, one-sentence blurbs, so this floor never opens a large gap
          on the shorter ones. */}
      <div
        key={step}
        className={`flex min-h-56 flex-col justify-center space-y-4 motion-safe:transition-all motion-safe:duration-300 motion-safe:ease-out ${
          visible
            ? "opacity-100 translate-y-0"
            : "motion-safe:opacity-0 motion-safe:translate-y-2"
        }`}
      >
        <div
          className={`flex justify-center text-bark-600 dark:text-stone-400 ${step === 0 ? "motion-safe:animate-bounce" : ""}`}
        >
          <current.icon className="h-16 w-16" aria-hidden="true" />
        </div>
        <div>
          <h1 className="text-3xl font-semibold text-stone-900 dark:text-stone-100">
            {current.title}
          </h1>
          <p className="mt-2 text-stone-600 dark:text-stone-300">{current.benefit}</p>
        </div>
        {current.href && current.cta && (
          <Link
            href={current.href}
            className="inline-block text-sm text-bark-700 hover:underline dark:text-stone-300"
          >
            {current.cta} →
          </Link>
        )}
      </div>

      <div className="flex items-center justify-center gap-2">
        {STEPS.map((s, i) => (
          <span
            key={s.title}
            className={`h-2 w-2 rounded-full transition-colors ${
              i === step ? "bg-bark-600" : "bg-stone-200 dark:bg-stone-700"
            }`}
          />
        ))}
      </div>

      <div className="flex flex-col items-center gap-3">
        <div className="flex w-full gap-3">
          {step > 0 && (
            <button
              type="button"
              onClick={() => setStep((s) => s - 1)}
              aria-label={`Back to step ${step} of ${STEPS.length}`}
              className="btn-secondary flex-1"
            >
              Back
            </button>
          )}
          {last ? (
            <Link href="/dashboard" className="btn-primary flex-1">
              Go to my dashboard
            </Link>
          ) : (
            <button
              type="button"
              onClick={() => setStep((s) => s + 1)}
              aria-label={`Next, step ${step + 2} of ${STEPS.length}`}
              className="btn-primary flex-1"
            >
              Next
            </button>
          )}
        </div>
        {!last && (
          <Link href="/dashboard" className="text-sm text-stone-500 hover:underline dark:text-stone-400">
            Skip
          </Link>
        )}
      </div>

      {last && (
        <div className="space-y-3">
          {plan ? (
            <AutoRenewalTerms
              plan={plan}
              introEligible={introEligible}
              variant="acknowledgment"
            />
          ) : (
            <div className="rounded-xl border border-stone-200 bg-stone-50 p-3 text-left dark:border-white/10 dark:bg-stone-900">
              <p className="text-xs font-semibold uppercase tracking-wide text-stone-500 dark:text-stone-400">
                Your Hearth Plus renewal terms
              </p>
              <p className="mt-2 text-xs text-stone-600 dark:text-stone-300">
                Hearth Plus renews automatically until you cancel. Your
                confirmation email lists the exact amount and renewal date.
                Cancel anytime from{" "}
                <Link href="/plus" className="underline">
                  your membership page
                </Link>{" "}
                using the &quot;Cancel membership&quot; button. Cancelling takes
                effect at the end of the period you have already paid for, and
                there is nothing to call or email.
              </p>
            </div>
          )}
          <p className="text-xs text-stone-500 dark:text-stone-400">
            If a Plus feature still looks locked, give it a minute to sync, then
            refresh.
          </p>
        </div>
      )}
    </div>
  );
}
