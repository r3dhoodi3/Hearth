import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getCurrentContractor } from "@/lib/contractor";
import { labelFor, JOB_CATEGORIES } from "@/lib/constants";
import { isUnreadSince } from "@/lib/unread";
import { plainPreview } from "@/lib/previewText";
import LeadChat from "@/components/LeadChat";
import MarkChatSeen from "@/components/MarkChatSeen";
import AskHearthRow from "@/components/AskHearthRow";
import {
  sendQuoteAction,
  withdrawQuoteAction,
  createInvoiceAction,
  voidInvoiceAction,
} from "./actions";

// Seen-state cookie shared with the layout's unread badge.
const SEEN_COOKIE = "hearth_chat_seen"; // { [leadId]: ISO timestamp last viewed }

// async since Next 15, where cookies() returns a Promise.
async function readSeenMap(): Promise<Record<string, string>> {
  try {
    return JSON.parse((await cookies()).get(SEEN_COOKIE)?.value || "{}");
  } catch {
    return {};
  }
}

// Mark a conversation as read (called from the open thread).
async function markChatSeenAction(leadId: string) {
  "use server";
  const jar = await cookies();
  let map: Record<string, string> = {};
  try {
    map = JSON.parse(jar.get(SEEN_COOKIE)?.value || "{}");
  } catch {
    map = {};
  }
  map[leadId] = new Date().toISOString();
  jar.set(SEEN_COOKIE, JSON.stringify(map), { path: "/" });
  revalidatePath("/pro/chats");
}

