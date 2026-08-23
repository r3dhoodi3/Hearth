"use client";

import { useRef, useState, useTransition } from "react";
import { confirmSystemAction } from "./actions";
import { labelFor, SYSTEM_TYPES, systemFieldExample } from "@/lib/constants";
import TakePhotoButton from "@/components/TakePhotoButton";
import Lightbox from "@/components/Lightbox";
import AiNotice from "@/components/AiNotice";
import ProgressBar, { useStagedProgress } from "@/components/ProgressBar";
import type { HomeSystem } from "@/lib/database.types";
import { fetchWithTimeout, isTimeoutError } from "@/lib/fetchWithTimeout";

// What /api/confirm-system does with the photo: read the data plate, then pull
// the brand, model, and year off it into the editable suggestion.
const READ_STAGES = ["Reading the data plate", "Pulling out brand, model, and year"];

type Suggestion = {
  brand: string | null;
  model: string | null;
  serial: string | null;
  install_year: number | null;
};

const BLANK_SUGGESTION: Suggestion = {
  brand: null,
  model: null,
  serial: null,
  install_year: null,
};

// Read a File into base64 (no data: prefix) for the vision endpoint. Same
// helper as DocumentUpload.
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

// Plain-language, honest readout of the score change - never assumes it went
// up. A data plate can reveal a system is older or worse than the onboarding
// estimate guessed, so a scan can legitimately lower the score too.
function scoreMessage(before: number, after: number): string {
  if (after > before)
    return `Nice. Your Home Health Score moved from ${before} to ${after}.`;
  if (after < before)
    return `Your Home Health Score moved from ${before} to ${after}, now that we know more.`;
  return `Your Home Health Score stayed at ${after} - this one was already accounted for.`;
}

