"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { SYSTEM_TYPES } from "@/lib/constants";
import { saveDocumentAction } from "@/lib/document-actions";
import TakePhotoButton from "@/components/TakePhotoButton";
import { fetchWithTimeout, isTimeoutError } from "@/lib/fetchWithTimeout";
import { FilePreviewThumb } from "@/components/FilePreview";
import Lightbox from "@/components/Lightbox";
import AiNotice from "@/components/AiNotice";
import ProgressBar, { useStagedProgress } from "@/components/ProgressBar";
import { FREE_TASTE_PAYWALL, tasteMeterLabel } from "@/lib/freeAiTaste";

// What /api/extract-document does while the owner waits: read the file, then
// pull the facts (brand, model, dates) off it into the editable form.
const READ_STAGES = ["Reading the document", "Pulling out the details"];

const DOC_TYPES = [
  { value: "warranty", label: "Warranty" },
  { value: "manual", label: "Manual" },
  { value: "receipt", label: "Receipt / invoice" },
  { value: "inspection_report", label: "Inspection report" },
  { value: "other", label: "Other" },
];

type Extracted = {
  doc_type: string;
  title: string;
  brand: string | null;
  model: string | null;
  install_year: number | null;
  warranty_expires: string | null;
  system_type: string | null;
  summary: string | null;
};

// Read a File into base64 (no data: prefix) for the vision endpoint.
function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const res = String(reader.result || "");
      resolve(res.includes(",") ? res.split(",")[1] : res);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// Each status note carries a tone so the color matches the news: red for
// errors, green for success, calm stone for everything in between.
type Note = { text: string; tone: "error" | "ok" | "working" };

