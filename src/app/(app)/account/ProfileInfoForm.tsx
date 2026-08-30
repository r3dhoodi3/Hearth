"use client";

import Link from "next/link";
import { useFormStatus } from "react-dom";
import { saveAccountAction } from "./actions";
import PhoneInput from "@/components/PhoneInput";
import InlineSpinner from "@/components/InlineSpinner";
import type { UserProfile } from "@/lib/database.types";

function FieldIcon({ children }: { children: React.ReactNode }) {
  return (
    <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-stone-500 dark:text-stone-400">
      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        {children}
      </svg>
    </span>
  );
}

// Local submit button (not the shared SubmitButton) so the existing save icon
// can stay put next to the spinner instead of being swapped out.
function SaveChangesButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className="btn-primary">
      {pending && <InlineSpinner />}
      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z" />
        <path d="M17 21v-8H7v8M7 3v5h8" />
      </svg>
      Save Changes
    </button>
  );
}

// Identity details only (name, phone). Email and password are security
// concerns and live at /account/security. Posts to saveAccountAction, which
// writes the users row + mirrors the name into auth metadata.
export default function ProfileInfoForm({
  profile,
  name,
}: {
  profile: UserProfile;
  name: string;
}) {
  const smsConsent = profile.sms_consent ?? false;

  return (
    <form
      action={saveAccountAction}
      className="card p-6"
    >
      <h2 className="mb-4 text-base font-semibold text-stone-900 dark:text-stone-100">
        Basic Information
      </h2>

      <div className="max-w-md space-y-4">
        <div>
          <label className="label">Full Name</label>
          <div className="relative">
            <FieldIcon>
              <circle cx="12" cy="8" r="4" />
              <path d="M6 21v-1a6 6 0 0112 0v1" />
            </FieldIcon>
            <input
              name="full_name"
              className="input pl-9"
              defaultValue={name}
              placeholder="e.g. Alex Rivera"
              required
              minLength={2}
            />
          </div>
        </div>

        <div>
          <label className="label">Phone Number</label>
          <div className="relative">
            <FieldIcon>
              <path d="M22 16.9v3a2 2 0 01-2.2 2 19.8 19.8 0 01-8.6-3.1 19.5 19.5 0 01-6-6A19.8 19.8 0 012 4.2 2 2 0 014 2h3a2 2 0 012 1.7c.1.9.4 1.8.7 2.6a2 2 0 01-.5 2.1L8.1 9.8a16 16 0 006 6l1.4-1.1a2 2 0 012.1-.5c.8.3 1.7.6 2.6.7a2 2 0 011.7 2z" />
            </FieldIcon>
            <PhoneInput
              name="phone"
              className="input pl-9"
              defaultValue={profile.phone ?? ""}
            />
          </div>
        </div>

        {/* TODO(legal): have counsel review this TCPA consent copy before
            launch - checkbox must stay unchecked by default (opt-in only). */}
        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            name="sms_consent"
            defaultChecked={smsConsent}
            className="mt-1 h-4 w-4 shrink-0 rounded border-stone-300 text-bark-600 focus:ring-bark-600 dark:border-white/20"
          />
          <span className="text-xs text-stone-500 dark:text-stone-400">
            Text me at this number for account and job-related messages (like
            a reminder to review a pro after a job). Message and data rates
            may apply. Message frequency varies. Reply STOP to opt out, HELP
            for help.
          </span>
        </label>

      </div>

      {/* Footer */}
      <div className="mt-8 flex items-center justify-end gap-3 border-t border-stone-100 pt-5 dark:border-white/10">
        <Link
          href="/dashboard"
          className="rounded-lg px-4 py-2 text-sm font-medium text-stone-500 hover:text-stone-700 max-sm:flex max-sm:min-h-11 max-sm:items-center dark:text-stone-400 dark:hover:text-stone-200"
        >
          Cancel
        </Link>
        <SaveChangesButton />
      </div>
    </form>
  );
}
