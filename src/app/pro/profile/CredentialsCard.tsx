"use client";

import { useEffect, useRef } from "react";
import { useFormStatus } from "react-dom";
import InlineSpinner from "@/components/InlineSpinner";
import ComplianceCard from "@/components/pro/ComplianceCard";
import FieldIcon from "../FieldIcon";
import { saveLicenseNumberAction, verifyLicenseNowAction } from "../actions";
import { licenseDisputeAction, saveLicenseInsuranceAction } from "./actions";
import type { Contractor } from "@/lib/database.types";

// "Credentials": the pro's state license and their proof of insurance, in one
// place. Everything here used to be scattered - the license NUMBER lived in the
// Public Profile form, a second (and stricter) copy of the number plus the
// carrier and expiry lived in the "Your Public Page" card, and the two uploaded
// documents lived in a collapsed <details> on /pro/business. That last one is
// why the big-job insurance gate's "add your insurance" link used to land a pro
// on a page with nothing visible to fill in.
//
// Nothing on this tab is public. The public /p/<id> page shows a license badge
// and nothing about insurance at all, so the copy here says so rather than
// selling a badge the insurance half no longer earns.

// Small submit buttons. Each needs its own component because useFormStatus only
// reports pending state inside a descendant of the <form>, not the component
// rendering the form itself.
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
// VerifyLicenseButton: HTML forbids a nested <form>, so this is a formAction on
// a button inside the license form. It posts the whole form, but
// licenseDisputeAction reads only the message field and never touches the pro's
// verification state - only a human can move that.
function DisputeLicenseButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      formAction={licenseDisputeAction}
      disabled={pending}
      className="mt-2 inline-flex items-center justify-center gap-1.5 rounded-lg border border-stone-200 px-3 py-1.5 text-xs font-medium text-stone-600 hover:bg-stone-50 max-sm:min-h-11 max-sm:px-4 dark:border-white/10 dark:text-stone-300 dark:hover:bg-stone-700"
    >
      {pending && <InlineSpinner size={12} />}
      Send dispute
    </button>
  );
}

// Generic save button for the two forms on this tab.
function SaveButton({ label }: { label: string }) {
  const { pending } = useFormStatus();
  // Synchronous double-submit guard, same as src/components/SubmitButton.tsx:
  // `pending` is state and lands a render behind the click, so two clicks in
  // the same tick (a fast double tap) both still read `pending` as false and
  // both reach the native submit. This ref flips the instant the first click
  // happens, before React re-renders, so the second click can see it and stop
  // that submit before it starts.
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
    // browser's own constraint validation never runs the action, so `pending`
    // never flips and the effect above would never release the latch.
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
      {label}
    </button>
  );
}

function formatVerifiedDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

