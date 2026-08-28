"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import InlineSpinner from "@/components/InlineSpinner";

// A compact search box for the top nav. It routes to the /search page, which
// matches the query against the homeowner's own home (systems, documents,
// issues, reminders) and the app's pages, and hands off to Ask Hearth when
// nothing on the site matches. Focusing it shows a few example searches to tap.
const EXAMPLES = [
  "Water heater",
  "Warranty",
  "Find a plumber",
  "When to replace my roof",
  "My documents",
];

export default function GlobalSearch() {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [q, setQ] = useState("");
  const [focused, setFocused] = useState(false);
  // Plays the exit animation instead of an instant unmount: on the focused
  // -> blurred transition the panel stays mounted for one more tick with
  // fade-scale-out, then drops.
  const [closing, setClosing] = useState(false);
  const wasFocused = useRef(false);
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!focused && wasFocused.current) {
      setClosing(true);
      const t = setTimeout(() => setClosing(false), 120);
      wasFocused.current = focused;
      return () => clearTimeout(t);
    }
    wasFocused.current = focused;
  }, [focused]);
  const shouldRender = focused || closing;

  function go(query: string) {
    const s = query.trim();
    setFocused(false);
    // Wrap in a transition so the left icon can flip to a spinner the instant
    // they submit, rather than the box sitting dead until the RSC payload lands.
    if (s) startTransition(() => router.push(`/search?q=${encodeURIComponent(s)}`));
  }

  return (
    <div
      className="relative"
      onFocus={() => {
        if (blurTimer.current) clearTimeout(blurTimer.current);
        setFocused(true);
      }}
      onBlur={() => {
        blurTimer.current = setTimeout(() => setFocused(false), 120);
      }}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          go(q);
        }}
        className="relative"
        role="search"
      >
        <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-stone-500 dark:text-stone-400">
          {isPending ? (
            <InlineSpinner size={16} />
          ) : (
            <svg
              viewBox="0 0 24 24"
              className="h-4 w-4"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <circle cx="11" cy="11" r="7" />
              <path d="M21 21l-4.3-4.3" />
            </svg>
          )}
        </span>
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search"
          aria-label="Search"
          // w-24 at rest, not w-32: this box sits in a header row capped at
          // max-w-5xl that was 130px over budget, and 96px is exactly enough
          // for the magnifier and the word "Search". It still expands to w-48
          // the moment it has focus, which is when the extra width is worth
          // anything.
          className="w-24 rounded-full border border-stone-200 bg-white py-1.5 pl-8 pr-3 text-sm text-stone-700 transition-all placeholder:text-stone-500 focus:w-48 focus:border-bark-500 focus:outline-none dark:border-white/10 dark:bg-stone-900 dark:text-stone-200 dark:focus:border-bark-500"
        />
      </form>

      {shouldRender && (
        <div
          className={`absolute right-0 z-30 mt-1 w-56 rounded-xl border border-stone-200 bg-white p-2 shadow-menu dark:border-white/10 dark:bg-stone-700 ${
            focused ? "motion-safe:animate-fade-scale" : "motion-safe:animate-fade-scale-out"
          }`}
        >
          <p className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-stone-500 dark:text-stone-400">
            Try searching
          </p>
          {EXAMPLES.map((ex) => (
            <button
              key={ex}
              type="button"
              // Keep focus on the input so the click registers before blur hides
              // this panel.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => go(ex)}
              className="block w-full rounded-md px-2 py-1.5 text-left text-sm text-stone-700 active:opacity-70 hover:bg-bark-50 max-sm:flex max-sm:min-h-11 max-sm:items-center dark:text-stone-300 dark:hover:bg-stone-600"
            >
              {ex}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