export default async function ProChatsPage(props: {
  searchParams: Promise<{ lead?: string }>;
}) {
  const searchParams = await props.searchParams;
  const contractor = await getCurrentContractor();
  if (!contractor) redirect("/pro/onboarding");

  const supabase = await createClient();
  // Exactly the five columns this page renders, not select("*"). A pro's inbox
  // can be long, and every row of it used to drag along the homeowner's email
  // and phone plus two unbounded free-text fields (issue_description,
  // material_notes) that nothing here ever reads. That is bytes over the wire
  // and homeowner PII pulled into a render that has no use for it. The columns:
  //   id                - list keys, the ?lead= match, MarkChatSeen, LeadChat
  //   homeowner_name    - the list row title and the thread header
  //   category          - the row icon, the preview fallback, LeadChat's
  //                       subtitle and jobTitle
  //   property_address  - appended to LeadChat's subtitle
  //   created_at        - the sort fallback for a thread with no messages yet
  // contractor_id is deliberately absent: it is only a filter, applied
  // server-side by PostgREST, and is never read off the row.
  const { data: leads } = await supabase
    .from("contractor_leads")
    .select("id, homeowner_name, category, property_address, created_at")
    .eq("contractor_id", contractor.id)
    .order("created_at", { ascending: false });

  const seen = await readSeenMap();

  // The inbox is every lead assigned to this contractor (the homeowner picked
  // them). The old `paid` unlock flag predates the apply flow: the fee is now
  // charged at application time, so filtering on it hid every conversation.
  const convos = leads ?? [];

  // Pull the latest message per conversation for the list preview + unread.
  const ids = convos.map((l) => l.id);
  const lastByLead = new Map<string, any>();
  if (ids.length) {
    const { data: msgs } = await supabase
      .from("messages")
      .select("lead_id, body, created_at, sender_role")
      .in("lead_id", ids)
      .order("created_at", { ascending: false });
    for (const m of msgs ?? []) {
      if (!lastByLead.has(m.lead_id)) lastByLead.set(m.lead_id, m);
    }
  }

  // A conversation is unread if its latest message is from the homeowner and is
  // newer than the last time we viewed that thread. Compared with
  // isUnreadSince (epoch millis), not a raw string `<` - this was the one
  // page still comparing a JS-built seen timestamp ("...Z") against a
  // Postgres-returned created_at ("...+00:00") as plain strings, unlike the
  // homeowner chats page and UnreadProvider.tsx, which both already went
  // through epoch millis for the same format-mismatch reason. See
  // src/lib/unread.ts.
  const isUnread = (leadId: string) => {
    const last = lastByLead.get(leadId);
    if (!last || last.sender_role !== "homeowner") return false;
    return isUnreadSince(seen[leadId], last.created_at);
  };

  // Sort: conversations with the most recent message first, then newest leads.
  convos.sort((a, b) => {
    const ta = lastByLead.get(a.id)?.created_at ?? a.created_at;
    const tb = lastByLead.get(b.id)?.created_at ?? b.created_at;
    return tb < ta ? -1 : tb > ta ? 1 : 0;
  });

  // Which thread is open? Only the one named in the URL, mirroring the
  // homeowner page. No convos[0] fallback: on phones the bare route shows just
  // the list with the thread pane display:none, and auto-selecting would still
  // render MarkChatSeen and mount LeadChat (which writes a read receipt) for
  // that hidden pane, silently clearing the "New" badge and the nav unread
  // badge on the newest unread conversation. Without ?lead=, desktop shows the
  // "Select a conversation" placeholder instead.
  const selected = convos.find((l) => l.id === searchParams.lead) ?? null;

  // On phones the two-pane grid stacks, so tapping a conversation used to
  // render the thread below the list where it looked like nothing happened.
  // Instead we show one pane at a time: the list on the bare route, the thread
  // once ?lead= is in the URL. Desktop (md+) always shows both.
  const threadOpenOnMobile = Boolean(searchParams.lead);

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold text-stone-900 dark:text-stone-100">Messages</h1>

      {/* Mark the open conversation as read. */}
      {selected && (
        <MarkChatSeen leadId={selected.id} action={markChatSeenAction} />
      )}

      {/* The list always renders, even with no homeowner conversations yet:
          the pinned copilot row lives at the top of it, and on a phone that
          row is the only way into Ask Hearth for Pros (the bottom bar is back
          to four tabs and the floating pill is desktop-only). The old
          "no conversations yet" card is a row inside the list now. */}
      <div className="grid gap-4 md:grid-cols-[280px_1fr]">
          {/* ---- Conversation list (hidden on phones while a thread is open) ---- */}
          <ul
            className={`${
              threadOpenOnMobile ? "hidden md:block" : ""
            } max-h-[40vh] divide-y divide-stone-100 overflow-y-auto rounded-xl border border-stone-200 bg-white dark:divide-white/10 dark:border-white/10 dark:bg-stone-800 md:h-[calc(100vh-13rem)] md:max-h-none`}
          >
            {/* Pinned copilot, always first. */}
            <AskHearthRow
              href="/pro/ask"
              subtitle="Your business copilot"
              storageKeyBase="hearth_pro_ask_chat"
              retentionKeyBase="hearth_pro_ask_retention"
              userId={contractor.user_id ?? null}
              accent="hearth"
            />

            {convos.length === 0 && (
              <li className="px-4 py-6 text-sm text-stone-500 dark:text-stone-400">
                No conversations yet. Apply to jobs on the{" "}
                <Link
                  href="/pro"
                  className="font-medium text-hearth-700 underline dark:text-hearth-300"
                >
                  Leads
                </Link>{" "}
                page, and when a homeowner picks you, your chat opens here.
              </li>
            )}

            {convos.map((l) => {
              const last = lastByLead.get(l.id);
              const isActive = selected?.id === l.id;
              const unread = isUnread(l.id);
              return (
                <li key={l.id}>
                  <Link
                    href={`/pro/chats?lead=${l.id}`}
                    className={`block border-l-4 px-4 py-3 transition ${
                      isActive
                        ? "border-hearth-500 bg-hearth-50 dark:border-hearth-400 dark:bg-hearth-900/40"
                        : unread
                          ? "border-hearth-400 bg-hearth-50/60 hover:bg-hearth-50 dark:border-hearth-500 dark:bg-hearth-900/20 dark:hover:bg-hearth-900/30"
                          : "border-transparent hover:bg-stone-50 dark:hover:bg-stone-700"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span
                        className={`truncate ${
                          unread
                            ? "font-bold text-stone-900 dark:text-stone-100"
                            : "font-medium text-stone-900 dark:text-stone-100"
                        }`}
                      >
                        {l.homeowner_name || "Homeowner"}
                      </span>
                      {unread ? (
                        <span className="shrink-0 rounded-full bg-hearth-600 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white">
                          New
                        </span>
                      ) : (
                        <span className="shrink-0 text-xs text-stone-500 dark:text-stone-400">
                          {labelFor(JOB_CATEGORIES, l.category)}
                        </span>
                      )}
                    </div>
                    <p
                      className={`truncate text-xs ${
                        unread ? "font-medium text-stone-800 dark:text-stone-200" : "text-stone-500 dark:text-stone-400"
                      }`}
                    >
                      {/* plainPreview (@/lib/previewText): one line, with
                          markdown and any machine-readable [[TAG]] action
                          block taken out. A message body that reduces to
                          nothing falls back to the job category, same as a
                          thread with no messages at all. */}
                      {last
                        ? `${last.sender_role === "contractor" ? "You: " : ""}${
                            last.body.startsWith("[img]")
                              ? "Photo"
                              : plainPreview(last.body) ||
                                labelFor(JOB_CATEGORIES, l.category)
                          }`
                        : labelFor(JOB_CATEGORIES, l.category)}
                    </p>
                  </Link>
                </li>
              );
            })}
          </ul>

          {/* ---- Open thread (the only pane on phones once one is picked) ---- */}
          {selected ? (
            <div
              className={`${
                threadOpenOnMobile ? "flex" : "hidden md:flex"
              } h-[calc(100dvh-13rem)] flex-col rounded-xl border border-stone-200 bg-white p-3 dark:border-white/10 dark:bg-stone-800 md:h-[calc(100vh-13rem)]`}
            >
              <Link
                href="/pro/chats"
                className="mb-2 inline-flex w-fit shrink-0 items-center gap-1 text-sm font-medium text-hearth-700 hover:underline dark:text-hearth-300 md:hidden"
              >
                <span aria-hidden="true">←</span> All conversations
              </Link>
              {/* `key` forces a fresh thread when switching conversations. */}
              <div className="min-h-0 flex-1">
                <LeadChat
                  key={selected.id}
                  leadId={selected.id}
                  role="contractor"
                  embedded
                  title={selected.homeowner_name || "Homeowner"}
                  subtitle={`${labelFor(JOB_CATEGORIES, selected.category)}${
                    selected.property_address ? ` · ${selected.property_address}` : ""
                  }`}
                  jobTitle={labelFor(JOB_CATEGORIES, selected.category)}
                  contractorName={contractor.name}
                  sendQuoteAction={sendQuoteAction}
                  withdrawQuoteAction={withdrawQuoteAction}
                  createInvoiceAction={createInvoiceAction}
                  voidInvoiceAction={voidInvoiceAction}
                />
              </div>
            </div>
          ) : (
            <div
              className={`${
                threadOpenOnMobile ? "flex" : "hidden md:flex"
              } h-[60vh] flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-stone-300 text-sm text-stone-500 dark:border-stone-700 dark:text-stone-400 md:h-[calc(100vh-13rem)]`}
            >
              Select a conversation
              <Link
                href="/pro/chats"
                className="text-sm font-medium text-hearth-700 hover:underline dark:text-hearth-300 md:hidden"
              >
                <span aria-hidden="true">←</span> All conversations
              </Link>
            </div>
          )}
      </div>
    </div>
  );
}
