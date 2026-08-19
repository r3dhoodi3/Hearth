"use client";

import { useState } from "react";
import { reportIssueAction } from "./actions";
import PhotoUpload from "@/components/PhotoUpload";
import PhotoTips from "@/components/PhotoTips";
import SubmitButton from "@/components/SubmitButton";
import { ISSUE_CATEGORIES, SEVERITIES, SYSTEM_TYPES, labelFor } from "@/lib/constants";
import type { HomeSystem } from "@/lib/database.types";

export default function IssueForm({
  propertyId,
  systems,
}: {
  propertyId: string;
  systems: HomeSystem[];
}) {
  const [open, setOpen] = useState(false);
  // A validation/save error keeps the owner on this page with their typed
  // report intact, so it comes back as an ActionResult rendered inline here
  // rather than through the flash cookie (unread on a stay-on-page action). On
  // success the action redirects, so control never returns and `res` is
  // undefined.
  const [error, setError] = useState<string | null>(null);

  if (!open) {
    return (
      <button className="btn-primary" onClick={() => setOpen(true)}>
        + Report an issue
      </button>
    );
  }

  return (
    <form
      action={async (fd) => {
        setError(null);
        const res = await reportIssueAction(fd);
        if (res && !res.ok) setError(res.error);
      }}
      className="card space-y-4"
    >
      <h3 className="font-semibold text-stone-900 dark:text-stone-100">Report an issue</h3>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label className="label">Category</label>
          <select name="category" className="select" required>
            {ISSUE_CATEGORIES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label">Severity</label>
          <select name="severity" className="select" required defaultValue="medium">
            {SEVERITIES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {systems.length > 0 && (
        <div>
          <label className="label">Related system (optional)</label>
          <select name="system_id" className="select" defaultValue="">
            <option value="">- none -</option>
            {systems.map((s) => (
              <option key={s.id} value={s.id}>
                {labelFor(SYSTEM_TYPES, s.system_type)}
                {s.material_or_model ? ` · ${s.material_or_model}` : ""}
              </option>
            ))}
          </select>
        </div>
      )}

      <div>
        <label className="label">What&apos;s going on?</label>
        <textarea
          name="description"
          className="textarea"
          rows={3}
          placeholder="e.g. Water pooling under the kitchen sink after running the dishwasher."
        />
      </div>

      <PhotoUpload propertyId={propertyId} />
      <PhotoTips />

      {error && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}

      <div className="flex gap-3">
        <button type="button" className="btn-secondary" onClick={() => setOpen(false)}>
          Cancel
        </button>
        <SubmitButton pendingLabel="Logging…">Log issue</SubmitButton>
      </div>
      <p className="text-xs text-stone-500 dark:text-stone-400">
        After logging, we&apos;ll offer to connect you with a local pro.
      </p>
    </form>
  );
}
