"use client";

import { useEffect, useState } from "react";
import InlineSpinner from "@/components/InlineSpinner";

// One-line referral ask that page.tsx renders once, right under the "Your
// jobs" list, only when at least one job has been marked done (closedIds
// there, driven by the same isCloseMarker system-message check the review
// button uses). CR4#7 / MR3#12: post-job is a genuine peak-satisfaction
// moment ("that got fixed, thanks") distinct from the review flow's own
// share prompts in ReviewButton.tsx, which only fire after a rating is
// actually submitted.
//
// Same no-reward rule and the same invite link (referral_code, migration
// 0099) as InviteNeighbor.tsx - this is a compact, differently-timed prompt,
// not a second feature. Unlike InviteNeighbor's moment mode, there is no
// dismiss button here, so "shown once, ever" is marked the moment it
// actually becomes visible rather than on a later action.
const SEEN_KEY = "hearth_postjob_referral_seen";

function alreadySeen(): boolean {
  try {
    return (
      typeof window !== "undefined" &&
      window.localStorage.getItem(SEEN_KEY) === "1"
    );
  } catch {
    // Storage unavailable: fail closed rather than risk showing this on
    // every job-done visit for someone whose browser can't remember "seen".
    return true;
  }
}

function markSeen(): void {
  try {
    window.localStorage.setItem(SEEN_KEY, "1");
  } catch {
    // Best effort - worst case it can show again later.
  }
}

export default function PostJobDoneReferralAsk({
  code,
}: {
  // null when no code could be produced (pre-0099 DB, signed-out edge case
  // already ruled out by the page) - renders nothing rather than a dead link.
  code: string | null;
}) {
  const [hidden, setHidden] = useState(true);
  const [shareState, setShareState] = useState<"idle" | "copied" | "show-link">(
    "idle"
  );
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!code) return;
    if (alreadySeen()) return;
    setHidden(false);
    markSeen();
  }, [code]);

  function inviteUrl(): string {
    const path = `/homeowner-signup?ref=${code}`;
    return typeof window !== "undefined"
      ? `${window.location.origin}${path}`
      : path;
  }

  async function handleShare() {
    if (!code) return;
    setPending(true);
    try {
      const url = inviteUrl();
      const shareData = {
        title: "Hearth",
        text: "Know a neighbour with the same problem? Share Hearth:",
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
        setShareState("show-link");
      }
    } finally {
      setPending(false);
    }
  }

  if (!code || hidden) return null;

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-stone-200 bg-stone-50 p-3 text-sm dark:border-white/10 dark:bg-stone-700">
      <p className="text-stone-700 dark:text-stone-300">
        Know a neighbour with the same problem? Share Hearth.
      </p>
      <button
        type="button"
        onClick={handleShare}
        disabled={pending}
        className="btn-secondary inline-flex items-center gap-1.5 text-sm"
      >
        {pending && <InlineSpinner />}
        {shareState === "copied" ? "Link copied" : "Share"}
      </button>
      {shareState === "show-link" && (
        <p className="w-full select-all break-all text-xs text-stone-500 dark:text-stone-400">
          {inviteUrl()}
        </p>
      )}
    </div>
  );
}
