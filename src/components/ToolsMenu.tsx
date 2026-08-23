"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";

// "Tools" dropdown in the homeowner nav. Holds the home-related destination
// pages (Documents, Home value, taxes, inspection, Learn) and the Plus tools,
// which used to live in the profile dropdown and made it feel like a junk
// drawer. The profile menu is now account-only; navigation lives here.
//
// Rendered OUTSIDE the overflow-x-auto nav strip - a dropdown inside a
// scroll container gets clipped by it.
export default function ToolsMenu({ hasPlus }: { hasPlus: boolean }) {
  const [open, setOpen] = useState(false);
  // Plays the exit animation instead of an instant unmount: on the open ->
  // closed transition the panel stays mounted for one more tick with
  // fade-scale-out, then drops.
  const [closing, setClosing] = useState(false);
  const wasOpen = useRef(false);
  const ref = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open && wasOpen.current) {
      setClosing(true);
      const t = setTimeout(() => setClosing(false), 120);
      wasOpen.current = open;
      return () => clearTimeout(t);
    }
    wasOpen.current = open;
  }, [open]);
  const shouldRender = open || closing;

  // Close on outside click or Escape. Escape hands focus back to the trigger
  // so keyboard users aren't dropped at the top of the page.
  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpen(false);
        btnRef.current?.focus();
      }
    }
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const homeLinks = [
    { href: "/walkthrough", label: "Walk your home" },
    { href: "/documents", label: "Documents" },
    { href: "/value", label: "Home value" },
    { href: "/taxes", label: "Property taxes" },
    { href: "/inspection", label: "Home inspection" },
    { href: "/learn", label: "Learn" },
  ];

  // Straight to the tool for everyone. Each of these pages does its own
  // in-context gating (masked per-system detail on the forecast, one free
  // check then a redirect on the quote analyzer, a gated export on the home
  // report), so bouncing a free user to the pitch page first only put an ad
  // where the product should be. The Plus chip beside each label still says
  // what a membership adds.
  const plusTools = [
    { href: "/forecast", label: "Cost forecast" },
    { href: "/quote-check", label: "Quote analyzer" },
    { href: "/home-report", label: "Home report" },
  ];

  return (
    <div ref={ref} className="relative shrink-0">
      {/* Tighter horizontal padding below sm only: every pixel spent here
          comes out of the home address label to its left, which is the thing
          a phone user actually reads. sm and up keep the original px-3. */}
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-1.5 text-sm font-medium text-stone-600 hover:bg-bark-50 hover:text-stone-900 max-sm:min-h-10 sm:px-3 dark:text-stone-400 dark:hover:bg-stone-800 dark:hover:text-stone-100"
      >
        Tools
        <svg
          viewBox="0 0 20 20"
          className={`h-4 w-4 text-stone-500 transition-transform dark:text-stone-400 ${
            open ? "rotate-180" : ""
          }`}
          fill="currentColor"
          aria-hidden="true"
        >
          <path
            fillRule="evenodd"
            d="M5.23 7.21a.75.75 0 011.06.02L10 11.06l3.71-3.83a.75.75 0 111.08 1.04l-4.25 4.39a.75.75 0 01-1.08 0L5.21 8.27a.75.75 0 01.02-1.06z"
            clipRule="evenodd"
          />
        </svg>
      </button>

      {/* Plain disclosure panel, not an ARIA menu: we don't implement the
          menu keyboard contract (arrow keys, focus trapping), so we don't
          claim the role either. Tab + Escape work as expected. */}
      {shouldRender && (
        <div
          className={`absolute right-0 z-20 mt-1 w-56 overflow-hidden rounded-xl border border-stone-200 bg-white py-1.5 shadow-menu dark:border-white/10 dark:bg-stone-700 ${
            open ? "motion-safe:animate-fade-scale" : "motion-safe:animate-fade-scale-out"
          }`}
        >
          <div className="border-b border-stone-100 pb-1 dark:border-white/10">
            <Link
              href="/emergency"
              onClick={() => setOpen(false)}
              className="mx-1 flex items-center rounded-md px-3 py-2 text-sm font-medium text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-500/15"
            >
              Emergency
            </Link>
          </div>
          <div className="border-b border-stone-100 py-1 dark:border-white/10">
            <p className="px-4 pb-0.5 pt-1 text-[11px] font-semibold uppercase tracking-wide text-stone-500 dark:text-stone-400">
              Your home
            </p>
            {homeLinks.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                onClick={() => setOpen(false)}
                className="mx-1 flex items-center rounded-md px-3 py-2 text-sm text-stone-700 hover:bg-bark-50 dark:text-stone-300 dark:hover:bg-stone-600"
              >
                {l.label}
              </Link>
            ))}
          </div>
          <div className="py-1">
            <p className="px-4 pb-0.5 pt-1 text-[11px] font-semibold uppercase tracking-wide text-stone-500 dark:text-stone-400">
              Plus tools
            </p>
            {plusTools.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                onClick={() => setOpen(false)}
                className={`mx-1 flex items-center justify-between gap-2 rounded-md px-3 py-2 text-sm hover:bg-bark-50 dark:hover:bg-stone-600 ${
                  hasPlus
                    ? "text-stone-700 dark:text-stone-300"
                    : "text-stone-500 dark:text-stone-400"
                }`}
              >
                <span>{l.label}</span>
                {!hasPlus && (
                  <>
                    {/* Matches the dashboard's Plus chip. */}
                    <span className="rounded bg-bark-100 px-1.5 text-[11px] font-medium text-bark-700 dark:bg-bark-700 dark:text-stone-300">
                      Plus
                    </span>
                    <span className="sr-only">(requires Hearth Plus)</span>
                  </>
                )}
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
