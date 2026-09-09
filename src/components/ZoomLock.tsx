"use client";

import { useEffect } from "react";
import { isNativeApp } from "@/lib/platform";

// Locks pinch and double-tap zoom ONLY where the app runs as an app: the
// native Capacitor shell, or the installed home-screen PWA (display-mode
// standalone). A tester asked for the zoom lock on 2026-09-07 so the phone
// build reads as an app rather than a zoomable web page. In a normal browser
// tab the viewport stays zoomable on purpose: WCAG 2.1 SC 1.4.4 (Resize
// Text) is a real accessibility affordance for low-vision homeowners, and
// iOS Safari ignores user-scalable=no in the browser anyway, so locking it
// there would only cost accessibility on Android without changing iOS.
//
// The input focus auto-zoom on iOS is handled separately (every
// input/select/textarea is 16px below the sm breakpoint), so this component
// is purely about pinch and double-tap in app mode.
export default function ZoomLock() {
  useEffect(() => {
    let standalone = false;
    try {
      standalone =
        window.matchMedia("(display-mode: standalone)").matches ||
        (navigator as Navigator & { standalone?: boolean }).standalone === true;
    } catch {
      standalone = false;
    }
    if (!standalone && !isNativeApp()) return;
    const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
    if (!meta) return;
    const previous = meta.content;
    const parts = previous
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s && !/^(maximum-scale|user-scalable)=/i.test(s));
    meta.content = [...parts, "maximum-scale=1", "user-scalable=no"].join(", ");
    return () => {
      meta.content = previous;
    };
  }, []);
  return null;
}
