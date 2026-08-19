"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { useFormStatus } from "react-dom";
import { Hammer } from "lucide-react";
import { saveCompanyAction } from "../actions";
import CategoryPicker from "../CategoryPicker";
import FieldIcon from "../FieldIcon";
import PhoneInput from "@/components/PhoneInput";
import LaunchCityCheckboxes from "./LaunchCityCheckboxes";
import InlineSpinner from "@/components/InlineSpinner";

// Needs its own component because useFormStatus only reports pending state
// inside a descendant of the <form> it belongs to, not the component
// rendering the form itself.
function SeeOpenJobsButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className="btn-primary px-5 py-2.5">
      {pending && <InlineSpinner />}
      See open jobs
    </button>
  );
}

// Honest end state for a pro whose signup carried no served city:
// saveCompanyAction (../actions.ts) redirects here with ?waitlisted=1 instead
// of dumping them back on this blank form having lost every field they typed.
//
// The form itself can no longer produce this: the service-area question is now
// two checkboxes with at least one required, so there is no "No, I'm outside
// your area" answer to give. Kept because saveCompanyAction still falls back
// here for a post that carries no service-area answer at all (not a browser),
// and because it is the panel to reuse the moment an out-of-area path exists
// again.
// Same tone as the homeowner out_of_area step
// (src/app/onboarding/OnboardingForm.tsx): state plainly what happened, and
// always leave a working way out.
function WaitlistedPanel() {
  return (
    <div className="space-y-4 overflow-hidden rounded-2xl border border-stone-200 bg-white px-6 py-10 text-center shadow-sm dark:border-white/10 dark:bg-stone-800">
      <div className="flex justify-center">
        <Hammer className="h-8 w-8 text-bark-700 dark:text-bark-400" aria-hidden="true" />
      </div>
      <h1 className="text-2xl font-semibold text-stone-900 dark:text-stone-100">
        You&apos;re on the waitlist
      </h1>
      <p className="text-sm text-stone-600 dark:text-stone-300">
        Hearth is matching pros in Huntington Beach and Fountain Valley right
        now. We added you to the waitlist and will reach out when Hearth opens
        in your area.
      </p>
      <p className="text-sm text-stone-500 dark:text-stone-400">
        There&apos;s nothing else to set up here yet since Hearth covers
        Huntington Beach and Fountain Valley right now. Don&apos;t see your city
        yet? You will soon.
      </p>
      <form action="/auth/signout" method="post">
        <button
          type="submit"
          className="text-sm text-stone-500 hover:underline dark:text-stone-400"
        >
          Sign out
        </button>
      </form>
    </div>
  );
}

// First-time company setup. Same visual language as the edit-profile form
// (matching fields + category cards) but lean: no tabs, no account-security, no
// cover/logo upload, and the license is an open input since it's set here first.
// Posts to saveCompanyAction, which inserts the new contractor row.
//
// Wrapped in its own Suspense boundary below because useSearchParams needs
// one; kept self-contained here rather than threading the query param through
// the server page, so this file alone covers both the form and its honest
// waitlisted end state.
function OnboardingCompanyFormInner({
  defaultEmail,
  defaultReferralCode = "",
}: {
  defaultEmail: string;
  defaultReferralCode?: string;
}) {
  const searchParams = useSearchParams();
  if (searchParams.get("waitlisted") === "1") {
    return <WaitlistedPanel />;
  }

  return (
    <form
      action={saveCompanyAction}
      className="overflow-hidden rounded-2xl border border-stone-200 bg-white shadow-sm dark:border-white/10 dark:bg-stone-800"
    >
      {/* White header, matching the contractor signup card */}
      <div className="px-6 pt-8 text-center">
        <div className="flex justify-center">
          <Hammer className="h-8 w-8 text-bark-700 dark:text-bark-400" aria-hidden="true" />
        </div>
        <h1 className="mt-2 text-2xl font-semibold text-stone-900 dark:text-stone-100">
          Set up your company
        </h1>
        <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">
          Tell us what you do so we can match you with the right homeowner leads.
        </p>
      </div>

      {/* Form body */}
      <div className="px-6 pb-6 pt-6">
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
                    defaultValue={defaultEmail}
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
                  <PhoneInput name="contact_phone" className="input pl-9" />
                </div>
              </div>

              <div>
                <fieldset>
                  <legend className="label">
                    Do you serve Huntington Beach or Fountain Valley?
                  </legend>
                  <LaunchCityCheckboxes />
                </fieldset>
                <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
                  Check every city you serve. Hearth is matching pros in
                  Huntington Beach and Fountain Valley right now, so at least
                  one is required. You can add more cities from your profile
                  once we open in them.
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
                  you. Your job board shows homeowner jobs in California.
                </p>
              </div>

              <div>
                <label className="label">State License Number</label>
                <div className="relative">
                  <FieldIcon>
                    <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8zM14 2v6h6M9 13h6M9 17h6" />
                  </FieldIcon>
                  <input
                    name="license_number"
                    className="input pl-9"
                    placeholder="LIC-000000-XX"
                  />
                </div>
                <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
                  We keep this on file, show homeowners a &quot;license on
                  file&quot; badge, and flag it for verification. Locked once
                  verified. Typo? You can correct it until then.
                </p>
              </div>

              {/* Optional outbound review-page links (0110). Plain links only:
                  the public page shows a "See our reviews" button, never
                  imported review content or star counts. */}
              <div>
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
                    placeholder="https://g.page/your-business"
                  />
                </div>
                <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
                  Homeowners see a &quot;See our reviews&quot; button on your
                  public page.
                </p>
              </div>

              <div>
                <label className="label">
                  Referral code{" "}
                  <span className="font-normal text-stone-500 dark:text-stone-400">(optional)</span>
                </label>
                <div className="relative">
                  <FieldIcon>
                    <path d="M20 8h-9M20 8a2 2 0 012 2v9a2 2 0 01-2 2H4a2 2 0 01-2-2v-9a2 2 0 012-2h3M20 8V6a2 2 0 00-2-2h-2M9 12h6" />
                  </FieldIcon>
                  <input
                    name="referral_code"
                    className="input pl-9"
                    defaultValue={defaultReferralCode}
                    placeholder="From the pro who invited you"
                  />
                </div>
                <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
                  Invited by another Hearth pro? Enter their code: you both get
                  $25 of application credit when you win your first job.
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

            <CategoryPicker defaultSelected={[]} />
          </div>
        </div>

        {/* Footer */}
        <div className="mt-8 flex justify-end border-t border-stone-100 pt-5 dark:border-white/10">
          <SeeOpenJobsButton />
        </div>
      </div>
    </form>
  );
}

export default function OnboardingCompanyForm(props: {
  defaultEmail: string;
  defaultReferralCode?: string;
}) {
  return (
    <Suspense fallback={null}>
      <OnboardingCompanyFormInner {...props} />
    </Suspense>
  );
}
