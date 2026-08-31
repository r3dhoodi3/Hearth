"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { usePathname, useRouter } from "next/navigation";
import type { GuideSide } from "@/lib/appGuide";

// The first-run guide, rebuilt as a game-style spotlight tour. Instead of a
// bottom sheet of cards read in the abstract, each step brings the user to the
// page it talks about, dims everything except the one element it means, and
// draws a ring around it. AppGuide.tsx still owns every "should this show at
// all" rule (eligibility, snooze, the seen stamp); this component only owns
// the experience while it is up, and reports out through two callbacks:
// onClose when the tour ends (Done, Skip tour, or Escape - all of which
// AppGuide treats as "seen", exactly as its old dismiss did), and
// onTourNavigate just before the tour pushes a route itself, so AppGuide can
// tell a tour-driven navigation from the user wandering off (which still
// snoozes and closes the guide, unchanged).

export type TourStep = {
  // The page this step lives on. When the previous step ended somewhere else
  // the tour navigates here itself.
  route: string;
  // CSS selector for the element this step points at, or null for a step with
  // nothing to circle (the card centers instead). When the selector matches
  // several elements (the same link exists in the desktop strip and the phone
  // tab bar), the first VISIBLE one wins - visibility judged by a non-empty
  // bounding rect, which is exactly what display:none zeroes out.
  target: string | null;
  // Optional climb from the matched element to a named ancestor, for
  // spotlighting a whole card when only a child of it has a stable hook.
  targetClosest?: string;
  title: string;
  // One or two plain sentences, no more.
  body: string;
  // Which side of the cutout the card prefers. Without it the card picks the
  // roomier side on its own.
  fallbackPlacement?: "above" | "below";
};

// Every selector here is a hook that already exists in the product markup
// (an id, an href, an aria-label, a shared utility class), never one added
// for the tour: the nav files are mid-edit by other work and must not grow
// tour-specific attributes.
export const HOMEOWNER_STEPS: TourStep[] = [
  {
    route: "/dashboard",
    // The Home Health Score hero card, dashboard/page.tsx. card-hero appears
    // once on /dashboard (other pages reuse the class, but every step is
    // scoped to its own route).
    target: ".card-hero",
    title: "Your home score",
    body: "This number is a quick read on how your home is doing. It moves when a system ages or a task gets done, so you find out without going looking.",
  },
  {
    route: "/dashboard",
    // The weather strip has no id of its own; its local-time element carries
    // a stable aria-label (WeatherStrip.tsx), and climbing to .shadow-card
    // lands on the strip's own root. While the weather is still loading the
    // clock does not exist yet, so this step quietly centers instead.
    target: 'time[aria-label="Local time at your home"]',
    targetClosest: ".shadow-card",
    title: "Weather at your place",
    body: "Current conditions for your home's city, with the week ahead one tap away. Storm alerts show up right below when something is coming.",
    fallbackPlacement: "below",
  },
  {
    route: "/dashboard",
    // The systems inventory, <details id="systems"> on the dashboard.
    target: "#systems",
    title: "Your systems",
    body: "These came with your home. Tap one to tell us what you know about it, and your score, reminders, and forecasts all get sharper.",
  },
  {
    route: "/dashboard",
    // The Messages tab. Scoped to nav so the visible match is the phone tab
    // bar below lg and the header strip's pill from lg up, never a stray link
    // in the page body.
    target: 'nav a[href="/chats"]',
    title: "Messages and Ask Hearth",
    body: "Ask Hearth lives here, pinned at the top of Messages. Ask anything about your house and it answers from your own systems and their ages.",
    fallbackPlacement: "above",
  },
  {
    route: "/dashboard",
    // The Post a Job tab, same nav scoping as above.
    target: 'nav a[href="/contractors"]',
    title: "Find a pro",
    body: "Post the job once and local pros apply to it. Your phone and email stay private until you pick someone.",
    fallbackPlacement: "above",
  },
];

export const PRO_STEPS: TourStep[] = [
  {
    route: "/pro",
    // The "Today" stats grid on the pro Home screen (HomeView.tsx). The
    // Wallet card is the one tile with a unique stable hook (its href plus
    // the card-link class, which the hidden profile-menu link to the same
    // page does not carry), and climbing to .grid rings the whole row.
    target: '.card-link[href="/pro/billing"]',
    targetClosest: ".grid",
    title: "Today's numbers",
    body: "Your wallet, open jobs, active work, and win rate in one row. Each card opens the page behind it.",
  },
  {
    route: "/pro",
    target: 'nav a[href="/pro/leads"]',
    title: "The leads board",
    body: "Homeowners post jobs with the home details already filled in. Leads is where you see the work near you and apply to the jobs that fit.",
    fallbackPlacement: "above",
  },
  {
    route: "/pro",
    target: 'nav a[href="/pro/chats"]',
    title: "Messages and your copilot",
    body: "Homeowner conversations live here. Ask Hearth is pinned at the top, for pricing a job or wording a quote.",
    fallbackPlacement: "above",
  },
  {
    route: "/pro",
    target: 'nav a[href="/pro/business"]',
    title: "Your public page",
    body: "Your wins, reviews, and the link to your public page live under Business. It is what homeowners see when you apply.",
    fallbackPlacement: "above",
  },
];

