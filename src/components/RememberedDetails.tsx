"use client";

import { useLayoutEffect, useRef, type ReactNode } from "react";

// A <details> that starts OPEN every visit and only stays closed if the user
// closed it themselves. The owner's rule: "as long as they don't manually
// close it, it stays open" - open on the first visit and on the thousandth.
//
// Why the open state is not a React state value: the server renders the
// element with `open` so the content is there for the very first paint and for
// a no-JS render, and a remembered close is applied in useLayoutEffect (before
// paint, so it never flashes open then snaps shut). Rendering `open` from
// state would either mismatch hydration or need a two-pass render.
//
// The remembered flag lives in localStorage under a key namespaced by user id,
// same shape as SeasonalChecklist's per-period keys: it is a per-device UI
// preference, not data worth a round trip.
const PREFIX = "hearth_details_closed_";

export default function RememberedDetails({
  storageKey,
  forceOpen = false,
  className,
  testId,
  children,
}: {
  // Unique per surface AND per user, for example `this-month-${userId}`.
  storageKey: string;
  // An explicit request to see it (today: ?plan=open). Forces it open and
  // clears the remembered close, so "View my plan" is not silently a no-op.
  forceOpen?: boolean;
  className?: string;
  testId?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDetailsElement>(null);
  const key = `${PREFIX}${storageKey}`;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (forceOpen) {
      try {
        localStorage.removeItem(key);
      } catch {
        /* private mode / storage disabled: open is the default anyway */
      }
      el.open = true;
      return;
    }
    let closed = false;
    try {
      closed = localStorage.getItem(key) === "1";
    } catch {
      /* ignore */
    }
    if (closed) el.open = false;
  }, [key, forceOpen]);

  return (
    <details
      ref={ref}
      open
      className={className}
      data-testid={testId}
      onToggle={(e) => {
        // Closing is remembered, opening forgets it. Writing on every toggle
        // (including the one our own layout effect causes) is idempotent.
        try {
          if (e.currentTarget.open) localStorage.removeItem(key);
          else localStorage.setItem(key, "1");
        } catch {
          /* ignore */
        }
      }}
    >
      {children}
    </details>
  );
}
