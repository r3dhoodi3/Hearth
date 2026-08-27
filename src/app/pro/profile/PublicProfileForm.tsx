"use client";

import Link from "next/link";
import { useFormStatus } from "react-dom";
import InlineSpinner from "@/components/InlineSpinner";
import { saveCompanyAction, verifyLicenseNowAction } from "../actions";
import { licenseDisputeAction } from "./actions";
import CategoryPicker from "../CategoryPicker";
import FieldIcon from "../FieldIcon";
import PhoneInput from "@/components/PhoneInput";
import LaunchCityCheckboxes from "../onboarding/LaunchCityCheckboxes";
import type { Contractor } from "@/lib/database.types";

// Small submit buttons for the form below. Each needs its own component
// because useFormStatus only reports pending state inside a descendant of
// the <form>, not the component rendering the form itself.
function VerifyLicenseButton({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      formAction={verifyLicenseNowAction}
      disabled={pending}
      // "Reverify" / "Verify now" is the button that unblocks a badge, and at
      // py-1.5 on text-xs it was a ~26px-tall target. Below sm it gets the
      // full 44px; sm and up keep the exact button that was here.
      className="mt-2 inline-flex items-center justify-center gap-1.5 rounded-lg border border-stone-200 px-3 py-1.5 text-xs font-medium text-stone-600 hover:bg-stone-50 max-sm:min-h-11 max-sm:px-4 dark:border-white/10 dark:text-stone-300 dark:hover:bg-stone-700"
    >
      {pending && <InlineSpinner size={12} />}
      {label}
    </button>
  );
}

// Sends the dispute textarea below to support (0125). Same trick as
// VerifyLicenseButton: HTML forbids a nested <form>, so this is a formAction
// on a submit button inside the profile's single form. It posts the whole
// form, but licenseDisputeAction reads only the message field and never
// touches the pro's verification state - only a human can move that.
function DisputeLicenseButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      formAction={licenseDisputeAction}
      disabled={pending}
      className="mt-2 inline-flex items-center justify-center gap-1.5 rounded-lg border border-stone-200 px-3 py-1.5 text-xs font-medium text-stone-600 hover:bg-stone-50 dark:border-white/10 dark:text-stone-300 dark:hover:bg-stone-700"
    >
      {pending && <InlineSpinner size={12} />}
      Send dispute
    </button>
  );
}

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

// Redesigned contractor profile editor. Posts to the same saveCompanyAction the
// onboarding form uses, so field names must stay: name, contact_email,
// contact_phone, service_cities (+ the service_cities_present marker),
// categories. The license is read-only once
// VERIFIED, matching saveCompanyAction: until a real CSLB check passes, the
// pro can still fix a typo in the number.
//
// License verification (0055): license_verified_status (0037) drives the
// badge and copy below. 'verified' shows a real, dated confirmation; 'failed'
// shows why (from license_verify_detail) with a way to reverify after fixing
// it with the state. The pending copy is honest about what actually runs:
// CSLB is California's registry, so only a CA (or blank, "All states")
// service_state gets check-in-progress copy and a Verify button; a pro who
// explicitly serves another state is told checks don't cover them yet
// instead of being shown a check that can never run. The "Verify now" /
// "Reverify" button is a formAction on a button inside this SAME form
// (not a nested form, which HTML disallows) so it can post to
// verifyLicenseNowAction instead of saveCompanyAction for that one click;
// the action reads the license number out of this form's data, so a typo
// fixed in the input gets checked without a separate save.
function formatVerifiedDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

