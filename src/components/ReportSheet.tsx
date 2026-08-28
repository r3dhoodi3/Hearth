"use client";

import { useState } from "react";
import InlineSpinner from "@/components/InlineSpinner";
import { REPORT_REASONS } from "@/lib/reportReasons";
import { reportContentAction } from "@/lib/reportActions";
import type { ActionResult } from "@/lib/actionResult";
import type { ReportTargetType } from "@/lib/reportReasons";

// The quiet "Report" control that sits under a review and on a pro's public
// profile. Deliberately small and grey: it should be findable when somebody
// needs it and invisible the rest of the time, which is the opposite of how it
// would look if it were styled as a real button.
//
// Opens in place rather than in a modal. A modal here would mean trapping
// focus, an escape handler and a scroll lock for a form with two fields, and
// on a 390px phone the in-place panel is the better shape anyway: the thing
// being reported stays on screen above it.
export default function ReportSheet({
  targetType,
  targetId,
  label = "Report",
  openLabel,
  className = "",
  action = reportContentAction,
}: {
  targetType: ReportTargetType;
  targetId: string;
  // Text of the closed control.
  label?: string;
  // Heading shown once the panel is open. Defaults to the label.
  openLabel?: string;
  className?: string;
  // Injectable for tests. Production always uses the real server action.
  // `data`, when the action returns one, is the line to show in place of the
  // default thank-you: today that is only the already-reported case.
  action?: (formData: FormData) => Promise<ActionResult<string>>;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<string>(REPORT_REASONS[0]);
  const [note, setNote] = useState("");
  const [doneMessage, setDoneMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    const fd = new FormData();
    fd.set("target_type", targetType);
    fd.set("target_id", targetId);
    fd.set("reason", reason);
    fd.set("note", note);
    try {
      const res = await action(fd);
      if (res && !res.ok) {
        // Stay open with the reason still picked, so a retry is one tap.
        setError(res.error);
        return;
      }
      setDoneMessage(typeof res?.data === "string" ? res.data : null);
      setDone(true);
      setOpen(false);
    } catch {
      setError("Couldn't send that report. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <p className={`text-xs text-stone-500 dark:text-stone-400 ${className}`}>
        {/* The action only overrides this to say the report was already on
            file - a second identical report is now a unique-index hit (0139)
            rather than a duplicate row, and telling someone it failed would
            just have them file a third. */}
        {doneMessage ?? "Thanks, we'll take a look."}
      </p>
    );
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={`text-xs text-stone-500 hover:text-red-600 max-sm:inline-flex max-sm:min-h-11 max-sm:items-center dark:text-stone-400 dark:hover:text-red-400 ${className}`}
      >
        {label}
      </button>
    );
  }

  return (
    <div
      className={`mt-2 rounded-lg border border-stone-200 p-3 dark:border-white/10 ${className}`}
    >
      <p className="text-xs font-medium text-stone-900 dark:text-stone-100">
        {openLabel ?? label}
      </p>

      <label className="mt-2 block">
        <span className="sr-only">Reason</span>
        <select
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          disabled={busy}
          className="input w-full text-sm"
          aria-label="Reason"
        >
          {REPORT_REASONS.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </label>

      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        rows={2}
        maxLength={1000}
        disabled={busy}
        placeholder="Anything else we should know? (optional)"
        aria-label="Anything else we should know"
        className="input mt-2 w-full text-sm"
      />

      {error && (
        <p role="alert" className="mt-2 text-xs text-red-600 dark:text-red-400">
          {error}
        </p>
      )}

      <div className="mt-2 flex items-center gap-3">
        <button
          type="button"
          onClick={submit}
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-md bg-red-600 px-3 py-1 text-xs font-medium text-white max-sm:min-h-11 max-sm:px-4 disabled:opacity-50"
        >
          {busy && <InlineSpinner size={12} />}
          Send report
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          disabled={busy}
          className="text-xs text-stone-500 hover:text-stone-600 max-sm:inline-flex max-sm:min-h-11 max-sm:items-center disabled:opacity-50 dark:text-stone-400 dark:hover:text-stone-300"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
