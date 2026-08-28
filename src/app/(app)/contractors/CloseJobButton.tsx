"use client";

import { useState } from "react";
import { closeJobAction } from "./actions";
import SubmitButton from "@/components/SubmitButton";

const REASONS = [
  "Found a pro elsewhere",
  "No longer need the work",
  "Posted by mistake",
  "Taking too long",
  "Other",
];

// Close (cancel) a job posting. Clicking "Close job" opens a small panel that
// asks for a reason before confirming. The panel expands downward, so nothing
// shifts horizontally.
//
// Shown both for a job with no applicants yet (closeJobAction deletes it
// outright: nobody paid, nothing to preserve) and, now, for one that already
// has applicants (closeJobAction stamps owner_closed_at and notifies them
// instead - see the action for why it can't just flip status). applicantCount
// drives which honest copy shows in the confirm panel.
export default function CloseJobButton({
  leadId,
  applicantCount = 0,
}: {
  leadId: string;
  applicantCount?: number;
}) {
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState("");
  const [other, setOther] = useState("");

  if (!confirming) {
    return (
      <div className="flex justify-end">
        {/* Phone only: the bare text link measured 53x16, under the 44px thumb
            minimum. Same treatment as EditJobForm's "Edit job" beside it -
            max-sm makes it a real target, desktop keeps the plain text link,
            and -mr-3 cancels the padding so it still lines up with the card
            edge. */}
        <button
          type="button"
          onClick={() => setConfirming(true)}
          className="text-xs text-stone-500 hover:text-red-600 max-sm:-mr-3 max-sm:inline-flex max-sm:min-h-11 max-sm:items-center max-sm:px-3 dark:text-stone-400 dark:hover:text-red-400"
        >
          Close job
        </button>
      </div>
    );
  }

  return (
    <form action={closeJobAction} className="flex flex-col items-end gap-2">
      <input type="hidden" name="lead_id" value={leadId} />
      {applicantCount > 0 && (
        <p className="max-w-xs text-right text-xs text-stone-500 dark:text-stone-400">
          {applicantCount} pro{applicantCount === 1 ? " has" : "s have"}{" "}
          already paid to apply. Closing this won&apos;t pick anyone. Every
          applicant is notified, and their fee comes back as Hearth credit
          automatically within a week if nobody&apos;s chosen.
        </p>
      )}
      <select
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        className="select w-auto text-sm"
      >
        <option value="">
          Reason (optional)
        </option>
        {REASONS.map((r) => (
          <option key={r} value={r}>
            {r}
          </option>
        ))}
      </select>
      {reason === "Other" ? (
        <>
          <input
            value={other}
            onChange={(e) => setOther(e.target.value)}
            placeholder="Add a message (optional)"
            className="input w-56 text-sm"
          />
          {/* Optional: fall back to "Other" when they leave it blank. */}
          <input type="hidden" name="reason" value={other.trim() || "Other"} />
        </>
      ) : (
        <input type="hidden" name="reason" value={reason} />
      )}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => setConfirming(false)}
          className="btn-secondary text-sm"
        >
          Cancel
        </button>
        <SubmitButton className="btn-primary text-sm" pendingLabel="Closing…">
          Confirm close
        </SubmitButton>
      </div>
    </form>
  );
}
