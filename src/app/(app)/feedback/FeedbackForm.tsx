"use client";

import { useState } from "react";
import SubmitButton from "@/components/SubmitButton";
import { submitFeedbackAction } from "./actions";

// The private form the "Not really" button on the review prompt (see
// src/components/ReviewPrompt.tsx) routes to instead of the app store. Never
// linked from anywhere public - this goes straight into app_feedback
// (migration 0133), which nobody but the service role can read back, ever.
//
// Split out of page.tsx so the page itself can be a server component and read
// the signed-in account's email for the prefill below. Everything here is the
// same markup and state it had as the page.
export default function FeedbackForm({ defaultEmail }: { defaultEmail: string }) {
  // Off by default: most people who land here just want to say what's wrong,
  // not hand over their email. The input only exists in the DOM once this is
  // on, so a server action that never sees a "contact_email" field already
  // knows the answer was no.
  const [wantsContact, setWantsContact] = useState(false);

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-stone-900 dark:text-stone-100">
          Feedback
        </h1>
        <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">
          Tell us what would make it better. This goes straight to us, not to
          the store.
        </p>
      </div>

      <form action={submitFeedbackAction} className="card p-6">
        <label className="label" htmlFor="message">
          What could be better?
        </label>
        <textarea
          id="message"
          name="message"
          rows={5}
          required
          className="input"
          placeholder="Tell us what's not working, or what you wish Hearth did."
        />

        {/* min-h-11: the whole row is the tap target, at least 44px tall. */}
        <label className="mt-4 flex min-h-11 cursor-pointer items-center gap-3">
          <input
            type="checkbox"
            checked={wantsContact}
            onChange={(e) => setWantsContact(e.target.checked)}
            className="h-5 w-5 shrink-0 cursor-pointer accent-bark-600 rounded border-stone-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-bark-600 dark:border-white/20"
          />
          <span className="text-sm text-stone-700 dark:text-stone-300">
            You can email me back about this
          </span>
        </label>

        {wantsContact && (
          <div className="mt-3">
            <label className="label" htmlFor="contact_email">
              Email
            </label>
            <input
              id="contact_email"
              name="contact_email"
              type="email"
              // Prefilled from the account so nobody retypes an address we
              // already have. defaultValue, not value: someone who wants a
              // reply at a different address can still change it.
              defaultValue={defaultEmail}
              className="input"
              placeholder="you@example.com"
            />
          </div>
        )}

        <div className="mt-5">
          <SubmitButton pendingLabel="Sending…">Send</SubmitButton>
        </div>
      </form>
    </div>
  );
}
