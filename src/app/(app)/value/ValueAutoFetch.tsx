"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { fetchAndSaveMarketValueAction } from "./actions";

function money(n: number): string {
  return `$${Math.round(n).toLocaleString()}`;
}

// Kicks off the lazy RentCast AVM (market value) lookup the FIRST time someone
// opens /value, off the render path (the server component never writes to the
// DB during render). needsFetch is computed server-side from market_value
// being null plus an address on file.
//
// A per-property flag in localStorage means we attempt this exactly once, ever,
// per browser. This matters for the MISS case: if the address returns no value,
// market_value stays null, so without this guard the fetch would re-fire every
// single time the tab is reopened. We mark "tried" BEFORE firing, so even a
// failed or empty lookup is never retried on reopen. The in-memory ref still
// guards React Strict Mode's dev double-invoke within one mount.
export default function ValueAutoFetch({
  needsFetch,
  propertyId,
  silent = false,
}: {
  needsFetch: boolean;
  propertyId: string;
  // The dashboard mounts this inside its home-value tile purely to trigger the
  // lookup; the refreshed tile is the feedback, so it renders nothing of its
  // own. The localStorage flag below is keyed on the property, not the page,
  // so whichever screen the owner opens first spends the one attempt and the
  // other never repeats it.
  silent?: boolean;
}) {
  const router = useRouter();
  const firedRef = useRef(false);
  // The number the action just fetched, shown right away instead of leaving
  // this component blank until router.refresh() below re-renders the whole
  // page's server-side card. Read live against the current `needsFetch` prop
  // (not a snapshot from when the fetch started), so this note disappears the
  // instant the refreshed page takes over showing the real card - there's
  // never a moment with both on screen.
  const [fetched, setFetched] = useState<number | null>(null);

  useEffect(() => {
    if (!needsFetch || firedRef.current) return;
    firedRef.current = true;

    const flagKey = `hearth_avm_tried_${propertyId}`;
    try {
      // Already attempted once for this property: never run again, hit or miss.
      if (localStorage.getItem(flagKey)) return;
      localStorage.setItem(flagKey, "1");
    } catch {
      // localStorage unavailable (private mode, etc.): fall through and attempt
      // once for this mount anyway; the ref guard still prevents a double-fire.
    }

    fetchAndSaveMarketValueAction()
      .then((result) => {
        if (!result?.ok) return;
        if (typeof result.marketValue === "number") {
          setFetched(result.marketValue);
        }
        // Still needed to update everything else that is derived from the
        // market value server-side (equity, the value-over-time chart, the
        // purchase-price comparison) - the local number above just means the
        // owner isn't staring at nothing while that round trip is in flight.
        router.refresh();
      })
      .catch(() => {
        // Fail soft: leave whatever estimate the page already showed.
      });
  }, [needsFetch, propertyId, router]);

  if (silent || fetched == null || !needsFetch) return null;

  return (
    <p className="mb-4 rounded-lg border border-bark-100 bg-bark-50 px-3 py-2 text-center text-sm font-medium text-bark-700 dark:border-bark-700/40 dark:bg-bark-700/20 dark:text-stone-300">
      Estimated value: {money(fetched)}
    </p>
  );
}
