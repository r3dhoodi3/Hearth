"use client";

// STREAMING FIX, not a behaviour change. Same treatment as
// src/components/pro/SetupChecklist.tsx and src/app/pro/plus/PerksList.tsx,
// investigated in scratchpad/debug-DBG3.md.
//
// React Flight defers any element it meets once the row it is serializing has
// passed a 3200-byte budget: it writes "$L<id>" in place and starts a fresh
// row for that element. Fizz then has to stream each of those rows as an
// out-of-order segment - a <template id="P:n"> hole nested inside the page's
// own markup plus a late $RS(...) script to fill it - and that hole chain is
// the shape that comes with the React #418 / "$RS ... parentNode" hydration
// failure reported on the pro pages.
//
// /pro/chats hit it in the conversation list: measured on a pro with eight
// real conversations, the page's Flight row carried EIGHT deferred references
// (six conversation rows plus the thread pane), because every <li> the map
// produced was another element past the budget. A fast local server usually
// resolves those rows before Fizz walks past them, so the templates only
// materialize under real network timing - which is why this reproduced live
// and not on localhost. The deferrals are the thing to count.
//
// As one client module the whole two-pane body becomes a SINGLE client
// reference in the page's payload with plain-data props (strings, booleans,
// and the server-action references LeadChat already took), so there is no
// element left anywhere in that row for Flight to defer. Both branches - the
// list and the open thread - live in here for that reason: leaving either one
// behind in the page would put an element after the list's ~4 kB of props,
// which is exactly where the budget has already run out.
//
// Nothing here is newly interactive. AskHearthRow, PhoneChatFrame, LeadChat
// and next/link were already client components; the rest is static markup that
// used to be rendered on the server and is now rendered from plain props.

import Link from "next/link";
import { Briefcase, ChevronRight } from "lucide-react";
import AskHearthRow from "@/components/AskHearthRow";
import PhoneChatFrame from "@/components/PhoneChatFrame";
import LeadChat from "@/components/LeadChat";
import { PRO_LEADS_HREF } from "@/lib/constants";

// One conversation row, fully resolved on the server: the category label, the
// preview line and the unread decision are all computed there so nothing but
// plain data crosses the boundary.
export type ChatRow = {
  id: string;
  /** Homeowner name, already defaulted. */
  title: string;
  /** Category label, shown when the row is not unread. */
  categoryLabel: string;
  /** One-line preview, already prefixed with "You: " where it applies. */
  preview: string;
  unread: boolean;
  active: boolean;
};

// The open thread, when ?lead= names one.
export type SelectedChat = {
  id: string;
  title: string;
  subtitle: string;
  jobTitle: string;
};

// One application the pro paid to send that the homeowner has not answered
// yet. It is NOT a conversation: nobody has been picked, so there is nobody to
// message. It sits under the real conversations so the message a pro wrote
// when they applied is where they look for it, instead of vanishing into the
// homeowner's applicant list. Resolved on the server like a ChatRow, plain
// data only.
export type ApplicationRow = {
  /** lead_applications.id, the ?application= value. */
  id: string;
  /** Job category label, the row title. */
  title: string;
  /** "Sent Aug 29", formatted on the server so hydration can't disagree. */
  dateLabel: string;
  /** One line of what the pro wrote when they applied. */
  preview: string;
  active: boolean;
};

// The open application, when ?application= names one. No unread flag anywhere
// on it: an application is the pro's own outgoing message, so it can never be
// something new to read (the nav badge counts messages rows only, see
// src/components/UnreadProvider.tsx).
export type SelectedApplication = {
  id: string;
  /** Job category label. */
  title: string;
  /** "Applied Aug 29", the header's second line. */
  subtitle: string;
  /** The full application message, exactly as it was sent. */
  message: string;
  /** What happened to it, in one sentence. */
  statusLine: string;
  /** The money truth for that outcome, from src/lib/guaranteeCopy.ts. */
  noteLine: string;
};

