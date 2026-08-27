"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Footprints, X } from "lucide-react";

const DISMISS_KEY = "hearth_walkthrough_nudge_dismissed_at";
const REAPPEAR_MS = 14 * 24 * 60 * 60 * 1000;

// Prominent, dismissible nudge toward /walkthrough for confirming
// onboarding-estimated system details. Dismiss is stored client-side only
// (no schema change): a timestamp in localStorage, so the card stays hidden
// for 14 days then quietly comes back if systems are still unconfirmed.
export default function WalkthroughNudge({ count }: { count: number }) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (count <= 0) return;
    try {
      const raw = localStorage.getItem(DISMISS_KEY);
      const dismissedAt = raw ? Number(raw) : NaN;
      if (!Number.isNaN(dismissedAt) && Date.now() - dismissedAt < REAPPEAR_MS) {
        return;
      }
    } catch {
      // localStorage unavailable - just show the card.
    }
    setVisible(true);
  }, [count]);

  if (!visible || count <= 0) return null;

  function dismiss() {
    try {
      localStorage.setItem(DISMISS_KEY, String(Date.now()));
    } catch {
      // Nothing to persist to - dismissing just this once is fine.
    }
    setVisible(false);
  }

  return (
    <div className="flex items-start gap-3 rounded-xl border border-bark-100 bg-bark-50 p-4 dark:border-bark-700/40 dark:bg-bark-700/30">
      <span className="icon-chip shrink-0">
        <Footprints className="h-5 w-5" aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm text-stone-800 dark:text-stone-200">
          Confirm your home&apos;s details, each one makes your answers and
          score more accurate.
        </p>
        <Link
          href="/walkthrough"
          className="btn-primary mt-2 inline-block text-sm"
        >
          Walk your home
        </Link>
      </div>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss"
        className="-m-3.5 flex h-11 w-11 shrink-0 items-center justify-center text-bark-500 hover:text-bark-700 dark:text-stone-400 dark:hover:text-stone-300"
      >
        <X className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  );
}
