"use client";

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { getSupabase } from "@/lib/lazySupabase";

// The browser client's type, taken from the lazy loader rather than imported
// from supabase-js, so this module keeps no runtime dependency on it.
type Browser = Awaited<ReturnType<typeof getSupabase>>;

// Loads the unread-message count on the client (after render) so it never
// blocks page navigation. A realtime subscription bumps the count the instant
// a message arrives from the other side; that's the primary path. The poll
// below is just a safety net for missed/dropped realtime events (e.g. a
// channel that silently disconnects), so it runs on a slow 2-minute cadence
// rather than duplicating what realtime already does every 30s. A focus
// refresh and the "hearth:chat-seen" event both re-poll immediately for the
// cases that matter most (tab regains focus, user just opened a conversation).
const SEEN_COOKIE: Record<string, string> = {
  homeowner: "hearth_ho_chat_seen",
  contractor: "hearth_chat_seen",
};
const OTHER: Record<string, string> = {
  homeowner: "contractor",
  contractor: "homeowner",
};

function readSeen(name: string): Record<string, string> {
  const m = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  if (!m) return {};
  try {
    return JSON.parse(decodeURIComponent(m[1]));
  } catch {
    return {};
  }
}

// The latest time a lead was seen, in epoch millis, taking the max of the seen
// cookie and any localStorage override written the instant a chat was opened.
// The localStorage override removes any dependence on cookie write propagation,
// and epoch millis avoid string-comparison bugs between ISO "Z" timestamps and
// Postgres "+00:00" timestamps.
function seenMillis(name: string, leadId: string): number {
  const cookieVal = readSeen(name)[leadId];
  let ms = cookieVal ? new Date(cookieVal).getTime() : 0;
  try {
    const local = localStorage.getItem(`hearth:seen:${leadId}`);
    if (local) ms = Math.max(ms, Number(local) || 0);
  } catch {
    /* localStorage unavailable */
  }
  return ms;
}

export type UnreadRole = "homeowner" | "contractor";

// The poll + realtime-subscription mechanics for the unread badge, shared by
// UnreadProvider (the single instance mounted per shell, see below) and
// LiveUnreadBadge's own fallback path for any site that renders it with no
// provider above it (see LiveUnreadBadge.tsx). `enabled` lets a caller that isn't using this
// instance's result skip the poll/subscription entirely, so the hook can
// always be called (satisfying the rules of hooks) without ever doing
// duplicate work when a provider is already supplying the count.

// Realtime postgres_changes takes exactly ONE filter per subscription and the
// server puts a ceiling on how long it can be, so the lead-scoped `in.(...)`
// list below is capped. Past the cap the newest leads stay live and the rest
// fall back to the poll, which is the same safety net every other path here
// leans on. 60 uuids is roughly 2.2KB of filter, comfortably inside the limit,
// and no account in the app is anywhere near that many open conversations.
const REALTIME_LEAD_CAP = 60;

