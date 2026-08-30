"use client";

import { useEffect } from "react";
import { reportReviewMoment, type ReviewMoment } from "@/lib/nativeReview";

// Renders nothing. It exists so a SERVER component can record a positive
// moment for the review prompt, which reportReviewMoment cannot do on its own:
// it writes sessionStorage and dispatches a window event, both of which need a
// browser.
//
// The case it was built for is "plan_built", called out by name in the header
// of src/lib/nativeReview.ts as the one moment that could not be wired:
// generateMaintenancePlanAction is a server action posted from a plain <form>
// in the dashboard server component, so there is no client success state to
// call from. Mounting this beside the plan-ready state on the dashboard is
// that missing client success state.
//
// ONE REPORT PER SESSION, per moment. The dashboard re-renders on every visit
// and on every revalidate, so without the guard below a homeowner who has a
// plan would re-report "plan_built" all day, which turns a moment into a
// pulse. sessionStorage and not React state, because a fresh mount after a
// navigation is exactly the repeat being guarded against. ReviewPrompt.tsx
// still decides when, and whether, to actually ask.
const REPORTED_PREFIX = "hearth_review_moment_reported:";

export default function ReviewMomentReporter({
  moment,
}: {
  moment: ReviewMoment;
}) {
  useEffect(() => {
    const key = `${REPORTED_PREFIX}${moment}`;
    try {
      if (window.sessionStorage.getItem(key)) return;
      window.sessionStorage.setItem(key, "1");
    } catch {
      // Storage blocked: report anyway. A duplicate moment is harmless (the
      // prompt has its own frequency rules); a missed one is a lost ask.
    }
    reportReviewMoment(moment);
  }, [moment]);

  return null;
}
