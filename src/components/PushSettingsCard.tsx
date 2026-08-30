"use client";

import { useEffect, useRef, useState } from "react";
import InlineSpinner from "@/components/InlineSpinner";
import { needsHomeScreenInstallForPush } from "@/lib/installState";
import { track } from "@/lib/analytics";
import {
  disablePush,
  enablePush,
  hasPushSubscription,
  pushPermission,
  pushSupported,
  vapidPublicKey,
  type PushEnableResult,
  type PushSide,
} from "@/lib/pushClient";

// The permanent "turn phone notifications on" control, for the notification
// settings on both sides of the app. The one-time nudge that appears after a
// meaningful moment is src/components/PushPrompt.tsx; both drive the same
// helpers in src/lib/pushClient.ts, so there is one flow with two doors.
//
// Why the copy is so specific per side: "enable notifications" tells somebody
// nothing about what they are agreeing to. Naming the actual event ("when a
// homeowner messages you") is what makes the permission prompt that follows
// make sense, which is the difference between a granted and a denied tap.

const COPY: Record<
  PushSide,
  { title: string; detail: string; onDetail: string }
> = {
  homeowner: {
    title: "Get notified when a pro replies or sends a quote",
    detail:
      "Hearth can notify you on your phone even when the app is closed, so you do not have to keep checking.",
    onDetail:
      "You will get a notification when a pro replies, sends a quote, or an alert needs your attention.",
  },
  pro: {
    title: "Get notified when a homeowner messages you",
    detail:
      "Hearth can notify you on your phone even when the app is closed, so you can answer first.",
    onDetail:
      "You will get a notification for new messages, new jobs in your area, and quote requests.",
  },
};

