"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import { useFormStatus } from "react-dom";
import InlineSpinner from "@/components/InlineSpinner";
import { saveCompanyAction } from "../actions";
import { saveLogoAction, saveBannerAction } from "./actions";
import CategoryPicker from "../CategoryPicker";
import FieldIcon from "../FieldIcon";
import PhoneInput from "@/components/PhoneInput";
import LaunchCityCheckboxes from "../onboarding/LaunchCityCheckboxes";
import AvatarUpload from "@/components/AvatarUpload";
import type { Contractor } from "@/lib/database.types";
import { LEGAL } from "@/lib/legal";

// The license number's own submit buttons (Verify now / Reverify, Send
// dispute) moved out with the license block itself - see ./CredentialsCard.tsx.
function SaveChangesButton() {
  const { pending } = useFormStatus();
  // Synchronous double-submit guard, same as src/components/SubmitButton.tsx:
  // `pending` is state and lands a render behind the click, so two clicks in
  // the same tick (a fast double tap, confirmed live on this exact button)
  // both still read `pending` as false and both reach the native submit. This
  // ref flips the instant the first click happens, before React re-renders,
  // so the second click can see it and stop that submit before it starts.
  const submittedRef = useRef(false);

  useEffect(() => {
    // Release the latch once the action is no longer in flight, so a failed
    // submit can be retried with another click. Only the pending -> not-
    // pending edge resets it, never while still pending.
    if (!pending) submittedRef.current = false;
  }, [pending]);

  function handleClick(e: React.MouseEvent<HTMLButtonElement>) {
    if (submittedRef.current) {
      e.preventDefault();
      return;
    }
    // Only latch when a submit will actually start: a form that fails the
    // browser's own constraint validation (required, minLength, type=email)
    // never runs the action, so `pending` never flips and the effect above
    // would never release the latch.
    const form = e.currentTarget.form;
    if (form && !form.noValidate && !form.checkValidity()) return;
    submittedRef.current = true;
  }

  return (
    <button
      type="submit"
      disabled={pending}
      className="btn-primary"
      onClick={handleClick}
    >
      {pending && <InlineSpinner />}
      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z" />
        <path d="M17 21v-8H7v8M7 3v5h8" />
      </svg>
      Save Changes
    </button>
  );
}

