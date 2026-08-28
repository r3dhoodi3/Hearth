"use client";

import { useState } from "react";
import { setExtraHomesAction } from "./actions";
import SubmitButton from "@/components/SubmitButton";
import { EXTRA_HOME, extraHomeUnitPrice } from "@/lib/constants";

// The "More homes" control for a live monthly/yearly Plus member. Plus includes
// 5 homes; this buys extra ones on top, at the volume price that applies to ALL
// bought slots once the quantity crosses a tier (see EXTRA_HOME). The recurring
// total is shown honestly BEFORE confirming, with the auto-renew disclosure, so
// a member always sees the amount their card will be charged.
//
// `interval` is the member's own plan cadence: the add-on always bills on the
// same cadence as the base plan.
export default function ExtraHomes({
  interval,
  currentSlots,
  homesUsed,
}: {
  interval: "monthly" | "yearly";
  currentSlots: number;
  homesUsed: number;
}) {
  const [qty, setQty] = useState(currentSlots);

  const perUnit = interval === "monthly" ? "/mo" : "/yr";
  const perTerm = interval === "monthly" ? "a month" : "a year";
  const unit = extraHomeUnitPrice(interval, qty);
  const total = (unit * qty).toFixed(2);
  const included = 5;
  const capacity = included + qty;
  const currentCapacity = included + currentSlots;
  const changed = qty !== currentSlots;

  // Human-readable tier hints, derived from EXTRA_HOME so the copy can never
  // drift from what's charged. Each tier's lower bound is the previous tier's
  // upTo + 1.
  const tiers = EXTRA_HOME[interval];
  let lower = 1;
  const tierHints = tiers.map((t) => {
    const price = `$${t.unit.toFixed(2)}${perUnit}`;
    let range: string;
    if (t.upTo === null) {
      range = `${lower} or more`;
    } else if (t.upTo === lower) {
      range = `${lower}`;
    } else {
      range = `${lower} to ${t.upTo}`;
    }
    lower = (t.upTo ?? lower) + 1;
    return `${range}: ${price} each`;
  });

  const clamp = (n: number) => Math.max(0, Math.min(EXTRA_HOME.maxExtra, n));

  return (
    <div className="card space-y-4 text-left">
      <div>
        <p className="text-sm font-semibold text-stone-900 dark:text-stone-100">
          More homes
        </p>
        <p className="mt-1 text-sm text-stone-600 dark:text-stone-300">
          You&apos;re using {homesUsed} of {currentCapacity} homes. Plus includes
          5. Add more below.
        </p>
      </div>

      {homesUsed > currentCapacity && (
        <p className="rounded-lg border border-stone-200 bg-stone-50 p-3 text-xs text-stone-600 dark:border-white/10 dark:bg-stone-900 dark:text-stone-300">
          You have more homes than your current plan covers. Your existing homes
          are safe and stay put. You just can&apos;t add a new one until you have
          a free slot.
        </p>
      )}

      {/* Quantity stepper. */}
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm text-stone-700 dark:text-stone-300">
          Extra homes
        </span>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setQty((q) => clamp(q - 1))}
            disabled={qty <= 0}
            aria-label="Fewer homes"
            className="flex h-9 w-9 items-center justify-center rounded-lg border border-stone-200 text-lg text-stone-700 hover:border-stone-300 disabled:opacity-40 max-sm:h-11 max-sm:w-11 dark:border-white/10 dark:text-stone-300"
          >
            −
          </button>
          <span className="w-8 text-center text-lg font-semibold text-stone-900 dark:text-stone-100">
            {qty}
          </span>
          <button
            type="button"
            onClick={() => setQty((q) => clamp(q + 1))}
            disabled={qty >= EXTRA_HOME.maxExtra}
            aria-label="More homes"
            className="flex h-9 w-9 items-center justify-center rounded-lg border border-stone-200 text-lg text-stone-700 hover:border-stone-300 disabled:opacity-40 max-sm:h-11 max-sm:w-11 dark:border-white/10 dark:text-stone-300"
          >
            +
          </button>
        </div>
      </div>

      {/* Honest bulk-price breakdown. */}
      <ul className="space-y-1 text-xs text-stone-500 dark:text-stone-400">
        {tierHints.map((h) => (
          <li key={h}>{h}</li>
        ))}
      </ul>

      {/* Recurring total, shown before confirming, with the auto-renew
          disclosure. California's ARL requires a clear recurring-amount
          disclosure when the recurring charge changes. */}
      <div className="rounded-xl border border-stone-200 bg-stone-50 p-3 dark:border-white/10 dark:bg-stone-900">
        {qty > 0 ? (
          <>
            <p className="text-sm font-medium text-stone-900 dark:text-stone-100">
              {qty} extra {qty === 1 ? "home" : "homes"} at ${unit.toFixed(2)}{" "}
              each: ${total} {perTerm}
            </p>
            <p className="mt-1 text-xs text-stone-600 dark:text-stone-300">
              This is added to your Plus plan and charged to the same payment
              method every {interval === "monthly" ? "month" : "12 months"} until
              you change or remove it. Prorated for the rest of your current
              period. You can remove extra homes anytime from this page.
            </p>
          </>
        ) : (
          <p className="text-sm text-stone-600 dark:text-stone-300">
            No extra homes. You can track up to 5 with Plus.
          </p>
        )}
      </div>

      <form action={setExtraHomesAction}>
        <input type="hidden" name="quantity" value={qty} />
        <SubmitButton
          className="btn-primary w-full"
          pendingLabel="Updating…"
          disabled={!changed}
        >
          {qty > currentSlots
            ? `Add homes (now ${capacity} total)`
            : qty < currentSlots
              ? qty === 0
                ? "Remove extra homes"
                : `Reduce to ${capacity} homes`
              : "Update homes"}
        </SubmitButton>
      </form>
    </div>
  );
}
