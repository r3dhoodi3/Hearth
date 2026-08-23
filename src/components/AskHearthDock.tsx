"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";
import dynamic from "next/dynamic";
import { Sparkles, Maximize2, X } from "lucide-react";

// The AskHearth chat body (Markdown renderer, voice input, full conversation
// logic) is heavy and was previously bundled into every page via this dock.
// Loading it lazily keeps it out of the initial bundle; it's only fetched
// once the dock is actually opened (or a pending question opens it), which is
// exactly when it's needed. ssr:false is fine here: this is a client-only
// floating widget with no content that needs to exist in the server-rendered
// HTML, and the file is already "use client".
const AskHearth = dynamic(() => import("@/components/AskHearth"), {
  ssr: false,
  loading: () => <OpeningSkeleton />,
});

// What the panel shows while the chat chunk (or the greeting) is still in
// flight. A bare "Loading…" for several seconds read as a stall; this shows
// the shape of the conversation that is about to appear, so the wait looks
// like the panel filling in rather than nothing happening.
// Below Tailwind's sm breakpoint, matching the `sm:` classes that decide
// where the pill is allowed to render at all.
function isPhone() {
  return (
    typeof window !== "undefined" &&
    window.matchMedia("(max-width: 639px)").matches
  );
}

function OpeningSkeleton() {
  return (
    <div className="flex h-full flex-col gap-3 p-4" role="status">
      <div
        className="h-3 w-2/3 rounded bg-stone-200 motion-safe:animate-pulse dark:bg-stone-600"
        aria-hidden="true"
      />
      <div
        className="h-3 w-full rounded bg-stone-200 motion-safe:animate-pulse dark:bg-stone-600"
        aria-hidden="true"
      />
      <div
        className="h-3 w-5/6 rounded bg-stone-200 motion-safe:animate-pulse dark:bg-stone-600"
        aria-hidden="true"
      />
      <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">
        Opening Ask Hearth
      </p>
    </div>
  );
}

