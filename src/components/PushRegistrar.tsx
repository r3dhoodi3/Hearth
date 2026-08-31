"use client";

import { useEffect, useRef } from "react";
import {
  refreshPushSubscription,
  registerServiceWorker,
  pushPermission,
  pushSupported,
  vapidPublicKey,
  type PushSide,
} from "@/lib/pushClient";

// Renders nothing. Two jobs, both once per page load:
//
//   1. Register /sw.js, the service worker that shows a notification when the
//      app is closed AND paints the cold-start warming screen when a
//      navigation stalls (public/sw.js). Registering is harmless and
//      idempotent - the browser only installs a new worker when the file's
//      bytes change - and it happens for EVERYONE, with no VAPID keys and no
//      notification permission required: the warming screen half of the
//      worker must reach every installed device, not just push users.
//   2. If notifications are ALREADY granted, quietly re-post this device's
//      subscription to the server. That is the self-healing step: a browser can
//      drop or rotate a subscription on its own (site data cleared, the app
//      reinstalled, the server's VAPID keys rotated), and without this the
//      person's notifications would simply stop one day with nothing to show
//      for it. It never prompts: permission is already granted by the time this
//      branch runs.
//
// Mounted from src/components/NewMessageNotifier.tsx, which both shells already
// render, so this reaches homeowners and pros without touching either layout.
export default function PushRegistrar({ side }: { side: PushSide }) {
  // React 18 strict mode double-invokes effects in development, and this one
  // makes a network call. The ref makes it once per real mount.
  const ranRef = useRef(false);

  useEffect(() => {
    if (ranRef.current) return;
    ranRef.current = true;

    let cancelled = false;
    (async () => {
      // Registration runs unconditionally: the worker's warming screen serves
      // every user, so it must not wait on VAPID keys or push support. The
      // call is a no-op wherever service workers do not exist (it returns
      // null instead of throwing, see src/lib/pushClient.ts).
      await registerServiceWorker();
      if (cancelled) return;
      // Everything below is push only, and stays exactly as gated as before:
      // keys present, push APIs present, permission already granted. It never
      // prompts.
      if (!vapidPublicKey()) return;
      if (!pushSupported()) return;
      if (pushPermission() !== "granted") return;
      await refreshPushSubscription(side);
    })();

    return () => {
      cancelled = true;
    };
  }, [side]);

  return null;
}
