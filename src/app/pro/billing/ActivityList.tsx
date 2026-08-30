"use client";

// STREAMING FIX, not a behaviour change. Same treatment as
// src/app/pro/chats/ChatsView.tsx and src/components/pro/SetupChecklist.tsx,
// investigated in scratchpad/debug-DBG3.md.
//
// React Flight defers any element it meets once the row it is serializing has
// passed a 3200-byte budget, and Fizz then streams each deferred row as an
// out-of-order segment: a `<template id="P:n">` hole nested inside the page's
// own markup plus a late `$RS(...)` fill script. That hole chain is the shape
// that comes with the React #418 hydration failure on the pro pages.
//
// This section is the tail of /pro/billing, so it is where the budget had run
// out: measured on a pro with eight wallet transactions, the page's Flight row
// deferred the whole Activity block and then chopped three more elements out
// of the middle of it, for three nested holes in the served HTML. As one
// client module the section is a single client reference with plain-data props
// and there is nothing left to defer.
//
// The trailing guarantee paragraph is in here too, deliberately: an element
// left AFTER this component in the server page would sit past the same budget
// and be deferred in its place.

import { useState } from "react";
import {
  GHOST_PROTECTION_GUARANTEE,
  FIRST_APPLICATION_GUARANTEE,
  CREDIT_NOT_CASH_LINE,
} from "@/lib/guaranteeCopy";

// Phone only: how many rows show before the "See all activity" button. Rows
// arrive newest-first from the page, so this is always the latest N.
const PHONE_ROW_LIMIT = 3;

// One wallet transaction, fully resolved on the server. `when` is preformatted
// there so the timestamp keeps rendering in the server's locale exactly as it
// did before, rather than switching to the browser's.
export type ActivityRow = {
  id: string;
  label: string;
  when: string;
  /** Signed net amount, already formatted as an absolute dollar string. */
  amount: string;
  positive: boolean;
};

export default function ActivityList({ rows }: { rows: ActivityRow[] }) {
  // Phone only: collapsed to the latest 3 rows behind an explicit "See all
  // activity" button, in place, no navigation. This is a real control that
  // reveals real rows still in the DOM, not a card flip: nothing is swapped
  // away, and a screen reader sees the same rows once the button is pressed.
  // Desktop is unaffected - rows past the limit only carry max-sm:hidden, a
  // class with no effect at sm and up, so the full list there never changes.
  const [expanded, setExpanded] = useState(false);
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">Activity</h2>
      {rows.length === 0 ? (
        <p className="rounded-xl border border-dashed border-stone-300 p-6 text-center text-sm text-stone-500 dark:text-stone-400">
          No activity yet. Add credit to get started.
        </p>
      ) : (
        <ul className="space-y-2">
          {rows.map((t, i) => (
            <li
              key={t.id}
              className={`card flex items-center justify-between gap-3 ${
                !expanded && i >= PHONE_ROW_LIMIT ? "max-sm:hidden" : ""
              }`}
            >
              <div>
                <span className="font-medium text-stone-900 dark:text-stone-100">
                  {t.label}
                </span>
                <p className="text-xs text-stone-500 dark:text-stone-400">{t.when}</p>
              </div>
              <span
                className={`font-semibold [font-variant-numeric:tabular-nums] ${
                  t.positive
                    ? "text-green-600 dark:text-green-400"
                    : "text-stone-700 dark:text-stone-300"
                }`}
              >
                {t.positive ? "+" : "−"}
                {t.amount}
              </span>
            </li>
          ))}
        </ul>
      )}
      {rows.length > PHONE_ROW_LIMIT && (
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          aria-expanded={expanded}
          className="hidden w-full rounded-lg border border-stone-200 py-2.5 text-center text-sm font-medium text-stone-600 max-sm:block dark:border-white/10 dark:text-stone-300"
        >
          {expanded ? "Show less" : "See all activity"}
        </button>
      )}
      {rows.length > 0 && (
        <p className="text-xs text-stone-500 dark:text-stone-400">
          Ghost protection: {GHOST_PROTECTION_GUARANTEE} If they come back and
          choose you after that, the same fee is re-charged. Separately, if
          the homeowner picks someone else: {FIRST_APPLICATION_GUARANTEE}{" "}
          {CREDIT_NOT_CASH_LINE}
        </p>
      )}
    </section>
  );
}