// How long a step waits for its element before giving up and centering the
// card. It also has to cover the tour's own navigation landing, so it is
// longer than a plain render wait would need.
export const TOUR_TARGET_TIMEOUT_MS = 4000;
// The poll that backs up the MutationObserver, for appearances the observer
// cannot see (an attribute flip, a CSS breakpoint change).
export const TOUR_POLL_MS = 150;
// Breathing room between the element and the edge of its cutout.
const CUTOUT_PAD = 8;
// Corner radius of the cutout and its ring.
const CUTOUT_RADIUS = 12;
// Gap between the cutout and the card.
const CARD_GAP = 12;
// Below this much free space on the preferred side, the card flips to the
// other side if that one is roomier.
const CARD_MIN_SPACE = 200;

type Rect = { top: number; left: number; width: number; height: number };

// "seeking" while the step's element is being waited for, "anchored" once it
// is measured, "fallback" when it never showed inside the timeout. The card
// is on screen in all three (centered until anchored), so there is never a
// blank overlay.
type Phase = "seeking" | "anchored" | "fallback";

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), Math.max(lo, hi));
}

function findStepElement(step: TourStep): HTMLElement | null {
  if (!step.target) return null;
  let matches: HTMLElement[];
  try {
    matches = Array.from(document.querySelectorAll<HTMLElement>(step.target));
  } catch {
    // A selector typo must degrade to the centered card, never crash the app.
    return null;
  }
  for (const raw of matches) {
    const el = step.targetClosest
      ? raw.closest<HTMLElement>(step.targetClosest) ?? raw
      : raw;
    const r = el.getBoundingClientRect();
    // Zero-size means hidden (a display:none desktop strip on a phone, or the
    // reverse), so keep looking for the rendition that is actually on screen.
    if (r.width > 0 && r.height > 0) return el;
  }
  return null;
}

function measure(el: HTMLElement): Rect {
  const r = el.getBoundingClientRect();
  return { top: r.top, left: r.left, width: r.width, height: r.height };
}

// The scrim with a hole in it: one evenodd path whose outer ring is the whole
// viewport and whose inner ring is a rounded rect around the target. Exported
// for the unit tests, which check the hole really is where the target is.
export function spotlightPath(
  vw: number,
  vh: number,
  cut: Rect
): string {
  const x = cut.left;
  const y = cut.top;
  const w = cut.width;
  const h = cut.height;
  const r = Math.min(CUTOUT_RADIUS, w / 2, h / 2);
  const outer = `M0 0H${vw}V${vh}H0Z`;
  const inner =
    `M${x + r} ${y}` +
    `H${x + w - r}A${r} ${r} 0 0 1 ${x + w} ${y + r}` +
    `V${y + h - r}A${r} ${r} 0 0 1 ${x + w - r} ${y + h}` +
    `H${x + r}A${r} ${r} 0 0 1 ${x} ${y + h - r}` +
    `V${y + r}A${r} ${r} 0 0 1 ${x + r} ${y}Z`;
  return outer + inner;
}

