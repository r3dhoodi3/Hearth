"use client";

import { useState } from "react";
import { updateJobAction } from "./actions";
import { TIMING_OPTIONS } from "@/lib/constants";
import CategoryFilter from "./CategoryFilter";
import PhoneInput from "@/components/PhoneInput";
import {
  normalizeContactEmail,
  normalizeContactPhone,
} from "@/lib/contactFields";
import { parseOtherService } from "./otherService";

const MIN_DESCRIPTION = 10;

// Inline editor for a posted job. Shows an "Edit" link that opens a prefilled
// form (same fields as posting). Calls updateJobAction programmatically so it
// can read the ActionResult back: the panel only closes on a real ok(), and a
// validation failure keeps it open with what was typed and shows the error
// inline instead of closing optimistically and losing it.
export default function EditJobForm({ job }: { job: any }) {
  const [editing, setEditing] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Splits an "Other" job's stored description back into the owner's service
  // name and the description proper (see ./otherService.ts). A no-op for
  // every other category: name is "" and rest is the description as stored.
  const otherService = parseOtherService(job.issue_description ?? "");

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
        setError(null);
        const fd = new FormData(e.currentTarget);
        const email = String(fd.get("homeowner_email") ?? "").trim();
        const phone = String(fd.get("homeowner_phone") ?? "").trim();
        if (!email && !phone) {
          setError("Please add an email or phone number so pros can reach you.");
          return;
        }
        // Same shape checks the action runs (src/lib/contactFields.ts), so a
        // half-typed phone number is caught before the round trip.
        if (
          (email && normalizeContactEmail(email) === null) ||
          (phone && normalizeContactPhone(phone) === null)
        ) {
          setError(
            "That email address or phone number doesn't look right. Please check it and try again."
          );
          return;
        }
        setPending(true);
        try {
          const res = await updateJobAction(fd);
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
          {/* An "Other" job keeps its service name inside the description as
              a "Service needed: ..." prefix (there is no column for it), so
              the edit form pulls it back out: without this the inline field
              opened blank and `required` forced the owner to retype the name
              on every unrelated edit. */}
          <CategoryFilter
            category={job.category ?? ""}
            otherDefault={otherService.name}
          />
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
        {/* Not "optional": updateJobAction enforces the same 10-character
            floor postJobAction does (pros pay to apply, so an edit can't
            blank out what they're applying to). minLength surfaces that in
            the browser before the action rejects it. */}
        <label className="label">Details about your project</label>
        {/* The stored description for an "Other" job carries the service name
            as a "Service needed: ..." prefix; this box shows only what the
            owner typed, and updateJobAction puts the prefix back on save.
            For every other category parseOtherService hands the description
            back untouched. */}
        <textarea
          name="message"
          className="textarea"
          rows={3}
          minLength={MIN_DESCRIPTION}
          defaultValue={otherService.rest}
        />
        <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
          At least 10 characters so pros know what they&apos;re applying to.
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
          <label className="label">Email</label>
          <input
            name="homeowner_email"
            type="email"
            className="input"
            defaultValue={job.homeowner_email ?? ""}
          />
        </div>
        <div>
          <label className="label">Phone</label>
          <PhoneInput
            name="homeowner_phone"
            defaultValue={job.homeowner_phone ?? ""}
          />
          <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
            Add email or phone, whichever&apos;s easiest for pros to reach you.
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
