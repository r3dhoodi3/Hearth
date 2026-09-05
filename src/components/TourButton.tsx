"use client";

import { APP_GUIDE_EVENT } from "@/lib/appGuide";

// The header "take a tour" button, top-right of both shells (Nav.tsx and
// ProNav.tsx). The first-run spotlight tour only auto-opens once per account
// (AppGuide stamps guide_seen_at / pro_guide_seen_at and mirrors it in
// localStorage), so once somebody has been through it there was no visible way
// back in except the "Show the app guide again" link buried on the help pages.
// This button is that same replay, promoted to the header: it dispatches the
// window event AppGuideMount is already listening for in both signed-in shells,
// which reopens the tour in place - no navigation, no refetch - regardless of
// the seen stamp, exactly as ShowAppGuideButton does.
//
// Icon-only to match the other header controls (search, bell), with an
// accessible name. Accent follows the shell: bark on the homeowner side,
// hearth on the pro side, same split every other two-shell control makes.
const ACCENT = {
  homeowner:
    "text-stone-500 hover:bg-bark-50 hover:text-bark-700 dark:text-stone-400 dark:hover:bg-stone-800 dark:hover:text-stone-300",
  pro: "text-stone-500 hover:bg-hearth-50 hover:text-hearth-700 dark:text-stone-400 dark:hover:bg-stone-800 dark:hover:text-stone-300",
} as const;

export default function TourButton({
  side = "homeowner",
}: {
  side?: keyof typeof ACCENT;
}) {
  return (
    <button
      type="button"
      onClick={() => window.dispatchEvent(new CustomEvent(APP_GUIDE_EVENT))}
      aria-label="Take a tour"
      title="Take a tour"
      className={`focus-ring flex h-11 w-11 items-center justify-center rounded-full ${ACCENT[side]}`}
    >
      {/* Question mark in a circle: the universal "how does this work" glyph,
          drawn on the same 24-box, 2px stroke as the search icon beside it so
          the row stays visually even. */}
      <svg
        viewBox="0 0 24 24"
        className="h-5 w-5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="9" />
        <path d="M9.5 9a2.5 2.5 0 0 1 4.5 1.5c0 1.5-2 2-2 3.5" />
        <path d="M12 17h.01" />
      </svg>
    </button>
  );
}