export function useUnreadPoll(role: UnreadRole, enabled: boolean): number {
  const [count, setCount] = useState(0);
  // The lead ids the poll last saw, newest first, as a comma-joined string.
  // Kept as a string rather than an array so the subscription effect below
  // re-runs when the SET changes (a lead created after mount) and not on every
  // poll tick that happens to rebuild an identical array.
  const [leadKey, setLeadKey] = useState("");
  // The subscription effect has to re-poll, but poll() is defined inside the
  // poll effect. A ref hands the current one over without making the
  // subscription depend on a function identity that changes every render.
  const pollRef = useRef<() => void>(() => {});

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    // Cached across polls in this mount so a dual-role (homeowner + pro)
    // account isn't re-resolving auth.getUser() on every 2-minute tick.
    let uid: string | null = null;

    // The lead ids that belong to THIS side of the account. `messages` RLS
    // (can_access_lead in 0007_messages.sql) lets a dual-role account read
    // rows on BOTH its home's leads and its business's leads, so querying
    // "messages" by sender_role alone - with no lead_id scoping - picked up
    // the user's own OUTGOING business messages (sender_role: "contractor")
    // as "unread" on their HOMEOWNER nav badge, and vice versa on the pro
    // side. Those lead ids never get a "seen" cookie entry from the other
    // side's /chats page, so they counted as unread permanently: a real,
    // reported fake-notification bug for any account with both sides.
    // Takes the client rather than closing over one: supabase-js is fetched on
    // demand now (src/lib/lazySupabase.ts), so the caller awaits it once per
    // poll and hands it down.
    async function myLeadIds(supabase: Browser): Promise<string[]> {
      if (role === "homeowner") {
        // RLS-scoped to household membership (see chats/page.tsx's identical
        // note), so this is already exactly the user's own-home universe.
        const { data: props } = await supabase.from("properties").select("id");
        const propertyIds = (props ?? []).map((p: { id: string }) => p.id);
        if (!propertyIds.length) return [];
        // Newest first so the realtime cap below keeps the conversations most
        // likely to receive the next message.
        const { data: leads } = await supabase
          .from("contractor_leads")
          .select("id")
          .in("property_id", propertyIds)
          .order("created_at", { ascending: false });
        return (leads ?? []).map((l: { id: string }) => l.id);
      }
      // contractor: "contractors" RLS also allows reading OTHER contractors'
      // rows (any contractor related to a lead on a property you own - see
      // contractor_related_to_me() in 0069_contractors_rls_hardening.sql),
      // so it must be filtered to this user's own row by user_id explicitly
      // rather than relied on to self-scope.
      if (!uid) {
        const { data } = await supabase.auth.getUser();
        uid = data.user?.id ?? null;
      }
      if (!uid) return [];
      const { data: mine } = await supabase
        .from("contractors")
        .select("id")
        .eq("user_id", uid)
        .maybeSingle();
      if (!mine) return [];
      const { data: leads } = await supabase
        .from("contractor_leads")
        .select("id")
        .eq("contractor_id", mine.id)
        .order("created_at", { ascending: false });
      return (leads ?? []).map((l: { id: string }) => l.id);
    }

    async function poll() {
      if (typeof document !== "undefined" && document.hidden) return;
      const cookieName = SEEN_COOKIE[role];
      const supabase = await getSupabase();
      const leadIds = await myLeadIds(supabase);
      // Hand the current lead set to the subscription effect. A lead created
      // after mount lands here on the next poll (or focus, or chat-seen) and
      // the channel re-subscribes with it included, so a brand new
      // conversation still gets live updates without a page reload.
      if (active) setLeadKey(leadIds.slice(0, REALTIME_LEAD_CAP).join(","));
      if (!leadIds.length) {
        if (active) setCount(0);
        return;
      }
      // Only the most recent messages, since unread ones are always recent. This
      // keeps the query bounded and from hogging a DB connection.
      const { data } = await supabase
        .from("messages")
        .select("lead_id, sender_role, created_at")
        .eq("sender_role", OTHER[role])
        .in("lead_id", leadIds)
        .order("created_at", { ascending: false })
        .limit(50);
      // Count one per person (conversation), not one per message. A lead is
      // unread when its newest incoming message is later than the last time it
      // was seen, compared as epoch millis so timestamp formats cannot skew it.
      const unread = new Set<string>();
      for (const m of data ?? []) {
        if (new Date(m.created_at).getTime() > seenMillis(cookieName, m.lead_id)) {
          unread.add(m.lead_id);
        }
      }
      if (active) setCount(unread.size);
    }
    pollRef.current = poll;
    poll();

    const onFocus = () => poll();
    window.addEventListener("focus", onFocus);
    // Opening a conversation marks it read and fires this event; re-poll at once
    // so the count clears immediately instead of lingering until the next poll.
    const onSeen = () => poll();
    window.addEventListener("hearth:chat-seen", onSeen);
    const t = setInterval(poll, 120000);
    return () => {
      active = false;
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("hearth:chat-seen", onSeen);
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [role, enabled]);

  // Realtime: a new message on one of THIS user's leads updates the count
  // instantly. Its own effect because the filter depends on the lead set,
  // which the poll discovers asynchronously and can grow while mounted; this
  // re-subscribes whenever that set changes and leaves the poll effect alone.
  //
  // The filter used to be `sender_role=eq.<other role>`, which is not a scope
  // at all: it asked the realtime server for every message in the app written
  // by that role and relied on RLS alone to trim the stream. postgres_changes
  // accepts exactly one filter per subscription, so the lead scoping replaces
  // it rather than joining it: `lead_id=in.(...)` over the user's own leads.
  // Nothing is lost by dropping the role half, because the callback only
  // triggers poll(), and poll() still counts `sender_role=eq.<other role>`
  // rows only. The cost is a wasted poll when the user sends a message from
  // another tab, which is the same query the 120s tick runs anyway.
  //
  // One channel with an `in.(...)` list rather than one channel per lead: the
  // realtime client caps how many channels a socket can join, and a pro with
  // 40 jobs would otherwise open 40 of them for a single badge.
  useEffect(() => {
    if (!enabled || !leadKey) return;
    // The topic is unique per mount, not just per role: supabase-js returns the
    // SAME already-subscribed channel instance for a repeated topic, and a
    // second .on() on an already-subscribed channel throws. That collision is
    // reachable two ways - React dev StrictMode's mount-cleanup-remount (the
    // cleanup's removeChannel is async, so the remount can win the race) and
    // any layout that renders this hook's consumer twice with no shared
    // provider (e.g. ProNav's desktop + mobile nav) - so a random suffix
    // isolates every instance instead of sharing one topic.
    // Subscribing now waits on the lazily-loaded client, so the effect body
    // is a promise callback and the cleanup has to cope with running before
    // the client ever arrives (`cancelled`).
    let channel: ReturnType<Browser["channel"]> | null = null;
    let client: Browser | null = null;
    let cancelled = false;
    getSupabase().then((supabase) => {
      if (cancelled) return;
      client = supabase;
      try {
        const topic = "unread-" + role + "-" + Math.random().toString(36).slice(2);
        channel = supabase
          .channel(topic)
          .on(
            "postgres_changes",
            {
              event: "INSERT",
              schema: "public",
              table: "messages",
              filter: `lead_id=in.(${leadKey})`,
            },
            () => pollRef.current()
          )
          .subscribe();
      } catch {
        // Realtime is strictly best-effort: the poll/focus/interval paths in the
        // effect above keep the count working on their own, so a subscribe
        // failure here must never crash the signed-in shell.
        console.warn("useUnreadPoll: realtime subscription failed, falling back to polling");
      }
    });
    return () => {
      cancelled = true;
      if (client && channel) {
        try {
          client.removeChannel(channel);
        } catch {
          // Best-effort cleanup: nothing to do if this fails, the channel is
          // going away along with the component either way.
        }
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [role, enabled, leadKey]);

  return count;
}

type UnreadContextValue = { role: UnreadRole; count: number };

const UnreadContext = createContext<UnreadContextValue | null>(null);

// Consumed by LiveUnreadBadge. Returns null when no provider is mounted above
// it (or, in principle, if a badge's role doesn't match the provider's role),
// which is LiveUnreadBadge's signal to fall back to its own self-contained
// poll instead of trusting this context.
export function useUnreadContext(): UnreadContextValue | null {
  return useContext(UnreadContext);
}

// Mounted ONCE per shell (see Nav.tsx), wrapping every place that would
// otherwise render its own LiveUnreadBadge - the desktop top strip and the
// mobile bottom tab bar both read the same count from here instead of each
// running their own 120s poll and realtime channel subscription.
export default function UnreadProvider({
  role,
  children,
}: {
  role: UnreadRole;
  children: ReactNode;
}) {
  const count = useUnreadPoll(role, true);
  return (
    <UnreadContext.Provider value={{ role, count }}>
      {children}
    </UnreadContext.Provider>
  );
}
