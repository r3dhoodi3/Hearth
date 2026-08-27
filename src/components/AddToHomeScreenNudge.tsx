"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";

// A one-time "install this as an app" nudge for iOS Safari, where there is no
// native install prompt (unlike Android/Chrome, which get their own OS-level
// banner). Safari's only path is Share -> Add to Home Screen, which nobody
// finds on their own, so this card points at it once, then never again.
//
// Everything here fails closed: any thrown error (localStorage disabled,
// private browsing quirks, matchMedia missing) results in rendering nothing,
// never in a crash or a nudge that won't go away.

// Forever-dismissed flag. A single leading tap ("Got it" or the X) sets this
// and the component renders null for that browser from then on.
const DISMISSED_KEY = "hearth_a2hs_dismissed";
// Running count of page views, so the nudge waits until someone has actually
// looked around instead of firing on the very first paint.
const VIEWS_KEY = "hearth_a2hs_views";
const REQUIRED_VIEWS = 2;
const DELAY_MS = 5000;

// Flows where an install nudge would be noise or a distraction: getting
// signed up, getting signed in, paying, or leaving feedback. All are
// path-prefix matches, so a nested route under any of these is covered too.
const EXCLUDED_PATH_PREFIXES = [
  "/onboarding",
  "/pro/onboarding",
  "/signin",
  "/checkout",
  "/feedback",
];

function isExcludedPath(pathname: string | null): boolean {
  if (!pathname) return true;
  return EXCLUDED_PATH_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`)
  );
}

// iOS Safari only. iPhone/iPad is the target; other iOS browsers (Chrome,
// Firefox, Edge, DuckDuckGo) all render on WebKit and carry "Safari" in their
// user agent string too, but "Add to Home Screen" behaves differently (or is
// unavailable) there, so they're explicitly excluded. iPadOS 13+ reports its
// user agent as a plain Mac, so a touch-capable "Macintosh" UA counts as iOS
// too.
function isIosSafari(): boolean {
  try {
    const ua = window.navigator.userAgent;
    const isIosDevice =
      /iPad|iPhone|iPod/.test(ua) ||
      (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
    if (!isIosDevice) return false;
    return !/CriOS|FxiOS|EdgiOS|OPiOS|DuckDuckGo|Mercury/i.test(ua);
  } catch {
    return false;
  }
}

// True once the app is already installed and running full-screen - the one
// case this nudge exists to produce, so it has nothing left to say.
// navigator.standalone is iOS Safari's own flag; the display-mode media query
// is the standards-track fallback other engines use.
function isStandalone(): boolean {
  try {
    const nav = window.navigator as Navigator & { standalone?: boolean };
    if (nav.standalone === false) return false;
    if (nav.standalone === true) return true;
    return window.matchMedia("(display-mode: standalone)").matches;
  } catch {
    // Fail closed: if we can't tell, don't nudge.
    return true;
  }
}

function readCount(key: string): number {
  try {
    return Number(window.localStorage.getItem(key) ?? "0") || 0;
  } catch {
    return 0;
  }
}

export default function AddToHomeScreenNudge() {
  const pathname = usePathname();
  const [visible, setVisible] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Guards against counting the same pathname twice in one commit (React 18
  // strict-mode double-invokes effects in dev).
  const countedPathRef = useRef<string | null>(null);

  // Count this page view once per pathname change, including the first.
  useEffect(() => {
    if (countedPathRef.current === pathname) return;
    countedPathRef.current = pathname;
    try {
      window.localStorage.setItem(VIEWS_KEY, String(readCount(VIEWS_KEY) + 1));
    } catch {
      // Nothing to do - the view just won't count toward the threshold.
    }
  }, [pathname]);

  // Arm (or re-arm) the 5-second reveal timer whenever the route changes,
  // once every gate has been checked.
  useEffect(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    try {
      if (isExcludedPath(pathname)) return;
      if (window.localStorage.getItem(DISMISSED_KEY) === "1") return;
      if (!isIosSafari()) return;
      if (isStandalone()) return;
      if (readCount(VIEWS_KEY) < REQUIRED_VIEWS) return;
    } catch {
      return;
    }
    timerRef.current = setTimeout(() => setVisible(true), DELAY_MS);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [pathname]);

  function dismiss() {
    setVisible(false);
    try {
      window.localStorage.setItem(DISMISSED_KEY, "1");
    } catch {
      // Best effort - worst case it can show again this session.
    }
  }

  if (!visible) return null;

  return (
    // Phone-only: this sits just above the fixed bottom tab bar (see
    // Nav.tsx), which itself only exists below sm. bottom offset mirrors that
    // bar's own height (3rem content + its safe-area padding) plus a small
    // gap, the same math globals.css uses to lift the floating docks above it.
    // z-35: above the bottom tab bar (z-30, Nav.tsx) so this never renders
    // inline under it, but below the header's stacking context (z-40,
    // Nav.tsx) that the Tools sheet and its scrim are nested inside, so a
    // rare moment where both are visible resolves with the modal sheet on
    // top.
    <div className="pointer-events-none fixed inset-x-0 bottom-[calc(3.5rem+env(safe-area-inset-bottom)+0.5rem)] z-[35] flex justify-center px-3 sm:hidden">
      <div
        role="status"
        className="pointer-events-auto w-full max-w-sm rounded-xl border border-stone-200 bg-white p-3 shadow-menu dark:border-white/10 dark:bg-stone-800"
      >
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-stone-900 dark:text-stone-100">
              Add Hearth to your Home Screen
            </p>
            <p className="mt-0.5 text-xs text-stone-600 dark:text-stone-400">
              Tap Share, then Add to Home Screen. It opens like an app, full
              screen.
            </p>
          </div>
          <button
            type="button"
            onClick={dismiss}
            aria-label="Dismiss"
            className="-m-1.5 flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-stone-400 hover:bg-stone-100 hover:text-stone-600 dark:hover:bg-stone-700 dark:hover:text-stone-300"
          >
            <svg
              viewBox="0 0 20 20"
              className="h-4 w-4"
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
        <div className="mt-2 flex justify-end">
          <button type="button" onClick={dismiss} className="btn-primary">
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}
