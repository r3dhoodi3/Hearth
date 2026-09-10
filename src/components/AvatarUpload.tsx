"use client";

import { useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import InlineSpinner from "@/components/InlineSpinner";

// A tappable profile picture. The whole avatar IS the control - there is no
// separate "upload" button (product decision, 2026-09-08): tapping it opens the
// native file picker (camera or gallery on a phone), uploads straight to a
// PUBLIC Supabase Storage bucket under <ownerId>/, then auto-submits its own
// small <form> so the new photo persists immediately, no Save button.
//
// Generalised from the old pro-only LogoUpload: `bucket`, `ownerId` and
// `inputName` are all that differ between the pro logo (contractors.logo_url in
// the pro-logos bucket) and the homeowner avatar (users.avatar_url in the
// avatars bucket). The SVG rejection + size + MIME allow-list are kept verbatim:
// these buckets are PUBLIC and served on unauthenticated pages, so an
// image/svg+xml slipping through would be stored XSS on Hearth's own storage
// origin (the original security audit finding #7 behind LogoUpload).
const ALLOWED_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const MAX_BYTES = 5 * 1024 * 1024; // 5MB is plenty for an avatar/logo

export default function AvatarUpload({
  action,
  bucket,
  ownerId,
  inputName,
  initialUrl,
  shape = "square",
  size = 80,
  placeholder = "building",
}: {
  // The server action that writes the resulting URL to the right column. It is
  // expected to revalidate rather than redirect, so a neighbouring form's
  // unsaved edits survive the auto-submit below.
  action: (formData: FormData) => void | Promise<void>;
  bucket: string;
  ownerId: string;
  inputName: string;
  initialUrl: string | null;
  shape?: "round" | "square";
  size?: number;
  placeholder?: "building" | "person";
}) {
  const supabase = createClient();
  const [url, setUrl] = useState<string | null>(initialUrl);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const hiddenRef = useRef<HTMLInputElement>(null);

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const input = e.target;
    const file = input.files?.[0];
    if (!file) return;
    setBusy(true);
    setErr(null);

    // SVG is refused explicitly and first: it can carry a <script>, and this
    // bucket is public and served on unauthenticated pages.
    if (file.type === "image/svg+xml") {
      setErr("SVG images aren't supported. Please use a PNG, JPEG, or WEBP image.");
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
    const path = `${ownerId}/${id}.${ext}`;
    // finally guarantees busy resets even if the upload promise rejects, so the
    // control never stays disabled until a reload.
    try {
      const { error } = await supabase.storage
        .from(bucket)
        .upload(path, file, { upsert: false });
      if (error) {
        setErr("The photo couldn't upload. Please try again.");
      } else {
        const { data } = supabase.storage.from(bucket).getPublicUrl(path);
        setUrl(data.publicUrl);
        // Persist immediately: write the public URL into the hidden field, then
        // submit this component's own form. "Tap the placeholder" saves with no
        // separate button.
        if (hiddenRef.current) hiddenRef.current.value = data.publicUrl;
        formRef.current?.requestSubmit();
      }
    } finally {
      setBusy(false);
      // Reset so re-picking the same file still fires onChange.
      input.value = "";
    }
  }

  const rounded = shape === "round" ? "rounded-full" : "rounded-2xl";

  return (
    <form action={action} ref={formRef}>
      <input
        type="hidden"
        name={inputName}
        ref={hiddenRef}
        defaultValue={url ?? ""}
      />
      <label
        className={`group relative flex cursor-pointer items-center justify-center overflow-hidden border shadow-sm ${rounded} ${
          url
            ? "border-stone-200 dark:border-white/10"
            : "border-dashed border-stone-300 bg-stone-50 text-stone-500 dark:border-stone-600 dark:bg-stone-800 dark:text-stone-400"
        }`}
        style={{ height: size, width: size }}
        aria-label={url ? "Change your photo" : "Add a photo"}
        title={url ? "Change your photo" : "Add a photo"}
      >
        {url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={url} alt="" className="h-full w-full object-cover" />
        ) : placeholder === "person" ? (
          <svg
            viewBox="0 0 24 24"
            className="h-2/3 w-2/3"
            fill="currentColor"
            aria-hidden="true"
          >
            <circle cx="12" cy="9" r="4" />
            <path d="M4 20c0-3.6 3.6-6 8-6s8 2.4 8 6v1H4v-1z" />
          </svg>
        ) : (
          <svg
            viewBox="0 0 24 24"
            className="h-2/5 w-2/5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M4 21V5l8-2 8 2v16M9 9h.01M9 13h.01M15 9h.01M15 13h.01M10 21v-4h4v4" />
          </svg>
        )}

        {/* The whole avatar is tappable; this overlay says so on hover/focus,
            and shows the spinner while an upload is in flight. */}
        <span
          className={`pointer-events-none absolute inset-0 flex items-end justify-center pb-1 text-[10px] font-medium text-white opacity-0 transition group-hover:bg-black/40 group-hover:opacity-100 group-focus-within:bg-black/40 group-focus-within:opacity-100 ${
            busy ? "!bg-black/40 !opacity-100" : ""
          }`}
        >
          {busy ? <InlineSpinner size={16} /> : url ? "Edit" : "Add"}
        </span>

        <input
          type="file"
          accept="image/png,image/jpeg,image/webp"
          onChange={onPick}
          disabled={busy}
          className="sr-only"
        />
      </label>
      {err && (
        <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">{err}</p>
      )}
    </form>
  );
}
