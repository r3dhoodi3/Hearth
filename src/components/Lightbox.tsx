"use client";

import { useEffect, useRef } from "react";

// Fullscreen photo viewer, controlled by the caller: pass `src` as null to
// keep it closed, a URL to open it showing that photo. Deliberately simple -
// one photo at full size, no zoom, pan, or gallery arrows. Closes on an
// overlay click, the X button, or Escape; locks page scroll while open; and
// returns focus to whatever triggered it once closed.
export default function Lightbox({
  src,
  alt,
  caption,
  onClose,
}: {
  src: string | null;
  alt: string;
  caption?: string | null;
  onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!src) return;

    previouslyFocused.current = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();

    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);

    return () => {
      document.body.style.overflow = prevOverflow;
      document.removeEventListener("keydown", onKey);
      previouslyFocused.current?.focus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);

  if (!src) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={alt || "Photo"}
      onClick={onClose}
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/90 p-4"
    >
      <button
        ref={closeRef}
        type="button"
        onClick={onClose}
        aria-label="Close"
        className="absolute right-3 top-3 flex h-11 w-11 items-center justify-center rounded-full bg-black/50 text-white hover:bg-black/70 focus:outline-none focus-visible:ring-2 focus-visible:ring-white"
      >
        <svg
          viewBox="0 0 24 24"
          className="h-6 w-6"
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

      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={alt}
        onClick={(e) => e.stopPropagation()}
        className="max-h-[90vh] max-w-full rounded-md object-contain"
      />

      <div
        onClick={(e) => e.stopPropagation()}
        className="absolute bottom-3 left-1/2 flex max-w-[92vw] -translate-x-1/2 items-center gap-3 rounded-full bg-black/50 px-3 py-1.5 text-xs text-white max-sm:text-sm"
      >
        {caption && <span className="truncate">{caption}</span>}
        <a
          href={src}
          target="_blank"
          rel="noreferrer"
          // Phone only: a bare underlined link in a 12px caption bar.
          className="shrink-0 underline hover:no-underline max-sm:inline-flex max-sm:min-h-11 max-sm:items-center"
        >
          Open in new tab
        </a>
      </div>
    </div>
  );
}
