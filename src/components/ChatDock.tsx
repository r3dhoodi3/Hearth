"use client";

import { useEffect, useState } from "react";
import LeadChat from "@/components/LeadChat";

type ActiveChat = { leadId: string; name: string };

// A floating chat window pinned to the bottom-right. Opens when an
// "hearth:open-chat" event fires (see OpenChatButton). Can be minimized,
// expanded, or closed. Render once per page; role is set by the page.
export default function ChatDock({
  role = "contractor",
}: {
  role?: "homeowner" | "contractor";
}) {
  const [chat, setChat] = useState<ActiveChat | null>(null);
  const [minimized, setMinimized] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    function onOpen(e: Event) {
      const detail = (e as CustomEvent).detail as ActiveChat;
      setChat(detail);
      setMinimized(false);
    }
    window.addEventListener("hearth:open-chat", onOpen);
    return () => window.removeEventListener("hearth:open-chat", onOpen);
  }, []);

  if (!chat) return null;

  const width = expanded ? "w-[28rem]" : "w-80";
  const height = expanded ? "h-[70vh]" : "h-96";

  return (
    <div
      className={`fixed bottom-4 right-4 z-50 ${width} rounded-xl border border-stone-200 bg-white shadow-pop dark:border-white/10 dark:bg-stone-800`}
    >
      <div className="flex items-center justify-between gap-2 rounded-t-xl border-b border-stone-100 bg-stone-50 px-3 py-2 dark:border-white/10 dark:bg-stone-900">
        <span className="truncate text-sm font-semibold text-stone-900 dark:text-stone-100">
          {chat.name}
        </span>
        {/* Three bare glyphs 8px apart. On phones grow each to 44px and label
            them: they were unreadable and untappable with poor eyesight, and
            close is the only way to dismiss the dock. Desktop size unchanged. */}
        <div className="flex items-center gap-2 text-stone-500 dark:text-stone-400">
          <button
            type="button"
            onClick={() => setMinimized((m) => !m)}
            title={minimized ? "Open" : "Minimize"}
            aria-label={minimized ? "Open chat" : "Minimize chat"}
            className="leading-none hover:text-stone-700 max-sm:inline-flex max-sm:h-11 max-sm:w-11 max-sm:items-center max-sm:justify-center max-sm:text-lg dark:hover:text-stone-200"
          >
            {minimized ? "▢" : "-"}
          </button>
          <button
            type="button"
            onClick={() => setExpanded((x) => !x)}
            title={expanded ? "Shrink" : "Expand"}
            aria-label={expanded ? "Shrink chat" : "Expand chat"}
            className="leading-none hover:text-stone-700 max-sm:inline-flex max-sm:h-11 max-sm:w-11 max-sm:items-center max-sm:justify-center max-sm:text-lg dark:hover:text-stone-200"
          >
            ⤢
          </button>
          <button
            type="button"
            onClick={() => setChat(null)}
            title="Close"
            aria-label="Close chat"
            className="leading-none hover:text-red-600 max-sm:inline-flex max-sm:h-11 max-sm:w-11 max-sm:items-center max-sm:justify-center max-sm:text-lg dark:hover:text-red-400"
          >
            ✕
          </button>
        </div>
      </div>

      {!minimized && (
        <div className={`${height} p-3`}>
          <LeadChat key={chat.leadId} leadId={chat.leadId} role={role} embedded />
        </div>
      )}
    </div>
  );
}
