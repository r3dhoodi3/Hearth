"use client";

import { useState } from "react";
import { JOB_CATEGORIES } from "@/lib/constants";
import { reportReviewMoment } from "@/lib/nativeReview";
import type { ActionResult } from "@/lib/actionResult";

const MIN_DESCRIPTION = 20;

// "Hire again" button on a My Pros row. Opens a small form (category
// preselected from the last job, free-text description) that submits through
// rehireProAction, which creates the repeat lead free (no apply fee) and
// routes to the new chat thread with that pro.
//
// Submitted programmatically (not a plain <form action>) so the modal only
// closes once rehireProAction actually returns ok(): a failure keeps it open
// with the typed description intact and shows the error inline. The
// description is trimmed before the length check on the client too, not just
// the browser's minLength (which counts raw characters): the server already
// trims, so 20 spaces used to pass here and fail there with no useful error.
export default function HireAgainButton({
  contractorId,
  contractorName,
  lastCategory,
  action,
}: {
  contractorId: string;
  contractorName: string;
  lastCategory: string;
  action: (formData: FormData) => Promise<ActionResult>;
}) {
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState(lastCategory);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="btn-secondary shrink-0 text-sm"
      >
        Hire again
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-pop dark:bg-stone-800">
            <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
              Hire {contractorName} again
            </h2>
            <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">
              This is a free repeat lead: no apply fee, since you&apos;ve already
              worked together. Tell them what you need and we&apos;ll open a chat.
            </p>

            <form
              onSubmit={async (e) => {
                e.preventDefault();
                const fd = new FormData(e.currentTarget);
                const desc = String(fd.get("description") ?? "").trim();
                if (desc.length < MIN_DESCRIPTION) {
                  setError(
                    "Please describe the job in at least 20 characters so your pro knows what to expect."
                  );
                  return;
                }
                setPending(true);
                setError(null);
                try {
                  const res = await action(fd);
                  if (res.ok) {
                    // Hiring a pro is one of the two positive moments that can
                    // earn a native store-review ask later in the session (see
                    // src/lib/nativeReview.ts). It only records the moment; the
                    // ask itself waits for a calm one, and does nothing at all
                    // on the web.
                    reportReviewMoment("job_hired");
                    setOpen(false);
                  } else setError(res.error);
                } catch (err: any) {
                  // Trap: rehireProAction redirects straight to the new chat
                  // thread on success, and redirect() does that by throwing a
                  // NEXT_REDIRECT-digest error for Next's router to catch
                  // higher up. A bare catch here swallows that throw and
                  // reports a successful rehire as "something went wrong" -
                  // rethrow it so the redirect still happens, only treat
                  // everything else as a real failure.
                  if (err?.digest?.startsWith("NEXT_REDIRECT")) {
                    // The redirect IS the success path here, so the positive
                    // moment is recorded on this branch too. sessionStorage,
                    // not state, precisely because the page is about to be
                    // replaced by the new chat thread.
                    reportReviewMoment("job_hired");
                    throw err;
                  }
                  setError("Something went wrong. Please try again.");
                } finally {
                  setPending(false);
                }
              }}
              className="mt-4 space-y-4"
            >
              <input type="hidden" name="contractor_id" value={contractorId} />
              <div>
                <label className="label">What do you need?</label>
                <select
                  name="category"
                  className="select"
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                  required
                >
                  {JOB_CATEGORIES.map((c) => (
                    <option key={c.value} value={c.value}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="label">Describe the job</label>
                <textarea
                  name="description"
                  className="textarea"
                  rows={3}
                  minLength={20}
                  required
                  placeholder="What needs doing this time? At least 20 characters so they know what to expect."
                />
              </div>
              {error && (
                <p role="alert" className="text-sm font-medium text-red-600 dark:text-red-400">
                  {error}
                </p>
              )}
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="btn-secondary flex-1"
                  disabled={pending}
                >
                  Cancel
                </button>
                <button type="submit" className="btn-primary flex-1" disabled={pending}>
                  {pending ? "Sending…" : "Send"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
