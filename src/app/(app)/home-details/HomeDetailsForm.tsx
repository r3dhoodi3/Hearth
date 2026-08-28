"use client";

import { useState } from "react";
import { updatePropertyAction } from "../profile/actions";
import SubmitButton from "@/components/SubmitButton";

export default function HomeDetailsForm({
  yearBuilt,
  sqft,
  beds,
  baths,
  lotSizeSqft,
  purchaseDate,
}: {
  yearBuilt: number | null;
  sqft: number | null;
  beds: number | null;
  baths: number | null;
  lotSizeSqft: number | null;
  purchaseDate: string | null;
}) {
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  return (
    <form
      action={async (fd) => {
        setSaved(false);
        // updatePropertyAction (src/app/(app)/profile/actions.ts) treats a
        // blank box as "leave it as it is," not "clear this fact" - see the
        // comment there. So it is always safe to resubmit the whole form,
        // even if the owner only meant to fix one field.
        const result = await updatePropertyAction(fd);
        if (!result.ok) {
          setError(result.error);
          return;
        }
        setError(null);
        setSaved(true);
      }}
      onChange={() => setSaved(false)}
      className="card space-y-4"
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="year_built">
            Year built
          </label>
          <input
            id="year_built"
            name="year_built"
            type="number"
            inputMode="numeric"
            min={1700}
            max={2100}
            className="input"
            placeholder="e.g. 1998"
            defaultValue={yearBuilt ?? ""}
          />
        </div>
        <div>
          <label className="label" htmlFor="sqft">
            Square feet
          </label>
          <input
            id="sqft"
            name="sqft"
            type="number"
            inputMode="numeric"
            min={1}
            className="input"
            placeholder="e.g. 1800"
            defaultValue={sqft ?? ""}
          />
        </div>
        <div>
          <label className="label" htmlFor="beds">
            Bedrooms
          </label>
          <input
            id="beds"
            name="beds"
            type="number"
            inputMode="numeric"
            min={0}
            className="input"
            placeholder="e.g. 3"
            defaultValue={beds ?? ""}
          />
        </div>
        <div>
          <label className="label" htmlFor="baths">
            Bathrooms
          </label>
          <input
            id="baths"
            name="baths"
            type="number"
            // decimal, not numeric: half-baths (2.5) are a real, common value
            // and baths is stored as numeric(3,1), unlike the whole-number
            // fields above.
            inputMode="decimal"
            min={0}
            // numeric(3,1) tops out at 99.9. The server refuses anything above
            // it with a message naming the range (updatePropertyAction); this
            // is only the browser's own hint, so the number spinner stops in
            // the right place.
            max={99.9}
            step={0.5}
            className="input"
            placeholder="e.g. 2.5"
            defaultValue={baths ?? ""}
          />
        </div>
        <div>
          <label className="label" htmlFor="lot_size_sqft">
            Lot size (sq ft)
          </label>
          <input
            id="lot_size_sqft"
            name="lot_size_sqft"
            type="number"
            inputMode="numeric"
            min={0}
            className="input"
            placeholder="e.g. 6000"
            defaultValue={lotSizeSqft ?? ""}
          />
        </div>
        <div>
          <label className="label" htmlFor="purchase_date">
            Purchase date
          </label>
          <input
            id="purchase_date"
            name="purchase_date"
            type="date"
            className="input"
            defaultValue={purchaseDate ?? ""}
          />
        </div>
      </div>

      {error && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
      {saved && !error && (
        <p role="status" className="text-sm font-medium text-green-700 dark:text-green-400">
          Saved
        </p>
      )}

      <SubmitButton pendingLabel="Saving…" className="btn-primary w-full sm:w-auto">
        Save
      </SubmitButton>
    </form>
  );
}
