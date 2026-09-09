"use client";

import { useState } from "react";
import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import Lightbox from "@/components/Lightbox";

export type PrepKey = "water_shutoff" | "gas_shutoff" | "breaker_panel";

export type PanicFlow = {
  key: string;
  icon: LucideIcon;
  title: string;
  subtitle: string;
  category: string;
  desc: string;
  steps: string[];
  // Which saved prep photo (if any) is relevant to this flow's first step.
  prepKey?: PrepKey;
};

// The Server Component page can't pass `icon` (a LucideIcon, i.e. a function)
// down as a prop, that crashes with "Functions cannot be passed directly to
// Client Components". Nothing renders the per-system-type glyph any more (the
// card is plain text now), but the prop type stays icon-free so the server
// page keeps handing over serializable data only.
export type SerializablePanicFlow = Omit<PanicFlow, "icon">;

// One panic flow: a big tappable card that expands into short, numbered steps.
// Closed by default so the page reads as a few calm choices, not a wall of text.
export default function PanicCard({
  flow,
  prepPhotoSrc,
  prepNote,
}: {
  flow: SerializablePanicFlow;
  prepPhotoSrc: string | null;
  prepNote: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [lightboxOpen, setLightboxOpen] = useState(false);

  const ctaHref =
    `/contractors?category=${encodeURIComponent(flow.category)}` +
    `&desc=${encodeURIComponent(flow.desc)}` +
    `&timing=asap`;

  return (
    <div className="card overflow-hidden p-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-3 px-5 py-4 text-left"
      >
        <span className="flex-1">
          <span className="block font-semibold text-stone-900 dark:text-stone-100">{flow.title}</span>
          <span className="block text-sm text-stone-500 dark:text-stone-400">{flow.subtitle}</span>
        </span>
        <span className="text-sm font-medium text-bark-700 dark:text-stone-300">
          {open ? "Hide steps" : "See steps"}
        </span>
      </button>

      {open && (
        <div className="space-y-4 border-t border-stone-100 px-5 py-4 dark:border-white/10">
          <ol className="space-y-3">
            {flow.steps.map((step, i) => (
              <li key={i} className="flex gap-3">
                <span className="flex h-6 w-6 flex-none items-center justify-center rounded-full bg-bark-100 text-sm font-semibold text-bark-700 dark:bg-bark-700 dark:text-stone-300">
                  {i + 1}
                </span>
                <div className="flex-1">
                  <p className="text-stone-800 dark:text-stone-200">{step}</p>
                  {i === 0 && prepPhotoSrc && (
                    <div className="mt-2 rounded-md bg-bark-50 p-2 dark:bg-bark-700/30">
                      <p className="mb-1 text-xs font-medium text-bark-700 dark:text-stone-300">
                        Your shutoff is here:
                      </p>
                      <button
                        type="button"
                        onClick={() => setLightboxOpen(true)}
                        className="block cursor-zoom-in"
                        aria-label="View saved shutoff location photo full size"
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={prepPhotoSrc}
                          alt="Saved shutoff location"
                          className="h-32 w-full max-w-xs rounded-md object-cover"
                        />
                      </button>
                      <Lightbox
                        src={lightboxOpen ? prepPhotoSrc : null}
                        alt="Saved shutoff location"
                        onClose={() => setLightboxOpen(false)}
                      />
                      {prepNote && (
                        <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">{prepNote}</p>
                      )}
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ol>
          <Link href={ctaHref} className="btn-primary flex w-full text-center">
            Get a pro on it
          </Link>
        </div>
      )}
    </div>
  );
}
