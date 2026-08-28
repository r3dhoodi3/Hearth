"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Sparkles } from "lucide-react";
import { plainPreview } from "@/lib/previewText";

// The pinned "Ask Hearth" entry at the top of a conversation list. On a phone
// the assistant lives INSIDE Messages rather than in its own bottom tab or a
// floating pill, so this row is the way in: it looks like a conversation
// because that is what it is, and tapping it opens the full-screen view
// (/ask, /pro/ask).
//
// The conversation itself is browser-local (AskHearth keeps it in
// localStorage, namespaced per user id), so the last-message preview can only
// be read on the client. The server renders the subtitle; this swaps in the
// real preview once mounted, and again whenever an AskHearth instance on the
// same page writes a new message.

// Mirrors AskHearth's own retention windows, so a preview never shows a line
// the conversation has already aged out.
const RETENTION_MS: Record<string, number> = {
  "24h": 24 * 60 * 60 * 1000,
  "2w": 14 * 24 * 60 * 60 * 1000,
  "1m": 30 * 24 * 60 * 60 * 1000,
  never: Infinity,
};
// The event AskHearth fires after it persists a change.
const SYNC_EVENT = "hearth:ask-updated";

type StoredMsg = {
  role?: "user" | "assistant";
  content?: string;
  image?: string;
  ts?: number;
};

export default function AskHearthRow({
  href,
  desktopHref,
  subtitle,
  storageKeyBase,
  retentionKeyBase,
  userId,
  accent = "bark",
  active = false,
}: {
  // Where a tap goes on a phone (and everywhere, unless desktopHref is set).
  href: string;
  // Optional md-and-up destination. The homeowner inbox hosts its own Ask
  // Hearth pane, so on desktop this row keeps selecting that pane instead of
  // navigating away from the two-pane inbox.
  desktopHref?: string;
  subtitle: string;
  // Key BASES, matching what the matching AskHearth mount is given.
  storageKeyBase: string;
  retentionKeyBase: string;
  // The signed-in user's id, which namespaces those keys. Passed from the
  // server so this row doesn't pay for an auth round trip of its own.
  userId: string | null;
  accent?: "bark" | "hearth";
  active?: boolean;
}) {
  const [preview, setPreview] = useState<string | null>(null);

  useEffect(() => {
    const chatKey = userId ? `${storageKeyBase}:${userId}` : storageKeyBase;
    const retKey = userId
      ? `${retentionKeyBase}:${userId}`
      : retentionKeyBase;

    function read() {
      try {
        const raw = localStorage.getItem(chatKey);
        const parsed = raw ? JSON.parse(raw) : null;
        if (!Array.isArray(parsed) || parsed.length === 0) {
          setPreview(null);
          return;
        }
        const retentionMs =
          RETENTION_MS[localStorage.getItem(retKey) ?? ""] ??
          RETENTION_MS["24h"];
        const cutoff = Date.now() - retentionMs;
        const live = (parsed as StoredMsg[]).filter(
          (m) => typeof m?.ts !== "number" || m.ts >= cutoff
        );
        const last = live[live.length - 1];
        if (!last) {
          setPreview(null);
          return;
        }
        // The STORED content, not the rendered bubble: an assistant reply
        // carries markdown and the machine-readable [[TAG]]{...}[[/TAG]]
        // action blocks the chat strips before it renders (parseAssistant in
        // AskHearth.tsx). This row printed all of it, so a preview could read
        // `**Here's what I'd do:** [[OPTIONS]]{"options":[...]}[[/OPTIONS]]`.
        // plainPreview (@/lib/previewText) is the display-only version of that
        // strip, with no React or chat UI behind it.
        const body = plainPreview(last.content);
        const text = body || (last.image ? "Photo" : "");
        setPreview(
          text ? `${last.role === "user" ? "You: " : ""}${text}` : null
        );
      } catch {
        setPreview(null);
      }
    }

    read();
    window.addEventListener(SYNC_EVENT, read);
    // Another tab answering the same conversation.
    window.addEventListener("storage", read);
    return () => {
      window.removeEventListener(SYNC_EVENT, read);
      window.removeEventListener("storage", read);
    };
  }, [storageKeyBase, retentionKeyBase, userId]);

  // Full class strings per accent so Tailwind's compiler can see them.
  const shell =
    accent === "hearth"
      ? active
        ? "border-hearth-500 bg-hearth-50 dark:border-hearth-400 dark:bg-hearth-900/40"
        : "border-transparent hover:bg-stone-50 dark:hover:bg-stone-700"
      : active
        ? "border-bark-600 bg-bark-50 dark:bg-bark-700/40"
        : "border-transparent hover:bg-stone-50 dark:hover:bg-stone-700";
  const badge =
    accent === "hearth"
      ? "bg-hearth-100 text-hearth-700 dark:bg-hearth-900/50 dark:text-hearth-300"
      : "bg-bark-100 text-bark-700 dark:bg-bark-700/40 dark:text-stone-300";

  function body() {
    return (
      <>
        <span
          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${badge}`}
        >
          <Sparkles className="h-4 w-4" aria-hidden="true" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center justify-between gap-2">
            <span className="truncate font-medium text-stone-900 dark:text-stone-100">
              Ask Hearth
            </span>
            <span className="shrink-0 text-xs text-stone-500 dark:text-stone-400">
              Assistant
            </span>
          </span>
          {/* The stored conversation's last line once there is one, the
              standing description of what this assistant is until then -
              exactly how the real conversation rows below fall back to their
              job category before anyone has said anything. */}
          <span className="block truncate text-xs text-stone-500 dark:text-stone-400">
            {preview ?? subtitle}
          </span>
        </span>
      </>
    );
  }

  // Display is left off deliberately and added per link below, so the two
  // breakpoint-swapped copies can each own theirs.
  const shared = `items-center gap-3 border-l-4 px-4 py-3 transition ${shell}`;

  return (
    <li>
      {desktopHref ? (
        <>
          <Link href={href} className={`flex ${shared} md:hidden`}>
            {body()}
          </Link>
          <Link href={desktopHref} className={`hidden ${shared} md:flex`}>
            {body()}
          </Link>
        </>
      ) : (
        <Link href={href} className={`flex ${shared}`}>
          {body()}
        </Link>
      )}
    </li>
  );
}
