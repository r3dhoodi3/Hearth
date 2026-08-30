"use client";

import { useState } from "react";
import SubmitButton from "@/components/SubmitButton";
import Honeypot from "@/components/Honeypot";
import { sendContactMessageAction } from "./actions";

// Public contact form: no login required, so it needs its own spam defenses
// (a signed-in form, like account/help/SupportForm.tsx, gets those for free
// from requiring a session). Two of the three live here; the third, IP rate
// limiting, lives server-side in ./actions.ts where it can't be bypassed by
// skipping the client.
//
// Name / email / phone are prefilled when the visitor happens to be signed in
// (the page reads the session and passes them down), so a member who follows a
// legal-page link here does not retype what we already know.
//
// EVERY FIELD IS CONTROLLED, and that is load bearing rather than a style
// choice. React 19 RESETS a form automatically once the function passed to
// <form action> has finished - on the error return just as much as on success.
// With uncontrolled fields (defaultValue) that meant a visitor who wrote three
// paragraphs, forgot their email address and got "Please add an email or a
// phone number" back had the whole message wiped by the very submit that
// produced the message: verified live and locally on 2026-08-30, all four
// fields empty next to the error. React re-renders a controlled input from
// state straight after that reset, so holding the values here is what makes
// the reset a no-op and keeps what somebody typed on screen while they fix
// whatever the server complained about.
export default function ContactForm({
  topic,
  // Empty strings for a signed-out visitor, which is the common case here.
  // Seeds for the state below, not fixed values: a prefilled field must still
  // be editable (the account email is often not the one someone wants a reply
  // at).
  name = "",
  email = "",
  phone = "",
}: {
  topic: string | null;
  name?: string;
  email?: string;
  phone?: string;
}) {
  // A validation error stays on this page, so it comes back as an ActionResult
  // rendered inline here rather than through the flash cookie (which the root
  // layout only reads on a fresh GET, i.e. after a redirect). On the success
  // path the action redirects, so control never returns and `res` is undefined.
  const [error, setError] = useState<string | null>(null);
  const [nameValue, setNameValue] = useState(name);
  const [emailValue, setEmailValue] = useState(email);
  const [phoneValue, setPhoneValue] = useState(phone);
  const [messageValue, setMessageValue] = useState("");
  return (
    <form
      action={async (fd) => {
        setError(null);
        try {
          const res = await sendContactMessageAction(fd);
          if (res && !res.ok) setError(res.error);
        } catch (err) {
          // Same trap as OnboardingForm's onClaim (src/app/onboarding/
          // OnboardingForm.tsx): the SUCCESS path leaves this action by
          // redirect(), which reaches the browser as a thrown error carrying a
          // NEXT_REDIRECT digest. Swallowing that would report a sent message
          // as a failure and strand the visitor on this page, so it is
          // rethrown for the router to act on.
          //
          // Anything else is the request itself not landing - offline, a
          // dropped connection, a 500 from the action endpoint. Without this
          // catch the rejected promise reached the nearest error boundary and
          // replaced the entire page with the generic "Something went sideways"
          // screen, taking the typed message with it. An inline message keeps
          // the visitor on their own words and one click from retrying.
          if (
            typeof (err as { digest?: unknown })?.digest === "string" &&
            (err as { digest: string }).digest.startsWith("NEXT_REDIRECT")
          ) {
            throw err;
          }
          setError("Something went wrong. Please try again.");
        }
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

      {/* Honeypot. Lifted into src/components/Honeypot.tsx when the two in-app
          help forms got the same field, so the name and the markup cannot
          drift between the three forms that write to support_messages. See
          ./actions.ts for what happens when it comes back non-empty.
          Deliberately NOT controlled: a real visitor never touches it, and
          restoring it after a reset is the one thing we would not want. */}
      <Honeypot />

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className="label">Name</label>
          <input
            name="name"
            value={nameValue}
            onChange={(e) => setNameValue(e.target.value)}
            className="input"
            maxLength={200}
          />
        </div>
        <div>
          <label className="label">Email</label>
          <input
            name="email"
            type="email"
            value={emailValue}
            onChange={(e) => setEmailValue(e.target.value)}
            className="input"
            maxLength={254}
          />
        </div>
      </div>

      <div className="mt-4">
        <label className="label">Phone</label>
        <input
          name="phone"
          value={phoneValue}
          onChange={(e) => setPhoneValue(e.target.value)}
          className="input"
          maxLength={40}
        />
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
          value={messageValue}
          onChange={(e) => setMessageValue(e.target.value)}
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
