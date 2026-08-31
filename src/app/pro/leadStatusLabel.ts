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

// The statuses that mean a job is over: the pro either won it ("closed") or
// lost it. This is the same pair every pipeline filter in the repo already
// uses (pro/page.tsx activeCount, pro/leads/page.tsx isDone,
// lib/activeJobConflicts.ts), and it lives next to STATUS_LABEL so the
// vocabulary and its active/finished split cannot drift apart. Both Messages
// inboxes read it for their Active / Closed tabs.
export const TERMINAL_LEAD_STATUSES = ["closed", "lost"] as const;

// True when a lead's conversation is finished. Anything unknown (a null from
// an old row, a status added later) counts as active on purpose: hiding a
// conversation is the worse failure mode.
export function isTerminalLeadStatus(status: string | null | undefined): boolean {
  return (
    status != null && (TERMINAL_LEAD_STATUSES as readonly string[]).includes(status)
  );
}
