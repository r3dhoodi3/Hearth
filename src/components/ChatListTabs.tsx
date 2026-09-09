"use client";

// Active / Closed switcher for the Messages conversation list, shared by the
// homeowner inbox (src/app/(app)/chats/page.tsx) and the pro inbox
// (src/app/pro/chats/ChatsView.tsx) so the two sides render one structure and
// cannot drift apart. The rows arrive already rendered (both sides pass
// server-resolved or plain-data <li> elements), so switching tabs is a pure
// client toggle: no new queries, no navigation, instant.
//
// The segmented track copies the idiom from src/app/(app)/account/
// AccountTabs.tsx: a stone-100 rounded-xl track with p-1, the on tab lifted
// on white with a small shadow, 44px targets on a phone via min-h-11 that
// collapse to the compact desktop height from sm up.
//
// The tab deliberately resets to Active on every visit rather than being
// remembered in storage. The one exception is initialTab: when the thread the
// URL opens with is already a finished one, starting on Closed keeps that
// conversation visible and highlighted in the list beside it.

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { Sparkles } from "lucide-react";

export type ChatListTab = "active" | "closed";

// The empty-state row, one shape for both tabs and both sides.
function EmptyRow({ copy }: { copy: string }) {
  return (
    <li className="px-4 py-6 text-sm text-stone-500 dark:text-stone-400">
      {copy}
    </li>
  );
}

export default function ChatListTabs({
  hiddenOnMobile,
  initialTab = "active",
  activeCount,
  closedCount,
  activeEmpty,
  closedEmpty,
  pinned,
  activeRows,
  closedRows,
  mobileAskHref,
  mobileAskLabel = "Chat with AI",
}: {
  /** True while a thread is open on a phone, where the list pane hides. */
  hiddenOnMobile: boolean;
  /** Pass "closed" when the thread open on arrival is a finished one. */
  initialTab?: ChatListTab;
  /** Conversation counts per tab, counted off the already-fetched list. */
  activeCount: number;
  closedCount: number;
  /** Empty-state sentence for each tab, in each side's own voice. */
  activeEmpty: string;
  closedEmpty: string;
  /** Rows pinned above the filter (Ask OakTend and friends). Always visible. */
  pinned: ReactNode;
  activeRows: ReactNode;
  closedRows: ReactNode;
  /** Where the phone-only "Chat with AI" button below the list goes (the
      assistant's full-screen route, /ask or /pro/ask). The pinned row above
      already opens the same place, but it reads as just another conversation
      row in the list - a tester never noticed it was tappable. This is a
      second, unmistakably-a-button door to the same destination, so nobody
      leaves Messages thinking there is no way to talk to the assistant.
      Omit to render nothing here (every current caller passes it). */
  mobileAskHref?: string;
  /** Button text. Defaults to "Chat with AI". */
  mobileAskLabel?: string;
}) {
  const [tab, setTab] = useState<ChatListTab>(initialTab);

  const tabs: { key: ChatListTab; label: string; count: number }[] = [
    { key: "active", label: "Active", count: activeCount },
    { key: "closed", label: "Closed", count: closedCount },
  ];

  return (
    // The wrapper owns the desktop column height the bare <ul> used to carry,
    // so the control plus the list still fill exactly the old pane.
    <div
      className={`${
        hiddenOnMobile ? "hidden md:flex" : "flex"
      } min-h-0 flex-col gap-2 md:h-[calc(100vh-13rem)]`}
    >
      {/* Two equal buttons in a rounded track, per AccountTabs. Buttons, not
          links: the filter is client state over rows already on the page. */}
      <div className="flex shrink-0 rounded-xl border border-stone-200 bg-stone-100 p-1 dark:border-white/10 dark:bg-stone-800">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            aria-pressed={tab === t.key}
            className={`inline-flex min-h-11 flex-1 touch-manipulation items-center justify-center rounded-lg px-4 py-1.5 text-sm font-medium transition-colors sm:min-h-0 ${
              tab === t.key
                ? "bg-white text-stone-900 shadow-sm dark:bg-stone-700 dark:text-stone-100"
                : "text-stone-500 hover:text-stone-700 dark:text-stone-400 dark:hover:text-stone-200"
            }`}
          >
            {/* The count comes free off the fetched list; zero stays quiet. */}
            {t.label}
            {t.count > 0 ? ` (${t.count})` : ""}
          </button>
        ))}
      </div>

      <ul className="max-h-[40vh] min-h-0 divide-y divide-stone-100 overflow-y-auto rounded-xl border border-stone-200 bg-white dark:divide-white/10 dark:border-white/10 dark:bg-stone-800 md:max-h-none md:flex-1">
        {/* Pinned rows sit above the filter and never leave, whichever tab is
            on: Ask OakTend is an assistant, not a conversation with a status. */}
        {pinned}
        {tab === "active" ? (
          <>
            {activeCount === 0 && <EmptyRow copy={activeEmpty} />}
            {activeRows}
          </>
        ) : (
          <>
            {closedCount === 0 && <EmptyRow copy={closedEmpty} />}
            {closedRows}
          </>
        )}
      </ul>

      {/* Phone only: a plain, obviously-tappable button to the assistant,
          below the list. md:hidden, matching the wrapper's own md breakpoint
          above (that is where this stops being a single pane and the desktop
          layout can select the assistant inline) - sm:hidden left 640-767px,
          still the one-pane phone layout, with no button at all. */}
      {mobileAskHref && (
        <Link
          href={mobileAskHref}
          className="btn-secondary flex min-h-11 w-full shrink-0 items-center justify-center gap-2 md:hidden"
        >
          <Sparkles className="h-4 w-4" aria-hidden="true" />
          {mobileAskLabel}
        </Link>
      )}
    </div>
  );
}
