"use client";

import { useEffect, useState } from "react";

// Header background per theme, kept in sync with the theme-color meta tag so
// the iOS status bar / Android toolbar tint follows the page. Light is the
// value app/layout.tsx ships in its viewport export; dark matches stone-900.
const THEME_COLOR_LIGHT = "#fbf7f2";
const THEME_COLOR_DARK = "#1c1917";

// Point the theme-color meta at the active theme. Next renders the tag from
// the viewport export, but this creates it if it is somehow absent so the
// tint is never left stale.
function setThemeColorMeta(dark: boolean) {
  let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement("meta");
    meta.name = "theme-color";
    document.head.appendChild(meta);
  }
  meta.content = dark ? THEME_COLOR_DARK : THEME_COLOR_LIGHT;
}

// Light/dark switch. The source of truth is the .dark class on <html>, set
// before paint by the inline script in app/layout.tsx; this component reads
// it on mount, flips it on click, and saves the choice to localStorage so it
// carries across every page and the next visit. Two looks:
// - "icon" (default): a round sun/moon button for toolbars and headers.
// - "row": a full-width menu row ("Dark mode" + a small switch) for dropdowns.
export default function ThemeToggle({
  variant = "icon",
}: {
  variant?: "icon" | "row";
}) {
  // Server renders assume light; the real value arrives on mount. The one
  // frame where the icon could be stale is invisible because the page colors
  // themselves come from the html class, not from this state.
  const [dark, setDark] = useState(false);

  // The .dark class is the source of truth (themeInit already applied the
  // stored choice before paint), so read it rather than localStorage. Syncing
  // the meta here too covers the reload case: themeInit skips the tag when
  // Next has not rendered it yet.
  useEffect(() => {
    const isDark = document.documentElement.classList.contains("dark");
    setDark(isDark);
    setThemeColorMeta(isDark);
  }, []);

  function toggle() {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle("dark", next);
    setThemeColorMeta(next);
    try {
      localStorage.setItem("hearth-theme", next ? "dark" : "light");
    } catch {
      // Storage can be unavailable (private mode); the theme still flips for
      // this page view, it just won't persist.
    }
  }

  const sun = (
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
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
  );

  const moon = (
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
      <path d="M21 12.8A8.5 8.5 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
    </svg>
  );

  if (variant === "row") {
    return (
      <button
        type="button"
        onClick={toggle}
        role="switch"
        aria-checked={dark}
        className="mx-1 flex w-[calc(100%-0.5rem)] items-center justify-between gap-2 rounded-md px-3 py-2 text-left text-sm text-stone-700 active:opacity-70 hover:bg-bark-50 dark:text-stone-300 dark:hover:bg-stone-600"
      >
        <span className="flex items-center gap-2">
          <span className="text-stone-500 dark:text-stone-400">
            {dark ? moon : sun}
          </span>
          Dark mode
        </span>
        {/* Small switch so the current state is readable at a glance. */}
        <span
          aria-hidden="true"
          className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
            dark ? "bg-bark-600" : "bg-stone-300"
          }`}
        >
          <span
            className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${
              dark ? "translate-x-[1.125rem]" : "translate-x-0.5"
            }`}
          />
        </span>
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
      className="focus-ring flex h-9 w-9 items-center justify-center rounded-full text-stone-500 active:scale-95 hover:bg-bark-50 hover:text-bark-700 max-sm:h-11 max-sm:w-11 dark:text-stone-400 dark:hover:bg-stone-800 dark:hover:text-stone-300"
    >
      {dark ? sun : moon}
    </button>
  );
}