// The vault's "add" surface: pick a photo/PDF of a warranty, manual, receipt,
// or an appliance data plate; Hearth reads the facts off it; the owner confirms
// and saves. Then the saved card offers a one-tap "Add to my home".
//
// The file itself is only uploaded to storage once the owner actually saves
// (below). Extraction only needs the bytes, not a stored object, so picking a
// file and then canceling or navigating away leaves nothing orphaned in the
// private bucket.
//
// `freeReadsLeft` is the meter: how many of the 2 lifetime free AI reads this
// account has left (src/lib/freeAiTaste.ts). It is null for a Plus or trialing
// member, and null when the counter could not be read, and in both cases no
// meter and no door is shown. At zero the picker is replaced by the Plus door
// carrying the SAME sentence /api/extract-document would have sent, so the
// refusal is never a surprise and never arrives cold.
export default function DocumentUpload({
  propertyId,
  freeReadsLeft = null,
}: {
  propertyId: string;
  freeReadsLeft?: number | null;
}) {
  const supabase = createClient();
  const [phase, setPhase] = useState<"idle" | "working" | "review">("idle");
  const [note, setNote] = useState<Note | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [fields, setFields] = useState<Extracted | null>(null);
  const [saving, startSave] = useTransition();
  // Lets the "Reading the document..." step be cancelled: aborts the
  // in-flight extraction fetch and hands the picker back to the owner.
  const [reading, setReading] = useState<AbortController | null>(null);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  // Progress bar for the "Reading the document" extraction step.
  const progress = useStagedProgress(READ_STAGES, 12000);
  // The live meter. Seeded from the server on render and decremented here as
  // reads succeed, so the count stays honest without a page refresh. Null
  // means "no meter" (Plus, or the counter could not be read).
  const [readsLeft, setReadsLeft] = useState<number | null>(freeReadsLeft);
  // Set when the server refuses (HTTP 402): the door replaces the picker with
  // the server's own sentence. Belt and braces behind the meter above, for the
  // tab that was already open when the last read was spent somewhere else.
  const [locked, setLocked] = useState(false);
  const doorShowing = locked || readsLeft === 0;

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const input = e.target;
    const picked = input.files?.[0];
    input.value = ""; // allow re-picking the same file
    if (!picked) return;

    // Guard the size before we read it into memory and POST it to the vision
    // endpoint (cost/DoS + browser OOM). accept="" is only a hint.
    const MAX_BYTES = 15 * 1024 * 1024; // 15MB
    if (picked.size > MAX_BYTES) {
      setPhase("idle");
      setNote({
        text: "That file is too large (max 15MB). Try a smaller photo or PDF.",
        tone: "error",
      });
      return;
    }

    // Real allowed types only - matches the home-photos bucket's own
    // allowed_mime_types (migration 0079: png/jpeg/webp/pdf, deliberately no
    // SVG). accept="image/*,application/pdf" is only a browser hint; a naive
    // client check like `type.startsWith("image/")` would still let
    // image/svg+xml through, which can carry a <script> and gets served back
    // off Hearth's own storage origin (security audit finding #7).
    if (picked.type === "image/svg+xml") {
      setPhase("idle");
      setNote({
        text: "SVG images aren't supported. Please use a PNG, JPEG, WEBP photo, or a PDF.",
        tone: "error",
      });
      return;
    }
    const ALLOWED_TYPES = new Set([
      "image/png",
      "image/jpeg",
      "image/webp",
      "application/pdf",
    ]);
    if (!ALLOWED_TYPES.has(picked.type)) {
      setPhase("idle");
      setNote({
        text: "Please pick a PNG, JPEG, WEBP photo, or a PDF.",
        tone: "error",
      });
      return;
    }

    setPhase("working");
    setNote({ text: "Reading the document…", tone: "working" });
    setFields(null);
    setFile(picked);
    progress.start();
    // Local preview only, no storage object: a blob URL renders directly, no
    // signing needed, and it never touches the (private) home-photos bucket.
    // Kept in a local too (not just state) so the timeout path below revokes
    // THIS call's URL, not a stale `preview` from before the await. Covers
    // both images and PDFs now (previously images only) - the review step
    // below picks the right render for whichever `file.type` this turns out
    // to be.
    const objectUrl = URL.createObjectURL(picked);
    setPreview(objectUrl);

    // Ask Hearth to read the facts off it. The controller lets the Cancel
    // affordance below abort this mid-flight; fetchWithTimeout also aborts
    // it on its own after 90s so a hung endpoint can't strand the picker.
    const controller = new AbortController();
    setReading(controller);
    let extracted: Extracted | null = null;
    let timedOut = false;
    // The server said this account is out of free reads (HTTP 402). Handled
    // like the timeout below: hand the picker back and show the door, rather
    // than dropping into the blank review form as if extraction had merely
    // failed.
    let paywalled = false;
    try {
      const b64 = await toBase64(picked);
      const resp = await fetchWithTimeout(
        "/api/extract-document",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ image: b64, mime: picked.type || "image/jpeg" }),
          signal: controller.signal,
        },
        90_000
      );
      const data = await resp.json().catch(() => ({}));
      if (resp.status === 402) {
        paywalled = true;
        setReadsLeft(0);
        setLocked(true);
      } else {
        extracted = data?.doc ?? null;
      }
    } catch (e) {
      if (isTimeoutError(e)) {
        timedOut = true;
      } else if (controller.signal.aborted) {
        // Owner hit "Cancel" below; cancelReading() already reset the phase
        // and picker, so there is nothing left to do here.
        return;
      }
      extracted = null;
    }
    setReading(null);
    progress.finish();

    if (timedOut) {
      setPhase("idle");
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      setFile(null);
      setPreview(null);
      setNote({ text: "That took too long. Try again.", tone: "error" });
      return;
    }

    if (paywalled) {
      // The door below carries the message, so no red error note here: this
      // is not something the owner got wrong.
      setPhase("idle");
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      setFile(null);
      setPreview(null);
      setNote(null);
      return;
    }

    // A real read landed, so one free read is gone. A failed read is refunded
    // server side, so the meter only moves when the owner actually got
    // something back.
    if (extracted) {
      setReadsLeft((n) => (n === null ? null : Math.max(0, n - 1)));
    }

    // Fall back to a blank, editable form if extraction was unavailable.
    setFields(
      extracted ?? {
        doc_type: "other",
        title: "",
        brand: null,
        model: null,
        install_year: null,
        warranty_expires: null,
        system_type: null,
        summary: null,
      }
    );
    setNote({
      text: extracted
        ? "Here's what Hearth read. Check it and save."
        : "Couldn't read it automatically. Fill in what you like and save.",
      tone: "working",
    });
    setPhase("review");
  }

  function save(formData: FormData) {
    startSave(async () => {
      if (!file) return;
      setNote({ text: "Uploading…", tone: "working" });
      // Only now, on the owner's actual say-so, does the file land in
      // storage: the property-scoped path lets RLS gate it.
      // Sanitize the derived extension to a safe charset so no ".." or path
      // fragment from a crafted filename can enter the storage key.
      const rawExt = file.name.split(".").pop()?.toLowerCase() ?? "";
      const ext = /^[a-z0-9]{1,5}$/.test(rawExt) ? rawExt : "jpg";
      const path = `${propertyId}/docs/${crypto.randomUUID()}.${ext}`;
      const { error: upErr } = await supabase.storage
        .from("home-photos")
        .upload(path, file, { upsert: false });
      if (upErr) {
        // The setup detail (a missing home-photos bucket, a policy problem)
        // belongs in the console, not in front of the homeowner.
        console.error("Document upload to home-photos failed:", upErr);
        setNote({
          text: "We couldn't upload that file. Please try again in a moment.",
          tone: "error",
        });
        return;
      }
      const { data: pub } = supabase.storage
        .from("home-photos")
        .getPublicUrl(path);
      formData.set("file_url", pub.publicUrl);

      const result = await saveDocumentAction(formData);
      if (!result.ok) {
        // The action already flashed the error and removed the orphan file.
        // Keep the review form intact so the owner can retry, and never claim
        // it saved. Surface the reason inline too.
        setNote({ text: result.error, tone: "error" });
        return;
      }
      // Reset for the next upload; the saved card appears in the list below.
      if (preview) URL.revokeObjectURL(preview);
      setPhase("idle");
      setFields(null);
      setFile(null);
      setPreview(null);
      setNote({ text: "Saved. It's in your documents below.", tone: "ok" });
    });
  }

  function cancel() {
    if (preview) URL.revokeObjectURL(preview);
    setPhase("idle");
    setFile(null);
    setFields(null);
    setPreview(null);
    setNote(null);
  }

  // Back out of "Reading the document..." without waiting on it: abort the
  // extraction fetch and hand the picker straight back to the owner.
  function cancelReading() {
    reading?.abort();
    setReading(null);
    progress.reset();
    if (preview) URL.revokeObjectURL(preview);
    setPhase("idle");
    setFile(null);
    setPreview(null);
    setNote(null);
  }

  const val = (v: string | number | null) => (v == null ? "" : String(v));

  return (
    <div className="rounded-xl border border-stone-200 bg-white p-4 dark:border-white/10 dark:bg-stone-800">
      {/* THE DOOR. Shown in place of the picker once the free reads are gone,
          carrying the same sentence the route sends, so nobody meets a cold
          refusal after picking a file. Uploads themselves are not gated: the
          card below points that out, since storing paperwork stays free. */}
      {phase !== "review" && doorShowing && (
        <div className="space-y-3 rounded-lg border border-bark-100 bg-bark-50 p-4 text-center dark:border-bark-700 dark:bg-bark-700/40">
          <p className="text-sm text-bark-700 dark:text-stone-300">
            {FREE_TASTE_PAYWALL.document.message}
          </p>
          <Link
            href={FREE_TASTE_PAYWALL.document.link}
            className="btn-primary inline-block"
          >
            Get Hearth Plus
          </Link>
        </div>
      )}

      {phase !== "review" && !doorShowing && (
        <>
          <label className="flex cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed border-stone-200 px-4 py-8 text-center hover:border-bark-500 hover:bg-bark-50 dark:border-white/10">
            <span className="text-sm font-medium text-stone-700 dark:text-stone-300">
              Add a warranty, manual, receipt, or a photo of a model label
            </span>
            <span className="text-xs text-stone-500 dark:text-stone-400">
              Hearth reads it and fills in your home details for you
            </span>
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp,application/pdf"
              onChange={onPick}
              disabled={phase === "working"}
              className="hidden"
            />
          </label>
          {/* THE METER, stated before the tap rather than after the wall: the
              exact number left, next to the action it applies to. Plus and
              trialing members get null and see nothing here. */}
          {readsLeft !== null && readsLeft > 0 && (
            <p className="mt-2 text-xs text-stone-500 dark:text-stone-400">
              {tasteMeterLabel("document", readsLeft)}. Plus reads every
              document you add.
            </p>
          )}
          {/* On phones, shooting the label/receipt right now beats hunting the
              gallery. Same onPick, so extraction works identically. */}
          <TakePhotoButton
            onPick={onPick}
            disabled={phase === "working"}
            className="mt-2"
          />
          {phase === "working" && (
            <button
              type="button"
              onClick={cancelReading}
              // Phone only: 16px tall, and it is the way out of a stuck read.
              className="mt-2 text-xs text-stone-500 underline-offset-2 hover:text-stone-700 hover:underline max-sm:inline-flex max-sm:min-h-11 max-sm:items-center max-sm:text-sm dark:text-stone-400 dark:hover:text-stone-300"
            >
              Cancel and pick a different file
            </button>
          )}
        </>
      )}

      {note && (
        <p
          className={`mt-2 text-xs ${
            note.tone === "error"
              ? "text-red-600 dark:text-red-400"
              : note.tone === "ok"
                ? "text-green-700 dark:text-green-300"
                : "text-stone-500 dark:text-stone-400"
          }`}
        >
          {note.text}
        </p>
      )}

      {phase === "working" && (
        <ProgressBar
          className="mt-2"
          value={progress.value}
          stages={READ_STAGES}
          stageIndex={progress.stageIndex}
          ariaLabel="Reading your document"
        />
      )}

      {phase === "review" && fields && (
        <form action={save} className="mt-3 space-y-3">
          {/* Sits above the editable fields, same placement as the equivalent
              notice on the inspection-report reader: this IS the human
              review step, so the caveat needs to be read before it. */}
          <AiNotice detail="A model read this file, so it can misread a brand, model, or date; check every field before you save. If this is an insurance document, this isn't insurance advice: what your policy actually covers is decided by your insurer and the policy itself, not this reading." />
          {preview && file && (
            file.type === "application/pdf" ? (
              <FilePreviewThumb file={file} size="mb-1 h-28 w-28" />
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => setLightboxOpen(true)}
                  className="mb-1 block cursor-zoom-in"
                  aria-label="View document preview full size"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={preview}
                    alt="Document preview"
                    className="max-h-40 rounded-lg border border-stone-200 object-contain dark:border-white/10"
                  />
                </button>
                <Lightbox
                  src={lightboxOpen ? preview : null}
                  alt="Document preview"
                  onClose={() => setLightboxOpen(false)}
                />
              </>
            )
          )}

          <div>
            <label className="label">Title</label>
            <input
              name="title"
              defaultValue={val(fields.title)}
              placeholder="e.g. Rheem water heater warranty"
              className="input"
              required
            />
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="label">Type</label>
              <select
                name="doc_type"
                defaultValue={fields.doc_type}
                className="input"
              >
                {DOC_TYPES.map((d) => (
                  <option key={d.value} value={d.value}>
                    {d.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label">Relates to</label>
              <select
                name="system_type"
                defaultValue={fields.system_type ?? ""}
                className="input"
              >
                <option value="">- none -</option>
                {SYSTEM_TYPES.map((sys) => (
                  <option key={sys.value} value={sys.value}>
                    {sys.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="label">Brand</label>
              <input
                name="brand"
                defaultValue={val(fields.brand)}
                placeholder="e.g. Rheem"
                className="input"
              />
            </div>
            <div>
              <label className="label">Model</label>
              <input
                name="model"
                defaultValue={val(fields.model)}
                placeholder="e.g. XE50T10H45U0"
                className="input"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="label">Install / purchase year</label>
              <input
                name="install_year"
                type="number"
                defaultValue={val(fields.install_year)}
                placeholder="e.g. 2021"
                className="input"
              />
            </div>
            <div>
              <label className="label">Warranty expires</label>
              <input
                name="warranty_expires"
                type="date"
                defaultValue={val(fields.warranty_expires)}
                className="input"
              />
              <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
                This date is what makes it show up on your dashboard&apos;s warranty countdown.
              </p>
            </div>
          </div>

          <div>
            <label className="label">Summary</label>
            <textarea
              name="summary"
              defaultValue={val(fields.summary)}
              rows={2}
              placeholder="What this is and the one fact worth remembering"
              className="input"
            />
          </div>

          <div className="flex items-center gap-2">
            <button type="submit" disabled={saving} className="btn-primary">
              {saving ? "Saving…" : "Save to documents"}
            </button>
            <button
              type="button"
              onClick={cancel}
              // Phone only: ~20px tall beside a full-size save button.
              className="text-sm text-stone-500 hover:text-stone-700 max-sm:inline-flex max-sm:min-h-11 max-sm:items-center dark:text-stone-400 dark:hover:text-stone-300"
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
