"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import InlineSpinner from "@/components/InlineSpinner";

// LeadChat is the largest client component in the app and this drawer is shut
// on every page that mounts it until someone taps "Message". Loading it on
// demand keeps it (and the whole message thread's code) out of the First Load
// JS of /pro, /pro/leads, /pro/crm and every other page that renders the
// drawer. ssr: false because nothing is rendered until a click anyway.
const LeadChat = dynamic(() => import("@/components/LeadChat"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center">
      <InlineSpinner />
    </div>
  ),
});

type ActiveChat = { leadId: string; name: string };

// A right-side, full-height slide-in chat panel. Opens when an
// "hearth:open-chat" event fires (see OpenChatButton). Render once per page;
// the page sets the role. Closes on the backdrop, the X, or Escape.
export default function ChatDrawer({
  role = "contractor",
}: {
  role?: "homeowner" | "contractor";
}) {
  const [chat, setChat] = useState<ActiveChat | null>(null);

  useEffect(() => {
    function onOpen(e: Event) {
      setChat((e as CustomEvent).detail as ActiveChat);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setChat(null);
    }
    window.addEventListener("hearth:open-chat", onOpen);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("hearth:open-chat", onOpen);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  if (!chat) return null;

  return (
    <div className="fixed inset-0 z-50">
      <div
        className="absolute inset-0 bg-black/30"
        onClick={() => setChat(null)}
      />
      <div className="absolute inset-y-0 right-0 flex w-full max-w-md flex-col border-l border-stone-200 bg-white shadow-2xl dark:border-white/10 dark:bg-stone-800">
        <div className="flex items-center justify-between gap-2 border-b border-stone-100 bg-stone-50 px-4 py-3 dark:border-white/10 dark:bg-stone-900">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-stone-900 dark:text-stone-100">
              {chat.name}
            </p>
            <p className="text-xs text-stone-500 dark:text-stone-400">Messages</p>
          </div>
          <button
            type="button"
            onClick={() => setChat(null)}
            title="Close"
            aria-label="Close"
            className="text-stone-500 hover:text-red-600 dark:text-stone-400 dark:hover:text-red-400"
          >
            <svg
              viewBox="0 0 24 24"
              className="h-5 w-5"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="flex-1 overflow-hidden p-3">
          <LeadChat key={chat.leadId} leadId={chat.leadId} role={role} embedded />
        </div>
      </div>
    </div>
  );
}
