"use client";

import Link from "next/link";
import SubmitButton from "@/components/SubmitButton";
import Honeypot from "@/components/Honeypot";
import { saveSupportMessageAction } from "./actions";

// The in-app contact form. Name, email, and phone are prefilled from the
// account so the homeowner rarely has to type them, and they tell us how they
// would prefer to be reached.
//
// `sent` comes from page.tsx reading ?sent=1, which saveSupportMessageAction
// (./actions.ts) adds to its redirect on a successful send. When true, this
// swaps the form for a confirmation card rather than leaving a blank form on
// screen with only a toast (easy to miss, and gone in a few seconds) to say
// anything happened. "Send another" links back to the plain path so a
// homeowner who forgot to attach something, or has a second question, is one
// tap from a fresh form instead of stuck on the card.
export default function SupportForm({
  name,
  email,
  phone,
  sent = false,
}: {
  name: string;
  email: string;
  phone: string;
  sent?: boolean;
}) {
  if (sent) {
    return (
      <div className="card">
        <h2 className="text-base font-semibold text-stone-900 dark:text-stone-100">
          Message sent
        </h2>
        <p className="mt-1 text-sm text-stone-600 dark:text-stone-300">
          Thanks - we got your message. We&apos;ll reply by email or phone.
        </p>
        <div className="mt-4 flex flex-col gap-3 sm:flex-row">
          <Link href="/dashboard" className="btn-primary text-center">
            Back to my dashboard
          </Link>
          <Link href="/account/help" className="btn-secondary text-center">
            Send another
          </Link>
        </div>
      </div>
    );
  }

  return (
    <form action={saveSupportMessageAction} className="card">
      <h2 className="text-base font-semibold text-stone-900 dark:text-stone-100">Contact us</h2>
      <p className="mt-1 text-sm text-stone-600 dark:text-stone-300">
        Send us a message and we will get back to you.
      </p>

      {/* The same honeypot the public /contact form has had. This form is
          behind a session, so auth and the per-user rate limit are the real
          defense - but it writes to the same support_messages table that the
          same people read, and a scripted POST from a signed-in session hits
          exactly this endpoint. One form in the app defended differently from
          another is how the difference gets forgotten. */}
      <Honeypot />

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div>
          <label className="label">Name</label>
          <input name="name" defaultValue={name} className="input" />
        </div>
        <div>
          <label className="label">Email</label>
          <input
            name="email"
            type="email"
            defaultValue={email}
            className="input"
          />
        </div>
        <div>
          <label className="label">Phone</label>
          <input name="phone" defaultValue={phone} className="input" />
        </div>
      </div>

      <div className="mt-4">
        <label className="label">How can we help?</label>
        <textarea
          name="message"
          rows={4}
          required
          className="input"
          placeholder="Tell us what is going on."
        />
      </div>

      <div className="mt-4">
        <SubmitButton>Send message</SubmitButton>
      </div>
    </form>
  );
}
