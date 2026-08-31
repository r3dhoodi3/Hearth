"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { getSupabase } from "@/lib/lazySupabase";
import { myLeadIdsForRole } from "@/lib/sideLeads";
import { plainPreview } from "@/lib/previewText";
import { leadContractorEmbed } from "@/lib/leadJoin";
import PushRegistrar from "@/components/PushRegistrar";
import PushPrompt from "@/components/PushPrompt";
import WebVitals from "@/components/WebVitals";
import { markPushMoment } from "@/lib/pushPrompt";

type Toast = { id: string; name: string; body: string; href: string };

// Each poll scopes `messages` with `.in("lead_id", ...)`, so the id list is
// capped the same way UnreadProvider caps its realtime filter
// (REALTIME_LEAD_CAP, same rationale): the newest 60 conversations stay
// covered, and no account in the app is anywhere near that many open ones.
const LEAD_SCOPE_CAP = 60;

// Mounted once per shell. Polls for incoming messages (from the other party)
// across THIS side's conversations and shows a bottom-right popup, anywhere in
// the app. Only notifies about messages that arrive after the page loads.
//
// Scoping: every poll resolves the side's own lead ids through the shared
// myLeadIdsForRole helper (src/lib/sideLeads.ts) and adds
// `.in("lead_id", ...)` to the messages query. Relying on RLS plus
// `.neq("sender_role", role)` alone was the reported fake-toast bug: a
// dual-role (homeowner + pro) account can read messages on BOTH sides' leads,
// so its own outgoing business messages toasted as "Your pro" on the
// homeowner side, and incoming homeowner-side messages toasted on the pro
// side with wrong links - the same failure class the unread badge already
// fixed in UnreadProvider, now funneled through the one helper.
//
// It also carries the two Web Push mounts (PushRegistrar, PushPrompt) and the
// Web Vitals reporter (WebVitals), because it is the one component both
// shells already render for both roles - so push and perf reporting reach
// homeowners and pros without a second mount point in either root layout.
// This poller is ALSO the honest moment to ask about push: a toast for a
// message that arrived while the app was open is exactly the thing the person
// would have missed with the app closed.
export default function NewMessageNotifier({
  role,
}: {
  role: "homeowner" | "contractor";
}) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const sinceRef = useRef<string>(new Date().toISOString());
  const seenIds = useRef<Set<string>>(new Set());
  // Handed to myLeadIdsForRole every poll so a contractor-side account
  // resolves auth.getUser() once per mount instead of every 45 seconds.
  const cachedUid = useRef<{ uid: string | null }>({ uid: null });

  function dismiss(id: string) {
    setToasts((t) => t.filter((x) => x.id !== id));
  }

  useEffect(() => {
    let active = true;

    async function poll() {
      if (typeof document !== "undefined" && document.hidden) return;
      // supabase-js is fetched here, not at import time, so it stays out of
      // this route's First Load JS (see src/lib/lazySupabase.ts).
      const supabase = await getSupabase();
      // Re-resolved on every poll rather than cached longer: the lookups are
      // cheap, RLS-scoped queries, and refreshing each tick means a brand-new
      // conversation starts toasting within one 45s cycle, no reload needed.
      const leadIds = (
        await myLeadIdsForRole(supabase, role, cachedUid.current)
      ).slice(0, LEAD_SCOPE_CAP);
      // No conversations on this side means nothing can toast, so the
      // messages query is skipped outright.
      if (!active || leadIds.length === 0) return;
      // Kept simple (no joins) so a relationship hiccup can't silently break
      // notifications. The lead_id scoping below, not RLS, is what keeps a
      // dual-role account's other side out (see the header comment).
      const { data } = await supabase
        .from("messages")
        .select("id, lead_id, sender_role, body, created_at")
        .gt("created_at", sinceRef.current)
        .neq("sender_role", role)
        .neq("sender_role", "system")
        .in("lead_id", leadIds)
        .order("created_at", { ascending: false })
        .limit(5);

      if (!active || !data || data.length === 0) return;

      const fresh = data.filter((m: any) => !seenIds.current.has(m.id));
      if (!fresh.length) return;
      sinceRef.current = fresh[0].created_at;

      // Name the sender in the toast. Homeowners see the pro's company name.
      // Contractors see a generic label, because RLS hides the homeowner's
      // details from the pro side.
      const nameByLead: Record<string, string> = {};
      if (role === "homeowner") {
        const leadIds = Array.from(new Set(fresh.map((m: any) => m.lead_id)));
        const { data: leads } = await supabase
          .from("contractor_leads")
          // FK hint, not a bare "contractors(name)": contractor_leads has two
          // FKs into contractors since migration 0105, and the ambiguous embed
          // returns 300/PGRST201 with no rows (src/lib/leadJoin.ts) - which
          // showed here as every toast naming an empty pro.
          .select(`id, ${leadContractorEmbed("name")}`)
          .in("id", leadIds);
        for (const l of leads ?? []) {
          nameByLead[(l as any).id] = (l as any).contractors?.name ?? "";
        }
      }

      // First few words of the message, with a photo shown as "Photo".
      // Through plainPreview (@/lib/previewText) so markdown and any
      // machine-readable [[TAG]] action block are gone before the slice, not
      // cut in half by it.
      const preview = (body: string) => {
        if (body.startsWith("[img]")) return "Photo";
        return plainPreview(body, 15);
      };

      const next: Toast[] = fresh.map((m: any) => {
        seenIds.current.add(m.id);
        const name =
          role === "contractor"
            ? "Homeowner"
            : nameByLead[m.lead_id] || "Your pro";
        const href =
          role === "contractor"
            ? `/pro/chats?lead=${m.lead_id}`
            : `/chats?lead=${m.lead_id}`;
        return { id: m.id, name, body: preview(m.body), href };
      });

      setToasts((t) => [...next, ...t].slice(0, 4));
      next.forEach((t) => setTimeout(() => dismiss(t.id), 6000));

      // A real message just arrived from the other side. That is the moment the
      // push prompt is allowed to appear (see src/lib/pushPrompt.ts) - it makes
      // "want your phone to tell you next time?" self-explanatory instead of a
      // permission request out of nowhere.
      markPushMoment();
    }

    poll();
    // 45s: this component has no realtime subscription of its own (it's the
    // sole mechanism for the "new message" toast), so it can't be backed off
    // as far as the realtime-covered pollers below. The query itself is
    // already cheap (scoped columns, gt(created_at), limit 5), so slowing the
    // cadence from 20s is the lever here; toasts still land within 45s worst
    // case, same as before just less chatty against the DB.
    const interval = setInterval(poll, 45000);
    return () => {
      active = false;
      clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [role]);

  // The two push mounts render on every page, toasts or not - which is why the
  // old `if (!toasts.length) return null` early exit is now a fragment: the
  // service worker has to register on a quiet page too. PushRegistrar renders
  // nothing at all and PushPrompt renders nothing unless a moment has just
  // happened, so the DOM is unchanged whenever both are idle.
  const pushSide = role === "contractor" ? "pro" : "homeowner";

  return (
    <>
      <WebVitals />
      <PushRegistrar side={pushSide} />
      <PushPrompt side={pushSide} />
      {toasts.length > 0 && (
        <div role="status" aria-live="polite" className="fixed bottom-4 right-4 z-50 flex flex-col gap-2">
          {toasts.map((t) => (
            <Link
              key={t.id}
              href={t.href}
              onClick={() => dismiss(t.id)}
              className="block w-72 rounded-xl border border-stone-200 bg-white p-3 shadow-pop transition hover:border-bark-500 dark:border-white/10 dark:bg-stone-800 dark:hover:border-bark-500"
            >
              <p className="text-sm font-semibold text-stone-900 dark:text-stone-100">{t.name}</p>
              <p className="truncate text-xs text-stone-500 dark:text-stone-400">{t.body}</p>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}
