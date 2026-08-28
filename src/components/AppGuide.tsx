"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import {
  BadgeCheck,
  CalendarCheck,
  Inbox,
  MessageSquare,
  ShieldCheck,
  Users,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import {
  APP_GUIDE_EVENT,
  appGuideSeenKey,
  isEligibleForAppGuide,
  type GuideSide,
} from "@/lib/appGuide";
import { markGuideSeenAction } from "@/lib/appGuideActions";

// A short guide to the app, shown once, right after somebody's first sign-in.
//
// The phone landing page is being cut down to a sign-in button and little else
// (they installed the app; they know what it is), so everything the old
// landing page explained - what Hearth watches, how the plan works, that Ask
// Hearth and real local pros are both here, how finding a pro goes - moves
// here, to four cards somebody actually reads because they are already in.
//
// A full-screen bottom sheet on a phone, a small centered modal on a desktop.
// Renders NOTHING until it opens (no wrapper, no placeholder), so mounting it
// in a layout can never move a pixel of the page under it.

// Written out rather than pulled from LAUNCH_AREA_LABEL in
// src/lib/serviceArea.ts on purpose: that module carries the whole Orange
// County ZIP set and city roster with it, and none of that belongs in a client
// bundle for the sake of one phrase. If the launch area ever changes, this
// file is one of the places to change with it.
const AREA = "all of Orange County";

type Slide = {
  icon: LucideIcon;
  title: string;
  // Two lines, no more. Anything longer is a help page, not a guide.
  lines: [string, string];
};

const HOMEOWNER_SLIDES: Slide[] = [
  {
    icon: ShieldCheck,
    title: "Hearth watches your home",
    lines: [
      "We keep a list of what your home runs on and how old each thing is, and we watch storms, recalls, and aging systems for you.",
      "Your home score moves when something needs attention, so you find out without going looking.",
    ],
  },
  {
    icon: CalendarCheck,
    title: "This month",
    lines: [
      "Your plan says what to do this month and when, in plain words, with the small stuff first.",
      "A short job now is usually what keeps a big bill from showing up later.",
    ],
  },
  {
    icon: MessageSquare,
    title: "Ask Hearth, real answers",
    lines: [
      // No claim of a human on our end: Hearth does not staff answers. The
      // assistant answers off the home's own record, and the humans in this
      // product are the pros, reached by posting a job.
      "Ask anything about your house. Hearth answers from your own systems, their ages, and whatever you have logged about them.",
      `When you want a person instead of an answer, real local pros across ${AREA} are one job post away.`,
    ],
  },
  {
    icon: Wrench,
    title: "Find a pro when you need one",
    lines: [
      "Post the job once and local pros apply to it. Your phone and email stay private until you pick someone.",
      // The real rule from leave_review() (migration 0132, part 6): you own
      // the property, a pro was actually hired for that job, one review per
      // job, and no reviewing yourself or a linked account. Deliberately NOT
      // "a finished job" - only the pro can close a job, so that rule would
      // hand the reviewed party a veto over their own reviews.
      "Reviews only come from homeowners who hired a pro through Hearth, one per job.",
    ],
  },
];

const PRO_SLIDES: Slide[] = [
  {
    icon: Inbox,
    title: "Leads from real homeowners in Orange County",
    lines: [
      "Homeowners post jobs with the home details already filled in, so you are not guessing at the age of the water heater.",
      `You see the work across ${AREA} and apply to the jobs that fit.`,
    ],
  },
  {
    icon: BadgeCheck,
    title: "Your profile and reviews",
    lines: [
      // True as written: src/lib/cslb.ts looks the number up against the CSLB
      // public record when it is saved (src/app/pro/actions.ts), the
      // registered name has to match this account (migration 0125), and
      // /api/cron/license-recheck runs it again weekly.
      "Add your California license and Hearth checks it against the state board, then checks again every week, so your badge stays current.",
      // Same leave_review() rule as the homeowner side, said from the pro's
      // point of view: hired through Hearth, one per job, and an account
      // linked to yours cannot review you.
      "Reviews only come from homeowners who hired you through Hearth, one per job, so nobody can pile on jobs you never had.",
    ],
  },
  {
    icon: Users,
    title: "Clients and follow-ups",
    lines: [
      "Every homeowner you work with lands in your client list with the job and what was said.",
      "Set a follow-up and Hearth reminds you, so the next job does not quietly slip.",
    ],
  },
  {
    icon: MessageSquare,
    title: "Ask Hearth for pros",
    lines: [
      "Your copilot for pricing a job, wording a quote, and deciding which lead is worth your morning.",
      "Find it in Messages, pinned at the top, or from your account menu.",
    ],
  },
];

