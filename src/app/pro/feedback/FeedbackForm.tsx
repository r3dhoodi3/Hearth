"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import InlineSpinner from "@/components/InlineSpinner";
import { submitProFeedbackAction } from "./actions";
import {
  FEEDBACK_MIN_MESSAGE,
  FEEDBACK_MAX_MESSAGE,
  FEEDBACK_SCORE_LABELS,
  FEEDBACK_PENDING_NOTE,
  validateFeedback,
  FEEDBACK_ERROR_COPY,
} from "@/lib/proFeedback";

// The bug-report form. Client-side because the action returns an ActionResult
// rather than redirecting: a refused submit has to keep the note the pro just
// typed on screen.
//
// C7 (2026-09-07): there is only one outcome now. Every report is stored
// pending review; FEEDBACK_PENDING_NOTE says so both before the tap (sets the
// expectation) and after (confirms it). No props here decide money any more -
// that is a human decision made outside the app (verify_pro_feedback, 0157),
// never something this screen can promise.
export default function FeedbackForm() {
  const [score, setScore] = useState<number | null>(null);
  const [message, setMessage] = useState("");
  const [contactOk, setContactOk] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [pending, startTransition] = useTransition();

  const trimmed = message.trim();
  const short = trimmed.length < FEEDBACK_MIN_MESSAGE;

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
      if (res.ok) setDone(true);
      else setError(res.error);
    });
  }

  if (done) {
    return (
      <div className="card space-y-3">
        <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
          {FEEDBACK_PENDING_NOTE}
        </h2>
        <p className="text-sm text-stone-600 dark:text-stone-300">
          If we need more detail, and you said we could contact you, we will
          reach out.
        </p>
        <div className="flex flex-wrap gap-2">
          <Link href="/pro" className="btn-primary">
            Back to Home
          </Link>
          <button
            type="button"
            className="btn-secondary"
            onClick={() => {
              setDone(false);
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
      <p className="text-sm text-stone-600 dark:text-stone-300">
        {FEEDBACK_PENDING_NOTE}
      </p>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium text-stone-900 dark:text-stone-100">
          How is OakTend working for you?
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
                  ? "border-oaktend-600 bg-oaktend-50 text-oaktend-800 dark:border-oaktend-500 dark:bg-oaktend-500/15 dark:text-oaktend-200"
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
          className="mt-1 h-6 w-6 shrink-0 rounded border-stone-300 text-oaktend-600 focus:ring-oaktend-600 dark:border-white/20"
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
