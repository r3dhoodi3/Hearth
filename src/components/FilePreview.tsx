"use client";

import { useEffect, useState } from "react";
import Lightbox from "@/components/Lightbox";

// Small, shared "what did I just pick" previews, used everywhere a homeowner
// selects a file before or while it uploads. Images get a real thumbnail,
// PDFs get a tiny inline render, anything else gets a plain file card. Every
// object URL this creates is revoked on unmount/replacement so repeated
// picks never leak memory.
//
// This file also carries the "already saved" counterpart (StoredPhotoThumb /
// StoredPhotoGrid): the same small-thumbnail look, but for a photo that's
// already in storage (a signed/proxied URL, not a local File), with a link
// out to the full image in a new tab instead of a preview-only render.

function bytesLabel(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function extLabel(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > -1 && dot < name.length - 1
    ? name.slice(dot + 1).toUpperCase().slice(0, 4)
    : "FILE";
}

// A plain "this is a file" card: extension badge, filename, size. Used both
// as the whole preview for an unrecognized type and as the always-rendered
// background layer behind a PDF's inline render (see PdfPreviewFrame), so a
// browser that can't render the PDF inline still shows something intentional
// rather than a blank box.
function FileCard({
  file,
  className = "",
}: {
  file: { name: string; size?: number };
  className?: string;
}) {
  return (
    <div
      className={`flex min-w-0 items-center gap-1.5 overflow-hidden px-2 text-center ${className}`}
    >
      <span className="shrink-0 rounded bg-stone-200 px-1 py-0.5 text-[9px] font-semibold text-stone-600 dark:bg-stone-600 dark:text-stone-200">
        {extLabel(file.name)}
      </span>
      <span className="min-w-0 flex-1 truncate text-left text-[11px] text-stone-600 dark:text-stone-300">
        {file.name}
      </span>
      {file.size != null && (
        <span className="shrink-0 text-[10px] text-stone-500 dark:text-stone-500">
          {bytesLabel(file.size)}
        </span>
      )}
    </div>
  );
}

// A small, thumbnail-sized inline PDF render. Deliberately non-interactive
// (pointer-events-none) so it reads as a preview, not a scrollable document.
// The file card sits underneath as a real background layer (not a JS-detected
// fallback - mobile support for inline PDF rendering is inconsistent and not
// worth trying to detect): if the browser renders the PDF, it covers the
// card; if it can't, the card shows through and still looks intentional.
function PdfPreviewFrame({
  url,
  file,
  className = "h-16 w-16",
}: {
  url: string;
  file: { name: string; size?: number };
  className?: string;
}) {
  return (
    <div
      className={`relative overflow-hidden rounded-md border border-stone-200 bg-stone-50 dark:border-white/10 dark:bg-stone-800 ${className}`}
      title={file.name}
    >
      <div className="absolute inset-0 flex items-center justify-center">
        <FileCard file={file} className="w-full" />
      </div>
      <object
        data={`${url}#toolbar=0`}
        type="application/pdf"
        className="pointer-events-none absolute inset-0 h-full w-full"
        aria-hidden="true"
      />
    </div>
  );
}

function RemoveButton({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <button
      type="button"
      onClick={onRemove}
      aria-label={`Remove ${label}`}
      // Phone only: the badge grows to 24px and an invisible ::after ring
      // pushes the touch area to 44px. 16px was the smallest target in the
      // app; growing the circle itself would cover the thumbnail.
      className="absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-stone-800 text-[10px] leading-none text-white shadow hover:bg-stone-900 max-sm:h-6 max-sm:w-6 max-sm:text-sm max-sm:after:absolute max-sm:after:-inset-2.5 max-sm:after:content-[''] dark:bg-stone-600 dark:hover:bg-stone-500"
    >
      x
    </button>
  );
}

// One preview for a File the owner just picked, not yet (or still being)
// uploaded.
export function FilePreviewThumb({
  file,
  onRemove,
  size = "h-16 w-16",
}: {
  file: File;
  onRemove?: () => void;
  size?: string;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  // SVG is excluded from the image branch on purpose: Hearth's upload spots
  // that accept images never accept image/svg+xml (it can carry a <script>),
  // so a picked SVG renders as a plain file card, matching what would
  // actually happen to it server-side.
  const isImage = file.type.startsWith("image/") && file.type !== "image/svg+xml";
  const isPdf = file.type === "application/pdf";

  useEffect(() => {
    if (!isImage && !isPdf) return;
    const objectUrl = URL.createObjectURL(file);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file, isImage, isPdf]);

  if (isImage && url) {
    return (
      <div className="relative shrink-0">
        <button
          type="button"
          onClick={() => setLightboxOpen(true)}
          className="block cursor-zoom-in"
          aria-label={`View ${file.name} full size`}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={url}
            alt={file.name}
            title={file.name}
            className={`${size} rounded-md border border-stone-200 object-cover dark:border-white/10`}
          />
        </button>
        {onRemove && <RemoveButton label={file.name} onRemove={onRemove} />}
        <Lightbox
          src={lightboxOpen ? url : null}
          alt={file.name}
          caption={file.name}
          onClose={() => setLightboxOpen(false)}
        />
      </div>
    );
  }

  if (isPdf && url) {
    return (
      <div className="relative shrink-0">
        <PdfPreviewFrame url={url} file={file} className={size} />
        {onRemove && <RemoveButton label={file.name} onRemove={onRemove} />}
      </div>
    );
  }

  return (
    <div className="relative shrink-0">
      <div
        className={`flex flex-col items-center justify-center gap-1 rounded-md border border-stone-200 bg-stone-50 dark:border-white/10 dark:bg-stone-800 ${size}`}
      >
        <FileCard file={file} />
      </div>
      {onRemove && <RemoveButton label={file.name} onRemove={onRemove} />}
    </div>
  );
}

// A row of picked-file previews, matching the app's usual
// "mt-2 flex flex-wrap gap-2" convention.
export function FilePreviewGrid({
  files,
  onRemove,
  size,
  className = "mt-2 flex flex-wrap gap-2",
}: {
  files: File[];
  onRemove?: (index: number) => void;
  size?: string;
  className?: string;
}) {
  if (files.length === 0) return null;
  return (
    <div className={className}>
      {files.map((f, i) => (
        <FilePreviewThumb
          key={`${f.name}-${f.size}-${f.lastModified}-${i}`}
          file={f}
          size={size}
          onRemove={onRemove ? () => onRemove(i) : undefined}
        />
      ))}
    </div>
  );
}

// A thumbnail for a photo that's already saved to storage (a resolved
// display URL - see lib/storage.ts's imgSrc - not a local File). Opens the
// full image in the fullscreen Lightbox instead of linking out to a new tab
// (the lightbox still offers an "open in new tab" link of its own).
export function StoredPhotoThumb({
  src,
  alt,
  onRemove,
  size = "h-16 w-16",
}: {
  src: string;
  alt: string;
  onRemove?: () => void;
  size?: string;
}) {
  const [lightboxOpen, setLightboxOpen] = useState(false);
  return (
    <div className="relative shrink-0">
      <button
        type="button"
        onClick={() => setLightboxOpen(true)}
        className="block cursor-zoom-in"
        aria-label={`View ${alt} full size`}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt={alt}
          title={alt}
          className={`${size} rounded-md border border-stone-200 object-cover dark:border-white/10`}
        />
      </button>
      {onRemove && <RemoveButton label={alt} onRemove={onRemove} />}
      <Lightbox
        src={lightboxOpen ? src : null}
        alt={alt}
        onClose={() => setLightboxOpen(false)}
      />
    </div>
  );
}

export function StoredPhotoGrid({
  photos,
  onRemove,
  size,
  className = "mt-2 flex flex-wrap gap-2",
}: {
  photos: { src: string; alt: string; key: string }[];
  onRemove?: (key: string) => void;
  size?: string;
  className?: string;
}) {
  if (photos.length === 0) return null;
  return (
    <div className={className}>
      {photos.map((p) => (
        <StoredPhotoThumb
          key={p.key}
          src={p.src}
          alt={p.alt}
          size={size}
          onRemove={onRemove ? () => onRemove(p.key) : undefined}
        />
      ))}
    </div>
  );
}
