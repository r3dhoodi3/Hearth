"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { getSupabase } from "@/lib/lazySupabase";

// The browser client and channel types, taken from the lazy loader rather than
// imported from supabase-js, so this module keeps no runtime dependency on it.
type Browser = Awaited<ReturnType<typeof getSupabase>>;
type RealtimeChannel = ReturnType<Browser["channel"]>;

// Keeps the contractor's Leads page live. A realtime subscription pushes an
// instant refresh when one of their leads is inserted or changes (a new request
// arrives, a status or unlock flips). The focus listener and slow poll are a
// safety net for when the realtime publication is not enabled on the table.
export default function LeadsRealtime({
  contractorId,
}: {
  contractorId: string;
}) {
  const router = useRouter();

  useEffect(() => {
    const refresh = () => router.refresh();
    // supabase-js is fetched on demand (src/lib/lazySupabase.ts) rather than
    // imported at the top of the module: it was 49.6 kB gzipped of this page's
    // First Load JS for a component that renders nothing and only subscribes
    // after hydration. Everything it sets up therefore lives inside the
    // promise callback below, and every handle it produces is declared out
    // here so the cleanup can still find them - including when the page
    // unmounts before the client ever arrives (`cancelled`).
    let client: Browser | null = null;
    let channel: RealtimeChannel | null = null;
    let notifChannel: RealtimeChannel | null = null;
    let notifTimer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;
    const debouncedRefresh = () => {
      if (notifTimer) clearTimeout(notifTimer);
      notifTimer = setTimeout(refresh, 500);
    };

    // The topic is unique per mount, not just per contractor: supabase-js
    // returns the SAME already-subscribed channel instance for a repeated
    // topic, and a second .on() on an already-subscribed channel throws. That
    // collision is reachable via React dev StrictMode's mount-cleanup-remount
    // (the cleanup's removeChannel is async, so the remount can win the
    // race), so a random suffix isolates every instance instead of sharing
    // one topic. The subscription itself hangs off the lazy client load.
    getSupabase().then((supabase) => {
      if (cancelled) return;
      client = supabase;
      try {
        const topic = `leads-${contractorId}-` + Math.random().toString(36).slice(2);
        channel = supabase
          .channel(topic)
          // Changes to the pro's own leads (a job they were chosen for, status moves).
          .on(
            "postgres_changes",
            {
              event: "*",
              schema: "public",
              table: "contractor_leads",
              filter: `contractor_id=eq.${contractorId}`,
            },
            refresh
          )
          // Any newly posted job (unassigned) so the open-jobs board updates live.
          // Filtered to status='new', the value open_jobs_for_me() itself filters
          // on for an unassigned job (contractor_leads.contractor_id is null and
          // status = 'new', see supabase/migrations/0138_user_blocks.sql) - the
          // coarsest honest narrowing Realtime's single-column filter allows,
          // rather than subscribing to every insert on the whole table.
          .on(
            "postgres_changes",
            {
              event: "INSERT",
              schema: "public",
              table: "contractor_leads",
              filter: "status=eq.new",
            },
            refresh
          )
          // This pro's own applications changing (applied, withdrawn, chosen,
          // declined). Scoped to contractor_id, not the whole table: a
          // competing pro's application to the same open job also moves that
          // job's applicant count, but this component's refresh() re-fetches
          // the whole page anyway, and the 20s poll/focus fallbacks below cover
          // that count going briefly stale between a stranger's apply and the
          // next refresh.
          .on(
            "postgres_changes",
            {
              event: "INSERT",
              schema: "public",
              table: "lead_applications",
              filter: `contractor_id=eq.${contractorId}`,
            },
            refresh
          )
          .subscribe();
      } catch {
        // Realtime is strictly best-effort: the focus/poll paths below keep
        // this list working on their own, so a subscribe failure here must
        // never crash the leads page.
        console.warn("LeadsRealtime: realtime subscription failed, falling back to polling");
      }

      // Pending DIRECT requests (contractor_leads rows with contractor_id null,
      // aimed at this pro) are invisible to them under RLS, so their
      // contractor_leads INSERT never reaches this client. But each direct
      // request also writes a public.notifications row for the target pro, and
      // that row IS RLS-visible to its owner, so we subscribe to the pro's own
      // notification inserts to catch them. A short debounce collapses a burst of
      // notifications (a request can fan out more than one) into a single
      // refresh. Needs the signed-in user's id, which is async, so this channel
      // is wired up after getUser() resolves and tracked for cleanup separately.
      supabase.auth
        .getUser()
        .then(({ data: { user } }) => {
          if (cancelled || !user) return;
          try {
            const topic =
              `leads-notif-${user.id}-` + Math.random().toString(36).slice(2);
            notifChannel = supabase
              .channel(topic)
              .on(
                "postgres_changes",
                {
                  event: "INSERT",
                  schema: "public",
                  table: "notifications",
                  filter: `user_id=eq.${user.id}`,
                },
                debouncedRefresh
              )
              .subscribe();
          } catch {
            // Same best-effort posture as the leads channel: the poll/focus
            // paths still surface a new direct request on their own.
            console.warn("LeadsRealtime: notifications subscription failed, falling back to polling");
          }
        })
        .catch(() => {
          // getUser can reject (e.g. offline); the poll/focus fallback covers it.
        });
    });

    const onFocus = () => refresh();
    window.addEventListener("focus", onFocus);
    const poll = setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, 20000);

    return () => {
      cancelled = true;
      if (notifTimer) clearTimeout(notifTimer);
      if (client && notifChannel) {
        try {
          client.removeChannel(notifChannel);
        } catch {
          // Best-effort cleanup, same as the leads channel below.
        }
      }
      if (client && channel) {
        try {
          client.removeChannel(channel);
        } catch {
          // Best-effort cleanup: nothing to do if this fails, the channel is
          // going away along with the component either way.
        }
      }
      window.removeEventListener("focus", onFocus);
      clearInterval(poll);
    };
  }, [contractorId, router]);

  return null;
}
