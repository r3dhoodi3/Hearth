"use client";

import { useEffect, useRef } from "react";
import { useFormStatus } from "react-dom";

// A form submit button that disables itself and shows a pending label while the
// server action is in flight, so a homeowner can't double-submit (e.g. log the
// same issue twice). Must be rendered INSIDE the <form> it submits.
export default function SubmitButton({
  children,
  pendingLabel,
  className = "btn-primary flex-1",
  disabled = false,
}: {
  children: React.ReactNode;
  pendingLabel?: string;
  className?: string;
  // Optional caller-driven disable (e.g. "nothing changed to submit"), ORed
  // with the in-flight pending state. Defaults to false, so existing callers
  // are unaffected.
  disabled?: boolean;
}) {
  const { pending } = useFormStatus();
  // Synchronous double-submit guard. `pending` is state: it lands a render
  // behind the click, so two clicks in the same tick (a fast double tap) both
  // still read `pending` as false and both reach the native submit -
  // confirmed live on the pro profile's Save Changes button. This ref flips
  // the instant the FIRST click happens, before React re-renders, so the
  // second click can see it and stop that submit before it starts.
  const submittedRef = useRef(false);

  useEffect(() => {
    // Release the latch once the action is no longer in flight, whether it
    // succeeded or failed, so a failed submit can be retried with another
    // click. Only the pending -> not-pending edge resets it: never while
    // still pending, or a stray extra render mid-flight would let a second
    // click through while the first submit is still running.
    if (!pending) submittedRef.current = false;
  }, [pending]);

  function handleClick(e: React.MouseEvent<HTMLButtonElement>) {
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
    <button
      type="submit"
      disabled={pending || disabled}
      className={className}
      onClick={handleClick}
    >
      {pending ? pendingLabel ?? "Saving…" : children}
    </button>
  );
}
