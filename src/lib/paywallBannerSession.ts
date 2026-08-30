// Pure counting rules for the /plus ?reason= paywall banner's per-session
// cap (see src/components/PaywallReasonBanner.tsx). Kept here, not inline in
// the component, so the counting itself is testable without a DOM or
// sessionStorage (PLAN A1#3 / R1#10: "session cap on paywall banners").
//
// A reason already seen this session keeps showing - revisiting a paywall
// you already hit does not spend a slot. Only a NEW distinct reason counts
// against the cap, and once the cap is spent the banner renders nothing at
// all; the page's own lock state (job posting blocked, tool gated) still
// applies, only the sales line stands down.
export const PAYWALL_BANNER_SESSION_CAP = 3;

export function shouldShowPaywallBanner(
  seenThisSession: readonly string[],
  reason: string
): boolean {
  if (seenThisSession.includes(reason)) return true;
  return seenThisSession.length < PAYWALL_BANNER_SESSION_CAP;
}

// The list to persist after this reason has been shown (or would have been):
// adds `reason` once, keeps prior order, never records the same reason twice.
export function recordPaywallBannerSeen(
  seenThisSession: readonly string[],
  reason: string
): string[] {
  if (seenThisSession.includes(reason)) return [...seenThisSession];
  return [...seenThisSession, reason];
}
