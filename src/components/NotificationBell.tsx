"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import InlineSpinner from "@/components/InlineSpinner";

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
  const supabase = createClient();
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
  const wasOpen = useRef(false);
  const ref = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  async function loadCount() {
    if (typeof document !== "undefined" && document.hidden) return;
    try {
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
    let channel: ReturnType<typeof supabase.channel> | null = null;
    try {
      const topic = "notifications-bell-" + Math.random().toString(36).slice(2);
      channel = supabase
        .channel(topic)
        .on(
          "postgres_changes",
          { event: "INSERT", schema: "public", table: "notifications" },
          () => active && poll()
        )
        .subscribe();
    } catch {
      // Realtime is strictly best-effort: the poll/focus paths below keep the
      // bell working on their own, so a subscribe failure here must never
      // crash the signed-in shell.
      console.warn("NotificationBell: realtime subscription failed, falling back to polling");
    }

    const onFocus = () => poll();
    window.addEventListener("focus", onFocus);
    const t = setInterval(poll, 30000);
    return () => {
      active = false;
      if (channel) {
        try {
          supabase.removeChannel(channel);
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

  // Close on outside click or Escape - matches ProfileMenu. Escape hands
  // focus back to the trigger so keyboard users aren't dropped at the top of
  // the page.
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

  function togglePanel() {
    const next = !open;
    setOpen(next);
    if (next) {
      setLimit(20);
      loadList(20);
    }
  }

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

      {/* Plain disclosure panel, not an ARIA menu: we don't implement the
          menu keyboard contract (arrow keys, focus trapping), so we don't
          claim the role either. The notifications themselves are a list. */}
      {shouldRender && (
        <div
          className={`absolute right-0 z-20 mt-1 w-80 overflow-hidden rounded-xl border border-stone-200 bg-white shadow-menu dark:border-white/10 dark:bg-stone-700 ${
            open ? "motion-safe:animate-fade-scale" : "motion-safe:animate-fade-scale-out"
          }`}
        >
          <div className="flex items-center justify-between border-b border-stone-100 px-4 py-2 dark:border-white/10">
            <span className="text-sm font-semibold text-stone-900 dark:text-stone-100">
              Notifications
            </span>
            {items.length > 0 && (
              <button
                type="button"
                onClick={markAllRead}
                disabled={markingRead}
                className="inline-flex items-center gap-1.5 text-xs font-medium text-bark-700 hover:underline active:opacity-70 disabled:opacity-50 dark:text-stone-300"
              >
                {markingRead && <InlineSpinner size={12} />}
                Mark all read
              </button>
            )}
          </div>
          <div className="max-h-80 overflow-y-auto">
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
                      <p className="mt-1 text-[11px] text-stone-500 dark:text-stone-400">
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
                          className="block px-4 py-3 hover:bg-bark-50 dark:hover:bg-stone-600"
                        >
                          {content}
                        </Link>
                      ) : (
                        <div className="px-4 py-3">{content}</div>
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
              className="flex w-full items-center justify-center gap-1.5 border-t border-stone-100 px-4 py-2 text-center text-xs font-medium text-bark-700 hover:bg-bark-50 hover:underline active:opacity-70 disabled:opacity-50 dark:border-white/10 dark:text-stone-300 dark:hover:bg-stone-600"
            >
              {loadingMore && <InlineSpinner size={12} />}
              Show more
            </button>
          )}
        </div>
      )}
    </div>
  );
}
