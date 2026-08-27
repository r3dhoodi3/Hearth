"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { X } from "lucide-react";
import {
  getReviewPromptSignals,
  recordReviewPromptEvent,
} from "@/app/(app)/feedback/actions";
import {
  isEligibleForReviewPrompt,
  isExcludedPath,
  isFirstSession,
  requestNativeReview,
} from "@/lib/reviewPrompt";

type Step = "hidden" | "ask" | "rate";

// Wait this long after the page has settled before the card can appear, so it
// never steals a tap the person meant for something else on the page they
// just landed on.
const SHOW_DELAY_MS = 3000;

// The one review-prompt surface in the app: "Enjoying Hearth?" -> Love it /
// Not really. Never the native store prompt - see requestNativeReview() in
// src/lib/reviewPrompt.ts for where that would plug in on a native wrapper.
// Mounted once, globally, in src/app/(app)/layout.tsx.
//
// The eligibility rules (once per account, not the first session, done
// something meaningful, never on an excluded page) live in
// src/lib/reviewPrompt.ts and src/app/(app)/feedback/actions.ts; this
// component only wires the timer and the two server round trips together.
export default function ReviewPrompt() {
  const pathname = usePathname();
  const router = useRouter();
  const [step, setStep] = useState<Step>("hidden");
  // Guards the timer and the fetch below from acting after either the route
  // has changed (a new effect run has already started) or the component has
  // unmounted.
  const cancelledRef = useRef(false);

  useEffect(() => {
    cancelledRef.current = false;

    // A page the card must never appear on (billing, onboarding, the
    // feedback page itself, ...). Also hides an already-showing card if the
    // route changed out from under it (e.g. "Not really" navigating away).
    if (isExcludedPath(pathname)) {
      setStep("hidden");
      return () => {
        cancelledRef.current = true;
      };
    }

    // Side-effecting: marks this browser as seen the first time it runs, and
    // returns true only that once. Must run unconditionally on every
    // eligible-page mount so a browser that never lands on one still gets
    // marked the first time it does.
    const firstSession = isFirstSession();

    let timerDone = false;
    let signalsDone = firstSession; // skip the fetch entirely when it can't matter
    let signals: Awaited<ReturnType<typeof getReviewPromptSignals>> = null;

    function maybeShow() {
      if (cancelledRef.current) return;
      if (!timerDone || !signalsDone) return;
      if (!signals) return; // no session, or the signal fetch failed/refused
      const eligible = isEligibleForReviewPrompt({
        pathname,
        isFirstSession: firstSession,
        alreadyShownOrAnswered: signals.alreadyShownOrAnswered,
        hasMeaningfulActivity: signals.hasMeaningfulActivity,
      });
      if (!eligible) return;
      setStep("ask");
      // Fire-and-forget: writing this is what makes "at most once per
      // account" hold even if the person never taps a button at all.
      recordReviewPromptEvent("prompt_shown");
    }

    const timer = setTimeout(() => {
      timerDone = true;
      maybeShow();
    }, SHOW_DELAY_MS);

    if (!firstSession) {
      getReviewPromptSignals()
        .then((s) => {
          signals = s;
        })
        .catch(() => {
          signals = null;
        })
        .finally(() => {
          signalsDone = true;
          maybeShow();
        });
    }

    return () => {
      cancelledRef.current = true;
      clearTimeout(timer);
    };
    // pathname is the only real dependency: a route change re-evaluates
    // eligibility for the page just landed on rather than the one left.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  function handleLove() {
    setStep("rate");
    recordReviewPromptEvent("loved");
  }

  function handleNotReally() {
    setStep("hidden");
    recordReviewPromptEvent("not_really");
    router.push("/feedback");
  }

  function handleDismiss() {
    // No extra write here: the 'prompt_shown' row from when the card
    // appeared already makes this "answered" for gating purposes, whether or
    // not the person ever pressed anything.
    setStep("hidden");
  }

  function handleRateClick() {
    // No-op on the web today. This is the tap a future Capacitor build
    // intercepts to call the native store review API instead of following
    // the link below.
    requestNativeReview();
  }

  if (step === "hidden") return null;

  const appStoreUrl = process.env.NEXT_PUBLIC_APP_STORE_URL;

  return (
    // Sits above the mobile bottom tab bar (Nav.tsx: 3rem tall, plus the
    // notch inset) by 12px, the same offset AskHearthDock uses; on sm+ there
    // is no tab bar, so it drops to a flat bottom-4.
    <div className="fixed inset-x-4 bottom-[calc(3rem+12px+env(safe-area-inset-bottom))] z-40 sm:inset-x-auto sm:right-4 sm:bottom-4 sm:w-96 print:hidden">
      <div className="card w-full p-4 shadow-pop">
        <div className="flex items-start justify-between gap-3">
          <p className="text-base font-semibold text-stone-900 dark:text-stone-100">
            {step === "ask" ? "Enjoying Hearth?" : "Rate Hearth"}
          </p>
          {/* -m-2 grows the actual tap target to 44px without moving the icon
              visually off the card's corner. */}
          <button
            type="button"
            onClick={handleDismiss}
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
      </div>
    </div>
  );
}
