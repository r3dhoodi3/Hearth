"use client";

import { useEffect, useRef, useState } from "react";
import { useFormStatus } from "react-dom";

// Both armed-state buttons, split into their own component because
// useFormStatus only reports the status of the nearest enclosing <form> and
// must be called from a component rendered inside it, not from ConfirmSubmit
// itself (which is the same component tree but the hook still needs its own
// function component below the <form> boundary). Rendering Yes AND Cancel
// from here, sharing one hook call, is what lets Cancel disable while
// pending too: without that, tapping Yes then Cancel makes the UI snap back
// to idle while the server action (cancel membership, remove a household
// member, delete a client...) is still running underneath - a lie about
// what's actually happening.
function ConfirmSubmitButtons({
  yesLabel,
  onCancel,
}: {
  yesLabel: string;
  onCancel: () => void;
}) {
  const { pending } = useFormStatus();
  // Same synchronous double-submit guard as SubmitButton.tsx: `pending` lags
  // a click by a render, so two fast taps on "Yes" both read pending as false
  // and both submit (a plan switch or a cancellation fired twice). The ref
  // flips on the first click, before React re-renders, and resets once
  // pending drops back to false so a failed submit can be retried.
  const submittedRef = useRef(false);

  useEffect(() => {
    if (!pending) submittedRef.current = false;
  }, [pending]);

  function handleYesClick(e: React.MouseEvent<HTMLButtonElement>) {
    if (submittedRef.current) {
      e.preventDefault();
      return;
    }
    // Only latch when a submit will actually start. A form that fails the
    // browser's own constraint validation (required, minLength, type=email)
    // never runs the action, so `pending` never flips and the effect above
    // would never release the latch: the button would be dead until reload.
    const form = e.currentTarget.form;
    if (form && !form.noValidate && !form.checkValidity()) return;
    submittedRef.current = true;
  }

  return (
    <>
      <button
        type="submit"
        className="btn-primary"
        disabled={pending}
        onClick={handleYesClick}
      >
        {pending ? `${yesLabel}…` : yesLabel}
      </button>
      <button
        type="button"
        onClick={onCancel}
        className="btn-secondary"
        disabled={pending}
      >
        Cancel
      </button>
    </>
  );
}

// A two-step submit for the Change plan forms: the first tap arms it, then a
// small inline "Are you sure?" with Yes/Cancel actually submits. Keeps a plan
// switch (which bills or reschedules billing) from firing on a stray click,
// without a jarring browser popup. Shared by the homeowner /plus and pro
// /pro/plus billing cards so the two confirm flows can't drift apart.
export default function ConfirmSubmit({
  label,
  note,
  yesLabel,
  subtle,
}: {
  label: string;
  // One short line restating what will happen, shown while armed.
  note: string;
  yesLabel: string;
  // Renders the idle state as quiet text instead of a button, for actions that
  // should be findable but not promoted (e.g. cancel membership).
  subtle?: boolean;
}) {
  const [armed, setArmed] = useState(false);

  if (!armed) {
    return (
      <button
        type="button"
        onClick={() => setArmed(true)}
        className={
          subtle
            ? "text-xs text-stone-500 underline-offset-2 hover:text-stone-600 hover:underline dark:text-stone-400 dark:hover:text-stone-300"
            : "btn-secondary"
        }
      >
        {label}
      </button>
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-sm text-stone-600 dark:text-stone-300">{note}</p>
      <div className="flex items-center justify-center gap-2">
        <ConfirmSubmitButtons yesLabel={yesLabel} onCancel={() => setArmed(false)} />
      </div>
    </div>
  );
}
