"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { imgSrc } from "@/lib/storage";
import { savePrepItemAction } from "./actions";
import SubmitButton from "@/components/SubmitButton";
import Lightbox from "@/components/Lightbox";
import type { PrepKey } from "./PanicCard";

const MAX_BYTES = 15 * 1024 * 1024; // 15MB, same cap as PhotoUpload

// One prep slot: a photo of where a shutoff lives plus an optional note. Same
// private-bucket + /api/img pattern as PhotoUpload, but a single photo saved
// straight into properties.emergency_prep instead of the polymorphic `photos`
// table, since this isn't tied to an issue or system row.
export default function PrepPhotoUpload({
  propertyId,
  itemKey,
  label,
  initialPhotoSrc,
  initialNote,
}: {
  propertyId: string;
  itemKey: PrepKey;
  label: string;
  initialPhotoSrc: string | null;
  initialNote: string;
}) {
  const supabase = createClient();
  const [preview, setPreview] = useState<string | null>(initialPhotoSrc);
  const [photoUrl, setPhotoUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [lightboxOpen, setLightboxOpen] = useState(false);

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const input = e.target;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    // Real allowed raster types only - matches the home-photos bucket's own
    // allowed_mime_types (migration 0079). accept="image/*" is only a browser
    // hint; the old `type.startsWith("image/")` check would still let
    // image/svg+xml through, which can carry a <script> and gets served back
    // off Hearth's own storage origin (security audit finding #7).
    const ALLOWED_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
    if (file.type === "image/svg+xml") {
      setErr("SVG images aren't supported. Please use a PNG, JPEG, or WEBP photo.");
      return;
    }
    if (file.size > MAX_BYTES || !ALLOWED_TYPES.has(file.type)) {
      setErr("That file's too big or isn't a supported image type (PNG, JPEG, WEBP).");
      return;
    }
    // Local preview right away, before the upload finishes, so the owner can
    // see what they picked. Swapped for the real (signed) URL once the
    // upload lands; revoked either way so it never lingers.
    const localUrl = URL.createObjectURL(file);
    setPreview(localUrl);
    setBusy(true);
    setErr(null);
    // Sanitize the derived extension to a safe charset so no ".." or path
    // fragment from a crafted filename can enter the storage key.
    const rawExt = file.name.split(".").pop()?.toLowerCase() ?? "";
    const ext = /^[a-z0-9]{1,5}$/.test(rawExt) ? rawExt : "jpg";
    const path = `${propertyId}/emergency-${itemKey}-${crypto.randomUUID()}.${ext}`;
    const { error } = await supabase.storage
      .from("home-photos")
      .upload(path, file, { upsert: false });
    setBusy(false);
    if (error) {
      URL.revokeObjectURL(localUrl);
      setPreview(initialPhotoSrc);
      setErr("That photo didn't upload. Check your connection and try again.");
      return;
    }
    const { data } = supabase.storage.from("home-photos").getPublicUrl(path);
    setPhotoUrl(data.publicUrl);
    URL.revokeObjectURL(localUrl);
    setPreview(imgSrc(data.publicUrl));
  }

  return (
    <form
      action={savePrepItemAction}
      className="space-y-2 rounded-lg border border-stone-200 p-3 dark:border-white/10"
    >
      <input type="hidden" name="key" value={itemKey} />
      <input type="hidden" name="photo_url" value={photoUrl} />
      <p className="text-sm font-medium text-stone-800 dark:text-stone-200">{label}</p>
      {preview ? (
        <>
          <button
            type="button"
            onClick={() => setLightboxOpen(true)}
            className="block w-full cursor-zoom-in"
            aria-label={`View ${label} photo full size`}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={preview}
              alt={label}
              className="h-28 w-full rounded-md object-cover"
            />
          </button>
          <Lightbox
            src={lightboxOpen ? preview : null}
            alt={label}
            onClose={() => setLightboxOpen(false)}
          />
        </>
      ) : (
        <div className="flex h-28 items-center justify-center rounded-md bg-stone-50 text-xs text-stone-500 dark:bg-stone-900 dark:text-stone-400">
          No photo yet
        </div>
      )}
      <input
        type="file"
        accept="image/png,image/jpeg,image/webp"
        onChange={onPick}
        className="block w-full text-xs text-stone-500 file:mr-2 file:rounded-md file:border-0 file:bg-bark-100 file:px-2 file:py-1 file:text-bark-700 dark:text-stone-400 dark:file:bg-bark-700 dark:file:text-stone-300"
      />
      {busy && <p className="text-xs text-stone-500 dark:text-stone-400">Uploading…</p>}
      {err && <p className="text-xs text-amber-600 dark:text-amber-400">{err}</p>}
      <textarea
        name="note"
        defaultValue={initialNote}
        rows={2}
        placeholder="Notes, e.g. behind the water heater"
        className="textarea text-base sm:text-sm"
      />
      <SubmitButton className="btn-secondary w-full text-sm" pendingLabel="Saving…">
        Save
      </SubmitButton>
    </form>
  );
}
