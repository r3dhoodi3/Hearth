"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import {
  APP_GUIDE_EVENT,
  appGuideSeenKey,
  appGuideSnoozeKey,
  isEligibleForAppGuide,
  type GuideSide,
} from "@/lib/appGuide";
import { markGuideSeenAction } from "@/lib/appGuideActions";
import SpotlightTour from "@/components/SpotlightTour";

// The gate around the first-run guide, shown once, right after somebody's
// first sign-in.
//
// The EXPERIENCE changed (2026-08-30): the four-card bottom sheet became a
// spotlight tour (src/components/SpotlightTour.tsx) that brings the user to
// each page it talks about and rings the element it means, like a game
// tutorial. What did NOT change is everything this file decides: when the
// guide triggers, which routes it must never take over, the session snooze
// when somebody navigates past it, the replay event from the help pages, and
// the two-part "seen" stamp (localStorage mirror + users-table timestamp)
// that Skip and Done both write. Renders NOTHING until it opens (no wrapper,
// no placeholder), so mounting it in a layout can never move a pixel of the
// page under it.

function readSeen(side: GuideSide): boolean {
  try {
    return window.localStorage.getItem(appGuideSeenKey(side)) === "1";
  } catch {
    // Storage disabled or private mode: the server stamp is still the real
    // gate, this mirror just cannot help this time.
    return false;
  }
}

function writeSeen(side: GuideSide): void {
  try {
    window.localStorage.setItem(appGuideSeenKey(side), "1");
  } catch {
    // Worst case it shows once more in this browser.
  }
}

// CR2#6: the guide used to full-screen the instant the dashboard or /pro
// first rendered, covering the new homeowner's real Home Health Score or the
// new pro's first real lead before they had seen it. It now waits for that
// content to be on screen AND for a minimum beat to pass, whichever finishes
// last - see the auto-open effect below.
//
// Minimum wait before the guide can take over, even if the target below is
// already on screen the instant this mounts (a fast render, or a replay).
export const GUIDE_OPEN_DELAY_MS = 1500;
// Upper bound on how long the wait for the target below runs before giving
// up and opening on the timer alone. A page that never grows the target (a
// future redesign, or the guide mounting somewhere unexpected) must still
// open the guide rather than never opening it at all.
export const GUIDE_TARGET_TIMEOUT_MS = 4000;

// "The real content has rendered", per side. Neither dashboard/page.tsx nor
// pro/HomeView.tsx is a file this change may edit (the dashboard is
// tile-order-only this wave, and the pro Home shell is explicitly somebody
// else's), so both read structure that already exists on those pages rather
// than a purpose-built id:
//  - homeowner: "#this-month" is the This Month section that sits right
//    below the Home Health Score card on /dashboard, so it cannot be true
//    before the score has already painted.
//  - pro: the "Open jobs" tile in the Home tiles grid (HomeView.tsx) carries
//    no id of its own, so it's matched by its label text instead.
function guideTargetPresent(side: GuideSide): boolean {
  if (side === "pro") {
    return Array.from(document.querySelectorAll(".stat-label")).some(
      (el) => el.textContent?.trim() === "Open jobs"
    );
  }
  return !!document.getElementById("this-month");
}

function readSnoozed(side: GuideSide): boolean {
  try {
    return window.sessionStorage.getItem(appGuideSnoozeKey(side)) === "1";
  } catch {
    // Storage disabled: fall back to the old behavior (offer it again).
    return false;
  }
}

function writeSnoozed(side: GuideSide): void {
  try {
    window.sessionStorage.setItem(appGuideSnoozeKey(side), "1");
  } catch {
    // Worst case it re-opens on the next route change, as it used to.
  }
}

