"use client";

import { useState } from "react";
import SubmitButton from "@/components/SubmitButton";
import { sendContactMessageAction } from "./actions";

// Public contact form: no login required, so it needs its own spam defenses
// (a signed-in form, like account/help/SupportForm.tsx, gets those for free
// from requiring a session). Two of the three live here; the third, IP rate
// limiting, lives server-side in ./actions.ts where it can't be bypassed by
// skipping the client.
export default function ContactForm({ topic }: { topic: string | null }) {
  // A validation error stays on this page, so it comes back as an ActionResult
  // rendered inline here rather than through the flash cookie (which the root
  // layout only reads on a fresh GET, i.e. after a redirect). On the success
  // path the action redirects, so control never returns and `res` is undefined.
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      action={async (fd) => {
        setError(null);
        const res = await sendContactMessageAction(fd);
        if (res && !res.ok) setError(res.error);
      }}
      className="card"
    >
      {topic && (
        <>
          <p className="mb-4 text-sm text-stone-500 dark:text-stone-400">
            Regarding:{" "}
            <span className="font-medium text-stone-700 dark:text-stone-300">
              {topic}
            </span>
          </p>
          {/* Carried into the stored message as a one-line prefix, so a
              safety report reaches the inbox already labelled instead of
              arriving as an unexplained message. The action re-caps it; it is
              display text either way and is never used to decide anything. */}
          <input type="hidden" name="topic" value={topic} />
        </>
      )}

      {/* Honeypot. A real visitor never sees or reaches this field: it sits
          off-screen (not display:none - some bots specifically skip
          display:none fields to evade that trick) and is skipped by keyboard
          tabbing. A script that fills every input in the form fills this one
          too. See ./actions.ts for what happens when it's non-empty. */}
      <div
        aria-hidden="true"
        style={{
          position: "absolute",
          left: "-9999px",
          width: 1,
          height: 1,
          overflow: "hidden",
        }}
      >
        <label htmlFor="company_website">Leave this field blank</label>
        <input
          type="text"
          id="company_website"
          name="company_website"
          tabIndex={-1}
          autoComplete="off"
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className="label">Name</label>
          <input name="name" className="input" maxLength={200} />
        </div>
        <div>
          <label className="label">Email</label>
          <input name="email" type="email" className="input" maxLength={254} />
        </div>
      </div>

      <div className="mt-4">
        <label className="label">Phone</label>
        <input name="phone" className="input" maxLength={40} />
      </div>
      <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
        Add an email or a phone number so we know how to reply.
      </p>

      <div className="mt-4">
        <label className="label">Message</label>
        <textarea
          name="message"
          rows={5}
          required
          minLength={10}
          maxLength={5000}
          className="input"
          placeholder="What can we help with?"
        />
      </div>

      {error && (
        <p role="alert" className="mt-4 text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}

      <div className="mt-4">
        <SubmitButton>Send message</SubmitButton>
      </div>
    </form>
  );
}
