"use client";

import Link from "next/link";
import SubmitButton from "@/components/SubmitButton";
import Honeypot from "@/components/Honeypot";
import { sendProSupportMessageAction } from "./actions";

// The in-app contact form for pros. Name, email and phone are prefilled from
// the company record so there is nothing to type, but they are real editable
// fields now: the details on file are often a business line or an Apple
// private-relay address, and support needs to be able to reply where the pro
// actually reads mail. The action still falls back to the company record when
// a field is cleared.
//
// `sent` comes from page.tsx reading ?sent=1, which sendProSupportMessageAction
// (./actions.ts) adds to its post-success redirect. When true, this swaps the
// form for a confirmation card instead of leaving a blank form up with only a
// toast to say anything happened. "Send another" links back to the plain path
// so a pro with a follow-up question is one tap from a fresh form.
export default function ProSupportForm({
  member,
  name,
  email,
  phone,
  sent = false,
}: {
  member: boolean;
  name: string;
  email: string;
  phone: string;
  sent?: boolean;
}) {
  if (sent) {
    return (
      <div className="rounded-2xl border border-stone-200 bg-white p-6 shadow-sm dark:border-white/10 dark:bg-stone-800">
        <h2 className="text-base font-semibold text-stone-900 dark:text-stone-100">
          Message sent
        </h2>
        <p className="mt-1 text-sm text-stone-600 dark:text-stone-300">
          Thanks - we got your message. We&apos;ll reply by email or phone.
        </p>
        <div className="mt-4 flex flex-col gap-3 sm:flex-row">
          <Link href="/pro" className="btn-primary text-center">
            Find jobs
          </Link>
          <Link href="/pro/help" className="btn-secondary text-center">
            Send another
          </Link>
        </div>
      </div>
    );
  }

  return (
    <form
      action={sendProSupportMessageAction}
      className="rounded-2xl border border-stone-200 bg-white p-6 shadow-sm dark:border-white/10 dark:bg-stone-800"
    >
      <h2 className="text-base font-semibold text-stone-900 dark:text-stone-100">
        Contact support
      </h2>
      <p className="mt-1 text-sm text-stone-600 dark:text-stone-300">
        Send us a message and we will get back to you. Your details are
        prefilled from your company profile, change them if you would rather we
        replied somewhere else.
      </p>

      {/* Same honeypot as the public /contact form and the homeowner help
          form: this writes to the same support_messages table, so it gets the
          same defense rather than being the one form that skips it. */}
      <Honeypot />

      {member && (
        <p className="mt-3 inline-block rounded-full border border-hearth-200 bg-hearth-50 px-3 py-1 text-xs font-medium text-hearth-800 dark:border-hearth-800 dark:bg-hearth-900/40 dark:text-hearth-200">
          Priority support: Pro members go to the front of the line.
        </p>
      )}

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div>
          <label className="label">Name</label>
          <input
            name="name"
            defaultValue={name}
            className="input"
            maxLength={200}
          />
        </div>
        <div>
          <label className="label">Email</label>
          <input
            name="email"
            type="email"
            defaultValue={email}
            className="input"
            maxLength={254}
          />
        </div>
        <div>
          <label className="label">Phone</label>
          <input
            name="phone"
            defaultValue={phone}
            className="input"
            maxLength={40}
          />
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
        <SubmitButton pendingLabel="Sending…">Send message</SubmitButton>
      </div>
    </form>
  );
}