export default function ChatsView({
  rows,
  applicationRows = [],
  askUserId,
  threadOpenOnMobile,
  selected,
  selectedApplication = null,
  contractorName,
  sendQuoteAction,
  withdrawQuoteAction,
  createInvoiceAction,
  voidInvoiceAction,
}: {
  rows: ChatRow[];
  applicationRows?: ApplicationRow[];
  askUserId: string | null;
  threadOpenOnMobile: boolean;
  selected: SelectedChat | null;
  selectedApplication?: SelectedApplication | null;
  contractorName?: string;
  sendQuoteAction?: (formData: FormData) => Promise<void>;
  withdrawQuoteAction?: (formData: FormData) => Promise<void>;
  createInvoiceAction?: (formData: FormData) => Promise<void>;
  voidInvoiceAction?: (formData: FormData) => Promise<void>;
}) {
  return (
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
          userId={askUserId}
          accent="hearth"
        />

        {/* Pinned second: the way OUT of an empty inbox. A pro with no
            conversations has nothing to do on this screen, and the answer
            is always the same one - go find a job to apply to. Same row
            shape as the copilot above it so the list stays one thing.
            PRO_LEADS_HREF rather than a literal "/pro", so it follows the
            open-jobs board when the pro Home / Leads tab split moves it. */}
        <li>
          <Link
            href={PRO_LEADS_HREF}
            className="flex min-h-11 items-center gap-3 border-l-4 border-transparent px-4 py-3 transition hover:bg-stone-50 dark:hover:bg-stone-700"
          >
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-hearth-100 text-hearth-700 dark:bg-hearth-900/50 dark:text-hearth-300">
              <Briefcase className="h-4 w-4" aria-hidden="true" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium text-stone-900 dark:text-stone-100">
                Find clients
              </span>
              <span className="block truncate text-xs text-stone-500 dark:text-stone-400">
                Open jobs near you, ready to apply
              </span>
            </span>
            <ChevronRight
              className="h-4 w-4 shrink-0 text-stone-400 dark:text-stone-500"
              aria-hidden="true"
            />
          </Link>
        </li>

        {rows.length === 0 && (
          <li className="px-4 py-6 text-sm text-stone-500 dark:text-stone-400">
            No conversations yet. Find clients to start one: when a homeowner
            picks you, your chat opens here.
          </li>
        )}

        {rows.map((row) => (
          <li key={row.id}>
            <Link
              href={`/pro/chats?lead=${row.id}`}
              className={`block border-l-4 px-4 py-3 transition ${
                row.active
                  ? "border-hearth-500 bg-hearth-50 dark:border-hearth-400 dark:bg-hearth-900/40"
                  : row.unread
                    ? "border-hearth-400 bg-hearth-50/60 hover:bg-hearth-50 dark:border-hearth-500 dark:bg-hearth-900/20 dark:hover:bg-hearth-900/30"
                    : "border-transparent hover:bg-stone-50 dark:hover:bg-stone-700"
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span
                  className={`truncate ${
                    row.unread
                      ? "font-bold text-stone-900 dark:text-stone-100"
                      : "font-medium text-stone-900 dark:text-stone-100"
                  }`}
                >
                  {row.title}
                </span>
                {row.unread ? (
                  // 10px reads fine at a desk but is under the readable
                  // floor on a phone; max-sm:text-sm brings it to 14px
                  // there, same convention as the license badges.
                  <span className="shrink-0 rounded-full bg-hearth-600 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white max-sm:text-sm">
                    New
                  </span>
                ) : (
                  <span className="shrink-0 text-xs text-stone-500 dark:text-stone-400">
                    {row.categoryLabel}
                  </span>
                )}
              </div>
              <p
                className={`truncate text-xs ${
                  row.unread
                    ? "font-medium text-stone-800 dark:text-stone-200"
                    : "text-stone-500 dark:text-stone-400"
                }`}
              >
                {row.preview}
              </p>
            </Link>
          </li>
        ))}

        {/* ---- Applications the homeowner has not answered yet ----
            Under the real conversations on purpose: these are not chats, and
            the pro cannot write in them. They exist so the message a pro
            wrote when they applied lives in Messages too, instead of only in
            the homeowner's applicant list. A row disappears the moment the
            homeowner picks this pro, because the lead is then assigned and
            the real conversation above takes its place (the page dedupes by
            lead id). No unread styling anywhere in here: nothing in an
            application is new to read, it is the pro's own outgoing note. */}
        {applicationRows.length > 0 && (
          <>
            <li className="bg-stone-50 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-stone-500 dark:bg-stone-700/40 dark:text-stone-400">
              Waiting on the homeowner
            </li>
            {applicationRows.map((row) => (
              <li key={row.id}>
                <Link
                  href={`/pro/chats?application=${row.id}`}
                  className={`block border-l-4 px-4 py-3 transition ${
                    row.active
                      ? "border-hearth-500 bg-hearth-50 dark:border-hearth-400 dark:bg-hearth-900/40"
                      : "border-transparent hover:bg-stone-50 dark:hover:bg-stone-700"
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate font-medium text-stone-900 dark:text-stone-100">
                      {row.title}
                    </span>
                    <span className="shrink-0 text-xs text-stone-500 dark:text-stone-400">
                      {row.dateLabel}
                    </span>
                  </div>
                  <p className="truncate text-xs text-stone-500 dark:text-stone-400">
                    {row.preview}
                  </p>
                </Link>
              </li>
            ))}
          </>
        )}
      </ul>

      {/* ---- Open thread (the only pane on phones once one is picked) ---- */}
      {selected ? (
        // Below sm PhoneChatFrame pins this panel to the visual viewport so
        // the software keyboard can't push the composer off screen; sm and
        // up render exactly the classes below, as before.
        <PhoneChatFrame
          className={`${
            threadOpenOnMobile ? "flex" : "hidden md:flex"
          } h-[calc(100dvh-13rem)] flex-col rounded-xl border border-stone-200 bg-white p-3 dark:border-white/10 dark:bg-stone-800 md:h-[calc(100vh-13rem)]`}
        >
          <Link
            href="/pro/chats"
            // Already md:hidden, so these sizes are phone-only: this
            // is the pro twin of the homeowner /chats back link, 44px tall
            // and 16px, with the negative margin keeping the text in line.
            className="mb-2 -ml-2 inline-flex min-h-11 w-fit shrink-0 items-center gap-1 px-2 text-base font-medium text-hearth-700 hover:underline dark:text-hearth-300 md:hidden"
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
              title={selected.title}
              subtitle={selected.subtitle}
              jobTitle={selected.jobTitle}
              contractorName={contractorName}
              sendQuoteAction={sendQuoteAction}
              withdrawQuoteAction={withdrawQuoteAction}
              createInvoiceAction={createInvoiceAction}
              voidInvoiceAction={voidInvoiceAction}
            />
          </div>
        </PhoneChatFrame>
      ) : selectedApplication ? (
        // An application, opened from the section above. A plain div, not
        // PhoneChatFrame: that wrapper exists to keep a composer above the
        // software keyboard, and this pane deliberately has no composer. A pro
        // cannot message a homeowner who has not picked them, so showing a
        // dead input would be a lie about what they can do.
        <div
          className={`${
            threadOpenOnMobile ? "flex" : "hidden md:flex"
          } h-[calc(100dvh-13rem)] flex-col rounded-xl border border-stone-200 bg-white p-3 dark:border-white/10 dark:bg-stone-800 md:h-[calc(100vh-13rem)]`}
        >
          <Link
            href="/pro/chats"
            // Same 44px, 16px phone-only back link as the thread pane above.
            className="mb-2 -ml-2 inline-flex min-h-11 w-fit shrink-0 items-center gap-1 px-2 text-base font-medium text-hearth-700 hover:underline dark:text-hearth-300 md:hidden"
          >
            <span aria-hidden="true">←</span> All conversations
          </Link>

          <div className="shrink-0 border-b border-stone-100 pb-2 dark:border-white/10">
            <p className="font-semibold text-stone-900 dark:text-stone-100">
              {selectedApplication.title}
            </p>
            <p className="text-xs text-stone-500 dark:text-stone-400">
              {selectedApplication.subtitle}
            </p>
          </div>

          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto py-3">
            {/* The pro's own words, in the same bubble the thread gives their
                messages, so this reads as the message it was. */}
            <div className="flex justify-end">
              <span className="block max-w-[80%] whitespace-pre-wrap break-words rounded-lg bg-bark-600 px-3 py-1.5 text-sm text-white">
                {selectedApplication.message}
              </span>
            </div>
            <p className="text-xs text-stone-500 dark:text-stone-400">
              {selectedApplication.statusLine}
            </p>
            <p className="text-xs text-stone-500 dark:text-stone-400">
              {selectedApplication.noteLine}
            </p>
          </div>

          {/* Where the composer would be. Plain words instead of a disabled
              input: the rule is not a bug to work around. */}
          <p className="shrink-0 rounded-lg bg-stone-50 px-3 py-2 text-xs text-stone-500 dark:bg-stone-700/40 dark:text-stone-400">
            You cannot message this homeowner yet. Messaging opens if they pick
            you for the job.
          </p>
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
            // Same treatment as the back link above, and as the
            // homeowner empty-state link.
            className="-ml-2 inline-flex min-h-11 items-center px-2 text-base font-medium text-hearth-700 hover:underline dark:text-hearth-300 md:hidden"
          >
            <span aria-hidden="true">←</span> All conversations
          </Link>
        </div>
      )}
    </div>
  );
}
