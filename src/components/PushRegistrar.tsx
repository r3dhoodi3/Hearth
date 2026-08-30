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
//      app is closed (public/sw.js). Registering is harmless and idempotent -
//      the browser only installs a new worker when the file's bytes change.
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

    // Nothing to register when the deployment has no VAPID keys: the worker
    // would install and then never receive anything. Keeping it unregistered
    // means turning the keys on later is a deploy, not a deploy plus a wait for
    // every browser to notice.
    if (!vapidPublicKey()) return;
    if (!pushSupported()) return;

    let cancelled = false;
    (async () => {
      await registerServiceWorker();
      if (cancelled) return;
      if (pushPermission() !== "granted") return;
      await refreshPushSubscription(side);
    })();

    return () => {
      cancelled = true;
    };
  }, [side]);

  return null;
}
