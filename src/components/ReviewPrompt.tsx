"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { X } from "lucide-react";
import {
  getReviewPromptSignals,
  recordReviewPromptEvent,
  type ReviewPromptSignals,
} from "@/app/(app)/feedback/actions";
import {
  clearReviewMoment,
  isNativePlatform,
  readReviewMoment,
  REVIEW_MOMENT_EVENT,
} from "@/lib/nativeReview";
import {
  advanceActiveTime,
  createActiveTimeState,
  getReviewSessionPlan,
  getSessionActiveThresholdMs,
  isAwaitingStoreReturn,
  isEligibleForRateFollowUp,
  isEligibleForReviewPrompt,
  isExcludedPath,
  isFirstSession,
  markFollowUpAskedThisSession,
  markPromptAskedThisSession,
  noteActivity,
  readSessionActiveMs,
  requestNativeReview,
  REVIEW_ACTIVE_MAX_MS,
  REVIEW_RECENT_ACTIVITY_MS,
  REVIEW_TICK_MS,
  setActiveTimeVisibility,
  setAwaitingStoreReturn,
  wasFollowUpAskedThisSession,
  wasPromptAskedThisSession,
  writeSessionActiveMs,
  type ActiveTimeState,
  type ReviewSessionPlan,
} from "@/lib/reviewPrompt";

// "ask"     -> Enjoying Hearth? (Love it / Not really)
// "rate"    -> thank you, here is the App Store link
// "confirm" -> did you get a chance to rate Hearth? (Yes, done / Not yet)
type Step = "hidden" | "ask" | "rate" | "confirm";

// Wait this long after the page has settled before the card can appear, so it
// never steals a tap the person meant for something else on the page they
// just landed on. Also used when somebody comes back from the App Store: the
// follow-up waits the same three seconds rather than landing under the thumb
// that just re-opened the app.
const SHOW_DELAY_MS = 3000;

// Anything that proves a person is actually using the screen, for the idle
// reset in src/lib/reviewPrompt.ts. All passive: none of these handlers can
// affect scrolling or typing.
const ACTIVITY_EVENTS = ["pointerdown", "keydown", "scroll", "touchstart"] as const;

// Once the server reports this account as settled ('rated', or the negative
// branch), that answer can never change back, so it is worth remembering
// client-side: every later navigation would otherwise pay a
// getReviewPromptSignals() round trip just to hear the same permanent no.
// Only ever written from a real server row or a real permanent answer, never
// from a failed fetch, so a database hiccup cannot silence the prompt forever.
const SETTLED_KEY = "hearth_review_prompt_settled";

function isSettled(): boolean {
  try {
    return typeof window !== "undefined" && window.localStorage.getItem(SETTLED_KEY) === "1";
  } catch {
    return false;
  }
}

function markSettled(): void {
  try {
    window.localStorage.setItem(SETTLED_KEY, "1");
  } catch {
    // Storage can be unavailable (private mode, disabled). Worst case, later
    // navigations keep asking the server, exactly like today.
  }
}

