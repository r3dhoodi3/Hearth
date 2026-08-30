"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getSupabase } from "@/lib/lazySupabase";
import InlineSpinner from "@/components/InlineSpinner";
import { needsHomeScreenInstallForPush } from "@/lib/installState";
import {
  enablePush,
  hasPushSubscription,
  pushPermission,
  pushSupported,
  vapidPublicKey,
  type PushSide,
} from "@/lib/pushClient";
import {
  clearPushMoment,
  hasFreshMoment,
  isPushPromptDone,
  isPushPromptSnoozed,
  markPushPromptDone,
  PUSH_MOMENT_EVENT,
  snoozePushPrompt,
} from "@/lib/pushPrompt";

// The one-time "want your phone to tell you?" card. It appears right after a
// moment that makes the offer obvious (see markPushMoment in
// src/lib/pushPrompt.ts), at most once every 14 days, and never again once
// permission is granted.
//
// PHONE ONLY (sm:hidden). This is the answer to "I want to be notified when the
// app is closed", which is a phone problem: a laptop user has the tab open or
// they do not. The permanent control on both sides is
// src/components/PushSettingsCard.tsx, which is not breakpoint gated.
//
// Mounted from src/components/NewMessageNotifier.tsx, which both shells already
// render, so this reaches homeowners and pros without touching either layout.
export default function PushPrompt({ side }: { side: PushSide }) {
  const [userId, setUserId] = useState<string | null>(null);
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  // Set when a tap could not produce permission, so the card can say something
  // true instead of just vanishing.
  const [note, setNote] = useState<string | null>(null);
  const mounted = useRef(true);

  // The account this browser is signed in as. Every stored answer is keyed on
  // it, so two people sharing a phone do not inherit each other's dismissals.
  useEffect(() => {
    mounted.current = true;
    (async () => {
      try {
        // Lazily loaded so supabase-js stays out of First Load JS on every
        // route this prompt mounts on (src/lib/lazySupabase.ts).
        const { data } = await (await getSupabase()).auth.getUser();
        if (mounted.current) setUserId(data.user?.id ?? null);
      } catch {
        // Signed out or offline: no id, no prompt.
      }
    })();
    return () => {
      mounted.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const evaluate = useCallback(async () => {
    if (!userId) return;
    // Dormant deployment, or a browser with none of the APIs: nothing to offer.
    if (!vapidPublicKey()) return;
    // iPhone in a Safari tab is deliberately NOT excluded here even though
    // pushSupported() is false there: that is the person this card can help
    // most, and the branch below tells them the one thing they need to do.
    if (!pushSupported() && !needsHomeScreenInstallForPush()) return;
    // Already answered, in either direction. "denied" is the browser's own
    // permanent no, and re-asking cannot change it.
    if (pushPermission() === "denied") return;
    if (isPushPromptDone(userId)) return;
    if (await hasPushSubscription()) {
      markPushPromptDone(userId);
      return;
    }
    if (isPushPromptSnoozed(userId)) return;
    if (!hasFreshMoment()) return;
    if (mounted.current) setVisible(true);
  }, [userId]);

  // Evaluate on mount (a moment that happened just before a navigation, e.g.
  // posting a job and being redirected) and again whenever one fires while this
  // is already on screen.
  useEffect(() => {
    void evaluate();
    const onMoment = () => void evaluate();
    window.addEventListener(PUSH_MOMENT_EVENT, onMoment);
    return () => window.removeEventListener(PUSH_MOMENT_EVENT, onMoment);
  }, [evaluate]);

  // Permission has to be requested inside this handler: browsers only honor
  // the request during a user gesture.
  async function turnOn() {
    setBusy(true);
    setNote(null);
    const result = await enablePush(side);
    if (!mounted.current) return;
    setBusy(false);
    if (result === "granted") {
      if (userId) markPushPromptDone(userId);
      clearPushMoment();
      setVisible(false);
      return;
    }
    if (result === "needs-install") {
      setNote(
        "On iPhone, add Hearth to your Home Screen first: tap Share, then Add to Home Screen. Then open Hearth from the new icon and turn this on."
      );
      return;
    }
    if (result === "denied") {
      // The browser's permanent no. Stop offering and say where it lives.
      if (userId) markPushPromptDone(userId);
      setNote(
        "Notifications are blocked for Hearth in this browser. You can allow them again in your browser's settings for this site."
      );
      return;
    }
    setNote("Could not turn notifications on. Please try again.");
  }

  function dismiss() {
    if (userId) snoozePushPrompt(userId);
    clearPushMoment();
    setVisible(false);
  }

  if (!visible) return null;

  const title =
    side === "pro"
      ? "Get notified when a homeowner messages you"
      : "Get notified when a pro replies or sends a quote";

  return (
    // Phone only, and lifted clear of the fixed bottom tab bar the same way
    // AddToHomeScreenNudge is: 48px of bar content plus its safe-area inset,
    // plus a full 1rem of air, so Home / Post / Messages stay tappable while
    // this is up. z-[35]: above the tab bar (z-30) and below the header's
    // stacking context (z-40).
    <div
      data-testid="push-prompt"
      className="pointer-events-none fixed inset-x-0 bottom-[calc(3.5rem+env(safe-area-inset-bottom)+1rem)] z-[35] flex justify-center px-3 sm:hidden"
    >
      <div
        role="status"
        className="pointer-events-auto w-full max-w-sm rounded-xl border border-stone-200 bg-white p-3 shadow-menu dark:border-white/10 dark:bg-stone-800"
      >
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-stone-900 dark:text-stone-100">
              {title}
            </p>
            <p className="mt-0.5 text-sm text-stone-600 dark:text-stone-400">
              {note ??
                "Your phone can tell you even when Hearth is closed. You can turn this off any time."}
            </p>
          </div>
          <button
            type="button"
            onClick={dismiss}
            aria-label="Dismiss"
            className="-m-1.5 flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-stone-400 hover:bg-stone-100 hover:text-stone-600 dark:hover:bg-stone-700 dark:hover:text-stone-300"
          >
            <svg
              viewBox="0 0 20 20"
              className="h-4 w-4"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <path d="M5 5l10 10M15 5L5 15" />
            </svg>
          </button>
        </div>
        <div className="mt-2 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={dismiss}
            className="inline-flex min-h-11 items-center rounded-lg px-3 text-sm font-medium text-stone-600 active:opacity-70 dark:text-stone-300"
          >
            Not now
          </button>
          <button
            type="button"
            onClick={turnOn}
            disabled={busy}
            className="btn-primary inline-flex min-h-11 items-center gap-2 text-sm disabled:opacity-50"
          >
            {busy && <InlineSpinner size={14} />}
            Turn on notifications
          </button>
        </div>
      </div>
    </div>
  );
}
