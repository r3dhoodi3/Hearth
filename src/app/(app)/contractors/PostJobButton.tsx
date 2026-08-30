"use client";

import { useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import { COLD_START_FREE_POSTING } from "@/lib/constants";
import { markPushMoment } from "@/lib/pushPrompt";

// The same 20-character floor postJobAction enforces on the server. Catching it
// here first means a too-short post never submits, so the form (and any photos
// already uploaded into its hidden inputs) is never wiped by the server-side
// redirect that drops the POST body.
const MIN_DESCRIPTION = 20;

// Submit button for the post-a-job form. Disables itself while the action is in
// flight so a double-click can't post the same job twice, and blocks submit
// with an inline message when the description is too short (mirroring the
// server), so nothing the homeowner typed or uploaded gets lost.
//
// IMPORTANT - the form region above this button (DescriptionField,
// StrongPostMeter) must never change height while the description textarea
// is focused. A tap on this button first fires mousedown/touchstart at the
// button's on-screen position, then blurs the textarea (which had focus),
// then fires mouseup/click at that SAME position. If anything above this
// button grows or shrinks in that window, the button's screen position
// moves and mouseup lands on whatever slid into its place instead - the
// browser then dispatches click to the nearest common ancestor (the form),
// and this onClick handler never runs. That's exactly what used to happen:
// DescriptionField conditionally mounted/unmounted a helper sentence based
// on whether the owner had typed by hand, which could add or remove a
// wrapped line right as they tapped Post. The fix lives in DescriptionField
// (keep the helper mounted, toggle `invisible` instead of unmounting) -
// don't "fix" this by switching to pointerdown-based submission; that
// papers over layout instability instead of removing it.
export default function PostJobButton({
  // The reason the LAST attempt was rejected, if there was one. postJobAction
  // sends every failure back to /contractors with the typed values plus an
  // ?error= code (see postJobErrors.ts), and the page turns that code into
  // this sentence. Rendered in the same slot as the client-side check below,
  // so a rejected post always says something right where the owner is looking
  // instead of silently resetting the form.
  serverError = null,
}: {
  serverError?: string | null;
}) {
  const { pending } = useFormStatus();
  const [error, setError] = useState<string | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  // While a submit is actually in flight, the server's message is about the
  // PREVIOUS attempt, so it is hidden for exactly that long. It must NOT be
  // suppressed by a latch that a passing submit sets once and never clears:
  // the failure path is a redirect back to /contractors?...&error=..., which
  // re-renders this same component with a NEW serverError prop, and a latched
  // "the server message is stale" flag would swallow the very message the
  // owner is waiting for. (The form's key is ?posted=, which does not change
  // on a failure redirect, so the component is updated, not remounted.)
  const shownError = error ?? (pending ? null : serverError);

  function check(e: React.MouseEvent<HTMLButtonElement>) {
    const form = btnRef.current?.closest("form");
    if (!form) return;
    const box = form.elements.namedItem(
      "message"
    ) as HTMLTextAreaElement | null;
    const msg = (box?.value ?? "").trim();
    const issueId =
      (form.elements.namedItem("issue_id") as HTMLInputElement | null)?.value ??
      "";

    // Mirror postJobAction exactly: a standalone post needs 20+ characters; a
    // post linked to an issue can fall back to that issue's own description
    // only when the box is left blank, so a blank-but-linked post is allowed
    // while a short (non-empty) one is not.
    const tooShort =
      msg.length < MIN_DESCRIPTION && !(issueId.length > 0 && msg.length === 0);

    if (tooShort) {
      e.preventDefault();
      setError(
        "Please describe the job in at least 20 characters so pros know what they're applying to."
      );
      box?.focus();
      return;
    }
    setError(null);
    // Posting a job is the moment the push offer makes sense: pros are about to
    // reply and the homeowner will want to know when they do. Stamped here
    // rather than after the redirect because postJobAction redirects away and
    // there is no client callback on the far side. See src/lib/pushPrompt.ts -
    // the stamp is only good for two minutes and the card still has to pass its
    // own once-per-14-days gate.
    markPushMoment();
  }

  return (
    <div className="space-y-2">
      {shownError && (
        <p role="alert" className="text-sm font-medium text-red-600 dark:text-red-400">
          {shownError}
        </p>
      )}
      <button
        ref={btnRef}
        onClick={check}
        className="btn-primary w-full"
        disabled={pending}
      >
        {pending ? "Posting…" : "Post job"}
      </button>
      {/* COLD START: while COLD_START_FREE_POSTING is on there is no posting
          cap for anyone, member or not. Saying so here, once and quietly, is
          the honest version of the moment - and it names the reason (a launch
          window), so nobody later feels a cap appeared out of nowhere. The
          line disappears with the flag. */}
      {COLD_START_FREE_POSTING && (
        <p className="text-xs text-stone-500 dark:text-stone-400">
          Job posting is free while we launch in your area.
        </p>
      )}
    </div>
  );
}
