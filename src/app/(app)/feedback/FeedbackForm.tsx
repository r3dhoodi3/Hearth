"use client";

import { useState } from "react";
import SubmitButton from "@/components/SubmitButton";
import { submitFeedbackAction } from "./actions";

// The homeowner side's bug-report page. Two doors lead here: the "Found a
// bug?" card on /account/help, and the "Not really" button on the review
// prompt (see src/components/ReviewPrompt.tsx), which routes here instead of
// the app store - so the copy welcomes both a broken button and a plain
// gripe. Everything goes straight into app_feedback (migration 0133), which
// nobody but the service role can read back, ever.
//
// NO credit language here, on purpose: Hearth has no homeowner wallet or
// credit to pay a bounty out of (the $5 first-report credit is a pro-side
// thing, src/lib/proFeedback.ts), so promising one would be a bug of its own.
//
// Split out of page.tsx so the page itself can be a server component and read
// the signed-in account's email for the prefill below.
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
          Report a bug
        </h1>
        <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">
          A button that does nothing, a number that is wrong, a page that will
          not load: tell us here. Ideas and complaints count too. This goes
          straight to us, not to the store, and a real person reads every
          report.
        </p>
      </div>

      <form action={submitFeedbackAction} className="card p-6">
        <label className="label" htmlFor="message">
          What happened, or what could be better?
        </label>
        <textarea
          id="message"
          name="message"
          rows={5}
          required
          className="input"
          placeholder="What broke, where it happened, and what you expected instead."
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