// The one review-prompt surface in the app: "Enjoying Hearth?" -> Love it /
// Not really, then the App Store link, then an honest "did you get a chance to
// rate Hearth?" when they come back. Never the native store prompt - see
// requestNativeReview() in src/lib/reviewPrompt.ts for where that would plug
// in on a native wrapper. Mounted once, globally, in src/app/(app)/layout.tsx.
//
// The eligibility rules (settled once and only by a real answer, not the first
// session, done something meaningful, the right session, 15 to 20 minutes of
// real use, never on an excluded page) live in src/lib/reviewPrompt.ts and
// src/app/(app)/feedback/actions.ts; this component wires the clock, the
// return-from-store check and the server round trips together.
export default function ReviewPrompt() {
  const pathname = usePathname();
  const router = useRouter();
  const [step, setStep] = useState<Step>("hidden");

  const mountedRef = useRef(true);
  // The current step, readable from the timers and listeners below without
  // making every one of them depend on a re-render.
  const stepRef = useRef<Step>("hidden");
  const pathnameRef = useRef(pathname);
  // Signals are fetched once per mount and then kept: the component lives in
  // the layout, so a route change re-runs the effect below but the answers
  // (settled, owed a follow-up, meaningful activity) have not changed.
  const signalsRef = useRef<ReviewPromptSignals | null>(null);
  const planRef = useRef<ReviewSessionPlan | null>(null);
  const activeRef = useRef<ActiveTimeState | null>(null);
  // The 3 second settle timer for the page we are on has fired.
  const settleDoneRef = useRef(false);
  // Computed once per mount rather than per route change: isFirstSession()
  // flips to false the moment it is called, so calling it again on the next
  // navigation would report "not the first session" while still inside it.
  const firstSessionRef = useRef<boolean | null>(null);
  // Lets the mount-only listeners below call the latest evaluate() without
  // re-subscribing on every render.
  const evaluateRef = useRef<() => void>(() => {});
  // Inside a Capacitor shell rather than a browser tab. Read once: it cannot
  // change while the app is running.
  const nativeRef = useRef<boolean | null>(null);
  if (nativeRef.current === null) nativeRef.current = isNativePlatform();

  function show(next: Step) {
    if (!mountedRef.current) return;
    stepRef.current = next;
    setStep(next);
  }

  function hide() {
    stepRef.current = "hidden";
    setStep("hidden");
  }

  // NATIVE ONLY, and a completely different shape from the web card.
  //
  // App Store Review Guideline 5.6.1 (and Google Play's in-app review docs,
  // which say it outright) rule out putting a "do you like this app?" filter
  // in front of the system review sheet: that pattern - only happy people get
  // routed to the store - is exactly what the system API was created to
  // replace. So inside the native shell the "Enjoying Hearth?" card never
  // renders at all, nothing is gated on a "Love it" tap, and the OS is asked
  // directly at a positive moment. The web keeps its card: a web page is not
  // an App Store app, its "Rate on the App Store" link is a plain navigation,
  // and none of 5.6.1 applies to it.
  //
  // Everything else the owner asked for still holds here: not the first
  // session, not on an excluded page, at most one ask per app open, the same
  // 15 to 20 minutes of real use, and only while somebody is actually
  // touching the screen. requestNativeReview() adds Hearth's own three-a-year
  // cap on top of the platform's.
  function evaluateNative() {
    if (isExcludedPath(pathnameRef.current)) return;
    if (firstSessionRef.current !== false) return;
    if (wasPromptAskedThisSession()) return;
    // A genuinely positive outcome earlier in this session: a maintenance
    // plan built, a pro hired. Without one, never ask.
    const moment = readReviewMoment();
    if (!moment) return;
    const activeMs = activeRef.current?.totalMs ?? 0;
    if (activeMs < getSessionActiveThresholdMs()) return;
    const msSinceActivity = activeRef.current
      ? Date.now() - activeRef.current.lastActivityAt
      : 0;
    if (msSinceActivity > REVIEW_RECENT_ACTIVITY_MS) return;
    markPromptAskedThisSession();
    clearReviewMoment();
    // TODO(native): when the Capacitor build lands, log the attempt too - a
    // "native_review_requested" kind on app_feedback carrying which moment
    // fired, so the owner can see which moments spend the three yearly asks.
    // It needs one more value in the kind constraint (migration 0142), so it
    // is deliberately not added while nothing can call this.
    requestNativeReview();
  }

  // The single decision point. Called after the settle timer, after every
  // active-time tick, and whenever the tab becomes visible again. Reads only
  // refs, so it is safe to call from any of those.
  function evaluate() {
    if (!mountedRef.current) return;
    if (stepRef.current !== "hidden") return; // a card is already up
    if (!settleDoneRef.current) return;
    if (nativeRef.current) {
      evaluateNative();
      return;
    }
    const signals = signalsRef.current;
    if (!signals) return; // no session, or the signal fetch failed/refused
    const plan = planRef.current;
    const activeMs = activeRef.current?.totalMs ?? 0;
    const thresholdMs = plan?.thresholdMs ?? REVIEW_ACTIVE_MAX_MS;
    // A card may only land while somebody is on the screen, never onto a phone
    // that has been sitting untouched.
    const msSinceActivity = activeRef.current
      ? Date.now() - activeRef.current.lastActivityAt
      : 0;

    // The follow-up comes first: somebody who already tapped through to the
    // store is owed the honest question, not another "Enjoying Hearth?".
    if (
      isEligibleForRateFollowUp({
        pathname: pathnameRef.current,
        settled: signals.settled,
        awaitingRateConfirm: signals.awaitingRateConfirm,
        rateDeferred: signals.rateDeferred,
        followUpAskedThisSession: wasFollowUpAskedThisSession(),
        returnedFromStore: isAwaitingStoreReturn(),
        askSession: plan?.askSession ?? false,
        activeMs,
        thresholdMs,
        msSinceActivity,
      })
    ) {
      markFollowUpAskedThisSession();
      setAwaitingStoreReturn(false);
      show("confirm");
      return;
    }

    if (!plan) return; // storage unavailable: never ask rather than nag
    if (
      !isEligibleForReviewPrompt({
        pathname: pathnameRef.current,
        isFirstSession: firstSessionRef.current ?? true,
        settled: signals.settled,
        hasMeaningfulActivity: signals.hasMeaningfulActivity,
        askSession: plan.askSession,
        activeMs,
        thresholdMs,
        msSinceActivity,
        askedThisSession: wasPromptAskedThisSession(),
      })
    ) {
      return;
    }
    markPromptAskedThisSession();
    show("ask");
    // Fire-and-forget, and no longer the thing that stops the prompt coming
    // back: it is one row for staff to count, deduped by the unique index in
    // migration 0133. "Do not ask again" is now only ever an answer.
    recordReviewPromptEvent("prompt_shown");
  }

  // Kept fresh every render so the mount-only listeners call today's closure.
  useEffect(() => {
    evaluateRef.current = evaluate;
  });

  useEffect(() => {
    pathnameRef.current = pathname;
  }, [pathname]);

  // The active-time clock. Mount-only: it must survive route changes, because
  // "15 to 20 minutes in the app" is a session-long measure, not a per-page
  // one, and the running total is mirrored into sessionStorage so even a full
  // reload keeps it.
  useEffect(() => {
    mountedRef.current = true;
    if (typeof window === "undefined" || typeof document === "undefined") return;

    activeRef.current = createActiveTimeState(
      Date.now(),
      readSessionActiveMs(),
      document.visibilityState === "visible"
    );

    let returnTimer: ReturnType<typeof setTimeout> | null = null;

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
      if (!visible) return;
      // Coming back from the App Store is the moment the follow-up exists
      // for. Everything else re-checks straight away.
      if (isAwaitingStoreReturn()) {
        if (returnTimer) clearTimeout(returnTimer);
        returnTimer = setTimeout(() => evaluateRef.current(), SHOW_DELAY_MS);
        return;
      }
      evaluateRef.current();
    }

    const interval = setInterval(() => {
      if (!activeRef.current) return;
      activeRef.current = advanceActiveTime(activeRef.current, Date.now());
      writeSessionActiveMs(activeRef.current.totalMs);
      evaluateRef.current();
    }, REVIEW_TICK_MS);

    // A success state announcing itself (reportReviewMoment). Only the native
    // path acts on it today, but the listener is unconditional so a moment
    // that lands while this is mounted is never missed.
    function onMoment() {
      evaluateRef.current();
    }

    for (const type of ACTIVITY_EVENTS) {
      window.addEventListener(type, onActivity, { passive: true });
    }
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener(REVIEW_MOMENT_EVENT, onMoment);

    return () => {
      mountedRef.current = false;
      clearInterval(interval);
      if (returnTimer) clearTimeout(returnTimer);
      for (const type of ACTIVITY_EVENTS) {
        window.removeEventListener(type, onActivity);
      }
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener(REVIEW_MOMENT_EVENT, onMoment);
    };
    // Mount-only on purpose; everything it needs lives in refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    // A page the card must never appear on (billing, onboarding, the
    // feedback page itself, ...). Also hides an already-showing card if the
    // route changed out from under it (e.g. "Not really" navigating away).
    if (isExcludedPath(pathname)) {
      hide();
      return;
    }

    // Side-effecting: marks this browser as seen the first time it runs, and
    // returns true only that once. Must run on the first eligible-page mount
    // so a browser that never lands on one still gets marked the first time
    // it does.
    if (firstSessionRef.current === null) {
      firstSessionRef.current = isFirstSession();
    }
    // A settled account can never become eligible again, so a settled browser
    // skips the round trip entirely on every navigation. Native deliberately
    // ignores this flag: it is the record of an answer to the web card, and
    // letting a past "Not really" suppress the system sheet would be the
    // review filtering guideline 5.6.1 rules out. The OS does its own
    // throttling there.
    if (!nativeRef.current && isSettled()) return;

    settleDoneRef.current = false;
    const timer = setTimeout(() => {
      settleDoneRef.current = true;
      evaluateRef.current();
    }, SHOW_DELAY_MS);

    // Native never renders the card, so none of the card's server signals
    // matter there: no round trip, no session pool, no settled flag.
    if (!nativeRef.current && !signalsRef.current) {
      getReviewPromptSignals()
        .then((s) => {
          signalsRef.current = s;
          if (!s) return;
          if (s.settled) {
            markSettled();
            return;
          }
          // Count this app open and draw its dice now that we know who this
          // is. poolOnly once they have said "Not yet" already: the guaranteed
          // "first few sessions" run is spent.
          planRef.current = getReviewSessionPlan({
            userId: s.userId,
            poolOnly: s.rateDeferred,
          });
        })
        .catch(() => {
          signalsRef.current = null;
        })
        .finally(() => {
          evaluateRef.current();
        });
    }

    return () => {
      clearTimeout(timer);
    };
    // pathname is the only real dependency: a route change re-evaluates
    // eligibility for the page just landed on rather than the one left.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  function handleLove() {
    show("rate");
    recordReviewPromptEvent("loved");
  }

  function handleNotReally() {
    hide();
    // Permanent, and the only permanent answer besides "Yes, done": somebody
    // who told us they are not enjoying it is never asked again, on any
    // device.
    markSettled();
    // Replaced, not mutated: the object came from a server action and may be
    // shared with whatever else is holding it.
    if (signalsRef.current) {
      signalsRef.current = { ...signalsRef.current, settled: true };
    }
    recordReviewPromptEvent("not_really");
    router.push("/feedback");
  }

  function handleDismiss() {
    // A snooze, not an answer. The per-session flag already written when the
    // card appeared keeps it away for the rest of this app open, and the
    // session pool decides when it comes back. Nothing is recorded, because a
    // mis-tap on an X must not end the conversation forever.
    hide();
  }

  function handleRateClick() {
    // The link itself still opens the store (this is an <a>). All we record is
    // the INTENT: Apple never tells an app whether a rating was left, so
    // treating this tap as "done" was the bug - come back without rating and
    // Hearth had already written you off. requestNativeReview() is where a
    // native build would show SKStoreReviewController instead.
    requestNativeReview();
    recordReviewPromptEvent("rate_clicked");
    setAwaitingStoreReturn(true);
    if (signalsRef.current) {
      signalsRef.current = { ...signalsRef.current, awaitingRateConfirm: true };
    }
    hide();
  }

  function handleRated() {
    // The only thing that ever counts as "they rated it": the person saying
    // so. Permanent, on every device, via the server row.
    hide();
    markSettled();
    setAwaitingStoreReturn(false);
    if (signalsRef.current) {
      signalsRef.current = { ...signalsRef.current, settled: true };
    }
    recordReviewPromptEvent("rated");
  }

  function handleNotYet() {
    // Back into the random-session pool, and never again inside this app
    // open.
    hide();
    markFollowUpAskedThisSession();
    setAwaitingStoreReturn(false);
    if (signalsRef.current) {
      signalsRef.current = { ...signalsRef.current, rateDeferred: true };
    }
    recordReviewPromptEvent("rate_deferred");
  }

  function handleFollowUpDismiss() {
    // An X on the follow-up is treated exactly like "Not yet": it is not a
    // "yes", and without the write it would come back at the start of every
    // session until answered, which is the nag this whole rewrite exists to
    // avoid.
    handleNotYet();
  }

  // Belt and braces for guideline 5.6.1: evaluateNative() never sets a step,
  // but nothing about this component may ever put a pre-filter card in front
  // of the system review sheet.
  if (nativeRef.current) return null;
  if (step === "hidden") return null;

  const appStoreUrl = process.env.NEXT_PUBLIC_APP_STORE_URL;
  const title =
    step === "ask"
      ? "Enjoying Hearth?"
      : step === "rate"
        ? "Rate Hearth"
        : "Did you get a chance to rate Hearth?";

  return (
    // Sits above the mobile bottom tab bar (Nav.tsx: 3rem tall, plus the
    // notch inset) by 12px; on sm+ there is no tab bar, so it drops to a flat
    // bottom-4.
    <div className="fixed inset-x-4 bottom-[calc(3rem+12px+env(safe-area-inset-bottom))] z-40 sm:inset-x-auto sm:right-4 sm:bottom-4 sm:w-96 print:hidden">
      <div className="card w-full p-4 shadow-pop">
        <div className="flex items-start justify-between gap-3">
          <p className="text-base font-semibold text-stone-900 dark:text-stone-100">
            {title}
          </p>
          {/* -m-2 grows the actual tap target to 44px without moving the icon
              visually off the card's corner. */}
          <button
            type="button"
            onClick={step === "confirm" ? handleFollowUpDismiss : handleDismiss}
            aria-label="Dismiss"
            className="focus-ring -m-2 flex h-11 w-11 shrink-0 items-center justify-center text-stone-400 hover:text-stone-600 dark:text-stone-500 dark:hover:text-stone-300"
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>

        {step === "ask" && (
          <div className="mt-4 flex gap-3">
            <button
              type="button"
              onClick={handleNotReally}
              className="btn-secondary flex-1"
            >
              Not really
            </button>
            <button
              type="button"
              onClick={handleLove}
              className="btn-primary flex-1"
            >
              Love it
            </button>
          </div>
        )}

        {step === "rate" && (
          <div className="mt-3">
            <p className="text-sm text-stone-600 dark:text-stone-300">
              Thank you. A quick rating helps other homeowners find Hearth.
            </p>
            {appStoreUrl && (
              <a
                href={appStoreUrl}
                target="_blank"
                rel="noopener noreferrer"
                onClick={handleRateClick}
                className="btn-primary mt-4 w-full"
              >
                Rate on the App Store
              </a>
            )}
          </div>
        )}

        {step === "confirm" && (
          <div className="mt-4 flex gap-3">
            <button
              type="button"
              onClick={handleNotYet}
              className="btn-secondary flex-1"
            >
              Not yet
            </button>
            <button
              type="button"
              onClick={handleRated}
              className="btn-primary flex-1"
            >
              Yes, done
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
