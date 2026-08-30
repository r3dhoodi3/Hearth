"use client";

import { useEffect, useState } from "react";

// Triggers the browser print dialog, which also covers "save as PDF" on every
// major browser. Hidden in the printed output itself via print:hidden.
//
// CR4#6: a one-line reason to keep the export ("share it with family, your
// realtor, or whoever buys the house next") plus a native share button where
// one exists. The share is link-only: window.print()'s PDF is produced by
// the OS print dialog and is never exposed to JS as a file, so there is no
// blob here for navigator.share to attach - this shares the report's own
// page link rather than faking a file branch that could never fire.
//
// canShare is read in an effect (not at render) so the server-rendered
// markup (no navigator) matches the client's first paint before hydration.
export default function PrintButton() {
  const [canShare, setCanShare] = useState(false);

  useEffect(() => {
    setCanShare(typeof navigator !== "undefined" && !!navigator.share);
  }, []);

  async function handleShare() {
    try {
      await navigator.share({
        title: "Home report",
        text: "Share it with family, your realtor, or whoever buys the house next.",
        url: window.location.href,
      });
    } catch (err) {
      // Closing the share sheet is a choice, not a failure.
      if (err instanceof Error && err.name === "AbortError") return;
    }
  }

  return (
    <div className="flex flex-col items-end gap-2 print:hidden">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <button type="button" onClick={() => window.print()} className="btn-primary">
          Print or save as PDF
        </button>
        {canShare && (
          <button type="button" onClick={handleShare} className="btn-secondary">
            Share
          </button>
        )}
      </div>
      <p className="text-xs text-stone-500 dark:text-stone-400">
        Share it with family, your realtor, or whoever buys the house next.
      </p>
    </div>
  );
}
