"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { PRO_PLAN } from "@/lib/constants";

// A quiet bottom card on /pro/billing offering the free Pro trial. Shown on
// the pro's FIRST visit to billing, then on every tenth visit after that
// (11, 21, 31 ...), so the offer is there when it is new and then only as an
// occasional reminder rather than a thing to dismiss on every trip to the
// wallet.
//
// Same shape and the same bottom offset as AddToHomeScreenNudge: fixed above
// the phone tab bar, one primary action, one quiet way out.
//
// WHO NEVER SEES IT: an active or trialing Pro member, and any pro whose
// trial is already spent. The page decides that (a pro-side subscriptions row
// outlives a cancellation, so "no row at all" is the only honest signal for
// "will really get a trial") and passes the answer in as `eligible`. This
// component never asks on its own.
//
// WHAT IT PROMISES: three free days, then the monthly price, cancel anytime.
// Deliberately NOT the deposit boost or the monthly lead credit: those start
// when the trial converts to a paid month, not during the trial, so naming
// them here would be selling something the trial does not include.

// Per-user so a shared machine does not count one pro's visits against
// another's, same rule the onboarding draft key follows.
const VISITS_KEY_PREFIX = "hearth_pro_billing_visits";
// Visit 1, then every 10th after it.
const REPEAT_EVERY = 10;

export function shouldShowOnVisit(visit: number): boolean {
  if (visit < 1) return false;
  return visit === 1 || (visit - 1) % REPEAT_EVERY === 0;
}

export default function ProTrialNudge({
  eligible,
  userId,
}: {
  eligible: boolean;
  userId: string | null;
}) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!eligible) return;
    const key = userId
      ? `${VISITS_KEY_PREFIX}:${userId}`
      : VISITS_KEY_PREFIX;
    try {
      // The count is bumped once per mount, and the decision is made from the
      // bumped value. That is what makes a dismissal stick for THIS visit: the
      // number does not move again until the next navigation, so a re-render
      // cannot bring the card back, and a refresh is genuinely a new visit.
      const raw = Number(localStorage.getItem(key) ?? "0");
      const previous = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
      const visit = previous + 1;
      localStorage.setItem(key, String(visit));
      if (shouldShowOnVisit(visit)) setOpen(true);
    } catch {
      // Private mode or storage disabled. Showing nothing is the safe answer:
      // without a count there is no way to stop showing it every single time.
    }
  }, [eligible, userId]);

  if (!eligible || !open) return null;

  return (
    // Above the phone tab bar (3.5rem of content plus the safe-area inset, the
    // same offset globals.css uses to lift the floating docks) with a further
    // 1rem of clear air, so the bar stays tappable underneath. z-[35] sits
    // above the bar (z-30) and below the header stacking context (z-40), the
    // same slot AddToHomeScreenNudge uses. Centered and max-w-sm on desktop
    // too: this is not a phone-only offer.
    <div
      data-testid="pro-trial-nudge"
      className="pointer-events-none fixed inset-x-0 bottom-[calc(3.5rem+env(safe-area-inset-bottom)+1rem)] z-[35] flex justify-center px-3 sm:bottom-6"
    >
      <div
        role="status"
        className="pointer-events-auto w-full max-w-sm rounded-xl border border-stone-200 bg-white p-4 shadow-menu dark:border-white/10 dark:bg-stone-800"
      >
        <p className="text-sm font-semibold text-stone-900 dark:text-stone-100">
          Try Hearth Pro free for {PRO_PLAN.trialDays} days
        </p>
        {/* text-sm, not text-xs: 14px is the floor for anything a phone has to
            read, and this is the line carrying the price. */}
        <p className="mt-1 text-sm text-stone-600 dark:text-stone-300">
          {PRO_PLAN.trialDays} days free, then $
          {PRO_PLAN.monthly.toFixed(2)}/month. Cancel anytime.
        </p>
        <div className="mt-3 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="inline-flex min-h-11 items-center rounded-lg px-3 text-sm font-medium text-stone-500 hover:text-stone-700 dark:text-stone-400 dark:hover:text-stone-200"
          >
            Not now
          </button>
          <Link href="/pro/plus" className="btn-primary">
            Start {PRO_PLAN.trialDays} free days
          </Link>
        </div>
      </div>
    </div>
  );
}
