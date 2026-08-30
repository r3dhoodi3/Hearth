"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { getSupabase } from "@/lib/lazySupabase";
import InlineSpinner from "@/components/InlineSpinner";

// Below this width the panel is a bottom sheet instead of a dropdown. Matches
// Tailwind's `sm` breakpoint (640px), so the JS behavior and the `max-sm:`
// classes below can never disagree about which layout is on screen.
const PHONE_MAX_WIDTH = "(max-width: 639.98px)";

type Notification = {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  url: string | null;
  read_at: string | null;
  created_at: string;
};

// Rough "3h ago" / "2d ago" label - no need for a date library for this.
function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// Bell icon in the nav for the notifications the app already computes for the
// homeowner (weather alerts, recalls, ...). Polls for the unread count, and
// mirrors LiveUnreadBadge's realtime + poll pattern so it updates promptly
// without hammering the DB. Marking read happens the moment the panel opens,
// so the badge clears as soon as the homeowner has seen the list.
export default function NotificationBell() {
  // No client at render time: supabase-js loads on demand (see
  // src/lib/lazySupabase.ts). The bell sits in BOTH shell layouts, so a static
  // import here kept the 50 kB chunk in every signed-in route's First Load JS
  // even after the other components went lazy. Every use below is a poll, a
  // click or a subscription, all after hydration, so each awaits the loader.
  const [items, setItems] = useState<Notification[]>([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  // How many notifications the panel currently shows. Starts at 20 (the old
  // hard cap), "Show more" bumps it by 30 at a time instead of navigating to
  // a separate page (there isn't one yet, so this is the smaller change).
  const [limit, setLimit] = useState(20);
  const [hasMore, setHasMore] = useState(false);
  // Pending flags for the panel's two async buttons, so each shows its own
  // spinner instead of one shared flag covering both.
  const [markingRead, setMarkingRead] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  // Plays the exit animation instead of an instant unmount: on the open ->
  // closed transition the panel stays mounted for one more tick with
  // fade-scale-out, then drops.
  const [closing, setClosing] = useState(false);
  // Which layout is on screen. Starts false so the server render and the first
  // client render agree (the panel is closed at that point, so nothing is
  // visible either way) and the desktop dropdown stays exactly what it was.
  const [isPhone, setIsPhone] = useState(false);
  // Only true once mounted, which is what makes the phone sheet's portal into
  // document.body safe to render.
  const [portalReady, setPortalReady] = useState(false);
  const wasOpen = useRef(false);
  const ref = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  // The phone sheet is portalled to document.body (see the render below), so
  // it sits outside `ref`'s own DOM subtree. A second ref on the sheet's
  // dialog box is what lets the outside-click check below recognize a tap
  // inside the sheet as "inside", even though it is not a DOM descendant of
  // `ref`. Unused on desktop, where the dropdown lives inside `ref` already.
  const panelRef = useRef<HTMLDivElement>(null);

  async function loadCount() {
    if (typeof document !== "undefined" && document.hidden) return;
    try {
      const supabase = await getSupabase();
      const { count } = await supabase
        .from("notifications")
        .select("id", { count: "exact", head: true })
        .is("read_at", null);
      setUnread(count ?? 0);
    } catch {
      // Degrade to nothing - a failed count just leaves the badge as-is.
    }
  }

  async function loadList(lim: number) {
    try {
      const supabase = await getSupabase();
      const { data } = await supabase
        .from("notifications")
        .select("id, kind, title, body, url, read_at, created_at")
        .order("created_at", { ascending: false })
        .limit(lim);
      setItems(data ?? []);
      // A full page back means there's likely more beyond it.
      setHasMore((data ?? []).length >= lim);

      const unreadIds = (data ?? [])
        .filter((n) => !n.read_at)
        .map((n) => n.id);
      if (unreadIds.length) {
        await supabase
          .from("notifications")
          .update({ read_at: new Date().toISOString() })
          .in("id", unreadIds);
        setItems((cur) =>
          cur.map((n) =>
            unreadIds.includes(n.id)
              ? { ...n, read_at: new Date().toISOString() }
              : n
          )
        );
        setUnread(0);
      }
    } catch {
      // Leave whatever was already shown.
    }
  }

  // Loads 30 more beyond the current limit, in place, instead of a "view all" page.
  async function showMore() {
    const next = limit + 30;
    setLimit(next);
    setLoadingMore(true);
    try {
      await loadList(next);
    } finally {
      setLoadingMore(false);
    }
  }

  // Clears every unread notification, not just the batch currently loaded
  // (loadList above only marks-read the rows it fetched, which can leave the
  // badge count wrong if there are more unread than the current limit).
  async function markAllRead() {
    // Optimistic: zero the badge and dim every item to read locally first,
    // THEN fire the Supabase update in the background. There is nothing to
    // roll back on failure - the worst case is a stale read_at that the next
    // poll (or simply reopening the panel, which re-marks read on load)
    // reconciles anyway, and that beats leaving the badge stuck on its old
    // count while the request is still in flight.
    setItems((cur) =>
      cur.map((n) => (n.read_at ? n : { ...n, read_at: new Date().toISOString() }))
    );
    setUnread(0);
    setMarkingRead(true);
    try {
      const supabase = await getSupabase();
      await supabase
        .from("notifications")
        .update({ read_at: new Date().toISOString() })
        .is("read_at", null);
    } catch {
      // Leave whatever was already shown; next poll will reconcile.
    } finally {
      setMarkingRead(false);
    }
  }

  useEffect(() => {
    let active = true;
    async function poll() {
      await loadCount();
    }
    poll();

    // The topic is unique per mount, not just fixed: supabase-js returns the
    // SAME already-subscribed channel instance for a repeated topic, and a
    // second .on() on an already-subscribed channel throws. That collision is
    // reachable via React dev StrictMode's mount-cleanup-remount (the
    // cleanup's removeChannel is async, so the remount can win the race), so
    // a random suffix isolates every instance instead of sharing one topic.
    //
    // The subscription waits for the signed-in user id because it MUST carry a
    // filter. Without one the client asks the realtime server for every
    // notifications INSERT in the table and leans on RLS alone to trim the
    // stream down to this user's rows; a filter means the server never
    // considers anybody else's row in the first place. user_id is the owning
    // column (0026_notifications.sql), the same one the RLS policy keys off.
    // Until getUser() resolves the poll below is the only path, which is
    // exactly what it is for.
    type Client = Awaited<ReturnType<typeof getSupabase>>;
    let client: Client | null = null;
    let channel: ReturnType<Client["channel"]> | null = null;
    let cancelled = false;
    getSupabase()
      .then(async (supabase) => {
        client = supabase;
        const { data } = await supabase.auth.getUser();
        const uid = data?.user?.id;
        if (cancelled || !uid) return;
        try {
          const topic = "notifications-bell-" + Math.random().toString(36).slice(2);
          channel = supabase
            .channel(topic)
            .on(
              "postgres_changes",
              {
                event: "INSERT",
                schema: "public",
                table: "notifications",
                filter: `user_id=eq.${uid}`,
              },
              () => active && poll()
            )
            .subscribe();
        } catch {
          // Realtime is strictly best-effort: the poll/focus paths below keep
          // the bell working on their own, so a subscribe failure here must
          // never crash the signed-in shell.
          console.warn("NotificationBell: realtime subscription failed, falling back to polling");
        }
      })
      .catch(() => {
        // No user id, no scoped channel. Same posture: polling covers it.
      });

    const onFocus = () => poll();
    window.addEventListener("focus", onFocus);
    const t = setInterval(poll, 30000);
    return () => {
      active = false;
      cancelled = true;
      if (channel && client) {
        try {
          client.removeChannel(channel);
        } catch {
          // Best-effort cleanup: nothing to do if this fails, the channel is
          // going away along with the component either way.
        }
      }
      window.removeEventListener("focus", onFocus);
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  // Track the breakpoint, because the two layouts do not just look different -
  // they behave differently (see the outside-click effect below).
  useEffect(() => {
    setPortalReady(true);
    let media: MediaQueryList;
    try {
      media = window.matchMedia(PHONE_MAX_WIDTH);
    } catch {
      // No matchMedia (very old engine, some test environments): stay on the
      // desktop behavior, which is the one that works with a mouse.
      return;
    }
    const sync = () => setIsPhone(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);

  // Close on outside click or Escape - matches ProfileMenu. Escape hands
  // focus back to the trigger so keyboard users aren't dropped at the top of
  // the page.
  //
  // BOTH layouts: a click or tap on the backdrop, or anywhere else outside the
  // panel, closes it - on the phone sheet exactly like the desktop dropdown.
  // The backdrop below has no handler of its own; it closes because it is
  // outside both refs checked here, same as the rest of the page.
  //
  // Only mousedown ever reaches this handler - never scroll, wheel, or
  // touchmove, and it never will. That is deliberate: this used to also
  // listen on scroll, and a touch flick that starts outside the panel
  // dispatches a synthesized mousedown at the touch point, so "I flicked the
  // page" and "I tapped outside" looked identical and closed the sheet out
  // from under a page that was merely moving. Listening only for the pointer
  // event itself, and nothing scroll-shaped, is what keeps a scroll from
  // closing the panel while still closing it on a real tap.
  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      const target = e.target as Node;
      const insideTrigger = ref.current?.contains(target);
      const insidePanel = panelRef.current?.contains(target);
      if (!insideTrigger && !insidePanel) setOpen(false);
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

  // Hold the page still behind the phone sheet. Without this the backdrop dims
  // a page that still scrolls under the finger, which reads as broken. Restores
  // whatever inline value was there before rather than assuming "" - another
  // component may own it while a chat keyboard is open.
  //
  // <html> AND <body>, not body alone: body's overflow only reaches the
  // viewport by the propagation rule, and only while the root's own overflow is
  // visible. A live check still saw the dashboard scrolling behind this sheet,
  // so the root is locked directly rather than relying on that. overscroll
  // -behavior on the root is the belt to that braces: anything that does manage
  // to reach the page stops there instead of dragging it.
  //
  // Keyed on shouldRender, not open, so the lock outlasts the 120ms exit
  // animation - releasing it while the sheet is still painted let the page jump
  // underneath a visible sheet.
  useEffect(() => {
    if (!isPhone || !shouldRender) return;
    const root = document.documentElement;
    const previousBody = document.body.style.overflow;
    const previousRoot = root.style.overflow;
    const previousBounce = root.style.overscrollBehavior;
    document.body.style.overflow = "hidden";
    root.style.overflow = "hidden";
    root.style.overscrollBehavior = "contain";
    return () => {
      document.body.style.overflow = previousBody;
      root.style.overflow = previousRoot;
      root.style.overscrollBehavior = previousBounce;
    };
  }, [isPhone, shouldRender]);

  function togglePanel() {
    const next = !open;
    setOpen(next);
    if (next) {
      setLimit(20);
      loadList(20);
    }
  }

  // Everything inside the panel, shared by the desktop dropdown and the phone
  // sheet so the two can never drift. Every phone-specific rule here is a
  // `max-sm:` utility, which is inert from 640px up: the desktop dropdown
  // computes exactly the styles it did before.
  const panelBody = (
    <>
      <div className="flex items-center justify-between border-b border-stone-100 px-4 py-2 dark:border-white/10">
        <span className="text-sm font-semibold text-stone-900 dark:text-stone-100">
          Notifications
        </span>
        {items.length > 0 && (
          <button
            type="button"
            onClick={markAllRead}
            disabled={markingRead}
            // Phone only: 16px tall before, in a header row where every
            // other target is bigger.
            className="inline-flex items-center gap-1.5 text-xs font-medium text-bark-700 hover:underline active:opacity-70 disabled:opacity-50 max-sm:min-h-11 max-sm:text-sm dark:text-stone-300"
          >
            {markingRead && <InlineSpinner size={12} />}
            Mark all read
          </button>
        )}
        {/* Phone only. An outside tap already closes the sheet (see the
            outside-click effect above), but this stays as the obvious,
            reachable-with-a-thumb close control right where the sheet is.
            `sm:hidden` removes it from the flex row entirely on desktop
            (display:none is not a flex item), so the dropdown's header is
            laid out exactly as before. */}
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            btnRef.current?.focus();
          }}
          aria-label="Close notifications"
          className="-mr-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-stone-400 hover:bg-stone-100 hover:text-stone-600 sm:hidden dark:hover:bg-stone-600 dark:hover:text-stone-200"
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
      {/* overscroll-contain: a flick that reaches the end of this list must
          not hand the scroll to the page behind it (that "scroll chaining" is
          what made the sheet feel like it was closing itself). max-sm:flex-1
          lets the list, not the card, own the leftover height in the sheet. */}
      <div className="max-h-80 overflow-y-auto overscroll-contain max-sm:max-h-none max-sm:flex-1">
        {items.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-stone-500 dark:text-stone-400">
            Nothing new right now.
          </p>
        ) : (
          // role="list" restores list semantics that Tailwind's list-none
          // reset strips in some screen readers.
          <ul role="list">
            {items.map((n) => {
              const content = (
                <>
                  <p className="text-sm font-medium text-stone-900 dark:text-stone-100">
                    {n.title}
                  </p>
                  {n.body && (
                    <p className="mt-0.5 line-clamp-2 text-xs text-stone-500 dark:text-stone-400">
                      {n.body}
                    </p>
                  )}
                  <p className="mt-1 text-[11px] text-stone-500 max-sm:text-xs dark:text-stone-400">
                    {timeAgo(n.created_at)}
                  </p>
                </>
              );
              return (
                <li
                  key={n.id}
                  className="border-b border-stone-50 last:border-b-0 dark:border-white/5"
                >
                  {n.url ? (
                    <Link
                      href={n.url}
                      onClick={() => setOpen(false)}
                      // max-sm:min-h-11: a row is the tap target, so it stays
                      // at least 44px tall even for a one-line notification.
                      className="block px-4 py-3 hover:bg-bark-50 max-sm:flex max-sm:min-h-11 max-sm:flex-col max-sm:justify-center dark:hover:bg-stone-600"
                    >
                      {content}
                    </Link>
                  ) : (
                    <div className="px-4 py-3 max-sm:flex max-sm:min-h-11 max-sm:flex-col max-sm:justify-center">
                      {content}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {hasMore && (
        <button
          type="button"
          onClick={showMore}
          disabled={loadingMore}
          // Phone only: 32px tall before.
          className="flex w-full items-center justify-center gap-1.5 border-t border-stone-100 px-4 py-2 text-center text-xs font-medium text-bark-700 hover:bg-bark-50 hover:underline active:opacity-70 disabled:opacity-50 max-sm:min-h-11 max-sm:shrink-0 max-sm:text-sm dark:border-white/10 dark:text-stone-300 dark:hover:bg-stone-600"
        >
          {loadingMore && <InlineSpinner size={12} />}
          Show more
        </button>
      )}
    </>
  );

  return (
    <div ref={ref} className="relative">
      <button
        ref={btnRef}
        type="button"
        onClick={togglePanel}
        aria-expanded={open}
        aria-label={
          unread > 0 ? `Notifications, ${unread} unread` : "Notifications"
        }
        // Phone only: a 44x44 hit area (the tap-target minimum) in 40px of
        // header width, because -mx-0.5 pulls 2px of the extra box on each
        // side back out of the layout.
        //
        // -mx-0.5 and not -mx-1: the nav row this sits in has gap-0.5 (2px)
        // below sm, so pulling the full 4px per side made this button's
        // tappable box overlap its neighbours' by 2px on each side - the
        // search link on one side, the profile menu on the other - and the
        // bell, painted later, won the overlap. At -mx-0.5 the boxes abut
        // exactly instead, costing the row 4px it can spare and stealing no
        // taps from either neighbour.
        //
        // From sm up the box goes back to a plain 36px: the desktop header
        // row is sized off it, and a taller button there would push the whole
        // bar down 4px for no benefit (a mouse doesn't need the bigger
        // target).
        className="group -mx-0.5 flex h-11 w-11 items-center justify-center active:scale-95 sm:mx-0 sm:h-9 sm:w-9"
      >
        {/* The visible control stays the old 36px circle - icon, hover ring,
            and badge all unchanged. Only the tappable box around it grew. */}
        <span className="relative flex h-9 w-9 items-center justify-center rounded-full text-stone-500 group-hover:bg-bark-50 group-hover:text-bark-700 dark:text-stone-400 dark:group-hover:bg-stone-800 dark:group-hover:text-stone-300">
          <svg
            viewBox="0 0 24 24"
            className="h-5 w-5"
            fill="currentColor"
            aria-hidden="true"
          >
            <path d="M12 2a6 6 0 00-6 6v3.09c0 .5-.16.98-.46 1.38L4 15.5c-.6.8-.02 2 .98 2h14.04c1 0 1.58-1.2.98-2l-1.54-3.03A2.25 2.25 0 0118 11.09V8a6 6 0 00-6-6z" />
            <path d="M9.5 20a2.5 2.5 0 005 0h-5z" />
          </svg>
          {unread > 0 && (
            <span className="absolute -right-0.5 -top-0.5 inline-flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-red-600 px-1 text-[10px] font-semibold text-white">
              {unread > 9 ? "9+" : unread}
            </span>
          )}
        </span>
      </button>

      {/* DESKTOP: the dropdown, unchanged. Plain disclosure panel, not an ARIA
          menu: we don't implement the menu keyboard contract (arrow keys,
          focus trapping), so we don't claim the role either. The notifications
          themselves are a list. */}
      {shouldRender && !isPhone && (
        <div
          data-testid="notification-panel"
          className={`absolute right-0 z-20 mt-1 w-80 overflow-hidden rounded-xl border border-stone-200 bg-white shadow-menu dark:border-white/10 dark:bg-stone-700 ${
            open ? "motion-safe:animate-fade-scale" : "motion-safe:animate-fade-scale-out"
          }`}
        >
          {panelBody}
        </div>
      )}

      {/* PHONE: a bottom sheet instead of a dropdown. Closes the same way the
          desktop dropdown does: a tap on the dimmed backdrop, a tap anywhere
          else outside it, Escape, the X, or opening a notification.
          Portalled to document.body rather than rendered here: this sits
          inside the sticky header (z-40 homeowner, z-30 pro) and the fixed
          bottom tab bar is also z-30, so a sheet left inside the header's
          stacking context paints UNDER the tab bar on the pro side. The
          portal puts it above everything. */}
      {shouldRender && isPhone && portalReady &&
        createPortal(
          <div data-testid="notification-sheet" className="sm:hidden">
            {/* Backdrop. Dims the page and, like the rest of the page outside
                the panel, closes it on tap - it has no handler of its own,
                that comes from the outside-click effect above finding it
                outside both refs. aria-hidden because it is decoration with
                no action of its own. */}
            <div
              aria-hidden="true"
              className={`fixed inset-0 z-[55] bg-stone-900/40 ${
                open ? "motion-safe:animate-fade-scale" : "motion-safe:animate-fade-scale-out"
              }`}
            />
            <div
              ref={panelRef}
              role="dialog"
              aria-label="Notifications"
              // Anchored to the bottom of the screen and capped at 85% of the
              // viewport, so the page behind stays visible enough to keep
              // your place. flex-col + the list's flex-1 make the list the
              // part that scrolls, never the sheet.
              // overscroll-contain here as well as on the list: the list
              // already refuses to hand a flick to the page, but a flick that
              // starts on the sheet's header (not a scroll container) used to
              // chain straight out of this box.
              className={`fixed inset-x-0 bottom-0 z-[60] flex max-h-[85dvh] flex-col overflow-hidden overscroll-contain rounded-t-2xl border-t border-stone-200 bg-white pb-[env(safe-area-inset-bottom)] shadow-menu dark:border-white/10 dark:bg-stone-700 ${
                open
                  ? "motion-safe:animate-fade-slide-up"
                  : "motion-safe:animate-fade-slide-down"
              }`}
            >
              {panelBody}
            </div>
          </div>,
          document.body
        )}
    </div>
  );
}