// One card in the "walk your home" flow: snap the data plate, Hearth reads a
// SUGGESTION off it (never auto-written), the owner confirms or edits it, and
// the card shows the real Home Health Score payoff for that one scan.
//
// The photo itself is never uploaded to storage: confirmSystemAction only
// ever writes the extracted fields (brand/model/serial/year), never a photo
// URL, so a stored object would just be an orphan whether the owner confirms
// or abandons the scan. The preview thumbnail is a local blob URL instead.
export default function SystemCaptureCard({
  system,
  propertyId,
}: {
  system: HomeSystem;
  propertyId: string;
}) {
  const [phase, setPhase] = useState<"idle" | "working" | "review" | "confirmed">(
    "idle"
  );
  const [note, setNote] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  const [delta, setDelta] = useState<{ before: number; after: number } | null>(
    null
  );
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [saving, startSave] = useTransition();
  // Lets the Cancel button below abort an in-flight read and lets the catch
  // block tell an owner-initiated cancel apart from a real failure (so
  // cancelling doesn't also flash an error note). Same pattern as
  // InspectionUpload.tsx.
  const abortRef = useRef<AbortController | null>(null);
  const cancelledRef = useRef(false);
  // Progress bar for the "Reading the data plate" step.
  const progress = useStagedProgress(READ_STAGES, 10000);

  const name = labelFor(SYSTEM_TYPES, system.system_type);
  // Placeholders for the manual-entry fields, keyed to THIS system. Both boxes
  // used to show the same water-heater example whatever you were standing in
  // front of; see SYSTEM_FIELD_EXAMPLES. An empty example means the system has
  // no brand or model to give, and the field says so instead of guessing.
  const example = systemFieldExample(system.system_type);

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const input = e.target;
    const file = input.files?.[0];
    input.value = ""; // allow re-picking the same file
    if (!file) return;

    // Guard the size before reading it into memory and POSTing to the vision
    // endpoint (cost/DoS + browser OOM). 10MB binary stays safely under the
    // route's 14M-char base64 cap (base64 inflates bytes by ~4/3), so a photo
    // that passes here can't get a 413 after the upload already happened.
    const MAX_BYTES = 10 * 1024 * 1024; // 10MB
    if (file.size > MAX_BYTES) {
      setNote("That photo is too large (max 10MB). Try a smaller one.");
      return;
    }

    setPhase("working");
    setNote("Reading the data plate…");
    setSuggestion(null);
    // Local preview only; nothing is written to storage (see the note above
    // the component).
    setPreview(URL.createObjectURL(file));
    cancelledRef.current = false;
    progress.start();
    const controller = new AbortController();
    abortRef.current = controller;

    let read: Suggestion | null = null;
    let failNote =
      "Couldn't read it automatically. Fill in what you can and confirm.";
    try {
      const b64 = await toBase64(file);
      const resp = await fetchWithTimeout("/api/confirm-system", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          image: b64,
          mime: file.type || "image/jpeg",
          system_id: system.id,
        }),
        signal: controller.signal,
      });
      abortRef.current = null;
      const data = await resp.json().catch(() => null);
      read = data?.suggestion ?? null;
      // Tell the truth about WHY nothing was read: a used-up daily AI limit
      // or unconfigured key is not a bad photo.
      if (!read && data?.reason === "rate_limited") {
        failNote =
          "You've hit today's AI limit, so Hearth can't read the photo right now. Fill in what you can and confirm.";
      } else if (!read && data?.reason === "busy") {
        // An owner-wide ceiling, or a burst window filled by another tool
        // (this route no longer counts toward the burst limit, so a normal
        // walkthrough never trips it). Their own allowance is untouched, so
        // do not tell them they are out for the day.
        failNote =
          "Hearth's AI is busy right now. Fill in what you can and confirm.";
      } else if (!read && data?.reason === "no_key") {
        failNote =
          "Automatic reading isn't set up yet. Fill in what you can and confirm.";
      }
    } catch (e) {
      abortRef.current = null;
      // Cancel already reset the phase and left no note - don't overwrite
      // that with a failure message for an abort the owner asked for.
      if (cancelledRef.current) {
        cancelledRef.current = false;
        return;
      }
      read = null;
      if (isTimeoutError(e)) {
        failNote = "That took too long. Fill in what you can and confirm.";
      }
    }

    progress.finish();
    setSuggestion(read ?? BLANK_SUGGESTION);
    setNote(
      read
        ? "Here's what Hearth read off the label. Check it and confirm."
        : failNote
    );
    setPhase("review");
  }

  // Lets the owner back out of "Reading the data plate..." instead of being
  // stuck waiting on a hung request with no escape.
  function cancelCapture() {
    cancelledRef.current = true;
    abortRef.current?.abort();
    abortRef.current = null;
    progress.reset();
    if (preview) URL.revokeObjectURL(preview);
    setPhase("idle");
    setSuggestion(null);
    setPreview(null);
    setNote(null);
  }

  function skipToManual() {
    setSuggestion(BLANK_SUGGESTION);
    setNote(null);
    setPhase("review");
  }

  function confirm(formData: FormData) {
    startSave(async () => {
      const result = await confirmSystemAction(formData);
      if (!result.ok) {
        // Surface the failure inline instead of silently dying: keep the review
        // form so the owner can retry, and never show the "Confirmed" payoff.
        setNote(result.error);
        return;
      }
      if (preview) URL.revokeObjectURL(preview);
      setDelta({ before: result.before, after: result.after });
      setPhase("confirmed");
    });
  }

  if (phase === "confirmed" && delta) {
    return (
      <li className="card space-y-1 border-green-200 bg-green-50/60 dark:border-green-900 dark:bg-green-950/30">
        <p className="flex items-center gap-2 font-medium text-stone-900 dark:text-stone-100">
          {name}
          <span className="chip bg-green-100 text-green-700 dark:bg-green-950/40 dark:text-green-200">✓ Confirmed</span>
        </p>
        <p className="text-sm text-green-800 dark:text-green-200">
          {scoreMessage(delta.before, delta.after)}
        </p>
      </li>
    );
  }

  return (
    <li className="card space-y-3">
      <p className="flex items-center gap-2 font-medium text-stone-900 dark:text-stone-100">
        {name}
        <span className="chip bg-stone-100 text-stone-500 dark:bg-stone-700 dark:text-stone-400">Estimated</span>
      </p>

      {phase !== "review" && (
        <>
          <label className="flex cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed border-stone-200 px-4 py-6 text-center hover:border-bark-500 hover:bg-bark-50 dark:border-stone-700 dark:hover:bg-bark-700/30">
            <span className="text-sm font-medium text-stone-700 dark:text-stone-300">
              Snap the data plate
            </span>
            <span className="text-xs text-stone-500 dark:text-stone-400">
              Hearth reads the brand, model, and age off it
            </span>
            <input
              type="file"
              accept="image/*"
              onChange={onPick}
              disabled={phase === "working"}
              className="hidden"
            />
          </label>
          {/* The walkthrough IS the standing-at-the-furnace moment, so phones
              get a straight-to-camera button; the tile above still opens the
              gallery for a photo taken earlier. */}
          <TakePhotoButton
            onPick={onPick}
            disabled={phase === "working"}
            label="Open the camera"
          />
          <button
            type="button"
            onClick={skipToManual}
            className="block text-xs text-stone-500 hover:text-stone-600 max-sm:inline-flex max-sm:min-h-11 max-sm:items-center dark:text-stone-400 dark:hover:text-stone-300"
          >
            No photo handy? Enter details by hand
          </button>
        </>
      )}

      {note && (
        <p className="text-xs text-stone-500 dark:text-stone-400">
          {note}
        </p>
      )}

      {phase === "working" && (
        <>
          <ProgressBar
            value={progress.value}
            stages={READ_STAGES}
            stageIndex={progress.stageIndex}
            ariaLabel="Reading the data plate"
          />
          <button
            type="button"
            onClick={cancelCapture}
            className="block text-xs text-stone-500 hover:text-stone-600 dark:text-stone-400 dark:hover:text-stone-300"
          >
            Cancel
          </button>
        </>
      )}

      {phase === "review" && suggestion && (
        <form action={confirm} className="space-y-3">
          <input type="hidden" name="system_id" value={system.id} />

          {preview && (
            <>
              <button
                type="button"
                onClick={() => setLightboxOpen(true)}
                className="block cursor-zoom-in"
                aria-label={`View ${name} data plate photo full size`}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={preview}
                  alt={`${name} data plate`}
                  className="max-h-32 rounded-lg border border-stone-200 object-contain dark:border-white/10"
                />
              </button>
              <Lightbox
                src={lightboxOpen ? preview : null}
                alt={`${name} data plate`}
                onClose={() => setLightboxOpen(false)}
              />
            </>
          )}

          {/* This IS the review step (every field below is editable before
              Confirm), same placement convention as InspectionUpload and
              DocumentUpload's equivalent notice. */}
          <AiNotice detail="A model read the data plate, so it can misread a letter or number. Check every field before you confirm." />

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">Brand</label>
              <input
                name="brand"
                className="input"
                placeholder={
                  example.brand ? `e.g. ${example.brand}` : "Not applicable"
                }
                defaultValue={suggestion.brand ?? ""}
              />
            </div>
            <div>
              <label className="label">Model</label>
              <input
                name="model"
                className="input"
                placeholder={
                  example.model ? `e.g. ${example.model}` : "Not applicable"
                }
                defaultValue={suggestion.model ?? ""}
              />
            </div>
            <div>
              <label className="label">Serial (optional)</label>
              <input
                name="serial"
                className="input"
                defaultValue={suggestion.serial ?? ""}
              />
            </div>
            <div>
              <label className="label">Install year</label>
              <input
                name="install_year"
                type="number"
                className="input"
                placeholder="2015"
                defaultValue={suggestion.install_year ?? system.install_year ?? ""}
              />
            </div>
            <div className="col-span-2">
              <label className="label">Condition (optional)</label>
              <select
                name="condition_rating"
                className="select"
                defaultValue={system.condition_rating ?? ""}
              >
                <option value="">Not sure</option>
                <option value="5">5 (like new)</option>
                <option value="4">4 (good)</option>
                <option value="3">3 (fair)</option>
                <option value="2">2 (worn)</option>
                <option value="1">1 (failing)</option>
              </select>
            </div>
          </div>

          <div className="flex gap-3">
            <button
              type="button"
              className="btn-secondary"
              onClick={() => {
                if (preview) URL.revokeObjectURL(preview);
                setPhase("idle");
                setSuggestion(null);
                setPreview(null);
                setNote(null);
              }}
            >
              Cancel
            </button>
            <button type="submit" disabled={saving} className="btn-primary flex-1">
              {saving ? "Confirming…" : "Confirm"}
            </button>
          </div>
        </form>
      )}
    </li>
  );
}