// A floating Ask Hearth widget pinned to the bottom-right. Always available; a
// little tab that opens into the full, scrollable conversation.
export default function AskHearthDock({
  greeting,
  greetingUrl,
  endpoint,
  storageKeyBase,
  retentionKeyBase,
  headingTitle = "Ask Hearth",
  headingSubtitle,
  hideOnPhone = false,
  phoneAskHref = "/ask",
}: {
  greeting?: string;
  // Where to fetch the proactive opener from, for callers whose greeting is
  // expensive to compute. The homeowner side passes /api/ask-greeting: its
  // greeting costs three DB queries, and computing it during every page render
  // meant every navigation paid for a string that only matters once someone
  // opens this dock. Callers whose greeting is already cheap and in hand (the
  // pro copilot builds its line from an RPC the pro dashboard runs anyway)
  // keep passing `greeting` and skip all of this.
  greetingUrl?: string;
  // Override to mount a different-brained assistant (e.g. the pro copilot).
  // Defaults leave the homeowner dock behaving exactly as before.
  endpoint?: string;
  storageKeyBase?: string;
  retentionKeyBase?: string;
  headingTitle?: string;
  headingSubtitle?: string;
  // Hide the floating pill below Tailwind's sm breakpoint. Both shells pass
  // true: each now carries an "Ask" tab in its phone bottom nav (Nav.tsx and
  // ProNav.tsx), and two entry points on a 390px screen is one too many - the
  // pill was landing on form controls (the Post a Job phone field, the Quote
  // check photo picker, the /pro/profile fields). Explicit rather than
  // inferred from `endpoint`, which said nothing about layout.
  hideOnPhone?: boolean;
  // Where a phone sends a forwarded question when the pill is hidden. The
  // full-screen counterpart of this dock: /ask for the homeowner assistant,
  // /pro/ask for the pro copilot.
  phoneAskHref?: string;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  // A question that arrived while the dock was closed; handed to the freshly
  // mounted AskHearth (which submits it once) when the dock opens for it.
  const [pendingQuestion, setPendingQuestion] = useState<string | null>(null);
  const openRef = useRef(open);
  openRef.current = open;

  // The lazily fetched opener. `settled` (not "is it non-empty") is the gate,
  // because AskHearth reads `greeting` once, when it mounts, to seed its first
  // message. Mounting it before the answer arrives would permanently show the
  // generic fallback, so the panel holds the same "Loading…" state the dynamic
  // import already uses until we know one way or the other. With no greetingUrl
  // there is nothing to wait for and this starts settled.
  const [fetchedGreeting, setFetchedGreeting] = useState<string | undefined>(
    undefined
  );
  const [greetingSettled, setGreetingSettled] = useState(!greetingUrl);
  const greetingStarted = useRef(false);

  // Fire the greeting request at most once per mount. Called on open, and
  // speculatively on hover/focus/touch of the FAB: by the time someone's
  // pointer has travelled to the button and clicked, the answer is usually
  // already back, so the panel opens straight into the conversation and the
  // Loading… state is never seen. A failure is deliberately silent - the dock
  // falls back to AskHearth's generic greeting, which is exactly what happened
  // before whenever the server-side computation returned undefined.
  const primeGreeting = useCallback(() => {
    if (!greetingUrl || greetingStarted.current) return;
    greetingStarted.current = true;
    fetch(greetingUrl)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (typeof d?.greeting === "string") setFetchedGreeting(d.greeting);
      })
      .catch(() => {})
      .finally(() => setGreetingSettled(true));
  }, [greetingUrl]);

  // Open the shell when an app-wide "ask this" event fires and no mounted
  // AskHearth instance claimed it (a page's inline box, or this dock's own
  // instance while open, takes priority). Instances claim synchronously via a
  // flag on the event object, so check it after a tick. This listener never
  // claims the event itself; it only opens the shell.
  useEffect(() => {
    function onAsk(e: Event) {
      const q = (e as CustomEvent).detail;
      if (typeof q !== "string") return;
      setTimeout(() => {
        if ((e as any).__hearthHandled) return;
        if (openRef.current) return; // the open dock's instance handles it
        // On a phone the dock isn't on screen at all (the Ask tab in the
        // bottom nav is the way in), so opening it would answer into an
        // invisible panel. Send them to the full-screen Ask view with the
        // question prefilled instead, which is what tapping the tab shows.
        if (hideOnPhone && isPhone()) {
          router.push(`${phoneAskHref}?q=${encodeURIComponent(q)}`);
          return;
        }
        primeGreeting();
        setPendingQuestion(q);
        setOpen(true);
      }, 0);
    }
    window.addEventListener("hearth:ask-question", onAsk);
    return () => window.removeEventListener("hearth:ask-question", onAsk);
  }, [primeGreeting, hideOnPhone, phoneAskHref, router]);

  function close() {
    setOpen(false);
    setPendingQuestion(null);
  }

  // Ask Hearth stays docked bottom-right on almost every screen, /emergency
  // included. The one care there: the pill must not sit on top of a panic
  // button (a wrong-tap in a real emergency). That's handled on the Emergency
  // page by giving its content bottom clearance (pb) so the pill floats over
  // empty space, not a card - see src/app/(app)/emergency/page.tsx.
  //
  // The exceptions are the two homeowner screens that already host a
  // full-screen Ask Hearth conversation, Messages and the Ask tab's own page:
  // a second entry point there is just clutter sitting on top of the composer.
  // /pro/chats is NOT hidden: the pro side has no embedded assistant, and this
  // dock is the only entry point to the pro copilot.
  const hiddenHere =
    pathname === "/chats" ||
    pathname.startsWith("/chats/") ||
    pathname === "/ask" ||
    pathname === "/pro/ask" ||
    // These pages render their own inline Ask Hearth card; a second pane
    // reading the same conversation shows every bubble twice.
    pathname === "/learn" ||
    pathname === "/search";

  // Hiding the dock unmounts its AskHearth instance while `open` and
  // `pendingQuestion` survive in this component. A fresh AskHearth mounted on
  // the way back would treat the same initialQuestion as new (its one-shot
  // guard is a ref inside the instance) and submit it again on every round
  // trip. By the time this route is reached the question was either already
  // submitted or abandoned, so drop it.
  useEffect(() => {
    if (hiddenHere && pendingQuestion) setPendingQuestion(null);
  }, [hiddenHere, pendingQuestion]);

  if (hiddenHere) return null;

  return (
    // Desktop is exactly where it was (bottom-4 right-4). The phone rules are
    // all behind the breakpoint: with hideOnPhone the pill is gone entirely
    // (the shell's Ask tab replaces it), and a caller that keeps it on a phone
    // gets a bottom offset that clears the bottom tab bar (3rem of content
    // plus the notch inset) by 12px. That explicit mobile bottom also opts
    // this widget out of the shared .fixed.bottom-4.right-4.z-40 nudge in
    // globals.css, which still covers the other floating widgets.
    <div
      className={`fixed bottom-[calc(3rem+12px+env(safe-area-inset-bottom))] right-4 z-40 print:hidden sm:bottom-4 ${
        hideOnPhone ? "hidden sm:block" : ""
      }`}
    >
      {open ? (
        <div className="flex h-[60vh] max-h-[560px] w-[22rem] max-w-[calc(100vw-2rem)] flex-col rounded-2xl border border-stone-200 bg-white p-3 shadow-pop dark:border-white/10 dark:bg-stone-800">
          <div className="mb-1 flex items-center justify-end gap-3 text-stone-500 dark:text-stone-400">
            <Link
              href="/chats?lead=ask-hearth"
              onClick={close}
              title="Open full screen in Messages"
              className="focus-ring leading-none hover:text-bark-700 dark:hover:text-stone-300"
            >
              <Maximize2 className="h-4 w-4" aria-hidden="true" />
            </Link>
            {/* Single control: the dock stays docked by design, so minimizing
                and closing are the same action (back to the FAB). */}
            <button
              type="button"
              onClick={close}
              title="Minimize"
              className="focus-ring -m-2 p-2 leading-none hover:text-stone-700 dark:hover:text-stone-200"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
          <div className="min-h-0 flex-1">
            {greetingSettled ? (
              <AskHearth
                fill
                greeting={greeting ?? fetchedGreeting}
                initialQuestion={pendingQuestion ?? undefined}
                endpoint={endpoint}
                storageKeyBase={storageKeyBase}
                retentionKeyBase={retentionKeyBase}
                headingTitle={headingTitle}
                headingSubtitle={headingSubtitle}
              />
            ) : (
              // Same placeholder the dynamic import shows, so waiting on the
              // greeting is visually indistinguishable from waiting on the
              // chunk. In practice the hover prefetch means this is rarely
              // reached at all.
              <OpeningSkeleton />
            )}
          </div>
        </div>
      ) : (
        // Compact icon-only FAB on phones; the full labeled pill from sm up.
        <button
          type="button"
          onClick={() => {
            primeGreeting();
            setOpen(true);
          }}
          onPointerEnter={primeGreeting}
          onTouchStart={primeGreeting}
          onFocus={primeGreeting}
          className="flex h-12 w-12 items-center justify-center rounded-full bg-bark-600 text-lg font-semibold text-white shadow-pop hover:bg-bark-700 dark:bg-bark-500 dark:hover:bg-bark-600 sm:h-auto sm:w-auto sm:px-4 sm:py-3 sm:text-sm"
        >
          <span aria-hidden="true" className="sm:hidden">
            <Sparkles className="h-5 w-5" />
          </span>
          <span className="sr-only sm:not-sr-only">{headingTitle}</span>
        </button>
      )}
    </div>
  );
}
