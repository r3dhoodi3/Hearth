"use client";

import { useEffect, useState } from "react";
import {
  recordPaywallBannerSeen,
  shouldShowPaywallBanner,
} from "@/lib/paywallBannerSession";

// The cookie the dashboard reads to lead with the tool tile matching whatever
// paywall the person hit most recently (PLAN A1#2 / R1#5). One value, the
// reason id only - never free text - and it expires on its own after a week
// so a stale visit from a while ago cannot keep steering the dashboard.
const LAST_REASON_COOKIE = "hearth_last_reason";
const LAST_REASON_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

// Distinct reasons seen this session, for the cap in
// src/lib/paywallBannerSession.ts. sessionStorage, not localStorage: the cap
// is per-visit, not forever.
const SESSION_KEY = "hearth_paywall_reasons_seen";

function readSeen(): string[] {
  try {
    const raw = window.sessionStorage.getItem(SESSION_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.filter((r): r is string => typeof r === "string")
      : [];
  } catch {
    // Storage disabled or private mode: the cap just never engages this
    // session, and every reason banner shows - the safe direction to fail.
    return [];
  }
}

function writeSeen(seen: string[]): void {
  try {
    window.sessionStorage.setItem(SESSION_KEY, JSON.stringify(seen));
  } catch {
    // Worst case the cap forgets between reasons this session.
  }
}

// Wraps the /plus page's ?reason= banner block (server-rendered JSX; exactly
// one of the reason-conditional children is ever truthy for a given
// searchParams.reason). Two client-only jobs neither the server component
// nor the tool pages that link here can do on their own:
//
//  1. Remember the reason in LAST_REASON_COOKIE so the dashboard can lead
//     with the matching tool tile on the next visit (PLAN A1#2).
//  2. Cap how many DISTINCT reasons get a banner in one session - a
//     homeowner who bounces off four different paywalls in one visit sees
//     the sales line on the first three only. The underlying gate (job
//     posting blocked, tool locked, quote credit spent) is unaffected either
//     way; only this banner's text stands down (PLAN A1#3).
//
// Starts visible - the children arrived in the server-rendered HTML already -
// and only ever HIDES after the mount check runs, never the other way
// around. That means the common case (the 1st-3rd distinct reason of a
// session) never flashes, and the rare 4th-distinct case briefly shows the
// banner before this effect removes it, which is the safer direction: real
// content disappearing after a beat, not real content being withheld from
// every first-time visitor while a client-only check runs.
export default function PaywallReasonBanner({
  reason,
  children,
}: {
  reason: string;
  children: React.ReactNode;
}) {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    try {
      document.cookie = `${LAST_REASON_COOKIE}=${encodeURIComponent(
        reason
      )}; path=/; max-age=${LAST_REASON_MAX_AGE_SECONDS}; samesite=lax`;
    } catch {
      // Cookies disabled: the dashboard just keeps its default tile order.
    }

    const seen = readSeen();
    setVisible(shouldShowPaywallBanner(seen, reason));
    writeSeen(recordPaywallBannerSeen(seen, reason));
  }, [reason]);

  if (!visible) return null;
  return <>{children}</>;
}
