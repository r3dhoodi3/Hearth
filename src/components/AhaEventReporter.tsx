"use client";

import { useEffect } from "react";
import { track } from "@/lib/analytics";
import { ahaReportedKey, type AhaEvent } from "@/lib/trackAhaEvents";

// Renders nothing. Reports one of the two aha-moment events (PLAN A1#6 /
// CR2#8) at most once per account, from a server-rendered page that has no
// client success state of its own to call track() from - same shape as
// ReviewMomentReporter.tsx, localStorage instead of sessionStorage because
// this moment matters once, ever, not once per tab.
//
// `eligible` is the page's own computed condition (a score with a system on
// file, an open jobs board with something on it); this component only adds
// the "have we already told the pipeline about this account" gate on top, so
// the page's render logic stays free of storage concerns.
export default function AhaEventReporter({
  event,
  eligible,
}: {
  event: AhaEvent;
  eligible: boolean;
}) {
  useEffect(() => {
    if (!eligible) return;
    const key = ahaReportedKey(event);
    try {
      if (window.localStorage.getItem(key)) return;
      window.localStorage.setItem(key, "1");
    } catch {
      // Storage blocked: report anyway. A duplicate is a harmless double
      // count on a one-off event; a missed one loses the whole signal.
    }
    track(event);
  }, [event, eligible]);

  return null;
}