export default function AppGuide({
  side,
  // Decided on the server by AppGuideMount: false once the users-table stamp
  // exists. The localStorage mirror below is checked on top of it, so a stale
  // true (a page rendered before the stamp landed) still cannot show it twice.
  startOpen,
}: {
  side: GuideSide;
  startOpen: boolean;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  // Whatever had focus when the guide opened, so closing hands it back (the
  // "Show the app guide again" link on the help pages, usually).
  const returnFocusRef = useRef<HTMLElement | null>(null);
  // The route the tour is expected to be on, or null when it is closed. The
  // tour navigates between pages itself and reports each push through
  // onTourNavigate below, which updates this BEFORE the pathname catches up -
  // so a pathname that no longer matches it while the tour is up can only
  // mean the USER navigated (back button, a tapped link that somehow got
  // through): that ends the tour with the session snooze, exactly the way
  // navigating past the old sheet did.
  const expectedPathRef = useRef<string | null>(null);

  // Auto-open, once. Re-runs on navigation so somebody who lands on an
  // excluded page first (a payment screen, the emergency page) still gets the
  // guide on the next ordinary page instead of losing it entirely.
  //
  // The same re-run is why the snooze below exists: without it, somebody who
  // ignored the guide and tapped into the app got it thrown back full-screen
  // over every page they navigated to - the post-a-job form, the walkthrough -
  // until they found Skip. Navigating away with it up is a "not now": it
  // closes and stays closed for this tab, WITHOUT stamping "seen" (only Skip
  // and Done do that, in close() below), so a later visit still offers it
  // and the help pages' "Show the app guide again" brings it back now.
  useEffect(() => {
    if (open) {
      // Route changed under the open tour to somewhere the tour did not push
      // toward: they navigated past it.
      if (
        expectedPathRef.current !== null &&
        expectedPathRef.current !== pathname
      ) {
        expectedPathRef.current = null;
        writeSnoozed(side);
        setOpen(false);
      }
      return;
    }
    const eligible = isEligibleForAppGuide({
      pathname,
      // The mount point is the onboarding gate: this component is only
      // rendered inside a shell that already requires a claimed home (or a
      // contractors row on the pro side).
      onboardingComplete: true,
      seenOnServer: !startOpen,
      seenInThisBrowser: readSeen(side),
      snoozedInThisSession: readSnoozed(side),
    });
    if (!eligible) return;

    // Eligible, but not yet: opening the instant this mounts would cover the
    // health score / first lead before anyone has seen it (CR2#6). Wait for
    // guideTargetPresent(side) AND GUIDE_OPEN_DELAY_MS, whichever finishes
    // last, capped at GUIDE_TARGET_TIMEOUT_MS so a page that never grows the
    // target still opens on the timer alone.
    let settled = false;
    const startedAt = Date.now();
    let delayTimer: ReturnType<typeof setTimeout> | null = null;
    let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
    let observer: MutationObserver | null = null;

    function openNow() {
      if (settled) return;
      settled = true;
      observer?.disconnect();
      if (delayTimer) clearTimeout(delayTimer);
      if (fallbackTimer) clearTimeout(fallbackTimer);
      expectedPathRef.current = pathname;
      setOpen(true);
    }

    function armMinimumDelay() {
      if (settled || delayTimer) return;
      const elapsed = Date.now() - startedAt;
      delayTimer = setTimeout(openNow, Math.max(0, GUIDE_OPEN_DELAY_MS - elapsed));
    }

    if (guideTargetPresent(side)) {
      armMinimumDelay();
    } else {
      observer = new MutationObserver(() => {
        if (guideTargetPresent(side)) armMinimumDelay();
      });
      observer.observe(document.body, { childList: true, subtree: true });
      // Fall back to the timer alone: the target never showing up must not
      // mean the guide never opens.
      fallbackTimer = setTimeout(openNow, GUIDE_TARGET_TIMEOUT_MS);
    }

    return () => {
      settled = true;
      observer?.disconnect();
      if (delayTimer) clearTimeout(delayTimer);
      if (fallbackTimer) clearTimeout(fallbackTimer);
    };
    // `open` is deliberately absent from the deps: this must not re-fire the
    // moment the tour opens, only on a route change or a new mount. It is
    // still READ above, to tell "the route changed under an open tour" from
    // "we are deciding whether to open one".
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname, side, startOpen]);

  // Replay from the help pages ("Show the app guide again"). Always available,
  // seen or snoozed or not, on any page. The tour starts over from its first
  // step on every replay because it mounts fresh (it only renders while open).
  // pathname is in the deps so the replayed tour records where it opened and
  // the navigate-away snooze above applies to it too.
  useEffect(() => {
    function onShow() {
      expectedPathRef.current = pathname;
      setOpen(true);
    }
    window.addEventListener(APP_GUIDE_EVENT, onShow);
    return () => window.removeEventListener(APP_GUIDE_EVENT, onShow);
  }, [pathname]);

  // Remember where focus was when the tour opened; close() hands it back.
  // The tour manages focus INSIDE itself (card focus, Tab trap, Escape).
  useEffect(() => {
    if (!open) return;
    const active = document.activeElement;
    returnFocusRef.current =
      active instanceof HTMLElement && active !== document.body ? active : null;
  }, [open]);

  const close = useCallback(() => {
    setOpen(false);
    expectedPathRef.current = null;
    // Both halves of "seen": the browser mirror is synchronous so nothing in
    // this session can show it again even if the round trip below is slow or
    // never lands, and the server stamp is what covers the next device.
    writeSeen(side);
    void markGuideSeenAction(side);
    const back = returnFocusRef.current;
    returnFocusRef.current = null;
    if (back && typeof back.focus === "function") back.focus();
  }, [side]);

  if (!open) return null;

  return (
    <SpotlightTour
      side={side}
      // Done, Skip tour, and Escape all land here: the same finality the old
      // sheet's Skip / Got it had.
      onClose={close}
      // The tour is about to push this route itself; update the expectation
      // first so the auto-open effect above does not read the tour's own
      // navigation as the user leaving.
      onTourNavigate={(route) => {
        expectedPathRef.current = route;
      }}
    />
  );
}
