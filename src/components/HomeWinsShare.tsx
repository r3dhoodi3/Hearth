"use client";

// Home Wins feature - remove this file to remove the in-app surface.
//
// A small, dismissible "Share your home wins" card for the dashboard. Shows the
// homeowner their own positive wins (computed server-side by
// src/lib/homeWins.ts and passed in), then lets them share them: the public
// wins card image (src/app/api/wins-card/[code]/route.tsx) is fetched and
// shared as an actual FILE through the Web Share API where the platform
// accepts files (iMessage, Instagram, Photos, etc), so the recipient gets the
// real picture instead of a bare link. Falls back to a link-only native
// share, then to copying the caption and link, then to showing them as
// selectable text - and a "Download image" of the same card stays available
// no matter which of those paths runs. The referral link (?ref=CODE) rides
// along in every path so the share and the acquisition attribution always
// use the SAME code.
//
// The file-share attempt mirrors ReviewButton.tsx's CR4#2 photo share
// exactly: gate on navigator.canShare being a function before ever fetching
// bytes, build a File from the fetched Blob, and only hand it to
// navigator.share once canShare({ files }) itself says yes.
//
// Reuses the exact clipboard/share/localStorage patterns already proven in
// InviteNeighbor.tsx and ReviewShareRow.tsx. No reward is promised anywhere.

import { useEffect, useState } from "react";
import { Sparkles } from "lucide-react";
import InlineSpinner from "@/components/InlineSpinner";
import type { HomeWins } from "@/lib/homeWins";
import { homeWinsCaption } from "@/lib/homeWins";

// Dismissed once, stays dismissed. Same "answer once, remember forever" shape
// as InviteNeighbor's MOMENT_SEEN_KEY, wrapped in try/catch so storage being
// unavailable never throws.
const DISMISSED_KEY = "hearth_home_wins_share_dismissed";

function alreadyDismissed(): boolean {
  try {
    return (
      typeof window !== "undefined" &&
      window.localStorage.getItem(DISMISSED_KEY) === "1"
    );
  } catch {
    // Storage unavailable: fail closed (treat as dismissed) rather than risk
    // re-showing a card someone already put away in a working session.
    return true;
  }
}

function markDismissed(): void {
  try {
    window.localStorage.setItem(DISMISSED_KEY, "1");
  } catch {
    // Best effort - worst case the card can reappear on a later visit.
  }
}

export default function HomeWinsShare({
  wins,
  code,
}: {
  wins: HomeWins;
  // The homeowner's referral_code (migration 0099). Used for BOTH the share
  // link (?ref=CODE, attribution) and the image lookup (/api/wins-card/CODE).
  code: string;
}) {
  // Fail closed until the localStorage check runs, so a dismissed card never
  // flashes on screen.
  const [hidden, setHidden] = useState(true);
  const [pending, setPending] = useState(false);
  const [shareState, setShareState] = useState<"idle" | "copied" | "show-link">(
    "idle"
  );

  useEffect(() => {
    setHidden(alreadyDismissed());
  }, []);

  function inviteUrl(): string {
    const path = `/homeowner-signup?ref=${code}`;
    return typeof window !== "undefined"
      ? `${window.location.origin}${path}`
      : path;
  }

  const cardUrl = `/api/wins-card/${code}`;

  async function handleShare() {
    setPending(true);
    try {
      const url = inviteUrl();
      const caption = homeWinsCaption(wins);
      if (typeof navigator !== "undefined" && navigator.share) {
        // Try sharing the actual card image as a FILE first - a picture
        // beats a bare link here. Gated on navigator.canShare being a
        // function so a browser that would silently drop an unsupported
        // `files` field falls through to the link share below instead of
        // the share sheet quietly opening with no image in it.
        if (typeof navigator.canShare === "function") {
          try {
            const res = await fetch(cardUrl);
            const blob = await res.blob();
            const file = new File([blob], "hearth-home-wins.png", {
              type: blob.type || "image/png",
            });
            if (navigator.canShare({ files: [file] })) {
              await navigator.share({ files: [file], text: caption, url });
              return;
            }
          } catch {
            // Fetching or attaching the card image failed (network, an
            // unsupported type) - fall through to the ordinary link share
            // rather than failing the whole share over a missing image.
          }
        }
        try {
          await navigator.share({ title: "Hearth", text: caption, url });
          return;
        } catch (err) {
          // Closing the share sheet is a choice, not a failure.
          if (err instanceof Error && err.name === "AbortError") return;
        }
      }
      // No native share: copy the caption plus the link so there is always a
      // usable result. Falls back to showing the text if the clipboard is
      // blocked (permissions, insecure origin).
      try {
        await navigator.clipboard.writeText(`${caption} ${url}`);
        setShareState("copied");
        setTimeout(() => setShareState("idle"), 2000);
      } catch {
        setShareState("show-link");
      }
    } finally {
      setPending(false);
    }
  }

  function dismiss() {
    setHidden(true);
    markDismissed();
  }

  if (hidden) return null;

  return (
    <div className="card p-6">
      <div className="flex items-start justify-between gap-2">
        <h2 className="flex items-center gap-2 text-base font-semibold text-stone-900 dark:text-stone-100">
          <span className="icon-chip">
            <Sparkles className="h-4 w-4" aria-hidden="true" />
          </span>
          Share your home wins
        </h2>
        <button
          type="button"
          onClick={dismiss}
          className="shrink-0 text-xs text-stone-500 underline decoration-stone-300 underline-offset-2 hover:text-stone-700 dark:text-stone-400 dark:decoration-stone-600 dark:hover:text-stone-200"
        >
          Not now
        </button>
      </div>

      <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">
        {wins.variant === "starter"
          ? "Your home is set up on Hearth. Know a neighbor who could use the same head start?"
          : "Nice work staying on top of your home. Pass it along to a neighbor."}
      </p>

      {/* The wins themselves, as plain positive chips - never a score. */}
      <ul className="mt-3 flex flex-wrap gap-1.5">
        {wins.wins.map((w) => (
          <li
            key={w.key}
            className="chip border border-bark-100 bg-bark-50 text-bark-700 dark:border-bark-700 dark:bg-bark-700/30 dark:text-stone-300"
          >
            {w.text}
          </li>
        ))}
      </ul>

      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={handleShare}
          disabled={pending}
          className="btn-primary text-sm"
        >
          {pending && <InlineSpinner />}
          {shareState === "copied" ? "Copied" : "Share"}
        </button>
        <a
          href={cardUrl}
          download="hearth-home-wins.png"
          className="btn-secondary text-sm"
        >
          Download image
        </a>
      </div>

      {shareState === "show-link" && (
        <p className="mt-2 select-all break-all text-xs text-stone-500 dark:text-stone-400">
          {homeWinsCaption(wins)} {inviteUrl()}
        </p>
      )}
    </div>
  );
}
