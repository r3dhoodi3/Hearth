"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import InlineSpinner from "@/components/InlineSpinner";

// Uploads a single logo image to the PUBLIC `pro-logos` bucket under
// <contractorId>/ and renders a hidden input (name="logo_url") so the parent
// <form>'s server action receives the public URL. Same machinery as
// PhotoUpload, minus the multi-file handling; the bucket is public because the
// logo is served on an unauthenticated page. Degrades gracefully if the bucket
// isn't set up yet (migration 0033 not run).
export default function LogoUpload({
  contractorId,
  initialUrl,
}: {
  contractorId: string;
  initialUrl: string | null;
}) {
  const supabase = createClient();
  const [url, setUrl] = useState<string | null>(initialUrl);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const input = e.target;
    const file = input.files?.[0];
    if (!file) return;
    setBusy(true);
    setErr(null);

    const MAX_BYTES = 5 * 1024 * 1024; // 5MB is plenty for a logo
    // Real allowed raster types only - matches the pro-logos bucket's own
    // allowed_mime_types (migration 0079). This bucket is PUBLIC and serves
    // logos on unauthenticated pro pages, which makes it the worst place for
    // the client's old `file.type.startsWith("image/")` check to have let
    // image/svg+xml through: an SVG can carry a <script> and would execute on
    // OakTend's own storage/proxy origin against any visitor viewing that pro's
    // page (security audit finding #7).
    const ALLOWED_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
    if (file.type === "image/svg+xml") {
      setErr("SVG images aren't supported. Please use a PNG, JPEG, or WEBP logo.");
      setBusy(false);
      input.value = "";
      return;
    }
    if (file.size > MAX_BYTES || !ALLOWED_TYPES.has(file.type)) {
      setErr("Please pick a PNG, JPEG, or WEBP image under 5MB.");
      setBusy(false);
      input.value = "";
      return;
    }

    const rawExt = file.name.split(".").pop()?.toLowerCase() ?? "";
    const ext = /^[a-z0-9]{1,5}$/.test(rawExt) ? rawExt : "png";
    const id = crypto.randomUUID();
    const path = `${contractorId}/${id}.${ext}`;
    // finally guarantees busy resets even if the upload promise rejects
    // (network blip, thrown error), so the input never stays disabled until a
    // page reload.
    try {
      const { error } = await supabase.storage
        .from("pro-logos")
        .upload(path, file, { upsert: false });
      if (error) {
        setErr(
          "The logo couldn't upload (is the pro-logos bucket created?). You can still save the rest."
        );
      } else {
        const { data } = supabase.storage.from("pro-logos").getPublicUrl(path);
        setUrl(data.publicUrl);
      }
    } finally {
      setBusy(false);
      // Reset so picking the same file again still fires onChange.
      input.value = "";
    }
  }

  return (
    <div>
      <label className="label">Logo</label>
      <div className="flex items-center gap-3">
        {url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={url}
            alt="logo preview"
            className="h-14 w-14 rounded-xl border border-stone-200 object-cover dark:border-white/10"
          />
        ) : (
          <div className="flex h-14 w-14 items-center justify-center rounded-xl border border-dashed border-stone-300 bg-stone-50 text-stone-500 dark:border-stone-700 dark:bg-stone-800 dark:text-stone-400">
            <svg
              viewBox="0 0 24 24"
              className="h-6 w-6"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M4 21V5l8-2 8 2v16M9 9h.01M9 13h.01M15 9h.01M15 13h.01M10 21v-4h4v4" />
            </svg>
          </div>
        )}
        <input
          type="file"
          accept="image/png,image/jpeg,image/webp"
          onChange={onPick}
          disabled={busy}
          className="block w-full text-sm text-stone-600 file:mr-3 file:rounded-md file:border-0 file:bg-oaktend-100 file:px-3 file:py-1.5 file:text-oaktend-800 dark:text-stone-300 dark:file:bg-oaktend-900/40 dark:file:text-oaktend-200"
        />
      </div>
      {busy && (
        <p className="mt-1 flex items-center gap-1.5 text-xs text-stone-500 dark:text-stone-400">
          <InlineSpinner size={14} />
          Uploading…
        </p>
      )}
      {err && <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">{err}</p>}
      {url && <input type="hidden" name="logo_url" value={url} />}
    </div>
  );
}
