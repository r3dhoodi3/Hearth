"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

// MR3#12, pro side: after the first Won lead, a one-time nudge toward the
// referral card that's already sitting in the collapsed Account panel below
// (AccountPanel -> ReferralCard, src/components/pro/ReferralCard.tsx) - most
// pros never open that panel unprompted, so the card alone was easy to miss.
// #account is the panel's <details id="account">; browsers auto-expand an
// ancestor <details> when a hash navigation targets an element inside it, so
// the link both scrolls to and opens the card with no extra wiring here.
//
// Shown at most once per account, ever - same "mark seen the moment it's
// shown" shape as PostJobDoneReferralAsk.tsx (the homeowner-side half of
// this same item): there's no dismiss button here either.
const SEEN_KEY = "hearth_won_referral_nudge_seen";

function alreadySeen(): boolean {
  try {
    return (
      typeof window !== "undefined" &&
      window.localStorage.getItem(SEEN_KEY) === "1"
    );
  } catch {
    return true;
  }
}

function markSeen(): void {
  try {
    window.localStorage.setItem(SEEN_KEY, "1");
  } catch {
    // Best effort - worst case it can show again later.
  }
}

export default function WonReferralNudge({ wonCount }: { wonCount: number }) {
  const [hidden, setHidden] = useState(true);

  useEffect(() => {
    if (wonCount < 1) return;
    if (alreadySeen()) return;
    setHidden(false);
    markSeen();
  }, [wonCount]);

  if (hidden) return null;

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-stone-200 bg-stone-50 p-3 text-sm dark:border-white/10 dark:bg-stone-700">
      <p className="text-stone-700 dark:text-stone-300">
        Who else should be on Hearth? Refer another pro.
      </p>
      <Link href="/pro/business#account" className="btn-secondary shrink-0 text-sm">
        See your referral link
      </Link>
    </div>
  );
}