// A swipe has to move this far sideways to count, and stay this straight, so a
// tap on a button and a scroll down the sheet are never mistaken for one.
const SWIPE_MIN_X = 48;
const SWIPE_MAX_Y = 60;

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
  const [index, setIndex] = useState(0);
  const panelRef = useRef<HTMLDivElement | null>(null);
  // Whatever had focus when the guide opened, so closing hands it back (the
  // "Show the app guide again" link on the help pages, usually).
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const swipeStartRef = useRef<{ x: number; y: number } | null>(null);

  const slides = side === "pro" ? PRO_SLIDES : HOMEOWNER_SLIDES;
  const last = slides.length - 1;

  // Auto-open, once. Re-runs on navigation so somebody who lands on an
  // excluded page first (a payment screen, the emergency page) still gets the
  // guide on the next ordinary page instead of losing it entirely.
  useEffect(() => {
    if (open) return;
    const eligible = isEligibleForAppGuide({
      pathname,
      // The mount point is the onboarding gate: this component is only
      // rendered inside a shell that already requires a claimed home (or a
      // contractors row on the pro side).
      onboardingComplete: true,
      seenOnServer: !startOpen,
      seenInThisBrowser: readSeen(side),
    });
    if (eligible) setOpen(true);
    // `open` is deliberately absent: this must not re-fire the moment the
    // sheet opens, only on a route change or a new mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname, side, startOpen]);

  // Replay from the help pages ("Show the app guide again"). Always available,
  // seen or not, on any page.
  useEffect(() => {
    function onShow() {
      setIndex(0);
      setOpen(true);
    }
    window.addEventListener(APP_GUIDE_EVENT, onShow);
    return () => window.removeEventListener(APP_GUIDE_EVENT, onShow);
  }, []);

  const close = useCallback(() => {
    setOpen(false);
    // Both halves of "seen": the browser mirror is synchronous so nothing in
    // this session can show it again even if the round trip below is slow or
    // never lands, and the server stamp is what covers the next device.
    writeSeen(side);
    void markGuideSeenAction(side);
    const back = returnFocusRef.current;
    returnFocusRef.current = null;
    if (back && typeof back.focus === "function") back.focus();
  }, [side]);

  // Focus into the sheet on open, remember where focus came from, and keep Tab
  // inside it while it is up.
  useEffect(() => {
    if (!open) return;
    const active = document.activeElement;
    returnFocusRef.current =
      active instanceof HTMLElement && active !== document.body ? active : null;
    panelRef.current?.focus();

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
        return;
      }
      if (e.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const focusable = Array.from(
        panel.querySelectorAll<HTMLElement>(
          'button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'
        )
      ).filter((el) => el.offsetParent !== null || el === panel);
      if (focusable.length === 0) {
        // Nothing to move to: keep focus on the panel rather than letting it
        // escape to the page underneath.
        e.preventDefault();
        panel.focus();
        return;
      }
      const first = focusable[0];
      const lastEl = focusable[focusable.length - 1];
      const current = document.activeElement;
      if (e.shiftKey && (current === first || current === panel)) {
        e.preventDefault();
        lastEl.focus();
      } else if (!e.shiftKey && current === lastEl) {
        e.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, close]);

  function next() {
    if (index >= last) close();
    else setIndex(index + 1);
  }

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    // A drag that starts on a control is that control's, not a swipe.
    if ((e.target as HTMLElement).closest("button, a")) {
      swipeStartRef.current = null;
      return;
    }
    swipeStartRef.current = { x: e.clientX, y: e.clientY };
  }

  function onPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    const start = swipeStartRef.current;
    swipeStartRef.current = null;
    if (!start) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    if (Math.abs(dx) < SWIPE_MIN_X || Math.abs(dy) > SWIPE_MAX_Y) return;
    if (dx < 0) {
      // Swiping left goes forward, but never off the end: the last card is
      // closed with "Got it", deliberately, so nobody dismisses the guide with
      // a flick they did not mean.
      if (index < last) setIndex(index + 1);
    } else if (index > 0) {
      setIndex(index - 1);
    }
  }

  if (!open) return null;

  const slide = slides[index];
  const Icon = slide.icon;

  return (
    // z-[60]: one tier above everything else that can be on screen at once -
    // the bottom tab bar (z-30, Nav.tsx), the header (z-40) and the Tools sheet
    // nested in it (z-50). This is a first-run takeover; nothing outranks it.
    <div className="fixed inset-0 z-[60] flex items-end justify-center sm:items-center">
      <div
        aria-hidden="true"
        onClick={close}
        className="absolute inset-0 bg-black/40 motion-safe:animate-fade-scale"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="app-guide-title"
        tabIndex={-1}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        className="relative w-full max-h-[92vh] overflow-y-auto rounded-t-2xl border-t border-stone-200 bg-white px-6 pt-6 pb-[calc(env(safe-area-inset-bottom)+1.5rem)] shadow-menu outline-none motion-safe:animate-fade-slide-up sm:max-w-md sm:rounded-2xl sm:border sm:pb-6 dark:border-white/10 dark:bg-stone-800"
      >
        <div className="icon-chip" aria-hidden="true">
          <Icon className="h-5 w-5 text-bark-700 dark:text-stone-200" />
        </div>

        <h2
          id="app-guide-title"
          className="mt-4 text-xl font-semibold text-stone-900 [text-wrap:balance] dark:text-stone-100"
        >
          {slide.title}
        </h2>
        {slide.lines.map((line) => (
          <p
            key={line}
            className="mt-2 text-sm leading-relaxed text-stone-600 dark:text-stone-300"
          >
            {line}
          </p>
        ))}

        <p className="sr-only" aria-live="polite">
          Step {index + 1} of {slides.length}
        </p>

        <div className="mt-6 flex items-center justify-between gap-4">
          {/* Dots are decoration, not controls: a tab stop per card would put
              four extra stops between "Skip" and "Next" for no gain, and the
              live region above already says where you are out loud. */}
          <div className="flex items-center gap-1.5" aria-hidden="true">
            {slides.map((s, i) => (
              <span
                key={s.title}
                className={`h-1.5 rounded-full transition-all ${
                  i === index
                    ? "w-5 bg-bark-600 dark:bg-bark-500"
                    : "w-1.5 bg-stone-300 dark:bg-stone-600"
                }`}
              />
            ))}
          </div>
          <button type="button" onClick={next} className="btn-primary">
            {index === last ? "Got it" : "Next"}
          </button>
        </div>

        <div className="mt-3 text-center">
          <button
            type="button"
            onClick={close}
            className="focus-ring inline-flex min-h-11 items-center justify-center px-2 text-sm text-stone-500 underline hover:text-stone-700 dark:text-stone-400 dark:hover:text-stone-200"
          >
            Skip
          </button>
        </div>
      </div>
    </div>
  );
}
