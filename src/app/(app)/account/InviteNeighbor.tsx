"use client";

import { useEffect, useRef, useState } from "react";
import InlineSpinner from "@/components/InlineSpinner";

// "Invite a neighbor" card on /account. Shows the homeowner's personal invite
// link (their referral code, migration 0099) with a copy button and a native
// share button where supported. The code is generated server-side by the
// account page and passed in; this component only builds the full URL and
// handles copy/share.
//
// v1 is pure neighbor-to-neighbor sharing: honest copy, and no reward, credit,
// or wallet is mentioned or implied anywhere. If no code could be produced the
// account page renders nothing instead of this card.
//
// The full URL is built here on the client from window.location.origin, the
// same way ReviewButton and PublicPageCard do: a server-side env fallback
// could otherwise bake "localhost:3000" into a production share sheet.
export default function InviteNeighbor({ code }: { code: string }) {
  const [shareState, setShareState] = useState<"idle" | "copied" | "show-link">(
    "idle"
  );
  const [pending, setPending] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // The end of the link is the part that identifies it (?ref=<code>), and the
  // field is narrower than the whole URL, so park the view at the end on
  // mount. This used to be dir="rtl", which really does reverse the text
  // direction: it moved the "?" and "=" of the query string to the wrong side
  // of the visible tail, so the one part a neighbor might read back over the
  // phone was rendered wrong. Scrolling shows the same characters in order.
  useEffect(() => {
    const el = inputRef.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, []);

  function inviteUrl(): string {
    const path = `/homeowner-signup?ref=${code}`;
    return typeof window !== "undefined"
      ? `${window.location.origin}${path}`
      : path;
  }

  async function handleShare() {
    setPending(true);
    try {
      const url = inviteUrl();
      const shareData = {
        title: "Hearth",
        text: "I've been using Hearth to keep on top of my house. Thought you might find it handy for yours:",
        url,
      };
      if (typeof navigator !== "undefined" && navigator.share) {
        try {
          await navigator.share(shareData);
          return;
        } catch (err) {
          // Closing the share sheet is a choice, not a failure.
          if (err instanceof Error && err.name === "AbortError") return;
        }
      }
      try {
        await navigator.clipboard.writeText(url);
        setShareState("copied");
        setTimeout(() => setShareState("idle"), 2000);
      } catch {
        // No clipboard (permissions, insecure origin): show the link as
        // selectable text so there is always some way to grab it.
        setShareState("show-link");
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="card p-6">
      <h2 className="text-base font-semibold text-stone-900 dark:text-stone-100">
        Invite a neighbor
      </h2>
      <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">
        Hearth grows street by street. If it&apos;s been useful, pass it along.
      </p>

      <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center">
        <input
          ref={inputRef}
          type="text"
          readOnly
          value={inviteUrl()}
          onFocus={(e) => e.currentTarget.select()}
          className="input flex-1 select-all text-sm"
          aria-label="Your invite link"
        />
        <button
          type="button"
          onClick={handleShare}
          disabled={pending}
          className="btn-primary text-sm sm:shrink-0"
        >
          {pending && <InlineSpinner />}
          {shareState === "copied" ? "Link copied" : "Copy link"}
        </button>
      </div>

      {shareState === "show-link" && (
        <p className="mt-2 select-all break-all text-xs text-stone-500 dark:text-stone-400">
          {inviteUrl()}
        </p>
      )}
    </div>
  );
}