export default function CredentialsCard({
  contractor,
}: {
  contractor: Contractor;
}) {
  const hasLicense = Boolean(contractor.license_number);
  const verifyStatus = contractor.license_verified_status ?? "unverified";
  // Locked only once VERIFIED (mirrors saveLicenseNumberAction and the
  // saveCompanyAction rule it was lifted from): before that, the number stays
  // editable so a typo can be corrected and rechecked. Deliberately NOT the
  // stricter "locked once set" rule saveLicenseInsuranceAction applies.
  const licenseLocked = hasLicense && verifyStatus === "verified";
  const verifiedAt = contractor.license_verified_at ?? null;
  const verifyDetail = contractor.license_verify_detail ?? null;
  // 0125: a failure OakTend caused (identity), not one CSLB reported. These two
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

  // Cast: license_expires / license_doc_path / insurance_expires /
  // insurance_doc_path land in migrations 0033 and 0051 and are not all in the
  // generated types (database.types.ts is not regenerated here) - the same
  // any-cast reading /pro/business used when this card lived there.
  const extra = contractor as any;

  return (
    <div className="space-y-6">
      {/* (a) The number itself, and what the CSLB said about it. id="license"
          is where saveLicenseNumberAction sends the pro back to, and what
          ProfileTabs' HASH_TAB maps to this tab. */}
      <div id="license">
        <form action={saveLicenseNumberAction} className="card space-y-4">
          <div>
            <h2 className="font-semibold text-stone-900 dark:text-stone-100">
              State license
            </h2>
            <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">
              Your CSLB license number. OakTend checks it against
              California&apos;s public license board; a confirmed license earns
              the verified badge on your public page.
            </p>
          </div>

          {/* The state the check runs against. OakTend serves California only
              right now, so the Public Profile form locks this to CA and this
              form posts the same hidden value, which is what
              saveLicenseNumberAction reads to decide whether a CSLB lookup can
              run at all. */}
          <input type="hidden" name="service_state" value="CA" />

          <div>
            <label className="label flex items-center gap-2">
              State License Number
              {/* license_verified_status (0037/0055): a real CSLB check now
                  backs 'verified' and 'failed'. Never claim "Verified"
                  beyond what was actually confirmed. */}
              {/* 10px carries meaning (verified/failed/pending), so on a
                  phone it steps up to 14px (max-sm:text-sm) instead of
                  the old 12px; desktop is unchanged. */}
              {hasLicense && verifyStatus === "verified" && (
                <span className="inline-flex items-center gap-1 rounded bg-green-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-green-700 max-sm:text-sm dark:bg-green-950/40 dark:text-green-200">
                  <svg viewBox="0 0 24 24" className="h-2.5 w-2.5" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M20 6L9 17l-5-5" />
                  </svg>
                  License verified
                </span>
              )}
              {hasLicense && verifyStatus === "failed" && (
                <span className="rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-red-700 max-sm:text-sm dark:bg-red-950/40 dark:text-red-200">
                  Not confirmed
                </span>
              )}
              {hasLicense &&
                (verifyStatus === "pending" || verifyStatus === "unverified") && (
                  <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700 max-sm:text-sm dark:bg-amber-500/15 dark:text-amber-300">
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
                    placeholder="1029384"
                    inputMode="numeric"
                    pattern="[0-9]{5,8}"
                    onChange={(e) => {
                      const stripped = e.target.value.replace(/\s+/g, "");
                      if (stripped !== e.target.value) e.target.value = stripped;
                    }}
                    defaultValue={contractor.license_number ?? ""}
                  />
                </div>
                {!hasLicense && (
                  <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
                    Your CSLB (California&apos;s contractor license board)
                    license number, digits only.
                  </p>
                )}
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
                          : "This license number is already verified on another OakTend account. If someone else used your license, file a dispute and we will investigate."}
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
                          className="input mt-1"
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
                      Automatic license checks only cover California (CSLB)
                      right now, so yours stays on file as-is. State You
                      Serve is already set to California, if it&apos;s a
                      CSLB license, save and then verify. You can keep
                      applying to jobs while you wait.
                    </p>
                  ))}
              </>
            )}
          </div>

          {/* Nothing left to save once the number is locked: the read-only
              branch above posts no license_number at all, so a Save button
              there would be a button that cannot change anything. */}
          {!licenseLocked && (
            <div className="flex justify-end border-t border-stone-100 pt-4 dark:border-white/10">
              <SaveButton label="Save license number" />
            </div>
          )}
        </form>
      </div>

      {/* (b) The two uploaded documents, with the expiry calendar OakTend
          reminds the pro from. The insurance row carries id="insurance", which
          is where INSURANCE_UPLOAD_HREF lands. verification is deliberately
          not passed: the number and its CSLB status are directly above, and
          two places showing the same fact is how /pro/business and
          /pro/profile drifted apart in the first place. */}
      <ComplianceCard
        license={{
          expires: extra.license_expires ?? null,
          docPath: extra.license_doc_path ?? null,
        }}
        insurance={{
          expires: extra.insurance_expires ?? null,
          docPath: extra.insurance_doc_path ?? null,
        }}
        verification={undefined}
      />

      {/* (c) Who the policy is with. Deliberately WITHOUT an insurance_expires
          field: the upload row above owns that date (the API route reads it off
          the document), and a second input for it here would let a stale form
          overwrite what an upload just set. saveLicenseInsuranceAction only
          writes the fields a form actually carries, so posting the carrier
          alone cannot touch the date, the number, or the state. */}
      <form action={saveLicenseInsuranceAction} className="card space-y-4">
        <div>
          <h2 className="font-semibold text-stone-900 dark:text-stone-100">
            Insurance carrier
          </h2>
          <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">
            Optional, and never shown publicly. It is here so you and OakTend
            support both know who to call when a homeowner asks for a
            certificate.
          </p>
        </div>

        <div>
          <label className="label">Carrier</label>
          <input
            name="insurance_carrier"
            className="input"
            maxLength={120}
            defaultValue={extra.insurance_carrier ?? ""}
            placeholder="e.g. State Farm"
          />
        </div>

        <div className="flex justify-end border-t border-stone-100 pt-4 dark:border-white/10">
          <SaveButton label="Save carrier" />
        </div>
      </form>
    </div>
  );
}
