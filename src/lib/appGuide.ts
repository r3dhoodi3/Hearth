// Pure helpers for the first-run app guide (src/components/AppGuide.tsx).
//
// WHY THIS EXISTS AT ALL: the phone landing page is being cut down to almost
// nothing - somebody who installed the app already knows what Hearth is, and
// every extra word between them and a sign-in button is a word in the way. The
// explaining has to happen somewhere though, so it moves to the first screen
// AFTER sign-in: four short cards, once, then never again.
//
// Kept out of the component so the "should this show at all" rules can be unit
// tested without rendering anything, and so both the client component and the
// server wrapper (AppGuideMount.tsx) read the same list of excluded routes.

export type GuideSide = "homeowner" | "pro";

// Routes the guide must never take over, even though it is mounted globally in
// both signed-in shells:
//   /onboarding, /pro/onboarding - somebody is mid-setup; a takeover here is a
//     dropped signup, and the guide has nothing to say about a home that does
//     not exist yet.
//   /plus, /pro/plus, /checkout  - a payment screen. Never cover one.
//   /emergency, /emergency-help  - a burst pipe is not the moment for a tour.
//   /signin, /welcome            - not inside either shell today, but a future
//     mount point that is would be wrong to interrupt.
export const APP_GUIDE_EXCLUDED_PATHS = [
  "/onboarding",
  "/pro/onboarding",
  "/plus",
  "/pro/plus",
  "/checkout",
  "/emergency",
  "/emergency-help",
  "/signin",
  "/welcome",
] as const;

// Matched segment-wise, not by bare prefix, so /plusters (or any future route
// that merely begins with one of these spellings) is not excluded by accident
// while a child path or a query string still is. Same rule
// src/lib/reviewPrompt.ts uses, deliberately copied rather than shared: that
// file's list is the review prompt's, and the two are allowed to drift.
export function isAppGuideExcludedPath(pathname: string | null): boolean {
  if (!pathname) return true; // no route yet: fail toward not showing
  const path = pathname.split(/[?#]/)[0];
  return APP_GUIDE_EXCLUDED_PATHS.some(
    (p) => path === p || path.startsWith(p + "/")
  );
}

// The localStorage mirror of the server-side "seen" stamp. The stamp itself
// lives on public.users (guide_seen_at / pro_guide_seen_at, migration 0137) so
// the guide does not reappear on a second device, but a slow write or a slow
// page load must never show it twice inside one session either, so the browser
// remembers too and either one saying "seen" is enough.
export function appGuideSeenKey(side: GuideSide): string {
  return side === "pro" ? "hearth_pro_guide_seen" : "hearth_app_guide_seen";
}

// A sessionStorage flag, deliberately NOT the "seen" stamp above.
//
// The guide re-opens on every route change until it is dismissed, so somebody
// who ignores it and taps into the app instead gets it thrown back over the
// page they were trying to use - over the post-a-job form, over the
// walkthrough - on every single navigation. Navigating away is a "not now",
// not a "I read it": it snoozes the guide for this tab and nothing more. The
// account is still un-stamped, so a later visit offers it again, and the
// "Show the app guide again" link on either help page brings it straight back
// (that replay ignores this flag and the seen stamp both).
//
// sessionStorage, not localStorage: a snooze should not outlive the tab.
export function appGuideSnoozeKey(side: GuideSide): string {
  return side === "pro"
    ? "hearth_pro_guide_snoozed"
    : "hearth_app_guide_snoozed";
}

// The window event the "Show the app guide again" links dispatch (help pages,
// both sides). The component is always mounted and simply renders null when
// closed, so replaying it costs no extra fetch and no navigation.
export const APP_GUIDE_EVENT = "hearth:show-app-guide";

// The whole gate, in one pure function.
//
// onboardingComplete is not really decided here - it is decided by WHERE the
// guide is mounted (the homeowner shell already redirects anyone with no
// claimed home to /onboarding, and the pro shell only renders its full layout
// once a contractors row exists) - but it is passed in explicitly so a future
// mount point that is not gated that way fails toward not showing instead of
// silently inheriting an assumption from a layout it never read.
export function isEligibleForAppGuide(opts: {
  pathname: string | null;
  onboardingComplete: boolean;
  // The users-table stamp said this account has already been through it.
  seenOnServer: boolean;
  // This browser's localStorage mirror said the same.
  seenInThisBrowser: boolean;
  // They already had the guide up in this tab and navigated away from it
  // without dismissing it (see appGuideSnoozeKey). Optional so a caller that
  // does not track it fails toward showing, which is the old behavior.
  snoozedInThisSession?: boolean;
}): boolean {
  if (!opts.onboardingComplete) return false;
  if (opts.seenOnServer || opts.seenInThisBrowser) return false;
  if (opts.snoozedInThisSession) return false;
  if (isAppGuideExcludedPath(opts.pathname)) return false;
  return true;
}
