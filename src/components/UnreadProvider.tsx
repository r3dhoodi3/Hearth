"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { createClient } from "@/lib/supabase/client";

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
export function useUnreadPoll(role: UnreadRole, enabled: boolean): number {
  const supabase = createClient();
  const [count, setCount] = useState(0);

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
    async function myLeadIds(): Promise<string[]> {
      if (role === "homeowner") {
        // RLS-scoped to household membership (see chats/page.tsx's identical
        // note), so this is already exactly the user's own-home universe.
        const { data: props } = await supabase.from("properties").select("id");
        const propertyIds = (props ?? []).map((p: { id: string }) => p.id);
        if (!propertyIds.length) return [];
        const { data: leads } = await supabase
          .from("contractor_leads")
          .select("id")
          .in("property_id", propertyIds);
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
        .eq("contractor_id", mine.id);
      return (leads ?? []).map((l: { id: string }) => l.id);
    }

    async function poll() {
      if (typeof document !== "undefined" && document.hidden) return;
      const cookieName = SEEN_COOKIE[role];
      const leadIds = await myLeadIds();
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
    poll();

    // Realtime: a new message from the other role updates the count instantly.
    // The topic is unique per mount, not just per role: supabase-js returns the
    // SAME already-subscribed channel instance for a repeated topic, and a
    // second .on() on an already-subscribed channel throws. That collision is
    // reachable two ways - React dev StrictMode's mount-cleanup-remount (the
    // cleanup's removeChannel is async, so the remount can win the race) and
    // any layout that renders this hook's consumer twice with no shared
    // provider (e.g. ProNav's desktop + mobile nav) - so a random suffix
    // isolates every instance instead of sharing one topic.
    let channel: ReturnType<typeof supabase.channel> | null = null;
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
            filter: `sender_role=eq.${OTHER[role]}`,
          },
          () => poll()
        )
        .subscribe();
    } catch {
      // Realtime is strictly best-effort: the poll/focus/interval paths below
      // keep the count working on their own, so a subscribe failure here must
      // never crash the signed-in shell.
      console.warn("useUnreadPoll: realtime subscription failed, falling back to polling");
    }

    const onFocus = () => poll();
    window.addEventListener("focus", onFocus);
    // Opening a conversation marks it read and fires this event; re-poll at once
    // so the count clears immediately instead of lingering until the next poll.
    const onSeen = () => poll();
    window.addEventListener("hearth:chat-seen", onSeen);
    const t = setInterval(poll, 120000);
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
      window.removeEventListener("hearth:chat-seen", onSeen);
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [role, enabled]);

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
