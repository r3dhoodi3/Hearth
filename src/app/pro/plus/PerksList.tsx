"use client";

// STREAMING FIX, not a behaviour change. Mirrors src/components/pro/SetupChecklist.tsx
// (investigated in scratchpad/debug-DBG3.md): PERKS.map() used to render six
// description-heavy cards or list rows inline inside a Server Component, and on this
// page that block sits at (or past) the point where React Flight's 3200-byte-per-row
// serialization budget runs out. Past that budget Flight defers every further element
// it meets into its own row, which Fizz then streams as an out-of-order segment - a
// <template id="P:n"> hole nested inside the page's own markup plus a late $RS(...) fill
// script, instead of the one clean top-level hole a healthy page has. That is the exact
// shape DBG3 found on /pro (eight holes, chained through SetupChecklist's <ul>) and it
// matches the React #418 / "$RS ... parentNode" hydration failure reported on /pro/plus.
//
// As a client module this whole perks block becomes ONE client reference in the parent
// page's Flight payload, with plain-data props (title/body strings; icon is a small,
// already-rendered leaf element, not a raw component reference - a bare function cannot
// cross the server/client boundary as a prop) - so there is nothing left at the tail of
// the row for Flight to defer. No interactivity here; this is a streaming-shape fix.

import type { ReactNode } from "react";

export type Perk = { title: string; body: string; icon?: ReactNode };

export default function PerksList({
  perks,
  variant,
}: {
  perks: Perk[];
  // "grid": the pitch page's two-up perk cards. "welcome" and "member" are the
  // two flavors of bullet list the other two branches use - a plain icon for
  // "welcome", a green checkmark (no icon prop needed) for "member".
  variant: "grid" | "welcome" | "member";
}) {
  if (variant === "grid") {
    return (
      <section className="grid gap-4 sm:grid-cols-2">
        {perks.map((p) => (
          <div key={p.title} className="card">
            <div className="icon-chip">{p.icon}</div>
            <h2 className="mt-2 font-semibold text-stone-900 dark:text-stone-100">
              {p.title}
            </h2>
            <p className="mt-1 text-sm text-stone-600 dark:text-stone-300">{p.body}</p>
          </div>
        ))}
      </section>
    );
  }

  // The two bullet-list branches share every class except the <ul> itself:
  // "welcome" sits centered in a bare max-w-2xl page, "member" sits inside a
  // .card that already constrains its own width.
  const ulClass =
    variant === "welcome" ? "mx-auto max-w-md space-y-2 text-left" : "space-y-2";

  return (
    <ul className={ulClass}>
      {perks.map((p) => (
        <li
          key={p.title}
          className="flex items-start gap-2 text-sm text-stone-700 dark:text-stone-300"
        >
          {variant === "member" ? (
            <span className="mt-0.5 font-bold text-green-600 dark:text-green-400">✓</span>
          ) : (
            p.icon
          )}
          <span>
            <span className="font-medium text-stone-900 dark:text-stone-100">
              {p.title}.
            </span>{" "}
            {p.body}
          </span>
        </li>
      ))}
    </ul>
  );
}