export default function PushSettingsCard({ side }: { side: PushSide }) {
  // "loading" until the browser has been asked what it already knows, so the
  // card never flashes "Turn on notifications" at somebody who has them on.
  const [state, setState] = useState<
    "loading" | "off" | "on" | "denied" | "needs-install" | "unsupported"
  >("loading");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    (async () => {
      // No keys on this deployment means the whole feature is dormant, so the
      // card says nothing rather than offering a button that cannot work.
      if (!vapidPublicKey()) {
        if (mounted.current) setState("unsupported");
        return;
      }
      // The iPhone check comes BEFORE the capability check, and that order is
      // the whole point: in a Safari tab `PushManager` does not exist, so a
      // capability check alone would classify an iPhone as "unsupported" and
      // hide the card from exactly the person who needs the one instruction
      // that fixes it.
      if (needsHomeScreenInstallForPush()) {
        if (mounted.current) setState("needs-install");
        return;
      }
      if (!pushSupported()) {
        if (mounted.current) setState("unsupported");
        return;
      }
      const permission = pushPermission();
      if (permission === "denied") {
        if (mounted.current) setState("denied");
        return;
      }
      const subscribed = await hasPushSubscription();
      if (mounted.current) setState(subscribed ? "on" : "off");
    })();
    return () => {
      mounted.current = false;
    };
  }, []);

  // The permission request has to happen inside this handler: browsers only
  // honor Notification.requestPermission() during a user gesture, and a call
  // from an effect is ignored or silently treated as a refusal.
  async function turnOn() {
    setBusy(true);
    setNote(null);
    let result: PushEnableResult;
    try {
      result = await enablePush(side);
    } finally {
      if (mounted.current) setBusy(false);
    }
    if (!mounted.current) return;
    if (result === "granted") {
      setState("on");
      // Funnel analytics (docs/ANALYTICS.md). side is an enum
      // ("homeowner"/"pro"), never free text.
      track("push_enabled", { side });
      return;
    }
    if (result === "denied") {
      setState("denied");
      return;
    }
    if (result === "needs-install") {
      setState("needs-install");
      return;
    }
    if (result === "unsupported") {
      setState("unsupported");
      return;
    }
    // "dismissed" (closed the browser prompt without answering) or "failed".
    setNote(
      result === "dismissed"
        ? "No answer from the browser prompt. Tap again when you are ready."
        : "Could not turn notifications on. Check your connection and try again."
    );
  }

  async function turnOff() {
    setBusy(true);
    setNote(null);
    const ok = await disablePush();
    if (!mounted.current) return;
    setBusy(false);
    if (ok) setState("off");
    else setNote("Could not turn notifications off. Please try again.");
  }

  // Nothing useful to say on a browser that cannot do this at all, and an
  // explanation nobody can act on is worse than silence.
  if (state === "unsupported") return null;

  const copy = COPY[side];

  return (
    <div className="card p-6" data-testid="push-settings-card">
      <p className="text-sm font-semibold text-stone-900 dark:text-stone-100">
        {copy.title}
      </p>
      {/* text-sm, not text-xs: the eyesight pass flagged 12px body copy on the
          phone, and this card is read once, on a phone, by somebody deciding
          whether to allow a permission. */}
      <p className="mt-1 text-sm text-stone-600 dark:text-stone-400">
        {state === "on" ? copy.onDetail : copy.detail}
      </p>

      {state === "needs-install" && (
        // The iPhone case, and the reason this card cannot just show a button:
        // Safari gives a web page no notification permission at all until the
        // site has been added to the Home Screen (iOS 16.4+). There is nothing
        // to tap until then, so the card says what to do instead of failing.
        <p className="mt-3 rounded-lg bg-stone-50 p-3 text-sm text-stone-700 dark:bg-stone-800 dark:text-stone-300">
          On iPhone, add Hearth to your Home Screen first, then turn this on.
          Tap the Share button in Safari, choose Add to Home Screen, then open
          Hearth from the new icon and come back here.
        </p>
      )}

      {state === "denied" && (
        <p className="mt-3 rounded-lg bg-stone-50 p-3 text-sm text-stone-700 dark:bg-stone-800 dark:text-stone-300">
          Notifications are blocked for Hearth in this browser. Only your
          browser settings can turn them back on: open its site settings for
          Hearth, allow notifications, then reload this page.
        </p>
      )}

      {note && (
        <p role="status" className="mt-3 text-sm text-stone-700 dark:text-stone-300">
          {note}
        </p>
      )}

      {/* Skipped entirely in the two states that have no control, so the card
          does not end with an empty 16px gap. */}
      <div className={state === "denied" || state === "needs-install" ? "" : "mt-4"}>
        {state === "loading" ? (
          // Same skeleton height as the button it becomes, so the card does not
          // jump once the browser answers.
          <div
            aria-hidden="true"
            className="h-11 w-44 animate-pulse rounded-lg bg-stone-100 dark:bg-stone-800"
          />
        ) : state === "on" ? (
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-sm font-medium text-stone-900 dark:text-stone-100">
              Notifications are on for this device.
            </span>
            <button
              type="button"
              onClick={turnOff}
              disabled={busy}
              // min-h-11: 44px tap target on the phone, per the phone pass.
              className="inline-flex min-h-11 items-center gap-1.5 rounded-lg px-3 text-sm font-medium text-bark-700 hover:underline active:opacity-70 disabled:opacity-50 dark:text-stone-300"
            >
              {busy && <InlineSpinner size={12} />}
              Turn off
            </button>
          </div>
        ) : state === "denied" || state === "needs-install" ? null : (
          // No button in either of those two states on purpose: a disabled
          // button invites a tap that can only fail. The paragraph above says
          // what to do instead.
          <button
            type="button"
            onClick={turnOn}
            disabled={busy}
            className="btn-primary inline-flex min-h-11 items-center gap-2 text-sm disabled:opacity-50"
          >
            {busy && <InlineSpinner size={14} />}
            Turn on notifications
          </button>
        )}
      </div>
    </div>
  );
}