export default function SpotlightTour({
  side,
  onClose,
  onTourNavigate,
}: {
  side: GuideSide;
  // Ends the tour with the same finality the old guide's dismiss had: the
  // caller stamps the account and this component unmounts.
  onClose: () => void;
  // Called just before the tour pushes a route itself, so the caller can tell
  // a tour-driven navigation from the user leaving (which closes the tour).
  onTourNavigate: (route: string) => void;
}) {
  const steps = side === "pro" ? PRO_STEPS : HOMEOWNER_STEPS;
  const router = useRouter();
  const pathname = usePathname();
  const [index, setIndex] = useState(0);
  const [phase, setPhase] = useState<Phase>("seeking");
  const [rect, setRect] = useState<Rect | null>(null);
  // Bumped when an anchored element disappears mid-step (a client rerender
  // swapped the node out), so the seek below runs again for the same step.
  const [seekNonce, setSeekNonce] = useState(0);
  // Rendered client-side only (AppGuide mounts this after an effect), so the
  // window is always there to read.
  const [viewport, setViewport] = useState(() => ({
    w: window.innerWidth,
    h: window.innerHeight,
  }));
  const elRef = useRef<HTMLElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const pathnameRef = useRef(pathname);
  pathnameRef.current = pathname;

  const step = steps[index];
  const last = steps.length - 1;

  // Bring the user to the step's page. Keyed on the step alone, on purpose:
  // this must fire exactly once per step, when it becomes current, and never
  // again in response to a pathname change - reacting to pathname would have
  // the tour yank someone back after they pressed the browser's back button,
  // in the instant before AppGuide notices the external navigation and closes
  // the whole thing.
  useEffect(() => {
    if (pathnameRef.current === step.route) return;
    onTourNavigate(step.route);
    router.push(step.route);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index]);

  // Find the step's element: an immediate try, then a MutationObserver plus a
  // slow poll while the page (or the tour's own navigation) catches up, then
  // a centered card if it never shows. Keyed on pathname too, so the element
  // hunt restarts the moment the navigation lands.
  useEffect(() => {
    setPhase("seeking");
    setRect(null);
    elRef.current = null;
    if (!step.target) {
      setPhase("fallback");
      return;
    }

    let done = false;
    let observer: MutationObserver | null = null;
    let poll: ReturnType<typeof setInterval> | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    function stop() {
      done = true;
      observer?.disconnect();
      if (poll) clearInterval(poll);
      if (timer) clearTimeout(timer);
    }

    function attempt() {
      if (done) return;
      const el = findStepElement(step);
      if (!el) return;
      stop();
      elRef.current = el;
      // Centered in the viewport before measuring, so the cutout is never
      // half off screen for a target far down the page. jsdom has no
      // scrollIntoView, hence the guard.
      if (typeof el.scrollIntoView === "function") {
        try {
          el.scrollIntoView({ block: "center" });
        } catch {
          // A failed scroll only means the measurement happens where we are.
        }
      }
      setRect(measure(el));
      setPhase("anchored");
    }

    attempt();
    if (done) return stop;

    observer = new MutationObserver(attempt);
    observer.observe(document.body, { childList: true, subtree: true });
    poll = setInterval(attempt, TOUR_POLL_MS);
    timer = setTimeout(() => {
      if (done) return;
      stop();
      setPhase("fallback");
    }, TOUR_TARGET_TIMEOUT_MS);

    return stop;
  }, [index, step, pathname, seekNonce]);

  // While anchored, keep the cutout glued to the element through scrolling
  // (capture, so scrolls inside nested containers count too) and resizing.
  // An element that has left the DOM sends the step back to seeking rather
  // than leaving a ring around where it used to be.
  useEffect(() => {
    if (phase !== "anchored") return;

    function remeasure() {
      const el = elRef.current;
      if (!el || !el.isConnected) {
        setSeekNonce((n) => n + 1);
        return;
      }
      setRect(measure(el));
    }

    function onResize() {
      setViewport({ w: window.innerWidth, h: window.innerHeight });
      remeasure();
    }

    window.addEventListener("scroll", remeasure, true);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("scroll", remeasure, true);
      window.removeEventListener("resize", onResize);
    };
  }, [phase]);

  // Focus follows the card from step to step, and Tab stays inside it while
  // the tour is up. Escape skips, with the same finality as "Skip tour".
  useEffect(() => {
    cardRef.current?.focus();
  }, [index]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const card = cardRef.current;
      if (!card) return;
      const focusable = Array.from(
        card.querySelectorAll<HTMLElement>(
          'button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'
        )
      );
      if (focusable.length === 0) {
        e.preventDefault();
        card.focus();
        return;
      }
      const first = focusable[0];
      const lastEl = focusable[focusable.length - 1];
      const current = document.activeElement;
      if (e.shiftKey && (current === first || current === card)) {
        e.preventDefault();
        lastEl.focus();
      } else if (!e.shiftKey && current === lastEl) {
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  function next() {
    if (index >= last) onClose();
    else setIndex(index + 1);
  }

  const { w: vw, h: vh } = viewport;

  // The cutout: the element's rect plus padding, clamped to the viewport so a
  // target hanging half off screen never produces negative geometry.
  let cutout: Rect | null = null;
  if (phase === "anchored" && rect) {
    const x = clamp(rect.left - CUTOUT_PAD, 0, vw);
    const y = clamp(rect.top - CUTOUT_PAD, 0, vh);
    const right = clamp(rect.left + rect.width + CUTOUT_PAD, 0, vw);
    const bottom = clamp(rect.top + rect.height + CUTOUT_PAD, 0, vh);
    cutout = { top: y, left: x, width: right - x, height: bottom - y };
  }

  // Where the card goes: above or below the cutout, whichever the step
  // prefers, flipped when the preferred side is too tight and the other side
  // has more room. Without a cutout the card just centers.
  let cardStyle: CSSProperties;
  if (cutout) {
    const spaceBelow = vh - (cutout.top + cutout.height);
    const spaceAbove = cutout.top;
    let placement =
      step.fallbackPlacement ??
      (cutout.top + cutout.height / 2 < vh / 2 ? "below" : "above");
    if (
      placement === "below" &&
      spaceBelow < CARD_MIN_SPACE &&
      spaceAbove > spaceBelow
    ) {
      placement = "above";
    } else if (
      placement === "above" &&
      spaceAbove < CARD_MIN_SPACE &&
      spaceBelow > spaceAbove
    ) {
      placement = "below";
    }
    cardStyle =
      placement === "below"
        ? { top: cutout.top + cutout.height + CARD_GAP }
        : { bottom: vh - cutout.top + CARD_GAP };
  } else {
    cardStyle = { top: "50%", transform: "translateY(-50%)" };
  }

  // The two shells accent differently (bark on the homeowner side, hearth on
  // the pro side), same split ShowAppGuideButton makes.
  const ringClass =
    side === "pro"
      ? "border-hearth-600 dark:border-hearth-400"
      : "border-bark-600 dark:border-bark-400";
  const dotClass = side === "pro" ? "bg-hearth-600" : "bg-bark-600";

  return (
    // z-[60]: one tier above everything else on screen at once - the bottom
    // tab bar (z-30), the header (z-40), the Tools sheet (z-50). Same slot
    // the old guide sheet held. The scrim layers below have no click handler
    // on purpose: during the tour the page underneath, spotlighted element
    // included, is not clickable, and the only live controls are the card's.
    <div className="fixed inset-0 z-[60]">
      {cutout ? (
        <>
          <svg
            data-testid="tour-cutout"
            className="absolute inset-0 h-full w-full"
            viewBox={`0 0 ${vw} ${vh}`}
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <path
              d={spotlightPath(vw, vh, cutout)}
              fillRule="evenodd"
              className="fill-black/60"
            />
          </svg>
          {/* The ring around the cutout. motion-safe keeps the pulse off for
              anyone with reduced motion set; the ring itself stays. */}
          <div
            data-testid="tour-ring"
            aria-hidden="true"
            className={`pointer-events-none absolute rounded-xl border-2 ${ringClass} motion-safe:animate-pulse`}
            style={{
              top: cutout.top,
              left: cutout.left,
              width: cutout.width,
              height: cutout.height,
            }}
          />
        </>
      ) : (
        // No target (yet, or ever): a plain scrim with the card centered on
        // it. Never a blank overlay.
        <div
          data-testid="tour-scrim"
          aria-hidden="true"
          className="absolute inset-0 bg-black/60"
        />
      )}

      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="spotlight-tour-title"
        tabIndex={-1}
        style={cardStyle}
        className="absolute left-4 right-4 mx-auto max-h-[70vh] max-w-sm overflow-y-auto rounded-2xl border border-stone-200 bg-white p-5 shadow-menu outline-none dark:border-white/10 dark:bg-stone-800"
      >
        <h2
          id="spotlight-tour-title"
          className="text-lg font-semibold text-stone-900 [text-wrap:balance] dark:text-stone-100"
        >
          {step.title}
        </h2>
        <p className="mt-1.5 text-sm leading-relaxed text-stone-600 dark:text-stone-300">
          {step.body}
        </p>

        <p className="sr-only" aria-live="polite">
          Step {index + 1} of {steps.length}
        </p>

        <div className="mt-4 flex items-center justify-between gap-4">
          {/* Dots are decoration, not controls, same reasoning as the old
              guide: a tab stop per step would pile stops between "Skip tour"
              and "Next", and the live region already says where you are. */}
          <div className="flex items-center gap-1.5" aria-hidden="true">
            {steps.map((s, i) => (
              <span
                key={s.title}
                className={`h-1.5 rounded-full transition-all ${
                  i === index
                    ? `w-5 ${dotClass}`
                    : "w-1.5 bg-stone-300 dark:bg-stone-600"
                }`}
              />
            ))}
          </div>
          <button type="button" onClick={next} className="btn-primary min-h-11">
            {index === last ? "Done" : "Next"}
          </button>
        </div>

        <div className="mt-2 text-center">
          <button
            type="button"
            onClick={onClose}
            className="focus-ring inline-flex min-h-11 items-center justify-center px-2 text-sm text-stone-500 underline hover:text-stone-700 dark:text-stone-400 dark:hover:text-stone-200"
          >
            Skip tour
          </button>
        </div>
      </div>
    </div>
  );
}
