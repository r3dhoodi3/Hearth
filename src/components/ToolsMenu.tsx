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
//
// Below sm the same links render as a bottom sheet instead of a dropdown - a
// 56px-wide list pinned to the top-right corner is workable with a mouse, not
// with a thumb. Both variants are mounted at once and toggled with sm:hidden
// / hidden sm:block, sharing the same `open` state, data, and close handlers.
export default function ToolsMenu({ hasPlus }: { hasPlus: boolean }) {
  const [open, setOpen] = useState(false);
  // Plays the exit animation instead of an instant unmount: on the open ->
  // closed transition the panel stays mounted for one more tick with
  // fade-scale-out, then drops.
  const [closing, setClosing] = useState(false);
  const wasOpen = useRef(false);
  const ref = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  // The phone sheet's own panel. Given focus on open; on desktop widths this
  // element is display:none (sm:hidden), and focusing a display:none element
  // is a silent no-op, so this never steals focus from the plain dropdown.
  const sheetRef = useRef<HTMLDivElement>(null);

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

  // Move focus into the phone sheet the moment it opens.
  useEffect(() => {
    if (open) sheetRef.current?.focus();
  }, [open]);

  // Close on outside click or Escape. Both hand focus back to the trigger so
  // keyboard users (and the sheet's scrim/X, via closeAndRefocus below)
  // aren't dropped at the top of the page.
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

  // The phone sheet's scrim tap and X both close explicitly (they're inside
  // `ref`, so the outside-click listener above never sees them) and return
  // focus to the trigger, matching Escape's behavior.
  function closeAndRefocus() {
    setOpen(false);
    btnRef.current?.focus();
  }

  const homeLinks = [
    { href: "/walkthrough", label: "Walk your home" },
    { href: "/home-details", label: "Home details" },
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
        className="flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-1.5 text-sm font-medium text-stone-600 hover:bg-bark-50 hover:text-stone-900 max-sm:min-h-11 sm:px-3 dark:text-stone-400 dark:hover:bg-stone-800 dark:hover:text-stone-100"
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

      {shouldRender && (
        <>
          {/* Desktop/tablet: the original dropdown, unchanged. Plain
              disclosure panel, not an ARIA menu: we don't implement the menu
              keyboard contract (arrow keys, focus trapping), so we don't
              claim the role either. Tab + Escape work as expected. */}
          <div
            className={`absolute right-0 z-20 mt-1 hidden w-56 overflow-hidden rounded-xl border border-stone-200 bg-white py-1.5 shadow-menu dark:border-white/10 dark:bg-stone-700 sm:block ${
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

          {/* Phone: a bottom sheet grid instead of a corner dropdown. Same
              links, same hrefs, same order - just laid out as tappable tiles
              instead of a cramped list. */}
          <div className="sm:hidden">
            <div
              onClick={closeAndRefocus}
              aria-hidden="true"
              className={`fixed inset-0 z-40 bg-black/40 ${
                open ? "motion-safe:animate-fade-scale" : "motion-safe:animate-fade-scale-out"
              }`}
            />
            <div
              ref={sheetRef}
              role="dialog"
              aria-modal="true"
              aria-label="Tools"
              tabIndex={-1}
              // max-h-[85vh] + overflow-y-auto keeps every tile reachable by
              // scroll on a short viewport; the bottom padding on the content
              // below is what actually clears the fixed tab bar, since this
              // panel's own bottom edge sits flush with the viewport bottom
              // (same as the tab bar's). z-50, one tier above the scrim
              // (z-40) and the header this sheet is nested in (Nav.tsx's
              // header is z-40, above the tab bar's z-30) - see Nav.tsx for
              // why the header's own z-index has to clear the tab bar.
              className={`fixed inset-x-0 bottom-0 z-50 max-h-[85vh] overflow-y-auto rounded-t-2xl border-t border-stone-200 bg-white pb-[env(safe-area-inset-bottom)] shadow-menu outline-none dark:border-white/10 dark:bg-stone-800 ${
                open ? "motion-safe:animate-fade-slide-up" : "motion-safe:animate-fade-slide-down"
              }`}
            >
              <div className="sticky top-0 z-10 flex items-center justify-between border-b border-stone-100 bg-white px-4 py-3 dark:border-white/10 dark:bg-stone-800">
                <p className="text-sm font-semibold text-stone-900 dark:text-stone-100">
                  Tools
                </p>
                <button
                  type="button"
                  onClick={closeAndRefocus}
                  aria-label="Close"
                  className="-m-1.5 flex h-11 w-11 items-center justify-center rounded-full text-stone-500 hover:bg-stone-100 dark:text-stone-400 dark:hover:bg-stone-700"
                >
                  <svg
                    viewBox="0 0 20 20"
                    className="h-5 w-5"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    aria-hidden="true"
                  >
                    <path d="M5 5l10 10M15 5L5 15" />
                  </svg>
                </button>
              </div>

              {/* Bottom padding equal to the tab bar's own height + safe area
                  + 1rem: on a short viewport the last row (Plus tools) would
                  otherwise scroll to sit flush with this panel's bottom edge,
                  which is exactly where the fixed tab bar overlaps it. This
                  guarantees the last tile always clears the tab bar even if
                  the z-index ordering above is ever undone. */}
              <div className="space-y-5 p-4 pb-[calc(3.5rem+env(safe-area-inset-bottom)+1rem)]">
                <div>
                  <p className="px-1 pb-2 text-[11px] font-semibold uppercase tracking-wide text-stone-500 dark:text-stone-400">
                    Emergency
                  </p>
                  <div className="grid grid-cols-3 gap-2">
                    <Link
                      href="/emergency"
                      onClick={closeAndRefocus}
                      className="flex min-h-[64px] flex-col items-center justify-center rounded-xl border border-red-200 bg-red-50 px-2 py-3 text-center text-xs font-medium text-red-600 dark:border-red-500/30 dark:bg-red-500/15 dark:text-red-400"
                    >
                      Emergency
                    </Link>
                  </div>
                </div>

                <div>
                  <p className="px-1 pb-2 text-[11px] font-semibold uppercase tracking-wide text-stone-500 dark:text-stone-400">
                    Your home
                  </p>
                  <div className="grid grid-cols-3 gap-2">
                    {homeLinks.map((l) => (
                      <Link
                        key={l.href}
                        href={l.href}
                        onClick={closeAndRefocus}
                        className="flex min-h-[64px] flex-col items-center justify-center rounded-xl border border-stone-200 bg-stone-50 px-2 py-3 text-center text-xs font-medium text-stone-700 hover:border-bark-300 hover:bg-bark-50 dark:border-white/10 dark:bg-stone-700 dark:text-stone-300"
                      >
                        {l.label}
                      </Link>
                    ))}
                  </div>
                </div>

                <div>
                  <p className="px-1 pb-2 text-[11px] font-semibold uppercase tracking-wide text-stone-500 dark:text-stone-400">
                    Plus tools
                  </p>
                  <div className="grid grid-cols-3 gap-2">
                    {plusTools.map((l) => (
                      <Link
                        key={l.href}
                        href={l.href}
                        onClick={closeAndRefocus}
                        className={`flex min-h-[64px] flex-col items-center justify-center gap-1 rounded-xl border px-2 py-3 text-center text-xs font-medium ${
                          hasPlus
                            ? "border-stone-200 bg-stone-50 text-stone-700 hover:border-bark-300 hover:bg-bark-50 dark:border-white/10 dark:bg-stone-700 dark:text-stone-300"
                            : "border-stone-200 bg-stone-50 text-stone-500 hover:border-bark-300 hover:bg-bark-50 dark:border-white/10 dark:bg-stone-700 dark:text-stone-400"
                        }`}
                      >
                        <span>{l.label}</span>
                        {!hasPlus && (
                          <>
                            {/* Matches the dashboard's Plus chip. */}
                            <span className="rounded bg-bark-100 px-1.5 text-[10px] font-medium text-bark-700 dark:bg-bark-700 dark:text-stone-300">
                              Plus
                            </span>
                            <span className="sr-only">(requires Hearth Plus)</span>
                          </>
                        )}
                      </Link>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
