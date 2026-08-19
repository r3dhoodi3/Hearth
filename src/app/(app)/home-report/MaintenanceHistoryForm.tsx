"use client";

import { useRef, useState } from "react";
import { addMaintenanceHistoryAction } from "./actions";
import SubmitButton from "@/components/SubmitButton";

// Lets the owner log a past maintenance event (date, what was done, optional
// cost/pro) directly. Never AI-generated: every field here is something the
// owner typed in. Print:hidden - a report someone shares with a buyer or
// insurer shouldn't include an empty "add an entry" button.
export default function MaintenanceHistoryForm() {
  const [open, setOpen] = useState(false);
  // A validation error (missing fields, a duplicate, or a failed save) keeps
  // the owner here with what they typed intact, shown inline. Previously the
  // form reset and closed no matter what, so an error both vanished and wiped
  // the entry.
  const [error, setError] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  if (!open) {
    return (
      <button
        type="button"
        className="btn-secondary print:hidden"
        onClick={() => setOpen(true)}
      >
        + Log something you had done
      </button>
    );
  }

  return (
    <form
      ref={formRef}
      action={async (fd) => {
        const res = await addMaintenanceHistoryAction(fd);
        if (!res.ok) {
          setError(res.error);
          return;
        }
        setError(null);
        formRef.current?.reset();
        setOpen(false);
      }}
      className="card print:hidden space-y-3"
    >
      <h3 className="font-semibold text-stone-900 dark:text-stone-100">Log a maintenance record</h3>
      <div className="grid grid-cols-2 gap-3">
        <div className="col-span-2">
          <label className="label">What was done</label>
          <input
            name="title"
            className="input"
            placeholder="Furnace serviced"
            required
          />
        </div>
        <div>
          <label className="label">Date</label>
          <input
            name="completed_date"
            type="date"
            className="input"
            max={new Date().toISOString().slice(0, 10)}
            required
          />
        </div>
        <div>
          <label className="label">Cost (optional)</label>
          <input
            name="cost"
            inputMode="decimal"
            className="input"
            placeholder="150"
          />
        </div>
        <div className="col-span-2">
          <label className="label">Pro or vendor (optional)</label>
          <input
            name="performed_by"
            className="input"
            placeholder="ABC Heating & Air"
          />
        </div>
      </div>
      {error && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <button
          type="button"
          className="btn-secondary"
          onClick={() => {
            setError(null);
            setOpen(false);
          }}
        >
          Cancel
        </button>
        <SubmitButton>Save entry</SubmitButton>
      </div>
    </form>
  );
}
