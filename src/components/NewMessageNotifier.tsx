"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { plainPreview } from "@/lib/previewText";
import { leadContractorEmbed } from "@/lib/leadJoin";
import PushRegistrar from "@/components/PushRegistrar";
import PushPrompt from "@/components/PushPrompt";
import { markPushMoment } from "@/lib/pushPrompt";

type Toast = { id: string; name: string; body: string; href: string };

// Mounted once per shell. Polls for incoming messages (from the other party)
// across all your conversations and shows a bottom-right popup, anywhere in the
// app. Only notifies about messages that arrive after the page loads.
//
// It also carries the two Web Push mounts (PushRegistrar, PushPrompt), because
// it is the one component both shells already render for both roles - so push
// reaches homeowners and pros without a second mount point in either layout.
// This poller is ALSO the honest moment to ask about push: a toast for a
// message that arrived while the app was open is exactly the thing the person
// would have missed with the app closed.
export default function NewMessageNotifier({
  role,
}: {
  role: "homeowner" | "contractor";
}) {
  const supabase = createClient();
  const [toasts, setToasts] = useState<Toast[]>([]);
  const sinceRef = useRef<string>(new Date().toISOString());
  const seenIds = useRef<Set<string>>(new Set());

  function dismiss(id: string) {
    setToasts((t) => t.filter((x) => x.id !== id));
  }

  useEffect(() => {
    let active = true;

    async function poll() {
      if (typeof document !== "undefined" && document.hidden) return;
      // RLS limits this to messages on the user's own conversations. Kept simple
      // (no joins) so a relationship hiccup can't silently break notifications.
      const { data } = await supabase
        .from("messages")
        .select("id, lead_id, sender_role, body, created_at")
        .gt("created_at", sinceRef.current)
        .neq("sender_role", role)
        .neq("sender_role", "system")
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
