"use client";

import { useEffect, useId, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import { useFormStatus } from "react-dom";
import { X } from "lucide-react";
import { startProCheckoutAction } from "@/app/pro/plus/actions";
import AutoRenewalTerms from "@/components/AutoRenewalTerms";
import InlineSpinner from "@/components/InlineSpinner";
import Logo from "@/components/Logo";
import {
  PRO_PLAN,
  formatUsd,
  yearlyAsMonthly,
  yearlyPerDay,
  yearlyRunRate,
  yearlySavings,
} from "@/lib/constants";
import {
  advanceActiveTime,
  claimFloatingPromptSlotForTrial,
  createActiveTimeState,
  getReviewSessionPlan,
  isAnyFloatingPromptClaimedThisSession,
  isEligibleForProTrialPrompt,
  isFirstSession,
  isProTrialExcludedPath,
  noteActivity,
  readSessionActiveMs,
  REVIEW_ACTIVE_MAX_MS,
  REVIEW_RECENT_ACTIVITY_MS,
  REVIEW_TICK_MS,
  setActiveTimeVisibility,
  wasTrialPromptAskedThisSession,
  writeSessionActiveMs,
  type ActiveTimeState,
  type ReviewSessionPlan,
} from "@/lib/reviewPrompt";

// A full-screen "3 Day Free Trial" takeover for Hearth Pro, in the same
// native-app-paywall shape as the App Store's own trial screens: an X to
// close top-left, the wordmark, a big headline, two plan cards (yearly
// preselected, monthly beside it), one primary button, and the legal renewal
// disclosure directly above that button.
//
// WHEN IT APPEARS: the same smart-timing algorithm as "Enjoying Hearth?"
// (src/components/ReviewPrompt.tsx / src/lib/reviewPrompt.ts) - not on the
// browser's first-ever app open, only in a session the same random pool
// picked as an "ask" session, and only once real active use in this tab has
// crossed the same 15 to 20 minute mark the review prompt draws. It reuses
// the review prompt's own helpers for every one of those checks, including
// the SAME sessionStorage-backed clock and the SAME per-account session
// count, so a tab that has already banked minutes (or already rolled its
// dice) toward the review prompt hands this takeover that exact state rather
// than starting a second, competing clock. See the "Pro trial takeover's own
// gate" section at the bottom of src/lib/reviewPrompt.ts.
//
// WHO NEVER SEES IT: an active or trialing Pro member, and any pro whose
// trial is already spent. The page decides that (a pro-side subscriptions row
// outlives a cancellation, so "no row at all" is the only honest signal for
// "will really get a trial") and passes the answer in as `eligible`. This
// component never asks that question on its own.
//
// NEVER ON A HOME/LANDING PAGE. isProTrialExcludedPath covers "/", "/pros"
// and the rest of the public funnel. In practice this component is only ever
// mounted inside the signed-in pro shell, so the check never actually fires
// today - it exists so a future mount point (a global one, say) cannot put a
// paywall in front of a page selling the product to a visitor who has not
// signed up yet.
//
// NEVER STACKED WITH THE REVIEW PROMPT. Both are floating, attention-grabbing
// asks, so at most one may be on screen in a session. isEligibleForProTrialPrompt
// checks isAnyFloatingPromptClaimedThisSession before opening (yields if the
// review card got there first), and the moment this takeover DOES open it
// calls claimFloatingPromptSlotForTrial, which marks the review card's own
// "asked this session" flag too - so "Enjoying Hearth?" cannot open on top of
// it later in the same app open either. Both flags live in sessionStorage:
// nothing here mutates ReviewPrompt.tsx, and nothing about what those flags
// mean to ReviewPrompt.tsx changes.
//
// NO REVIEWS/TESTIMONIAL SECTION, deliberately. Just the offer.

const SHOW_DELAY_MS = 3000;
const ACTIVITY_EVENTS = ["pointerdown", "keydown", "scroll", "touchstart"] as const;

type Plan = "monthly" | "yearly";

const YEARLY_PER_MONTH = formatUsd(yearlyAsMonthly(PRO_PLAN));
const YEARLY_PER_DAY = formatUsd(yearlyPerDay(PRO_PLAN));
const YEARLY_RUN_RATE = formatUsd(yearlyRunRate(PRO_PLAN));
const YEARLY_SAVING = formatUsd(yearlySavings(PRO_PLAN));
const YEARLY_SAVE_PCT = Math.round(
  (yearlySavings(PRO_PLAN) / yearlyRunRate(PRO_PLAN)) * 100
);
const MONTHLY_PRICE = formatUsd(PRO_PLAN.monthly);
const YEARLY_PRICE = formatUsd(PRO_PLAN.yearly);

function CheckoutButton({ label }: { label: string }) {
  const { pending } = useFormStatus();
  // Same synchronous double-submit latch src/app/pro/plus/ProPlanToggle.tsx
  // uses: `pending` lags a render behind the click, so a fast double tap can
  // otherwise reach the native submit twice.
  const submittedRef = useRef(false);
  useEffect(() => {
    if (!pending) submittedRef.current = false;
  }, [pending]);
  function handleClick(e: React.MouseEvent<HTMLButtonElement>) {
    if (submittedRef.current) {
      e.preventDefault();
      return;
    }
    const form = e.currentTarget.form;
    if (form && !form.noValidate && !form.checkValidity()) return;
    submittedRef.current = true;
  }
  return (
    <button
      type="submit"
      className="btn-primary min-h-12 w-full text-base"
      disabled={pending}
      onClick={handleClick}
    >
      {pending && <InlineSpinner />}
      {label}
    </button>
  );
}

export default function ProTrialNudge({
  eligible,
  userId,
}: {
  eligible: boolean;
  userId: string | null;
}) {
  const pathname = usePathname();
  const headingId = useId();
  const [open, setOpen] = useState(false);
  const [plan, setPlan] = useState<Plan>("yearly");

  const mountedRef = useRef(true);
  const openRef = useRef(false);
  const pathnameRef = useRef(pathname);
  const firstSessionRef = useRef<boolean | null>(null);
  const planRef = useRef<ReviewSessionPlan | null>(null);
  const activeRef = useRef<ActiveTimeState | null>(null);
  const settleDoneRef = useRef(false);
  const evaluateRef = useRef<() => void>(() => {});
  const dialogRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    pathnameRef.current = pathname;
    if (isProTrialExcludedPath(pathname) && openRef.current) {
      openRef.current = false;
      setOpen(false);
    }
  }, [pathname]);

  function evaluate() {
    if (!mountedRef.current) return;
    if (openRef.current) return; // already up
    if (!settleDoneRef.current) return;
    if (isProTrialExcludedPath(pathnameRef.current)) return;
    const plan = planRef.current;
    if (!plan) return; // storage unavailable: never ask rather than nag
    const activeMs = activeRef.current?.totalMs ?? 0;
    const thresholdMs = plan.thresholdMs || REVIEW_ACTIVE_MAX_MS;
    const msSinceActivity = activeRef.current
      ? Date.now() - activeRef.current.lastActivityAt
      : 0;
    const ok = isEligibleForProTrialPrompt({
      pathname: pathnameRef.current,
      isFirstSession: firstSessionRef.current ?? true,
      eligible,
      askSession: plan.askSession,
      activeMs,
      thresholdMs,
      msSinceActivity,
      askedThisSession: wasTrialPromptAskedThisSession(),
      anyOtherPromptActive: isAnyFloatingPromptClaimedThisSession(),
    });
    if (!ok) return;
    claimFloatingPromptSlotForTrial();
    openRef.current = true;
    setOpen(true);
  }

  useEffect(() => {
    evaluateRef.current = evaluate;
  });

  // The active-time clock, plus the first-session and session-plan draws.
  // Mount-only: it must survive route changes within the pro shell, the same
  // reason ReviewPrompt's own clock effect is mount-only. Does nothing at all
  // when this pro cannot get a trial or has no account id to key a plan on -
  // failing toward not tracking rather than tracking a nudge nobody can see.
  useEffect(() => {
    mountedRef.current = true;
    if (!eligible || !userId) return;
    if (typeof window === "undefined" || typeof document === "undefined") return;

    firstSessionRef.current = isFirstSession();
    planRef.current = getReviewSessionPlan({ userId });

    activeRef.current = createActiveTimeState(
      Date.now(),
      readSessionActiveMs(),
      document.visibilityState === "visible"
    );

    function onActivity() {
      if (activeRef.current) {
        activeRef.current = noteActivity(activeRef.current, Date.now());
      }
    }

    function onVisibility() {
      if (!activeRef.current) return;
      const visible = document.visibilityState === "visible";
      activeRef.current = setActiveTimeVisibility(
        activeRef.current,
        visible,
        Date.now()
      );
      writeSessionActiveMs(activeRef.current.totalMs);
      if (visible) evaluateRef.current();
    }

    const interval = setInterval(() => {
      if (!activeRef.current) return;
      activeRef.current = advanceActiveTime(activeRef.current, Date.now());
      writeSessionActiveMs(activeRef.current.totalMs);
      evaluateRef.current();
    }, REVIEW_TICK_MS);

    for (const type of ACTIVITY_EVENTS) {
      window.addEventListener(type, onActivity, { passive: true });
    }
    document.addEventListener("visibilitychange", onVisibility);

    settleDoneRef.current = false;
    const settleTimer = setTimeout(() => {
      settleDoneRef.current = true;
      evaluateRef.current();
    }, SHOW_DELAY_MS);

    return () => {
      mountedRef.current = false;
      clearInterval(interval);
      clearTimeout(settleTimer);
      for (const type of ACTIVITY_EVENTS) {
        window.removeEventListener(type, onActivity);
      }
      document.removeEventListener("visibilitychange", onVisibility);
    };
    // Mount-only on purpose; everything it needs lives in refs, same as
    // ReviewPrompt's clock effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eligible, userId]);

  function close() {
    // A snooze, not an answer: the per-session flag was already written when
    // the takeover opened (claimFloatingPromptSlotForTrial), which is what
    // keeps it away for the rest of THIS app open. Nothing permanent is
    // recorded, so a later session can draw it again from the same pool.
    openRef.current = false;
    setOpen(false);
  }

  // Escape closes, and body scroll is locked while open, exactly like any
  // other full-screen dialog. Also moves focus into the card the moment it
  // opens, so a screen reader user lands on the offer instead of wherever the
  // page behind it happened to be.
  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialogRef.current?.focus();
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKeyDown);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  const introEligible = true; // gated on `eligible` above; this pro really gets the trial
  const planLabel = plan === "yearly" ? "pro_yearly" : "pro_monthly";
  const priceLine =
    plan === "yearly"
      ? `${PRO_PLAN.trialDays} days free, then ${YEARLY_PRICE} for the year.`
      : `${PRO_PLAN.trialDays} days free, then ${MONTHLY_PRICE} a month.`;

  return (
    // Full-screen takeover, not a card: fixed inset-0, above every other
    // floating surface in the app (the review prompt is z-40, the bottom tab
    // bar z-30). Backdrop click closes only when the click lands on the
    // backdrop itself, never when it bubbles up from the card.
    <div
      className="fixed inset-0 z-[70] flex flex-col overflow-y-auto bg-white pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] dark:bg-stone-900"
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        tabIndex={-1}
        className="mx-auto flex w-full max-w-md flex-1 flex-col px-5 pb-8 pt-3 outline-none"
      >
        <div className="flex items-center">
          <button
            type="button"
            onClick={close}
            aria-label="Close"
            className="focus-ring -m-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-stone-500 hover:text-stone-700 dark:text-stone-400 dark:hover:text-stone-200"
          >
            <X className="h-6 w-6" aria-hidden="true" />
          </button>
        </div>

        <div className="mt-2 flex flex-col items-center text-center">
          <Logo className="h-9 w-9 text-hearth-700 dark:text-hearth-400" />
          <p className="mt-2 text-sm font-medium text-stone-500 dark:text-stone-400">
            Hearth Pro
          </p>
          <h1
            id={headingId}
            className="mt-3 text-3xl font-bold text-stone-900 dark:text-stone-100"
          >
            {PRO_PLAN.trialDays} Day Free Trial
          </h1>
          <p className="mt-2 text-sm text-stone-600 dark:text-stone-300">
            Every Pro perk, free for {PRO_PLAN.trialDays} days. Cancel any
            time before it ends and you pay nothing.
          </p>
        </div>

        <div
          role="radiogroup"
          aria-label="Choose your plan"
          className="mt-6 grid grid-cols-2 gap-3"
        >
          <button
            type="button"
            role="radio"
            aria-checked={plan === "yearly"}
            aria-label={`Yearly, ${YEARLY_PRICE} a year, save ${YEARLY_SAVE_PCT}%`}
            onClick={() => setPlan("yearly")}
            className={[
              "relative flex h-full flex-col rounded-xl border p-3 text-left transition-colors",
              plan === "yearly"
                ? "border-hearth-600 bg-hearth-50 ring-2 ring-hearth-600 ring-offset-1 ring-offset-white dark:bg-hearth-900/30 dark:ring-offset-stone-900"
                : "border-stone-200 bg-white hover:border-stone-300 dark:border-white/10 dark:bg-stone-800 dark:hover:border-white/20",
            ].join(" ")}
          >
            {YEARLY_SAVE_PCT > 0 && (
              <span className="absolute -top-2.5 left-3 whitespace-nowrap rounded-full bg-hearth-600 px-2 py-0.5 text-[10px] font-medium text-white">
                Save {YEARLY_SAVE_PCT}%
              </span>
            )}
            <span className="text-sm font-medium text-stone-700 dark:text-stone-300">
              Yearly
            </span>
            <span className="mt-1 block text-xl font-semibold text-stone-900 dark:text-stone-100">
              {YEARLY_PRICE}
              <span className="text-xs font-normal text-stone-500 dark:text-stone-400">
                /yr
              </span>
            </span>
            <span className="mt-0.5 block text-xs text-stone-500 dark:text-stone-400">
              {YEARLY_PER_MONTH}/mo
            </span>
          </button>

          <button
            type="button"
            role="radio"
            aria-checked={plan === "monthly"}
            aria-label={`Monthly, ${MONTHLY_PRICE} a month`}
            onClick={() => setPlan("monthly")}
            className={[
              "flex h-full flex-col rounded-xl border p-3 text-left transition-colors",
              plan === "monthly"
                ? "border-hearth-600 bg-hearth-50 ring-2 ring-hearth-600 ring-offset-1 ring-offset-white dark:bg-hearth-900/30 dark:ring-offset-stone-900"
                : "border-stone-200 bg-white hover:border-stone-300 dark:border-white/10 dark:bg-stone-800 dark:hover:border-white/20",
            ].join(" ")}
          >
            <span className="text-sm font-medium text-stone-700 dark:text-stone-300">
              Monthly
            </span>
            <span className="mt-1 block text-xl font-semibold text-stone-900 dark:text-stone-100">
              {MONTHLY_PRICE}
              <span className="text-xs font-normal text-stone-500 dark:text-stone-400">
                /mo
              </span>
            </span>
            <span className="mt-0.5 block text-xs text-stone-500 dark:text-stone-400">
              = {YEARLY_RUN_RATE}/yr
            </span>
          </button>
        </div>

        <div className="mt-6 space-y-3">
          <form action={startProCheckoutAction} className="space-y-3">
            <input type="hidden" name="plan" value={plan} />
            <p className="text-center text-sm text-stone-600 dark:text-stone-300">
              {priceLine}
            </p>
            <AutoRenewalTerms plan={planLabel} introEligible={introEligible} />
            <CheckoutButton
              label={`Start ${PRO_PLAN.trialDays}-day free trial`}
            />
          </form>
          <p className="text-center text-xs text-stone-500 dark:text-stone-400">
            Automatically renews until cancelled.{" "}
            <Link href="/privacy" className="underline hover:text-stone-700 dark:hover:text-stone-300">
              Privacy Policy
            </Link>{" "}
            &middot;{" "}
            <Link href="/terms" className="underline hover:text-stone-700 dark:hover:text-stone-300">
              Terms of Service
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
