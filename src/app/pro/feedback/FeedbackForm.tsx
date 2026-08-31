"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import InlineSpinner from "@/components/InlineSpinner";
import { submitProFeedbackAction } from "./actions";
import {
  FEEDBACK_MIN_MESSAGE,
  FEEDBACK_MAX_MESSAGE,
  FEEDBACK_SCORE_LABELS,
  FEEDBACK_DEAL_NOTE,
  FEEDBACK_REPEAT_NOTE,
  FEEDBACK_LOCKED_NOTE,
  FEEDBACK_CREDITED_NOTE,
  FEEDBACK_THANKS_NOTE,
  validateFeedback,
  FEEDBACK_ERROR_COPY,
  type FeedbackOutcome,
} from "@/lib/proFeedback";

// The bug-report form. Client-side because the action returns an ActionResult
// rather than redirecting: a refused submit has to keep the note the pro just
// typed on screen, and the success state has to say which of the three things
// happened (credited now, credit waiting on qualification, or a plain thanks
// for a later report).
export default function FeedbackForm({
  established,
  claimed,
}: {
  // Whether this pro's business already qualifies for the credit. Decides one
  // line of copy before the tap; the server re-checks it and is the authority.
  established: boolean;
  // Whether the $5 was already collected. Decides whether the deal or the
  // no-more-automatic-pay note shows above the form; the server re-checks.
  claimed: boolean;
}) {
  const [score, setScore] = useState<number | null>(null);
  const [message, setMessage] = useState("");
  const [contactOk, setContactOk] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<FeedbackOutcome | null>(null);
  const [pending, startTransition] = useTransition();

  const trimmed = message.trim();
  const short = trimmed.length < FEEDBACK_MIN_MESSAGE;

  // The deal, stated before the tap: first report pays instantly (established),
  // pays on qualification (not yet established), or already paid (claimed).
  const dealNote = claimed
    ? FEEDBACK_REPEAT_NOTE
    : established
      ? FEEDBACK_DEAL_NOTE
      : FEEDBACK_LOCKED_NOTE;

  function submit() {
    setError(null);
    const problem = validateFeedback({ score: Number(score), message });
    if (problem) {
      setError(FEEDBACK_ERROR_COPY[problem]);
      return;
    }
    startTransition(async () => {
      const res = await submitProFeedbackAction({
        score: Number(score),
        message: trimmed,
        contactOk,
      });
      if (res.ok) setDone(res.data?.outcome ?? "thanks");
      else setError(res.error);
    });
  }

  if (done) {
    return (
      <div className="card space-y-3">
        <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
          {done === "thanks"
            ? FEEDBACK_THANKS_NOTE
            : "Thank you. This helps us build the right things."}
        </h2>
        <p className="text-sm text-stone-600 dark:text-stone-300">
          {done === "credited"
            ? FEEDBACK_CREDITED_NOTE
            : done === "locked"
              ? FEEDBACK_LOCKED_NOTE
              : // A later report: warm, and quiet about money on purpose. The
                // deal above the form already said later reports do not pay on
                // their own.
                "If we need more detail, and you said we could contact you, we will reach out."}
        </p>
        <div className="flex flex-wrap gap-2">
          <Link href="/pro" className="btn-primary">
            Back to Home
          </Link>
          {done === "credited" && (
            <Link href="/pro/billing" className="btn-secondary">
              See my wallet
            </Link>
          )}
          <button
            type="button"
            className="btn-secondary"
            onClick={() => {
              // Fresh form for the next report; the deal copy the server
              // re-renders on a full visit is claimed-aware, and after a
              // credited submit the honest note is the repeat one, so nobody
              // expects a second $5.
              setDone(null);
              setScore(null);
              setMessage("");
              setContactOk(false);
              setError(null);
            }}
          >
            Report another bug
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="card space-y-5">
      <p className="text-sm text-stone-600 dark:text-stone-300">{dealNote}</p>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium text-stone-900 dark:text-stone-100">
          How is Hearth working for you?
        </legend>
        {/* Numbers with words: nobody should have to guess whether 1 is good
            or bad. Five buttons across at 390px, each a real tap target. */}
        <div className="grid grid-cols-5 gap-1.5">
          {FEEDBACK_SCORE_LABELS.map((o) => (
            <button
              key={o.value}
              type="button"
              onClick={() => setScore(o.value)}
              aria-pressed={score === o.value}
              className={`flex min-h-[3.5rem] flex-col items-center justify-center rounded-lg border px-1 py-2 text-center transition-colors ${
                score === o.value
                  ? "border-hearth-600 bg-hearth-50 text-hearth-800 dark:border-hearth-500 dark:bg-hearth-500/15 dark:text-hearth-200"
                  : "border-stone-200 text-stone-600 hover:border-stone-300 dark:border-white/10 dark:text-stone-300"
              }`}
            >
              <span className="text-base font-semibold">{o.value}</span>
              <span className="text-xs leading-tight">{o.label}</span>
            </button>
          ))}
        </div>
      </fieldset>

      <div className="space-y-1">
        <label
          htmlFor="pro-feedback-message"
          className="label"
        >
          What happened, or what should we build?
        </label>
        <textarea
          id="pro-feedback-message"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          rows={5}
          maxLength={FEEDBACK_MAX_MESSAGE}
          placeholder="What broke, where it happened, and what you expected instead."
          // 16px on a phone or iOS zooms the page on focus.
          className="input max-sm:text-base"
        />
        {/* The floor is stated in front of the button, never as a surprise
            on submit. */}
        <p className="text-xs text-stone-500 dark:text-stone-400">
          {short
            ? `${FEEDBACK_MIN_MESSAGE - trimmed.length} more character${
                FEEDBACK_MIN_MESSAGE - trimmed.length === 1 ? "" : "s"
              } to go.`
            : `${trimmed.length} of ${FEEDBACK_MAX_MESSAGE} characters.`}
        </p>
      </div>

      <label className="flex min-h-11 items-start gap-2">
        <input
          type="checkbox"
          checked={contactOk}
          onChange={(e) => setContactOk(e.target.checked)}
          className="mt-1 h-6 w-6 shrink-0 rounded border-stone-300 text-hearth-600 focus:ring-hearth-600 dark:border-white/20"
        />
        <span className="text-sm text-stone-600 dark:text-stone-300">
          You can contact me about this.
        </span>
      </label>

      {error && (
        <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
      )}

      <button
        type="button"
        onClick={submit}
        disabled={pending}
        className="btn-primary w-full"
      >
        {pending && <InlineSpinner />}
        Send it
      </button>
    </div>
  );
}
