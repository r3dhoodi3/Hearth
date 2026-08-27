"use client";

import { useState } from "react";
import { fetchWithTimeout, isTimeoutError } from "@/lib/fetchWithTimeout";
import ProgressBar, { useStagedProgress } from "@/components/ProgressBar";
import { useDraftJob } from "./DraftJobContext";

// What /api/draft-job actually does with the photo: read it, write a project
// description from it, and guess which trade the job belongs to.
const DRAFT_STAGES = [
  "Looking at your photo",
  "Writing a description",
  "Picking the trade",
];

// The "Details about your project" field, plus a photo-to-draft helper. When a
// photo is attached and the description is still empty or hasn't been typed by
// hand, a small button offers to draft the description FROM the photo (the
// owner then edits it, they don't originate it). The call is never fired on
// attach: it costs money and plenty of owners would rather just type.
//
// The 20-character server floor (postJobAction) is untouched: a drafted
// description is normal text in the same box, and PostJobButton still checks
// the same minimum before submit.
export default function DescriptionField({
  initialDescription,
}: {
  initialDescription: string;
}) {
  const ctx = useDraftJob();
  const [value, setValue] = useState(initialDescription);
  // Once the owner types in the box themselves, we stop offering to draft over
  // their words. An AI-filled draft leaves this false (it's untouched by hand),
  // so they can redraft until they start editing.
  const [handTyped, setHandTyped] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // True when the failure is one a fresh attempt could plausibly fix (an
  // unreadable photo, a timeout, or a transient error), so we offer a manual
  // "Try again". A retry is never fired automatically: rate-limit and
  // no-key failures leave this false since retrying can't help them.
  const [retryable, setRetryable] = useState(false);
  // Progress bar for the draft-from-photo call while it's in flight.
  const progress = useStagedProgress(DRAFT_STAGES, 12000);

  const photoUrl = ctx?.photoUrls[0] ?? null;
  const offerDraft = Boolean(photoUrl) && !handTyped;

  async function draftFromPhoto() {
    if (!photoUrl || drafting) return;
    setDrafting(true);
    setError(null);
    setRetryable(false);
    progress.start();
    try {
      const resp = await fetchWithTimeout(
        "/api/draft-job",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ photo_url: photoUrl }),
        },
        95_000
      );
      const data = await resp.json().catch(() => null);
      const description =
        data && typeof data.description === "string" ? data.description : "";
      if (description) {
        setValue(description);
        // Preselect the trade the draft guessed, but only if the owner hasn't
        // already picked one themselves. Always left changeable.
        if (
          data.category_guess &&
          ctx &&
          !ctx.categoryTouched &&
          !ctx.category
        ) {
          ctx.setCategory(data.category_guess);
        }
        return;
      }
      // No description came back: say why in plain terms instead of leaving the
      // box empty with no explanation. Retryable for the failures a fresh
      // attempt could fix (a bad photo read, or a transient hiccup); not for
      // rate-limit / no-key / not-found, where retrying the same call can't help.
      const reason = data?.reason;
      if (reason === "rate_limited") {
        setError(
          "You've hit today's AI limit, so Hearth can't draft this right now. You can still type the description yourself."
        );
      } else if (reason === "no_key") {
        setError(
          "Drafting from a photo isn't set up yet. Please type the description yourself."
        );
      } else if (reason === "unreadable") {
        setError(
          "Couldn't read enough from that photo. Try a brighter, closer shot, or just type it below."
        );
        setRetryable(true);
      } else if (reason === "not_found") {
        setError(
          "That photo isn't available to read. Try re-attaching it, or type the description yourself."
        );
      } else {
        setError(
          "Couldn't draft from the photo just now. Try again, or just type it below."
        );
        setRetryable(true);
      }
    } catch (e) {
      if (isTimeoutError(e)) {
        setError(
          "That took too long. Try again, or just type the description below."
        );
      } else {
        setError(
          "Couldn't draft from the photo just now. Try again, or just type it below."
        );
      }
      setRetryable(true);
    } finally {
      progress.finish();
      setDrafting(false);
    }
  }

  return (
    <div>
      {/* Not labeled optional: postJobAction enforces a 20-character floor
          on the description for a standalone post (a post linked to an
          issue can fall back to the issue's own description). minLength
          surfaces that floor in the browser before the action rejects it. */}
      <div className="flex items-center justify-between gap-2">
        <label className="label" htmlFor="job-details">
          Details about your project
        </label>
        {/* Mounted for as long as a photo is attached (a deliberate, rare
            action), never unmounted just because handTyped flips mid-typing.
            Typing only toggles `invisible` + disabled, so this row can never
            change height while the owner is typing and about to tap Post -
            see the comment on PostJobButton's check() for why that matters. */}
        {photoUrl && (
          <button
            type="button"
            onClick={draftFromPhoto}
            disabled={drafting || handTyped}
            aria-hidden={handTyped}
            tabIndex={handTyped ? -1 : 0}
            className={`shrink-0 text-xs font-medium text-bark-700 hover:underline disabled:opacity-60 dark:text-stone-300 ${
              handTyped ? "invisible pointer-events-none" : ""
            }`}
          >
            {drafting ? "Drafting…" : "Draft it for me from the photo"}
          </button>
        )}
      </div>
      <textarea
        name="message"
        id="job-details"
        className="textarea"
        rows={3}
        minLength={20}
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          setHandTyped(true);
        }}
        placeholder="What needs doing?"
      />
      {drafting && (
        <ProgressBar
          className="mt-2"
          value={progress.value}
          stages={DRAFT_STAGES}
          stageIndex={progress.stageIndex}
          ariaLabel="Drafting a description from your photo"
        />
      )}
      {error && (
        <div className="mt-1">
          <p role="alert" className="text-xs font-medium text-red-600 dark:text-red-400">
            {error}
          </p>
          {/* Manual retry only: refires the same call, never automatically,
              and only while a photo is still attached and untyped (offerDraft).
              Disabled during a pending attempt via the shared `drafting` flag. */}
          {retryable && offerDraft && (
            <button
              type="button"
              onClick={draftFromPhoto}
              disabled={drafting}
              className="mt-1 text-xs font-medium text-bark-700 hover:underline disabled:opacity-60 dark:text-stone-300"
            >
              {drafting ? "Trying again…" : "Try again"}
            </button>
          )}
        </div>
      )}
      <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
        A sentence or two helps pros quote accurately (20 characters minimum).
        {/* Same stability rule as the header button above: mounted whenever a
            photo is attached, so this line's height is reserved for the
            whole time a photo could be drafted from, and typing (handTyped)
            only toggles invisible instead of removing the text. Removing it
            outright on the first keystroke is what used to make this
            paragraph drop from two lines to one right as the owner kept
            typing, shifting the strong-post meter and Post button up from
            under a tap that started on the button (see PostJobButton). */}
        {photoUrl && (
          <span className={handTyped ? "invisible" : ""} aria-hidden={handTyped}>
            {" "}Or let Hearth draft it from your photo, then edit.
          </span>
        )}
      </p>
    </div>
  );
}