export default function PublicProfileForm({
  contractor,
}: {
  contractor: Contractor;
}) {
  const hasLicense = Boolean(contractor.license_number);
  const verifyStatus = contractor.license_verified_status ?? "unverified";
  // Locked only once VERIFIED (mirrors saveCompanyAction): before that, the
  // number stays editable so a typo can be corrected and rechecked.
  const licenseLocked = hasLicense && verifyStatus === "verified";
  const verifiedAt = contractor.license_verified_at ?? null;
  const verifyDetail = contractor.license_verify_detail ?? null;
  // 0125: a failure Hearth caused (identity), not one CSLB reported. These two
  // are the only ones a pro can appeal, because they're the only ones a human
  // can resolve - a canceled or expired license is fixed with the state, not
  // with support.
  const failureReason = verifyDetail?.failure_reason ?? null;
  const disputableReason =
    failureReason === "name_mismatch" || failureReason === "duplicate_license"
      ? failureReason
      : null;
  // CSLB eligibility mirrors verifyLicenseNowAction: null/blank service_state
  // ("All states") can run an explicit check; an explicit non-CA state is
  // refused, so those pros get honest copy instead of a dead button.
  const serviceState =
    (((contractor as any).service_state as string | null) ?? null) || null;
  const cslbEligible = serviceState === null || serviceState === "CA";

  return (
    <form action={saveCompanyAction} className="overflow-hidden rounded-2xl border border-stone-200 bg-white shadow-sm dark:border-white/10 dark:bg-stone-800">
      {/* Cover banner + avatar */}
      <div className="relative h-32 bg-stone-100 sm:h-40 dark:bg-stone-700">
        <button
          type="button"
          className="absolute right-4 top-4 inline-flex items-center gap-1.5 rounded-full border border-stone-200 bg-white px-3 py-1.5 text-sm font-medium text-stone-600 shadow-sm hover:bg-stone-50 dark:border-white/10 dark:bg-stone-800 dark:text-stone-300 dark:hover:bg-stone-700"
        >
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z" />
            <circle cx="12" cy="13" r="4" />
          </svg>
          Change Cover
        </button>
      </div>

      <div className="px-6 pb-6">
        {/* Logo / avatar, overlapping the banner */}
        <div className="-mt-10 mb-6">
          <button
            type="button"
            className="relative flex h-20 w-20 items-center justify-center rounded-2xl border border-dashed border-stone-300 bg-stone-50 text-stone-500 shadow-sm hover:bg-stone-100 dark:border-stone-600 dark:bg-stone-800 dark:text-stone-400 dark:hover:bg-stone-700"
          >
            <svg viewBox="0 0 24 24" className="h-8 w-8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 21V5l8-2 8 2v16M9 9h.01M9 13h.01M15 9h.01M15 13h.01M10 21v-4h4v4" />
            </svg>
            <span className="absolute -bottom-2 -right-2 flex h-6 w-6 items-center justify-center rounded-full border border-stone-200 bg-white text-stone-500 shadow-sm dark:border-white/10 dark:bg-stone-800 dark:text-stone-400">
              +
            </span>
          </button>
        </div>

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
                  />
                </div>
              </div>

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
                  Hearth serves all of Orange County. You only see, and only
                  pay for, jobs in the cities you keep checked here.
                </p>
              </div>

              <div>
                <label className="label">State You Serve</label>
                <div className="relative">
                  <FieldIcon>
                    <path d="M3 6l6-3 6 3 6-3v15l-6 3-6-3-6 3zM9 3v15M15 6v15" />
                  </FieldIcon>
                  {/* Locked to California while Hearth serves CA only. The
                      hidden input still posts service_state=CA, the two-letter
                      code saveCompanyAction and the CSLB check expect. */}
                  <div className="input cursor-not-allowed select-none bg-stone-100 pl-9 text-stone-500 dark:bg-stone-700 dark:text-stone-400">
                    California (CA)
                  </div>
                  <input type="hidden" name="service_state" value="CA" />
                </div>
                <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
                  Hearth serves California only right now, so this is set for
                  you.
                </p>
              </div>

              <div>
                <label className="label flex items-center gap-2">
                  State License Number
                  {/* license_verified_status (0037/0055): a real CSLB check now
                      backs 'verified' and 'failed'. Never claim "Verified"
                      beyond what was actually confirmed. */}
                  {hasLicense && verifyStatus === "verified" && (
                    <span className="inline-flex items-center gap-1 rounded bg-green-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-green-700 dark:bg-green-950/40 dark:text-green-200">
                      <svg viewBox="0 0 24 24" className="h-2.5 w-2.5" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M20 6L9 17l-5-5" />
                      </svg>
                      License verified
                    </span>
                  )}
                  {hasLicense && verifyStatus === "failed" && (
                    <span className="rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-red-700 dark:bg-red-950/40 dark:text-red-200">
                      Not confirmed
                    </span>
                  )}
                  {hasLicense &&
                    (verifyStatus === "pending" || verifyStatus === "unverified") && (
                      <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700 dark:bg-amber-500/15 dark:text-amber-300">
                        Verification pending
                      </span>
                    )}
                </label>
                {licenseLocked ? (
                  <>
                    <div className="relative">
                      <FieldIcon>
                        <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8zM14 2v6h6M9 13h6M9 17h6" />
                      </FieldIcon>
                      <div className="input cursor-not-allowed select-none bg-stone-100 pl-9 text-stone-500 dark:bg-stone-700 dark:text-stone-400">
                        {contractor.license_number}
                      </div>
                    </div>
                    <p className="mt-1 text-xs text-green-600 dark:text-green-400">
                      Checked against the CSLB public database
                      {verifiedAt ? ` on ${formatVerifiedDate(verifiedAt)}` : ""}.
                    </p>
                  </>
                ) : (
                  <>
                    <div className="relative">
                      <FieldIcon>
                        <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8zM14 2v6h6M9 13h6M9 17h6" />
                      </FieldIcon>
                      <input
                        name="license_number"
                        className="input pl-9"
                        placeholder="LIC-000000-XX"
                        defaultValue={contractor.license_number ?? ""}
                      />
                    </div>
                    {hasLicense && (
                      <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
                        Locked once verified. Typo? You can correct it until
                        then.
                      </p>
                    )}
                    {hasLicense && verifyStatus === "failed" && (
                      <>
                        {/* An identity failure (0125) is a different thing from
                            "CSLB says this license is canceled", and must not
                            wear the same copy: the license itself may be
                            perfectly good, and reverifying will just fail the
                            same way. Say what actually happened and offer the
                            only thing that can fix it - a human. The
                            CSLB-registered name is deliberately NOT echoed
                            back: whoever is at this form may not be the person
                            it belongs to. */}
                        {disputableReason ? (
                          <p className="mt-1 text-xs text-red-500 dark:text-red-400">
                            {disputableReason === "name_mismatch"
                              ? "The CSLB lists this license under a different name than your account. If this is your license, tell us and we will review it."
                              : "This license number is already verified on another Hearth account. If someone else used your license, file a dispute and we will investigate."}
                          </p>
                        ) : (
                          <p className="mt-1 text-xs text-red-500 dark:text-red-400">
                            {verifyDetail?.statusText
                              ? `CSLB says: ${verifyDetail.statusText}`
                              : "The CSLB public database did not confirm this license."}{" "}
                            {cslbEligible
                              ? "If this is out of date, update it with the state, then reverify below."
                              : "State You Serve is already set to California for you, so if this is a CSLB license, save your changes and then reverify."}
                          </p>
                        )}
                        {cslbEligible && !disputableReason && (
                          <VerifyLicenseButton label="Reverify" />
                        )}
                        {disputableReason && (
                          <div className="mt-2 rounded-lg border border-stone-200 p-3 dark:border-white/10">
                            <label
                              className="text-xs font-medium text-stone-600 dark:text-stone-300"
                              htmlFor="license_dispute_message"
                            >
                              File a dispute
                            </label>
                            <textarea
                              id="license_dispute_message"
                              name="message"
                              rows={3}
                              maxLength={2000}
                              className="input mt-1 text-sm"
                              placeholder={
                                disputableReason === "name_mismatch"
                                  ? "Tell us how this license is yours - the name it is registered under, your dba, anything that helps."
                                  : "Tell us what you know about the other account using this license."
                              }
                            />
                            <DisputeLicenseButton />
                          </div>
                        )}
                      </>
                    )}
                    {hasLicense &&
                      (verifyStatus === "pending" ||
                        verifyStatus === "unverified") &&
                      (cslbEligible ? (
                        <>
                          <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
                            {serviceState === "CA"
                              ? "We're checking your license against the CSLB public database. You can keep applying to jobs meanwhile."
                              : "Have a California (CSLB) license? Verify it below against the CSLB public database. Licenses from other states stay on file. You can keep applying to jobs meanwhile."}
                          </p>
                          <VerifyLicenseButton label="Verify now" />
                        </>
                      ) : (
                        <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
                          Automatic license checks currently cover California
                          (CSLB) licenses only, so yours stays on file as-is.
                          State You Serve is already set to California for
                          you, so if it is a CSLB license, save your changes
                          and then verify. You can keep applying to jobs
                          meanwhile.
                        </p>
                      ))}
                  </>
                )}
              </div>

              {/* Optional outbound review-page links (0110). Plain links only:
                  the public page shows a "See our reviews" button, never
                  imported review content or star counts. id="reviews" is the
                  anchor the /pro setup checklist links to. */}
              <div id="reviews">
                <label className="label">Yelp page (optional)</label>
                <div className="relative">
                  <FieldIcon>
                    <path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71" />
                    <path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71" />
                  </FieldIcon>
                  <input
                    name="yelp_url"
                    type="url"
                    className="input pl-9"
                    defaultValue={(contractor as any).yelp_url ?? ""}
                    placeholder="https://www.yelp.com/biz/your-business"
                  />
                </div>
              </div>

              <div>
                <label className="label">Google reviews link (optional)</label>
                <div className="relative">
                  <FieldIcon>
                    <path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71" />
                    <path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71" />
                  </FieldIcon>
                  <input
                    name="google_reviews_url"
                    type="url"
                    className="input pl-9"
                    defaultValue={(contractor as any).google_reviews_url ?? ""}
                    placeholder="https://g.page/your-business"
                  />
                </div>
                <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
                  Homeowners see a &quot;See our reviews&quot; button on your
                  public page.
                </p>
              </div>
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
      </div>
    </form>
  );
}
