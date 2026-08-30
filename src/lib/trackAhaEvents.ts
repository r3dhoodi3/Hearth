// The two "aha moment" events (PLAN A1#6 / CR2#8): the specific action each
// side takes once and that predicts whether the account sticks around, per
// the activation-metric methodology CR2 cites (find the action, orient the
// first session at it, measure time-to-it directly).
//
//   aha_home_score  - a homeowner's dashboard renders a real score with at
//                      least one system on file (src/app/(app)/dashboard/page.tsx).
//   aha_first_lead  - a pro's leads board renders with at least one open job
//                      (src/app/pro/leads/LeadsBoard.tsx).
//
// Both go through the existing app_events pipeline - src/lib/analytics.ts's
// client-side track() (see src/components/AhaEventReporter.tsx, the reporter
// that fires these) and the public sink at src/app/api/track/route.ts, whose
// CLIENT_ALLOWED_EVENTS carries both names. No new event mechanism, just two
// more names on the one that already exists. See docs/ANALYTICS.md.
export const AHA_HOME_SCORE = "aha_home_score";
export const AHA_FIRST_LEAD = "aha_first_lead";
export type AhaEvent = typeof AHA_HOME_SCORE | typeof AHA_FIRST_LEAD;

// The localStorage key AhaEventReporter checks before firing, so an account
// is reported at most once per browser. localStorage, not sessionStorage:
// this moment matters once, ever, not once per tab. (A server-side dedupe on
// (user, event) would close the "reported once per DEVICE, not per account"
// gap the plan calls out, but /api/track's insert has no such dedupe today -
// see the route - so this wave ships the localStorage half only.)
export function ahaReportedKey(event: AhaEvent): string {
  return `hearth_aha_reported:${event}`;
}
