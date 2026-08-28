"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";

// How many system rows a phone shows before the "See all" button.
const PHONE_VISIBLE = 3;

// The "Your systems" list, trimmed on a phone only.
//
// Seven system cards is five screens of scroll on a 390px phone, and it is the
// LAST thing on the dashboard a first-time owner needs - so below sm the list
// stops after three rows with a button that expands it in place. No
// navigation, no <details>, no second page: the rows are all rendered, the
// extra ones are simply hidden by CSS until asked for.
//
// DESKTOP IS UNTOUCHED. Both the hiding rule and the button are behind
// max-sm: / sm:hidden, so at sm and up this renders the same <ul> with the
// same rows it always did.
//
// The rows themselves stay server-rendered (SystemRow is passed in as
// children) - this component only owns the one boolean.
export default function SystemsPhoneList({
  total,
  children,
}: {
  // How many rows are in `children`. Passed rather than counted, because the
  // children arrive as one opaque node from the server component above.
  total: number;
  children: React.ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const extra = Math.max(0, total - PHONE_VISIBLE);
  const hasToggle = extra > 0;
  const collapsed = hasToggle && !expanded;

  return (
    <>
      <ul
        id="systems-phone-list"
        className={`space-y-3 ${
          collapsed ? "max-sm:[&>*:nth-child(n+4)]:hidden" : ""
        }`}
      >
        {children}
      </ul>
      {/* Mounted for as long as there is anything to expand, NOT only while
          collapsed. Unmounting it on expand dropped keyboard focus to the
          <body>, which on a screen reader means the announcement of the rows
          that just appeared never arrives and the reading position is lost -
          and it left aria-expanded with nothing to describe. Keeping the same
          button means focus stays exactly where the person put it, and the
          state it reports is a real one they can toggle back. */}
      {hasToggle && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          aria-controls="systems-phone-list"
          className="focus-ring flex min-h-11 w-full items-center justify-center gap-1.5 rounded-xl border border-stone-200 bg-white text-sm font-medium text-bark-700 shadow-card sm:hidden dark:border-white/10 dark:bg-stone-800 dark:text-stone-300"
        >
          {expanded ? "Show fewer" : `See all ${total} systems`}
          <ChevronDown
            className={`h-4 w-4 shrink-0 ${expanded ? "rotate-180" : ""}`}
            aria-hidden="true"
          />
        </button>
      )}
    </>
  );
}
