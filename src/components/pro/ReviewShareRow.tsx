"use client";

import { useState } from "react";
import InlineSpinner from "@/components/InlineSpinner";

// One row in the "Share your reviews" list: shares the actual review-card
// PNG (src/app/api/review-card/[reviewId]/route.tsx) as a FILE through the
// Web Share API where the platform accepts files (iMessage, Instagram,
// Photos, etc), so the recipient gets the real image instead of a bare link
// - falling back to a link-only share, then to opening the card in a new tab
// - with the pro's own public profile link (profileUrl) riding along in the
// file and link shares as the secondary attribution URL, since that link is
// public (unlike the review-card route itself, which needs the pro's own
// session to load). "Download" and "Copy caption" stay separate,
// always-visible actions the same way they always have.
//
// The file-share attempt mirrors ReviewButton.tsx's CR4#2 photo share and
// HomeWinsShare.tsx / WinShareButton.tsx: gate on navigator.canShare being a
// function before ever fetching bytes, build a File from the fetched Blob,
// and only hand it to navigator.share once canShare({ files }) itself says
// yes. The caption is fixed and honest - no incentive, no reward, just a
// thank-you and the pro's own public profile link - and review collection
// itself stays a completely separate flow (leave_review / saveReviewAction)
// that this component never touches.
export default function ReviewShareRow({
  reviewId,
  rating,
  comment,
  profileUrl,
}: {
  reviewId: string;
  rating: number;
  comment: string | null;
  profileUrl: string;
}) {
  const [copied, setCopied] = useState(false);
  const [sharePending, setSharePending] = useState(false);
  const cardUrl = `/api/review-card/${reviewId}`;
  const caption = `Thanks for the kind words! Find me on Hearth: ${profileUrl}`;
  const fileName = `hearth-review-${reviewId}.png`;

  async function copyCaption() {
    try {
      await navigator.clipboard.writeText(caption);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard can be unavailable (permissions, http). The caption is
      // still visible above for the pro to select by hand.
    }
  }

  async function handleShare() {
    setSharePending(true);
    try {
      const text = "Thanks for the kind words!";
      if (typeof navigator !== "undefined" && navigator.share) {
        if (typeof navigator.canShare === "function") {
          try {
            const res = await fetch(cardUrl);
            const blob = await res.blob();
            const file = new File([blob], fileName, {
              type: blob.type || "image/png",
            });
            if (navigator.canShare({ files: [file] })) {
              await navigator.share({ files: [file], text, url: profileUrl });
              return;
            }
          } catch {
            // Fetching or attaching the card image failed (network, an
            // unsupported type) - fall through to the link-only share
            // rather than failing the whole share over a missing image.
          }
        }
        try {
          await navigator.share({ text, url: profileUrl });
          return;
        } catch (err) {
          // Closing the share sheet is a choice, not a failure.
          if (err instanceof Error && err.name === "AbortError") return;
        }
      }
      // No usable share API at all: open the card so it can be viewed,
      // saved, or shared by hand - "Download" and "Copy caption" below cover
      // the rest.
      window.open(cardUrl, "_blank", "noreferrer");
    } finally {
      setSharePending(false);
    }
  }

  return (
    <li className="rounded-lg border border-stone-200 p-3 dark:border-white/10">
      <span className="text-sm text-amber-500">
        {"★".repeat(rating)}
        <span className="text-stone-300 dark:text-stone-600">{"★".repeat(5 - rating)}</span>
      </span>
      {comment && (
        <p className="mt-1 break-words text-sm text-stone-600 dark:text-stone-300">
          {Array.from(comment).length > 160
            ? `${Array.from(comment).slice(0, 160).join("").trimEnd()}…`
            : comment}
        </p>
      )}
      <div className="mt-2 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={handleShare}
          disabled={sharePending}
          className="btn-secondary inline-flex items-center gap-1 text-xs px-2.5 py-1"
        >
          {sharePending && <InlineSpinner size={12} />}
          Share
        </button>
        <a
          href={cardUrl}
          download={fileName}
          className="btn-secondary text-xs px-2.5 py-1"
        >
          Download
        </a>
        <button
          type="button"
          onClick={copyCaption}
          className="btn-secondary text-xs px-2.5 py-1"
        >
          {copied ? "Copied!" : "Copy caption"}
        </button>
      </div>
    </li>
  );
}