// Redesigned contractor profile editor. Posts to the same saveCompanyAction the
// onboarding form uses, so field names must stay: name, contact_email,
// contact_phone, service_cities (+ the service_cities_present marker),
// categories.
//
// The State License Number and everything around it (the verified / not
// confirmed / pending badges, the CSLB copy, "Verify now", the dispute form)
// used to live in this form and posted along with it. They now live on the
// Credentials tab (./CredentialsCard.tsx) with the license and insurance
// documents, so a pro manages credentials in one place instead of three, and
// the number posts to its own saveLicenseNumberAction under the same rules.
export default function PublicProfileForm({
  contractor,
  smsConsent = false,
}: {
  contractor: Contractor;
  // Current TCPA SMS consent for the ACCOUNT (users.sms_consent), not the
  // company row, so it has to be passed in rather than read off contractor.
  // Defaults to false: an unread value must never render as a ticked opt-in.
  smsConsent?: boolean;
}) {
  return (
    // A plain card (not a <form>): the tappable photo and the company details
    // are two SEPARATE forms below - a <form> cannot nest another - so the card
    // is just their shared frame.
    <div className="overflow-hidden rounded-2xl border border-stone-200 bg-white shadow-sm dark:border-white/10 dark:bg-stone-800">
      {/* Company cover banner. MED-20 removed the old dead "Change Cover"
          button because nothing backed it; migration 0155 builds the real
          thing. Tapping the strip uploads a wide cover image into the SAME
          public pro-logos bucket the logo uses (saved FREE by saveBannerAction,
          tracked in contractors.banner_url). AvatarUpload carries its own form
          (variant="banner"), so - exactly like the avatar below - it sits
          OUTSIDE the company <form> opened further down. The profile photo
          still overlaps its bottom edge via the -mt-10 on the avatar. */}
      <AvatarUpload
        action={saveBannerAction}
        bucket="pro-logos"
        ownerId={contractor.id}
        inputName="banner_url"
        initialUrl={(contractor as any).banner_url ?? null}
        variant="banner"
      />

      <div className="px-6 pb-6">
        {/* The profile photo, overlapping the banner. FREE for every pro as of
            2026-09-08: it used to be a Pro-member perk on the "Your Public
            Page" tab, and this spot was a dead placeholder pointing there. The
            whole avatar is now the control (tap it to upload); AvatarUpload
            carries its own form + saveLogoAction, which is why it sits OUTSIDE
            the company <form> opened just below. */}
        {/* relative z-10: the banner above is position:relative, so without a
            higher-stacked, positioned avatar here the banner (a positioned box)
            paints OVER this static one and clips its top border. Lifting the
            avatar onto its own stacking level puts it back on top of the banner
            it overlaps. */}
        <div className="relative z-10 -mt-10 mb-6">
          <AvatarUpload
            action={saveLogoAction}
            bucket="pro-logos"
            ownerId={contractor.id}
            inputName="logo_url"
            initialUrl={(contractor as any).logo_url ?? null}
            shape="square"
            size={80}
            placeholder="building"
          />
        </div>

        <form action={saveCompanyAction}>
        <div className="grid gap-8 md:grid-cols-2">
          {/* Basic information */}
          <div>
            <h2 className="mb-4 text-base font-semibold text-stone-900 dark:text-stone-100">
              Basic Information
            </h2>

            <div className="space-y-4">
              <div>
                <label className="label">
                  Company Name{" "}
                  <span className="font-normal text-stone-500 dark:text-stone-400">
                    (as it appears on your license)
                  </span>
                </label>
                <div className="relative">
                  <FieldIcon>
                    <path d="M4 21V5l8-2 8 2v16M9 9h.01M9 13h.01M15 9h.01M15 13h.01M10 21v-4h4v4" />
                  </FieldIcon>
                  <input
                    name="name"
                    className="input pl-9"
                    defaultValue={contractor.name ?? ""}
                    placeholder="e.g. Acme Home Services"
                    required
                  />
                </div>
              </div>

              {/* Who the homeowner is actually talking to, migration 0141.
                  Editable here for pros who set their company up before the
                  question existed, and shown on the public /p/<id> page under
                  the business name. */}
              <div>
                <label className="label">Owner Name</label>
                <div className="relative">
                  <FieldIcon>
                    <circle cx="12" cy="8" r="4" />
                    <path d="M6 21v-1a6 6 0 0112 0v1" />
                  </FieldIcon>
                  <input
                    name="owner_name"
                    className="input pl-9"
                    // 120 is the ceiling the column's check constraint
                    // enforces; saveCompanyAction caps it again server-side.
                    maxLength={120}
                    defaultValue={contractor.owner_name ?? ""}
                    placeholder="e.g. Alex Rivera"
                  />
                </div>
                <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
                  The person homeowners will be talking to. Shown on your public profile.
                </p>
              </div>

              <div>
                <label className="label">Email Address</label>
                <div className="relative">
                  <FieldIcon>
                    <path d="M4 4h16v16H4zM4 6l8 6 8-6" />
                  </FieldIcon>
                  <input
                    name="contact_email"
                    type="email"
                    className="input pl-9"
                    defaultValue={contractor.contact_email ?? ""}
                    placeholder="contact@yourcompany.com"
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
                    name="contact_phone"
                    className="input pl-9"
                    defaultValue={contractor.contact_phone ?? ""}
                    required
                    // HIGH-19: this form has no hidden panels (unlike the
                    // onboarding wizard's own PhoneInput), so native
                    // constraint validation works here. Matches
                    // saveCompanyAction's own 10-digit floor
                    // (../actions.ts) so an empty or malformed number is
                    // caught before the request even leaves the browser,
                    // not just after.
                    pattern="\(\d{3}\) \d{3}-\d{4}"
                  />
                </div>
                <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
                  Homeowners call this number after they pick you.
                </p>
              </div>

              {/* TCPA SMS consent. Opt-in only: NEVER pre-ticked, and the
                  hidden marker beside it is what tells saveCompanyAction
                  "unticked" apart from "this form did not ask" (an unticked
                  checkbox posts nothing at all). Without this box every pro
                  text OakTend already builds is dropped by the gate in
                  src/lib/notify.ts. See saveProSmsConsent in
                  src/app/pro/actions.ts.
                  TODO(legal): have counsel review this consent copy before
                  launch. */}
              <input type="hidden" name="sms_consent_present" value="1" />
              <label className="flex min-h-11 items-start gap-2">
                <input
                  type="checkbox"
                  name="sms_consent"
                  defaultChecked={smsConsent}
                  className="mt-1 h-6 w-6 shrink-0 rounded border-stone-300 text-oaktend-600 focus:ring-oaktend-600 dark:border-white/20"
                />
                <span className="text-sm text-stone-600 dark:text-stone-400">
                  Text me when a job matches or a homeowner replies. Message
                  and data rates may apply. Message frequency varies. Reply
                  STOP to opt out, HELP for help. This number is never used
                  for marketing from other companies.
                </span>
              </label>
              <p className="text-xs text-stone-500 dark:text-stone-400">
                Consent isn&apos;t required to use {LEGAL.brand} or to buy
                anything. See our{" "}
                <Link href="/sms-terms" className="underline hover:text-stone-700 dark:hover:text-stone-300">
                  SMS Terms
                </Link>
                .
              </p>

              <div>
                <label className="label">Cities You Serve</label>
                {/* The same checkboxes signup uses, posting the same
                    `service_cities` / `service_cities_present` field names to
                    the same saveCompanyAction, so one parsing path
                    (selectLaunchCities) covers both forms. Replaces the old
                    free-text ServiceAreaInput: since migration 0124 this
                    answer is a real gate - launch_cities is what
                    open_jobs_for_me and apply_to_lead filter each job's ZIP
                    against - so a free-text city list that nothing reads would
                    have quietly left a pro's board wrong. */}
                <LaunchCityCheckboxes
                  defaultCities={
                    ((contractor as { launch_cities?: string[] | null })
                      .launch_cities ?? []) as string[]
                  }
                />
                <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
                  OakTend serves all of Orange County. You only see, and only
                  pay for, jobs in the cities you keep checked here.
                </p>
              </div>

              <div>
                <label className="label">State You Serve</label>
                <div className="relative">
                  <FieldIcon>
                    <path d="M3 6l6-3 6 3 6-3v15l-6 3-6-3-6 3zM9 3v15M15 6v15" />
                  </FieldIcon>
                  {/* Locked to California while OakTend serves CA only. The
                      hidden input still posts service_state=CA, the two-letter
                      code saveCompanyAction and the CSLB check expect. */}
                  <div className="input cursor-not-allowed select-none bg-stone-100 pl-9 text-stone-500 dark:bg-stone-700 dark:text-stone-400">
                    California (CA)
                  </div>
                  <input type="hidden" name="service_state" value="CA" />
                </div>
                <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
                  OakTend serves California only right now, so this is set for
                  you.
                </p>
              </div>

              {/* The State License Number and its verification UI used to sit
                  here. Moved to the Credentials tab
                  (./CredentialsCard.tsx). */}

              {/* The optional outbound review-page links (0110) used to sit
                  here, with an id="reviews" anchor the setup checklist pointed
                  at. Removed 2026-09-12: an outbound link is a way off the
                  platform before any lead record exists, so no surface offers
                  one any more. The yelp_url / google_reviews_url columns and
                  saveCompanyAction's handling of them stay - that handling is
                  missing-field-safe, so a form that no longer posts the fields
                  leaves whatever is stored exactly as it is. */}
            </div>
          </div>

          {/* Service categories */}
          <div>
            <h2 className="mb-1 text-base font-semibold text-stone-900 dark:text-stone-100">
              Service Categories
            </h2>
            <p className="mb-4 text-sm text-stone-500 dark:text-stone-400">
              Select the main areas of work your company handles. This helps
              homeowners find you.
            </p>

            <CategoryPicker defaultSelected={contractor.categories ?? []} />
          </div>
        </div>

        {/* Footer */}
        <div className="mt-8 flex items-center justify-end gap-3 border-t border-stone-100 pt-5 dark:border-white/10">
          <Link
            href="/pro"
            className="rounded-lg px-4 py-2 text-sm font-medium text-stone-500 hover:text-stone-700 dark:text-stone-400 dark:hover:text-stone-200"
          >
            Cancel
          </Link>
          <SaveChangesButton />
        </div>
        </form>
      </div>
    </div>
  );
}
