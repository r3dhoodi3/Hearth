"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { proCtaLabel } from "@/components/pro/ProUpgradeCta";

// The membership nudge on the pro Home tab. Small, honest, and dismissable.
//
// THE RULE IT ENFORCES. Dismissing hides it for the rest of the DAY, not for
// the rest of the page view: the owner asked for "a little annoying", and the
// line between that and hostile is whether "not now" is respected for a
// meaningful stretch. So the stamp is an epoch day number per user, and the
// card comes back tomorrow rather than on the next navigation.
//
// It is deliberately NOT rendered on any screen where a pro is mid-task (the
// apply flow, a chat, onboarding, the billing form). The Home tab is the one
// place it mounts, and the server decides whether to mount it at all: only for
// an established non-member (see isEstablishedPro), never for a member.
//
// Hidden until the stamp has been read, so a dismissed card never flashes on
// screen before the effect can hide it. localStorage failures (private mode,
// storage disabled) fall through to showing the card, which is the safe
// direction: a nudge nobody can dismiss permanently is still just one card.

export function nudgeKey(userId: string): string {
  return `hearth_pro_nudge_dismissed_day:${userId}`;
}

// Epoch DAY, not a timestamp: two dismissals in the same calendar-ish window
// compare as equal integers, and "tomorrow" needs no date parsing.
export function epochDay(now: number = Date.now()): number {
  return Math.floor(now / 86_400_000);
}

// Pure so the once-per-day rule is testable without a DOM: has this pro
// already dismissed the card during the current epoch day?
export function dismissedToday(
  stored: string | null,
  now: number = Date.now()
): boolean {
  const day = Number(stored);
  if (!Number.isFinite(day)) return false;
  return day >= epochDay(now);
}

export default function ProNudge({
  userId,
  trialEligible,
  depositBoostPts,
  monthlyCreditDollars,
}: {
  userId: string;
  // Whether this pro can still have the free trial. Decides the button label
  // only; the perks listed are the same either way.
  trialEligible: boolean;
  depositBoostPts: number;
  monthlyCreditDollars: number;
}) {
  const [show, setShow] = useState(false);

  useEffect(() => {
    let stored: string | null = null;
    try {
      stored = window.localStorage.getItem(nudgeKey(userId));
    } catch {
      // No storage: show it. See the header.
    }
    setShow(!dismissedToday(stored));
  }, [userId]);

  if (!show) return null;

  function dismiss() {
    try {
      window.localStorage.setItem(nudgeKey(userId), String(epochDay()));
    } catch {
      // Nothing to do: the card still closes for this view.
    }
    setShow(false);
  }

  return (
    <div className="card flex items-start gap-3 border-hearth-200 bg-hearth-50 dark:border-hearth-500/30 dark:bg-hearth-500/15">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-hearth-800 dark:text-hearth-200">
          Hearth Pro
        </p>
        <p className="mt-1 text-sm text-hearth-700 dark:text-hearth-300">
          +{depositBoostPts}% bonus on every deposit and ${monthlyCreditDollars}{" "}
          of lead credit every month, once your membership is paid.
        </p>
        <Link
          href="/pro/plus?reason=nudge"
          className="btn-primary mt-3 inline-block text-sm"
        >
          {/* Same label the rest of the pro side uses, so the trial length is
              quoted from PRO_PLAN and can never drift from checkout. */}
          {proCtaLabel(trialEligible)}
        </Link>
      </div>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Hide this for today"
        // 44px so it is a real tap target on a phone, not a 20px glyph.
        className="-m-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-hearth-700 hover:bg-hearth-100 dark:text-hearth-300 dark:hover:bg-hearth-500/20"
      >
        <X className="h-5 w-5" aria-hidden="true" />
      </button>
    </div>
  );
}
