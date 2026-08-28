"use client";

import { useState } from "react";
import Link from "next/link";
import { refreshMarketValueAction } from "./actions";
import SubmitButton from "@/components/SubmitButton";

// The "Refresh estimate" control under the headline number.
//
// THE DOOR IS VISIBLE BEFORE THE TAP. A free account does not get a button
// that fails: it gets the same-looking control carrying a "Plus" tag, and it
// goes to /plus instead of to the server. Nobody learns where the line is by
// running into it. The server action refuses a free account anyway
// (refreshMarketValueAction checks hasPlus before it can bill RentCast) - this
// is the honest half of the same gate, not the enforcing half.
export default function RefreshValue({ isPlus }: { isPlus: boolean }) {
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  if (!isPlus) {
    return (
      <Link href="/plus?reason=value" className="btn-secondary inline-block">
        Refresh estimate
        <span className="chip ml-1.5 bg-bark-100 text-bark-700 dark:bg-bark-700 dark:text-stone-300">
          Plus
        </span>
      </Link>
    );
  }

  return (
    <form
      action={async () => {
        const result = await refreshMarketValueAction();
        if (!result.ok) {
          setDone(false);
          setError(result.error);
          return;
        }
        setError(null);
        setDone(true);
      }}
      className="space-y-2"
    >
      {/* pendingLabel is the whole point of routing this through
          SubmitButton: an AVM lookup is a network round trip to RentCast, so
          without a pending state the button looks dead for a second or two and
          gets tapped twice. */}
      <SubmitButton className="btn-secondary" pendingLabel="Refreshing…">
        Refresh estimate
      </SubmitButton>
      {error && (
        <p role="alert" className="text-xs text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
      {done && !error && (
        <p className="text-xs text-stone-500 dark:text-stone-400">
          Estimate updated.
        </p>
      )}
    </form>
  );
}
