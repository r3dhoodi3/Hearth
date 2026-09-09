"use client";

import { useEffect, useState } from "react";
import { isNativeApp } from "@/lib/platform";

// =============================================================================
// A real "you're offline" screen for the native app shell (2026-09-07,
// appstore-execute) - guideline 4.2 calls out offline/error handling as one
// of the concrete differences between "a real app" and "a WebView pointed at
// a website". Without this, losing connectivity on native shows whatever the
// WKWebView/WebView's own network-error page looks like (a browser chrome
// error, not an OakTend one) - exactly the "browser chrome" tell reviewers
// flag.
//
// No-op on web: renders nothing there (isNativeApp() false), so mounting it
// unconditionally near the root is safe. On native, mounted by
// NativeBootstrap.tsx alongside the other native-only wiring.
// =============================================================================
export default function NativeOfflineScreen() {
  const [ready, setReady] = useState(false);
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    if (!isNativeApp()) return;
    let cancelled = false;
    let handle: { remove: () => void } | null = null;

    (async () => {
      const { Network } = await import("@capacitor/network");
      if (cancelled) return;
      const status = await Network.getStatus();
      setOffline(!status.connected);
      setReady(true);
      handle = await Network.addListener("networkStatusChange", (status) => {
        setOffline(!status.connected);
      });
    })();

    return () => {
      cancelled = true;
      handle?.remove();
    };
  }, []);

  if (!ready || !offline) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed inset-0 z-[9999] flex flex-col items-center justify-center gap-3 bg-[#fbf7f2] px-6 text-center dark:bg-stone-900"
    >
      <p className="text-lg font-semibold text-stone-900 dark:text-stone-100">
        You&apos;re offline
      </p>
      <p className="max-w-xs text-sm text-stone-600 dark:text-stone-300">
        OakTend needs a connection to load your home&apos;s information. This
        will go away automatically once you&apos;re back online.
      </p>
    </div>
  );
}
