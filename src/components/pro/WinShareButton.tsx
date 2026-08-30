"use client";

import { useState } from "react";
import InlineSpinner from "@/components/InlineSpinner";

// Small affordance on a won job: shares the actual win-card PNG
// (src/app/api/win-card/[leadId]/route.tsx) as a FILE through the Web Share
// API where the platform accepts files (iMessage, Instagram, Photos, etc), so
// the recipient gets the real image instead of a bare link. The route
// re-checks ownership and win state on the server, so this component only
// ever needs the lead id. It renders no homeowner data itself: the card
// behind it carries none either (business name and logo, category, city and
// state, real rating, Hearth branding only) - and that same card already
// bakes the pro's public page link directly into the image, so no separate
// attribution URL needs to ride alongside the file (win-card also requires
// the pro's own session to load, so a bare link to it isn't something a
// recipient could open anyway).
//
// The file-share attempt mirrors ReviewButton.tsx's CR4#2 photo share and
// HomeWinsShare.tsx: gate on navigator.canShare being a function before ever
// fetching bytes, build a File from the fetched Blob, and only hand it to
// navigator.share once canShare({ files }) itself says yes. If no share API
// (or no file support) is available, this falls back to opening the card in
// a new tab - the same thing this button always did before file sharing
// existed - and "Download" stays a separate, always-visible action either way.
export default function WinShareButton({
  leadId,
  businessName,
}: {
  leadId: string;
  businessName: string;
}) {
  const [pending, setPending] = useState(false);
  const cardUrl = `/api/win-card/${leadId}`;
  const slug =
    businessName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "win";
  const fileName = `hearth-win-${slug}.png`;

  async function handleShare() {
    setPending(true);
    try {
      const text = "We just won a job on Hearth!";
      if (typeof navigator !== "undefined" && navigator.share) {
        if (typeof navigator.canShare === "function") {
          try {
            const res = await fetch(cardUrl);
            const blob = await res.blob();
            const file = new File([blob], fileName, {
              type: blob.type || "image/png",
            });
            if (navigator.canShare({ files: [file] })) {
              await navigator.share({ files: [file], text });
              return;
            }
          } catch {
            // Fetching or attaching the card image failed (network, an
            // unsupported type) - fall through to the plain text share, then
            // to opening the card, rather than failing the whole action.
          }
        }
        try {
          await navigator.share({ text });
          return;
        } catch (err) {
          // Closing the share sheet is a choice, not a failure.
          if (err instanceof Error && err.name === "AbortError") return;
        }
      }
      // No usable share API at all: open the card so it can be viewed,
      // saved, or shared by hand.
      window.open(cardUrl, "_blank", "noopener,noreferrer");
    } finally {
      setPending(false);
    }
  }

  return (
    <span className="flex shrink-0 items-center gap-2">
      <button
        type="button"
        onClick={handleShare}
        disabled={pending}
        className="btn-secondary inline-flex items-center gap-1 text-xs px-2.5 py-1"
      >
        {pending && <InlineSpinner size={12} />}
        Share this win
      </button>
      <a
        href={cardUrl}
        download={fileName}
        className="btn-secondary text-xs px-2.5 py-1"
      >
        Download
      </a>
    </span>
  );
}
