"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { track } from "@/lib/analytics";
import {
  buildWebVitalsProps,
  isWebVitalName,
  shouldSampleWebVitals,
  WEB_VITALS_EVENT,
} from "@/lib/webVitals";

// First-party Web Vitals reporting (LCP, INP, CLS, TTFB), sampled at 10% of
// page views (src/lib/webVitals.ts), into the existing app_events pipeline -
// no third-party RUM vendor, same rule as every other event
// (docs/ANALYTICS.md). Mounted once from NewMessageNotifier, the one
// component both the homeowner and pro shells already render, rather than
// adding a second mount point to either root layout.
//
// Module-level guard, not a ref: NewMessageNotifier itself only mounts once
// per shell, but React 19 StrictMode still runs every effect twice in dev,
// and the "web-vitals" listeners are not idempotent - a second registration
// would double-count every metric. This survives that; it does not survive
// (and does not need to survive) a full page reload, which is a new sample
// decision anyway.
let started = false;

export default function WebVitals() {
  const pathname = usePathname();

  useEffect(() => {
    if (started) return;
    if (!shouldSampleWebVitals()) return;
    started = true;

    // Dynamically imported so the ~1KB library never lands in the shared
    // shell bundle for the 90% of page views that skip reporting entirely.
    import("web-vitals").then(({ onLCP, onINP, onCLS, onTTFB }) => {
      const report = (metric: { name: string; value: number; rating: string }) => {
        if (!isWebVitalName(metric.name)) return;
        track(
          WEB_VITALS_EVENT,
          buildWebVitalsProps(
            metric.name,
            metric.value,
            metric.rating as "good" | "needs-improvement" | "poor",
            pathname ?? "/"
          )
        );
      };
      onLCP(report);
      onINP(report);
      onCLS(report);
      onTTFB(report);
    });
    // Deliberately empty deps beyond the mount: this reads `pathname` once,
    // for the page the sample decision was made on. Web Vitals' own listeners
    // track the initial document load (LCP/CLS/TTFB) or interactions across
    // its lifetime (INP), not a per-client-navigation reset, so re-running
    // this on every route change would attach duplicate listeners rather than
    // reporting the new page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null;
}
