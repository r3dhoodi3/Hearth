// The platform adapter for the OS's own "rate this app" sheet, plus the tiny
// event bus that tells the app a good moment to ask has just happened.
//
// WEB TODAY: every function here is a no-op or a plain flag. Nothing in this
// file imports a Capacitor package, and nothing may, until the native wrapper
// build actually exists: the packages assume a Capacitor runtime, they would
// either fail to resolve in the web build or ship dead native code to every
// browser visitor, and neither is worth paying for a call that cannot fire.
//
// WHEN THE CAPACITOR/iOS WRAPPER IS BUILT, this one file is what changes (or
// is aliased to a native twin at build time). Add
// @capacitor-community/in-app-review (or @capawesome/capacitor-app-review) in
// THAT build only and fill in requestPlatformReview():
//
//   import { Capacitor } from "@capacitor/core";
//   import { InAppReview } from "@capacitor-community/in-app-review";
//   export async function requestPlatformReview(): Promise<void> {
//     if (!Capacitor.isNativePlatform()) return;
//     try { await InAppReview.requestReview(); } catch { /* never surface */ }
//   }
//
// WHAT THE OS DOES WITH THE CALL, and why nothing here returns anything
// useful:
//   - iOS shows its own sheet at most 3 times per person per 365 days, per
//     app, across all versions. Calls past that are silently ignored.
//   - It reports NOTHING back: not whether the sheet appeared, not whether a
//     rating was left, not what the rating was. There is no callback, ever.
//   - A person can turn it off entirely (Settings > App Store > In-App Ratings
//     and Reviews), and TestFlight builds never show it. Both are silent.
//   - Google Play's equivalent has an undocumented, changeable quota and the
//     same silence.
// So: never branch any UI on this resolving, never show a spinner over it, and
// never tell somebody "thanks for rating" because of it.

// The positive outcomes that earn an ask. Deliberately short: "has done
// anything at all" is not a moment, it is a pulse.
//   job_hired   wired, src/app/(app)/contractors/HireAgainButton.tsx.
//   plan_built  NOT wired yet. generateMaintenancePlanAction
//               (src/app/(app)/dashboard/actions.ts) is a server action posted
//               from a plain <form> in the dashboard server component, so
//               there is no client success state to call this from. It needs a
//               small client component mounted on the dashboard that fires
//               reportReviewMoment("plan_built") once the "Your maintenance
//               plan is ready" state renders. Left undone on purpose: the
//               dashboard page was being rewritten in the same session.
// A third trigger the owner may want later, a positive in-app feedback score,
// has nothing to hang off yet: no thumbs/stars surface exists anywhere in the
// app. Build that first, then add its moment here.
export type ReviewMoment = "plan_built" | "job_hired";

// Dispatched the instant a positive outcome lands, by whatever component owns
// that success state. ReviewPrompt.tsx is the only listener.
export const REVIEW_MOMENT_EVENT = "hearth:review-moment";

// The moment also goes in sessionStorage, not just the event, for two reasons:
// the success state is often followed by a redirect (the rehire flow lands
// straight in a chat thread), and the ask deliberately waits for a calm
// moment later in the session rather than firing on the spot.
const REVIEW_MOMENT_KEY = "hearth_review_moment";

function sessionStore(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

// Call this from the success state of a genuinely positive outcome, right
// after the server action resolves. It never shows anything by itself: it
// records that this session earned an ask, and ReviewPrompt.tsx decides when
// (and on native, whether) to actually ask.
export function reportReviewMoment(moment: ReviewMoment): void {
  if (typeof window === "undefined") return;
  const s = sessionStore();
  try {
    s?.setItem(REVIEW_MOMENT_KEY, moment);
  } catch {
    // Private mode or storage off: the event below still reaches a listener
    // that is mounted right now, which covers the no-redirect case.
  }
  try {
    window.dispatchEvent(new CustomEvent(REVIEW_MOMENT_EVENT, { detail: moment }));
  } catch {
    // CustomEvent is missing only in very old engines; the stored flag is
    // still there for the next check.
  }
}

export function readReviewMoment(storage?: Storage): ReviewMoment | null {
  const s = storage ?? sessionStore();
  if (!s) return null;
  try {
    const raw = s.getItem(REVIEW_MOMENT_KEY);
    return raw === "plan_built" || raw === "job_hired" ? raw : null;
  } catch {
    return null;
  }
}

export function clearReviewMoment(storage?: Storage): void {
  const s = storage ?? sessionStore();
  if (!s) return;
  try {
    s.removeItem(REVIEW_MOMENT_KEY);
  } catch {
    // Worst case the same moment is considered again later in the session,
    // where the per-session "already asked" flag stops it anyway.
  }
}

// Capacitor exposes itself as a global on the webview's window, so this needs
// no import and no dependency: it is simply false in every browser today. The
// shape is declared rather than imported for the same reason - typing what we
// read is free, depending on the package is not.
type CapacitorGlobal = {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
};

export function isNativePlatform(): boolean {
  try {
    if (typeof window === "undefined") return false;
    const cap = (window as Window & { Capacitor?: CapacitorGlobal }).Capacitor;
    return cap?.isNativePlatform?.() === true;
  } catch {
    return false;
  }
}

// The actual platform call. A no-op on the web, by design and forever: on a
// web page the "Rate on the App Store" link IS the flow. See the header for
// what to put here when the wrapper build lands.
export async function requestPlatformReview(): Promise<void> {
  if (!isNativePlatform()) return;
  // TODO(native): call InAppReview.requestReview() here once the Capacitor
  // wrapper build adds the dependency. Nothing else in the app may depend on
  // what it returns, because it returns nothing meaningful.
}
