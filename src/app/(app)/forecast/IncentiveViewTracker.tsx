"use client";

import { useEffect, useRef } from "react";
import { track } from "@/lib/analytics";

// Fires forecast_incentive_viewed ONCE per page load, with the number of rebate
// lines the page actually rendered.
//
// Once, not once per incentive: a home with six systems would otherwise send
// six beacons for one glance at one page, which tells the funnel nothing extra
// and costs six writes. The count is a number, not a program name or a dollar
// figure, so the payload stays inside the ids-and-enums rule in
// docs/ANALYTICS.md.
//
// Renders nothing. The ref latch survives a re-render (Strict Mode in dev
// mounts effects twice), so a single view can never double-count.
export default function IncentiveViewTracker({ count }: { count: number }) {
  const fired = useRef(false);

  useEffect(() => {
    if (fired.current || count <= 0) return;
    fired.current = true;
    track("forecast_incentive_viewed", { count });
  }, [count]);

  return null;
}
