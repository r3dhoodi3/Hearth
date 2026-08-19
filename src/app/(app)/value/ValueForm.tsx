"use client";

import { useState } from "react";
import { saveHomeValueAction } from "./actions";
import SubmitButton from "@/components/SubmitButton";

export default function ValueForm({
  purchasePrice,
  purchaseYear,
  mortgageBalance,
  currentYear,
  startOpen,
}: {
  purchasePrice: number | null;
  purchaseYear: number | null;
  mortgageBalance: number | null;
  currentYear: number;
  startOpen: boolean;
}) {
  const [open, setOpen] = useState(startOpen);
  const [error, setError] = useState<string | null>(null);
  const hasData = purchasePrice != null && purchaseYear != null;

  if (!open) {
    return (
      <button className="btn-secondary" onClick={() => setOpen(true)}>
        Edit these numbers
      </button>
    );
  }

  return (
    <form
      action={async (fd) => {
        // Only collapse when the server confirms the save stuck. A rejected
        // or soft-failed save still resolves, and closing on that would show
        // the old numbers as if the new ones were saved. The reason comes back
        // as an ActionResult and shows inline (the flash cookie is unread on
        // this stay-on-page save).
        const result = await saveHomeValueAction(fd);
        if (!result.ok) {
          setError(result.error);
          return;
        }
        setError(null);
        if (!hasData) return;
        setOpen(false);
      }}
      className="card space-y-4"
    >
      <h3 className="font-semibold text-stone-900 dark:text-stone-100">
        {hasData ? "Update your numbers" : "Tell us about your purchase"}
      </h3>
      {!hasData && (
        <p className="text-sm text-stone-500 dark:text-stone-400">
          Just two numbers to get started. We will estimate the rest.
        </p>
      )}

      <div className="grid gap-3 sm:grid-cols-3">
        <div>
          <label className="label">What you paid</label>
          {/* step="any": a step of 1000 makes the browser REJECT real prices
              like 652500 with a native validation error (values must land on
              the step grid). Real purchase prices are not round thousands. */}
          <input
            name="purchase_price"
            type="number"
            min="1"
            step="any"
            className="input"
            placeholder="350000"
            defaultValue={purchasePrice ?? ""}
            required
          />
        </div>
        <div>
          <label className="label">Year you bought it</label>
          <input
            name="purchase_year"
            type="number"
            min="1900"
            max={currentYear}
            className="input"
            placeholder={String(currentYear)}
            defaultValue={purchaseYear ?? ""}
            required
          />
        </div>
        <div>
          <label className="label">Mortgage balance (optional)</label>
          <input
            name="mortgage_balance"
            type="number"
            min="0"
            step="any"
            className="input"
            placeholder="0 if paid off"
            defaultValue={mortgageBalance ?? ""}
          />
        </div>
      </div>

      {error && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}

      <div className="flex gap-3">
        {hasData && (
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
        )}
        <SubmitButton>Save</SubmitButton>
      </div>
    </form>
  );
}
