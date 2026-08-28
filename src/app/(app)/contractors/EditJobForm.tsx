"use client";

import { useState } from "react";
import { updateJobAction } from "./actions";
import { TIMING_OPTIONS } from "@/lib/constants";
import CategoryFilter from "./CategoryFilter";
import PhoneInput from "@/components/PhoneInput";

const MIN_DESCRIPTION = 20;

// Inline editor for a posted job. Shows an "Edit" link that opens a prefilled
// form (same fields as posting). Calls updateJobAction programmatically so it
// can read the ActionResult back: the panel only closes on a real ok(), and a
// validation failure keeps it open with what was typed and shows the error
// inline instead of closing optimistically and losing it.
export default function EditJobForm({ job }: { job: any }) {
  const [editing, setEditing] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!editing) {
    return (
      <div className="flex justify-end">
        {/* Phone only: the bare text link measured 43x16, well under the 44px
            thumb minimum. max-sm turns it into a real target without touching
            the desktop rendering, where it stays a plain inline text link.
            -mr-3 cancels the added horizontal padding so the label still
            lines up with the card's right edge. */}
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="text-xs font-medium text-bark-700 hover:underline max-sm:-mr-3 max-sm:inline-flex max-sm:min-h-11 max-sm:items-center max-sm:px-3 dark:text-stone-300"
        >
          Edit job
        </button>
      </div>
    );
  }

  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setPending(true);
        setError(null);
        try {
          const res = await updateJobAction(new FormData(e.currentTarget));
          if (res.ok) setEditing(false);
          else setError(res.error);
        } catch {
          // A rejected server action (network blip, server hiccup) must not
          // strand the button in its pending state with no explanation.
          setError("Something went wrong. Please try again.");
        } finally {
          setPending(false);
        }
      }}
      className="space-y-3 rounded-lg border border-stone-200 bg-stone-50 p-3 dark:border-white/10 dark:bg-stone-700"
    >
      <input type="hidden" name="lead_id" value={job.id} />
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="label">What do you need?</label>
          <CategoryFilter category={job.category ?? ""} />
        </div>
        <div>
          <label className="label">Preferred timing</label>
          <select
            name="timing"
            className="select"
            defaultValue={job.timing ?? "few_weeks"}
          >
            {TIMING_OPTIONS.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div>
        {/* Not "optional": updateJobAction enforces the same 20-character
            floor postJobAction does (pros pay to apply, so an edit can't
            blank out what they're applying to). minLength surfaces that in
            the browser before the action rejects it. */}
        <label className="label">Details about your project</label>
        <textarea
          name="message"
          className="textarea"
          rows={3}
          minLength={MIN_DESCRIPTION}
          defaultValue={job.issue_description ?? ""}
        />
        <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
          At least 20 characters so pros know what they&apos;re applying to.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <div>
          <label className="label">First and last name</label>
          <input
            name="homeowner_name"
            className="input"
            defaultValue={job.homeowner_name ?? ""}
            required
          />
        </div>
        <div>
          <label className="label">Email (optional)</label>
          <input
            name="homeowner_email"
            type="email"
            className="input"
            defaultValue={job.homeowner_email ?? ""}
          />
        </div>
        <div>
          <label className="label">Phone (optional)</label>
          <PhoneInput
            name="homeowner_phone"
            defaultValue={job.homeowner_phone ?? ""}
          />
          <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
            So pros can reach you faster (optional).
          </p>
        </div>
      </div>
      {error && (
        <p role="alert" className="text-sm font-medium text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => setEditing(false)}
          className="btn-secondary text-sm"
          disabled={pending}
        >
          Cancel
        </button>
        <button
          type="submit"
          className="btn-primary flex-1 text-sm"
          disabled={pending}
        >
          {pending ? "Saving…" : "Save changes"}
        </button>
      </div>
    </form>
  );
}
