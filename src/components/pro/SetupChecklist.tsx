// "use client" is a STREAMING fix, not a behaviour one. This component has no
// state, no effects and no browser APIs; it would work perfectly well as a
// server component, and it was one until 2026-08-30.
//
// The reason it moved: React Flight defers any element it meets once the row
// it is serializing has passed a byte budget (`3200 < serializedSize ->
// deferTask` in react-server-dom-webpack-server). The pro Home tab renders
// this checklist LAST, so on /pro the budget ran out right inside the <ul>
// and every remaining <li> was chopped into its own Flight row. SSR then
// suspends on each of those rows and emits an out-of-order stream segment for
// it, which is a `<template id="P:n">` hole in the flushed markup plus a late
// `<script>$RS(...)</script>` to fill it: eight of them on /pro, against the
// single one every healthy pro page has. That chain is the one structural
// difference between the pro pages that throw a hydration error on load
// (/pro, /pro/leads) and the ones that never do (/pro/help, /pro/chats,
// /pro/profile, /pro/crm, /pro/business), and when hydration does give up,
// every one of those late $RS calls then fails too ("Cannot read properties
// of null") because React has already removed the nodes they address.
//
// As a client component the checklist is a single client reference in the
// payload and its items are plain data, so there are no elements left at the
// tail of the row for Flight to defer. Measured on the local production build
// against the same account: /pro went from 8 `<template id="P:">` holes and 8
// $RS scripts to 1 and 1 - the same shape as the pro pages that were always
// clean - and the document shrank by 6.2 kB.
//
// Keep it a client component. If it ever needs server-only data, pass that in
// as a prop rather than moving the markup back across the boundary.
"use client";

import Link from "next/link";

export type SetupItem = {
  label: string;
  done: boolean;
  href: string;
  linkLabel: string;
  // Optional one-line reason shown under the label in smaller text.
  hint?: string;
  // A step this pro's account cannot actually complete right now (today: the
  // logo, which is a Pro-member cosmetic). It still shows, so the pro knows
  // the step exists and where it leads, but it is left OUT of the progress
  // count: an undone-forever item would otherwise pin the card open at "4 of
  // 5" and turn a setup guide into a permanent upsell.
  optional?: boolean;
};

// First-session guide for a new pro. Every item is derived from data the
// dashboard already fetches (no new tables, no extra queries), so the card is
// fully stateless: it shows while any step is open and disappears on its own
// once everything is done. Progress bar matches the homeowner dashboard's.
export default function SetupChecklist({ items }: { items: SetupItem[] }) {
  // Progress counts only the steps the pro can actually finish.
  const counted = items.filter((i) => !i.optional);
  const done = counted.filter((i) => i.done).length;
  if (done >= counted.length) return null;

  return (
    <section className="card space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-stone-900 dark:text-stone-100">
            Finish setting up
          </h2>
          <p className="text-sm text-stone-500 dark:text-stone-400">
            A complete profile wins more jobs. A few small steps and you&apos;re
            ready to go.
          </p>
        </div>
        <p className="shrink-0 text-xs text-stone-500 dark:text-stone-400">
          {done} of {counted.length} done
        </p>
      </div>

      <div className="h-1.5 w-full overflow-hidden rounded-full bg-stone-100 dark:bg-stone-700">
        <div
          className="h-full rounded-full bg-green-500 transition-all"
          style={{
            width: `${counted.length ? Math.round((done / counted.length) * 100) : 100}%`,
          }}
        />
      </div>

      <ul className="space-y-2">
        {items.map((item) => (
          <li
            key={item.label}
            className="flex items-center justify-between gap-3 text-sm"
          >
            <span
              className={`flex items-center gap-2 ${
                item.done ? "text-stone-500 line-through dark:text-stone-400" : "text-stone-700 dark:text-stone-300"
              }`}
            >
              <span
                // Phones get a 24px circle with 14px digits (the checkmark
                // carries meaning - done vs. not - so it gets the same
                // readable-floor bump as the other status badges); sm and up
                // keeps the original 20px / 11px marker exactly.
                className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[11px] font-bold max-sm:h-6 max-sm:w-6 max-sm:text-sm ${
                  item.done
                    ? "border-green-200 bg-green-50 text-green-600 dark:border-green-900 dark:bg-green-950/40 dark:text-green-400"
                    : "border-stone-200 bg-white text-transparent dark:border-white/10 dark:bg-stone-800"
                }`}
                aria-hidden
              >
                ✓
              </span>
              <span className="flex flex-col">
                <span>{item.label}</span>
                {item.hint && !item.done && (
                  <span className="text-xs text-stone-500 dark:text-stone-400">
                    {item.hint}
                  </span>
                )}
              </span>
            </span>
            {!item.done && (
              <Link
                href={item.href}
                // max-sm: only - below 40px tall as a plain text link, these
                // were confirmed too small to tap reliably on a phone.
                // Desktop keeps the original compact inline link untouched.
                className="shrink-0 text-sm font-medium text-hearth-700 hover:underline max-sm:flex max-sm:min-h-11 max-sm:items-center max-sm:py-2 dark:text-hearth-300"
              >
                {item.linkLabel} →
              </Link>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
