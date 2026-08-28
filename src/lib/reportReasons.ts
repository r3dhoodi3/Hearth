// The one list of reasons every "Report" control in the app offers, so a chat
// report, a review report and a profile report all land in the same inbox
// speaking the same vocabulary. Plain words on purpose: somebody reaching for
// this is usually upset, and a taxonomy is the last thing they want to parse.
//
// Values are stored verbatim in public.reports.reason (0009), which is a free
// text column - there is no enum to keep in sync, and old rows carry whatever
// free text the chat report captured.
export const REPORT_REASONS = [
  "Harassment or abuse",
  "Spam or a scam",
  "Off-platform payment request",
  "Hate speech or threats",
  "Sexual or explicit content",
  "Not a real business",
  "Something else",
] as const;

export type ReportReason = (typeof REPORT_REASONS)[number];

export function isReportReason(value: string): value is ReportReason {
  return (REPORT_REASONS as readonly string[]).includes(value);
}

// What can be reported outside a chat thread. Matches the
// reports_target_type_known CHECK constraint in migration 0138.
export const REPORT_TARGET_TYPES = ["review", "contractor"] as const;

export type ReportTargetType = (typeof REPORT_TARGET_TYPES)[number];
