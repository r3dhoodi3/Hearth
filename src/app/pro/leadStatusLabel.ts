// Friendly labels for a contractor_leads.status value, shared by every place
// a pro sees their own pipeline status: the badge on each assigned-job card
// (leads/LeadsBoard.tsx) and the flash toast updateLeadStatusAction shows
// right after a status change (actions.ts).
//
// LOW-3: the toast used to build its label from LEAD_STATUSES in
// src/lib/constants.ts instead - a DIFFERENT list, kept for a DIFFERENT
// purpose (labelFor(LEAD_STATUSES, ...) reads elsewhere in the app), whose
// wording drifted from what the badge actually says: "Closed (won)" /
// "Declined" from the toast vs. "Won" / "Lost" on the card the pro is
// looking at when the toast appears. One pro reading both in the same
// glance had no way to know they meant the same status. This is the one map
// both now read from, so they can't drift again.
export const STATUS_LABEL: Record<string, string> = {
  new: "New lead",
  accepted: "Active",
  closed: "Won",
  lost: "Lost",
};

export function leadStatusLabel(status: string): string {
  return STATUS_LABEL[status] ?? status;
}
