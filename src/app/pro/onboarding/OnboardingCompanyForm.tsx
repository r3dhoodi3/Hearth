"use client";

import {
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { useSearchParams } from "next/navigation";
import { useFormStatus } from "react-dom";
import { Hammer } from "lucide-react";
import { saveCompanyAction } from "../actions";
import CategoryPicker from "../CategoryPicker";
import FieldIcon from "../FieldIcon";
import PhoneInput from "@/components/PhoneInput";
import LaunchCityCheckboxes from "./LaunchCityCheckboxes";
import InlineSpinner from "@/components/InlineSpinner";
import { LAUNCH_AREA_LABEL } from "@/lib/serviceArea";
import {
  clearProOnboardingDraft,
  proOnboardingDraftKey,
} from "./draftKey";
import {
  PRO_ONBOARDING_STEPS,
  PRO_ONBOARDING_STEP_COUNT,
  firstInvalidProOnboardingStep,
  resumeProOnboardingStep,
  validateProOnboardingStep,
  type ProOnboardingValues,
} from "./wizardSteps";

const LAST_STEP = PRO_ONBOARDING_STEP_COUNT - 1;

// A half-typed form must survive a refresh (an iPhone reload, a tab restore, a
// back-forward) AND a killed tab: iOS Safari evicts background tabs on its own
// schedule, and sessionStorage dies with the tab, so a pro who got a phone call
// halfway through signup came back to a blank form. localStorage instead, with
// an explicit expiry below doing the job the tab lifetime used to. Nothing
// secret goes in it - a company name, a phone number, a license number and the
// boxes they ticked, all of which land on a public profile a minute later.
//
// The key is scoped to the signed-in account (./draftKey.ts), so a shared
// laptop never hands the next pro the previous one's answers.

// The wizard went from four steps to three (the city and category steps
// merged into one screen), which changed what a stored `step` index means -
// a v1 draft's step 2 or 3 does not point at the same panel any more. The key
// stays the same (still the same form, still worth resuming), but a draft
// without this version marker is a stranger's old shape, not a step to
// reinterpret, so it is dropped rather than guessed at.
const DRAFT_VERSION = 2;

// How long an unfinished signup is worth resuming. Past this the draft is
// stale enough that restoring it would be a surprise, not a convenience.
const DRAFT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

type Draft = ProOnboardingValues & {
  step: number;
  license: string;
  referral: string;
};

// What is actually written to storage: the draft plus when it was saved and
// the shape version it was saved under.
type StoredDraft = Draft & { savedAt: number; v: number };

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : [];
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

// Anything in storage is a previous version of this component's own write, a
// hand-edited value, or junk, so every field is re-derived rather than trusted.
// A parse failure just means "no draft".
function readDraft(userId: string): Draft | null {
  const key = proOnboardingDraftKey(userId);
  // No account id in hand, so there is no draft that can be proved to belong
  // to this person. Reading a shared key here is what handed one pro the
  // previous one's answers; see ./draftKey.ts.
  if (!key) return null;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const d = parsed as Record<string, unknown>;
    // Too old to resume, or written before savedAt existed (so its age cannot
    // be known). Drop it rather than restore a stranger's week-old answers.
    const savedAt = typeof d.savedAt === "number" ? d.savedAt : 0;
    if (!savedAt || Date.now() - savedAt > DRAFT_MAX_AGE_MS) {
      clearProOnboardingDraft(userId);
      return null;
    }
    // A draft from before the four-step wizard (no version marker, or an
    // older one) stored a `step` index against a panel layout that no longer
    // exists. Its field values are still fine, but resuming on its saved step
    // would land on the wrong screen, so it is treated as absent rather than
    // reinterpreted.
    if (d.v !== DRAFT_VERSION) {
      clearProOnboardingDraft(userId);
      return null;
    }
    return {
      step: typeof d.step === "number" ? d.step : 0,
      name: text(d.name),
      phone: text(d.phone),
      // Digits only, and no longer than the field itself accepts. The input
      // carries pattern="[0-9]{5,8}", and neither that nor maxLength applies
      // to a value React sets as defaultValue - so a draft written before
      // this cap (the field used to allow 50 characters) restored a value the
      // browser then refused to submit, with the pro left staring at a field
      // that looks filled in and a form that will not advance. Normalize on
      // the way out of storage instead.
      license: text(d.license).replace(/\D+/g, "").slice(0, 8),
      referral: text(d.referral),
      cities: stringList(d.cities),
      categories: stringList(d.categories),
    };
  } catch {
    return null;
  }
}

// DRAFT LIFETIME, and why the wizard does not clear its own draft on submit.
//
// advance() used to clear the draft the instant the last step validated,
// BEFORE saveCompanyAction had done anything. The happy path leaves through a
// server redirect to /pro, so that looked like the only moment left to clear
// it - but the unhappy path does not leave at all: a rejected save (the CSLB
// round trip times out, the insert fails, the network drops) re-renders this
// same form, and by then the safety net it was supposed to have was already
// gone. The pro retyped everything, which is precisely what the draft exists
// to prevent.
//
// So the submit deletes nothing, and the clearing happens on the far side of a
// save that actually worked: /pro renders ClearOnboardingDraft
// (../ClearOnboardingDraft.tsx), which removes this account's key on mount.
// Reaching /pro at all means a contractors row exists, which is the only
// honest proof the signup went through.
//
// The one end state in this file that IS final clears it directly: the
// waitlist panel below, where the signup is over either way.

// The live answers, read off the DOM rather than mirrored into React state.
// Everything the gate needs is already a named form control - CategoryPicker
// posts its picks as hidden `categories` inputs and LaunchCityCheckboxes posts
// `service_cities` - so FormData is the one source of truth, and neither picker
// needs a second "tell the parent what you selected" channel.
function readValues(form: HTMLFormElement): ProOnboardingValues {
  const data = new FormData(form);
  return {
    name: String(data.get("name") ?? ""),
    phone: String(data.get("contact_phone") ?? ""),
    cities: data.getAll("service_cities").map(String),
    categories: data.getAll("categories").map(String),
  };
}

// Needs its own component because useFormStatus only reports pending state
// inside a descendant of the <form> it belongs to, not the component
// rendering the form itself.
function WizardFooter({
  step,
  onBack,
  onNext,
}: {
  step: number;
  onBack: () => void;
  onNext: (event: ReactMouseEvent<HTMLButtonElement>) => void;
}) {
  // `data` is the FormData of the submission in flight, so the button can say
  // what the wait is actually FOR without the parent mirroring the license
  // field into state: saveCompanyAction calls the CSLB when a number was
  // typed, and that round trip is the slow part. Blank number, no CSLB call,
  // so promising one would be a lie.
  const { pending, data } = useFormStatus();
  const last = step === LAST_STEP;
  const checkingLicense =
    String(data?.get("license_number") ?? "").trim().length > 0;
  return (
    // data-wizard-nav marks this row off from the form-wide "the pro touched
    // something, clear the error" handler, which would otherwise wipe the
    // message the Next button just set on its way up the tree.
    <div
      data-wizard-nav
      className="mt-8 flex gap-3 border-t border-stone-100 pt-5 dark:border-white/10"
    >
      {/* Back disappears while the submit is in flight rather than sitting
          there disabled: it is already unusable, and on a 390px screen the two
          buttons split the row in half, which is not enough for the CSLB
          message the Finish button switches to. */}
      {step > 0 && !pending && (
        <button
          type="button"
          onClick={onBack}
          aria-label={`Back to step ${step} of ${PRO_ONBOARDING_STEP_COUNT}`}
          className="btn-secondary flex-1 sm:flex-none sm:px-6"
        >
          Back
        </button>
      )}
      {/* Only the last step's button is a submit control, so a stray Enter or
          click on an earlier step can never post a half-filled form. */}
      <button
        type={last ? "submit" : "button"}
        onClick={onNext}
        disabled={pending}
        className="btn-primary flex-1 sm:ml-auto sm:flex-none sm:px-6"
      >
        {pending && <InlineSpinner />}
        {pending && last
          ? checkingLicense
            ? "Checking your license with the CSLB..."
            : "Saving..."
          : last
          ? "Finish setup"
          : "Next"}
      </button>
    </div>
  );
}

// Honest end state for a pro whose signup carried no served city:
// saveCompanyAction (../actions.ts) redirects here with ?waitlisted=1 instead
// of dumping them back on this blank form having lost every field they typed.
//
// The form itself can no longer produce this: the service-area question is now
// a checkbox per launch city with at least one required to leave that step, so
// there is no "No, I'm outside your area" answer to give. Kept because
// saveCompanyAction still falls back here for a post that carries no
// service-area answer at all (not a browser), and because it is the panel to
// reuse the moment an out-of-area path exists again.
// Same tone as the homeowner out_of_area step
// (src/app/onboarding/OnboardingForm.tsx): state plainly what happened, and
// always leave a working way out.
function WaitlistedPanel({ userId }: { userId: string }) {
  // Reaching this means the signup is over one way or the other, so the draft
  // has nothing left to protect: this pro is on the waitlist, not going back
  // through the wizard. The one end state that is genuinely final, so the one
  // place the wizard still clears it itself.
  useEffect(() => {
    clearProOnboardingDraft(userId);
  }, [userId]);

  return (
    <div className="space-y-4 overflow-hidden rounded-2xl border border-stone-200 bg-white px-6 py-10 text-center shadow-sm dark:border-white/10 dark:bg-stone-800">
      <div className="flex justify-center">
        <Hammer className="h-8 w-8 text-bark-700 dark:text-bark-400" aria-hidden="true" />
      </div>
      <h1 className="text-2xl font-semibold text-stone-900 dark:text-stone-100">
        You&apos;re on the waitlist
      </h1>
      <p className="text-sm text-stone-600 dark:text-stone-300">
        Hearth is matching pros in {LAUNCH_AREA_LABEL} right now. We added you
        to the waitlist and will reach out when Hearth opens in your area.
      </p>
      <p className="text-sm text-stone-500 dark:text-stone-400">
        There&apos;s nothing else to set up here yet since Hearth covers{" "}
        {LAUNCH_AREA_LABEL} right now. We&apos;ll reach out when that changes.
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

// First-time company setup, as a three-step wizard on one phone-width card.
//
// ONE FORM, THREE PANELS. Every panel stays mounted inside the single
// <form action={saveCompanyAction}> and the inactive ones carry the `hidden`
// attribute, which hides them from sight and from the tab order but NOT from
// the submit: only disabled controls are left out of a form post. That is what
// keeps saveCompanyAction, its hidden markers (service_state, the
// service_cities_present marker, CategoryPicker's repeated `categories`
// inputs) and its server-side floors working exactly as they did when this was
// one long two-column form.
//
// The cost of that layout is native validation: a `required` control inside a
// hidden panel blocks the submit with a message the browser can neither show
// nor focus. So `required` is set per step (it only ever sits on the panel the
// pro is looking at) and the real gate is ./wizardSteps.ts, run on Next, on
// Enter and again on Finish. saveCompanyAction still enforces the same floors
// server-side for anything that isn't a browser.
//
// Wrapped in its own Suspense boundary below because useSearchParams needs
// one; kept self-contained here rather than threading the query param through
// the server page, so this file alone covers both the form and its honest
// waitlisted end state.
function OnboardingCompanyFormInner({
  userId,
  defaultEmail,
  defaultReferralCode = "",
}: {
  // The signed-in account's id, from the server page. The draft key is scoped
  // to it (./draftKey.ts) so a browser two pros share never prefills one of
  // them with the other's company details. Empty string when the page could
  // not read a user, which falls back to the old unscoped key.
  userId: string;
  defaultEmail: string;
  defaultReferralCode?: string;
}) {
  const searchParams = useSearchParams();
  const waitlisted = searchParams.get("waitlisted") === "1";

  const formRef = useRef<HTMLFormElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  // Nothing should steal focus on first paint; only a step change should.
  const movedRef = useRef(false);

  const [step, setStep] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  // Bumped once when a draft is restored. Every field below is uncontrolled
  // (PhoneInput, CategoryPicker and LaunchCityCheckboxes all seed themselves
  // from a default prop), so remounting them with this key is what lets saved
  // values become their defaults without turning the whole form into
  // controlled state or risking a hydration mismatch on first render.
  const [restoreKey, setRestoreKey] = useState(0);
  const [showReferral, setShowReferral] = useState(
    defaultReferralCode.trim().length > 0
  );

  // ONE RESTORE, EVER, AND ONLY INTO A FORM NOBODY HAS ANSWERED YET.
  //
  // Restoring bumps restoreKey, which REMOUNTS CategoryPicker and
  // LaunchCityCheckboxes (their picks live in their own state, seeded once
  // from a prop). A remount throws away whatever the pro has selected and
  // re-seeds it from the draft snapshot - which is fine on a blank form and is
  // a bug the moment it happens a beat late. That is the "I picked Plumbing,
  // used the city list, hit Next, and it said pick a type of work with the
  // chip cleared" report: the pro's tap landed on a form whose restore had not
  // run yet (a Suspense boundary hydrates on its own schedule, and this one is
  // hydrated by the very tap that gets replayed into it), so the restore
  // wiped it.
  //
  // Two guards, because they cover different halves. restoredRef makes it
  // one-shot no matter what re-runs this effect - a changed userId identity, a
  // remount, StrictMode's double invoke. The live-values check makes it
  // harmless even when it does run late: if the form already holds an answer,
  // the pro is ahead of the draft and the draft has nothing to give them.
  // Cities are deliberately not consulted - LaunchCityCheckboxes starts on
  // "All of Orange County", so every untouched form already posts all 36.
  const restoredRef = useRef(false);
  useEffect(() => {
    // Restore in an effect rather than in the initial state, so the
    // server-rendered blank form and the first client render still match.
    // Reaching this component at all means no contractors row exists yet, so
    // any draft still sitting here belongs to a signup that never landed -
    // exactly what the pro needs back.
    if (waitlisted || restoredRef.current) return;
    const form = formRef.current;
    if (form) {
      const live = readValues(form);
      if (
        live.name.trim() ||
        live.phone.trim() ||
        live.categories.some((c) => c.trim())
      ) {
        // Already being filled in by hand. Leave it alone, and never come
        // back: the draft keeps saving underneath, so nothing is lost.
        restoredRef.current = true;
        return;
      }
    }
    const saved = readDraft(userId);
    if (!saved) return;
    restoredRef.current = true;
    setDraft(saved);
    setRestoreKey((k) => k + 1);
    setStep(resumeProOnboardingStep(saved.step, saved));
    if (saved.referral.trim()) setShowReferral(true);
  }, [waitlisted, userId]);

  const persist = useCallback((atStep: number) => {
    const form = formRef.current;
    if (!form) return;
    const storageKey = proOnboardingDraftKey(userId);
    // Same rule as readDraft: with no account id there is no key this pro
    // could ever read back, and the shared one this used to fall back to
    // belonged to whoever signed in next.
    if (!storageKey) return;
    const data = new FormData(form);
    const field = (key: string, max: number) =>
      String(data.get(key) ?? "").slice(0, max);
    const next: StoredDraft = {
      savedAt: Date.now(),
      v: DRAFT_VERSION,
      step: atStep,
      name: field("name", 200),
      phone: field("contact_phone", 40),
      license: field("license_number", 50),
      referral: field("referral_code", 100),
      cities: data.getAll("service_cities").map(String),
      categories: data.getAll("categories").map(String).slice(0, 40),
    };
    try {
      localStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      // Storage full or blocked. Losing the draft is survivable; failing the
      // keystroke is not.
    }
  }, [userId]);

  // ALWAYS SAVE AFTER THE RENDER THE EVENT CAUSED, NEVER DURING IT.
  //
  // persist() reads the answers straight off the DOM, and a React event
  // handler runs BEFORE React has re-rendered anything that handler changed.
  // Saving from inside one can therefore store the form as it was a moment
  // ago. The click path already knew this - CategoryPicker's picks are hidden
  // inputs that only exist after the next render, which is why it deferred -
  // but the change path saved inline, and the controls it fires for change
  // what the form POSTS just as much: the "All of Orange County" row swaps 36
  // hidden city inputs for a list of checkboxes. One helper now, so both paths
  // are late by the same tick and a draft always mirrors the form the pro can
  // actually see.
  const schedulePersist = useCallback(
    (atStep: number) => {
      window.setTimeout(() => persist(atStep), 0);
    },
    [persist]
  );

  const goTo = useCallback(
    (next: number) => {
      movedRef.current = true;
      setStep(next);
      setError(null);
      schedulePersist(next);
    },
    [schedulePersist]
  );

  // The gate. Called by the Next/Finish button (which passes its click event so
  // an invalid last step can cancel the native submit) and by the Enter key
  // (which passes nothing, so a valid last step submits from here).
  const advance = useCallback(
    (event?: { preventDefault: () => void }) => {
      const form = formRef.current;
      if (!form) return;
      const values = readValues(form);

      const message = validateProOnboardingStep(step, values);
      if (message) {
        event?.preventDefault();
        setError(message);
        return;
      }
      if (step < LAST_STEP) {
        event?.preventDefault();
        goTo(step + 1);
        return;
      }
      // Finishing checks every step, not just this one: the pro can walk back
      // and clear a field they already filled, and a dead Finish button with no
      // explanation is the worst possible answer to that.
      const gap = firstInvalidProOnboardingStep(values);
      if (gap !== null) {
        event?.preventDefault();
        goTo(gap);
        setError(validateProOnboardingStep(gap, values));
        return;
      }
      // Valid on the last step, so this signup is on its way to the server.
      // The draft is deliberately KEPT here: the save can still be refused,
      // and this form is what the pro comes back to when it is. /pro clears it
      // once a contractors row proves the save landed - see the draft-lifetime
      // comment above.
      // A click just lets the submit button do its job (so useFormStatus sees
      // the pending action); Enter has to ask.
      if (!event) form.requestSubmit();
    },
    [goTo, step]
  );

  useEffect(() => {
    if (!movedRef.current) return;
    // Moves the screen reader (and the phone's scroll position) to the new
    // step's heading rather than leaving both where the old panel used to be.
    headingRef.current?.focus();
  }, [step]);

  if (waitlisted) return <WaitlistedPanel userId={userId} />;

  const current = PRO_ONBOARDING_STEPS[step];

  return (
    <form
      ref={formRef}
      action={saveCompanyAction}
      onKeyDown={(e) => {
        // Enter belongs to the wizard, not to the form: in a one-input step a
        // browser would otherwise post the whole thing from step 1.
        if (e.key !== "Enter") return;
        const target = e.target as HTMLElement | null;
        if (!target || target.tagName !== "INPUT") return;
        e.preventDefault();
        advance();
      }}
      onChange={() => {
        setError(null);
        // Deferred for the same reason as the click below: a checkbox that
        // changes what the form POSTS (the "All of Orange County" row swaps 36
        // hidden inputs for a list) has not re-rendered yet at this point.
        schedulePersist(step);
      }}
      onClick={(e) => {
        // Category cards are buttons, so they never fire a change event and
        // this is the only place their picks get saved. Deferred by a tick
        // because CategoryPicker renders its picks as hidden inputs: at the
        // moment this bubbled handler runs, the click that changed them has
        // not been painted yet, so reading FormData now would save the
        // selection from before the click.
        if ((e.target as HTMLElement | null)?.closest("[data-wizard-nav]")) {
          return;
        }
        setError(null);
        schedulePersist(step);
      }}
      className="rounded-2xl border border-stone-200 bg-white p-5 shadow-sm sm:p-6 dark:border-white/10 dark:bg-stone-800"
    >
      <div className="flex items-center justify-between gap-3">
        <span className="inline-flex items-center gap-2 text-xs font-medium text-stone-500 dark:text-stone-400">
          <Hammer className="h-4 w-4 text-bark-700 dark:text-bark-400" aria-hidden="true" />
          Set up your company
        </span>
        <span className="text-xs text-stone-500 dark:text-stone-400">
          Step {step + 1} of {PRO_ONBOARDING_STEP_COUNT}
        </span>
      </div>

      {/* Progress. Decorative: the "Step 2 of 3" line above already says this
          out loud, so the bars stay out of the accessibility tree. */}
      <div className="mt-3 flex gap-1.5" aria-hidden="true">
        {PRO_ONBOARDING_STEPS.map((s, i) => (
          <span
            key={s.id}
            className={`h-1 flex-1 rounded-full ${
              i <= step
                ? "bg-bark-600 dark:bg-bark-400"
                : "bg-stone-200 dark:bg-white/10"
            }`}
          />
        ))}
      </div>

      <h1
        ref={headingRef}
        tabIndex={-1}
        className="mt-5 text-xl font-semibold text-stone-900 outline-none dark:text-stone-100"
      >
        {current.title}
      </h1>
      <p className="mb-5 mt-1 text-sm text-stone-500 dark:text-stone-400">
        {current.blurb}
      </p>

      {/* Step 1: about your business */}
      <div hidden={step !== 0} className="space-y-4">
        <div>
          <label className="label" htmlFor="company-name">
            Company name{" "}
            <span className="font-normal text-stone-500 dark:text-stone-400">
              (as it appears on your license)
            </span>
          </label>
          <div className="relative">
            <FieldIcon>
              <path d="M4 21V5l8-2 8 2v16M9 9h.01M9 13h.01M15 9h.01M15 13h.01M10 21v-4h4v4" />
            </FieldIcon>
            <input
              key={`name-${restoreKey}`}
              id="company-name"
              name="name"
              className="input pl-9"
              placeholder="e.g. Acme Home Services"
              autoComplete="organization"
              maxLength={200}
              defaultValue={draft?.name ?? ""}
              required={step === 0}
            />
          </div>
        </div>

        <div>
          <label className="label" htmlFor="company-phone">
            Phone number
          </label>
          <div className="relative">
            <FieldIcon>
              <path d="M22 16.9v3a2 2 0 01-2.2 2 19.8 19.8 0 01-8.6-3.1 19.5 19.5 0 01-6-6A19.8 19.8 0 012 4.2 2 2 0 014 2h3a2 2 0 012 1.7c.1.9.4 1.8.7 2.6a2 2 0 01-.5 2.1L8.1 9.8a16 16 0 006 6l1.4-1.1a2 2 0 012.1-.5c.8.3 1.7.6 2.6.7a2 2 0 011.7 2z" />
            </FieldIcon>
            <PhoneInput
              key={`phone-${restoreKey}`}
              id="company-phone"
              name="contact_phone"
              className="input pl-9"
              defaultValue={draft?.phone ?? ""}
              required={step === 0}
            />
          </div>
          <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
            Homeowners call this number after they pick you.
          </p>
        </div>

        <div>
          <label className="label" htmlFor="company-email">
            Email address
          </label>
          <div className="relative">
            <FieldIcon>
              <path d="M4 4h16v16H4zM4 6l8 6 8-6" />
            </FieldIcon>
            {/* Read-only, not disabled: a disabled field posts nothing, and
                saveCompanyAction reads contact_email off this form. */}
            <input
              id="company-email"
              name="contact_email"
              type="email"
              readOnly
              className="input cursor-not-allowed bg-stone-100 pl-9 text-stone-500 dark:bg-stone-700 dark:text-stone-400"
              defaultValue={defaultEmail}
            />
          </div>
          <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
            The email on your account. You can change it later in your profile.
          </p>
        </div>
      </div>

      {/* Step 2: where and what, on one scrolling screen. Two small
          sub-headings (cities, then trades) replace what used to be two
          separate steps, so the tap count drops without losing the two
          questions - each still gates the step on its own in
          ./wizardSteps.ts, cities checked first. */}
      <div hidden={step !== 1} className="space-y-5">
        <div>
          <h2 className="text-sm font-semibold text-stone-700 dark:text-stone-300">
            Where you work
          </h2>
          <fieldset className="mt-2">
            <legend className="label">Which of these cities do you serve?</legend>
            {/* requireOne only while this panel is on screen: a `required`
                checkbox in a hidden panel would block the final submit with a
                message the browser cannot show. wizardSteps.ts enforces the
                same rule on the way out of this step. */}
            <LaunchCityCheckboxes
              key={`cities-${restoreKey}`}
              defaultCities={draft?.cities ?? []}
              requireOne={step === 1}
            />
          </fieldset>
          <p className="mt-2 text-xs text-stone-500 dark:text-stone-400">
            Hearth matches pros across all of Orange County. Keep the whole
            county, or narrow it to the cities you actually drive to. You can
            change this from your profile any time.
          </p>
        </div>

        <div>
          <label className="label">State you serve</label>
          <div className="relative">
            <FieldIcon>
              <path d="M3 6l6-3 6 3 6-3v15l-6 3-6-3-6 3zM9 3v15M15 6v15" />
            </FieldIcon>
            {/* Locked to California while Hearth serves CA only. The hidden
                input still posts service_state=CA, the two-letter code
                saveCompanyAction and the CSLB check expect. */}
            <div className="input cursor-not-allowed select-none bg-stone-100 pl-9 text-stone-500 dark:bg-stone-700 dark:text-stone-400">
              California (CA)
            </div>
            <input type="hidden" name="service_state" value="CA" />
          </div>
          <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
            Hearth serves California only right now, so this is set for you.
          </p>
        </div>

        <div>
          <h2 className="text-sm font-semibold text-stone-700 dark:text-stone-300">
            What you do
          </h2>
          <div className="mt-2">
            <CategoryPicker
              key={`categories-${restoreKey}`}
              defaultSelected={draft ? [...draft.categories] : []}
            />
          </div>
          <p className="mt-2 text-xs text-stone-500 dark:text-stone-400">
            Pick every area your company handles. Not listed? Describe it
            under Other.
          </p>
        </div>
      </div>

      {/* Step 3: almost done */}
      <div hidden={step !== 2} className="space-y-4">
        <div>
          <label className="label" htmlFor="license-number">
            State license number
          </label>
          <div className="relative">
            <FieldIcon>
              <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8zM14 2v6h6M9 13h6M9 17h6" />
            </FieldIcon>
            <input
              key={`license-${restoreKey}`}
              id="license-number"
              name="license_number"
              className="input pl-9"
              placeholder="1029384"
              inputMode="numeric"
              pattern="[0-9]{5,8}"
              onChange={(e) => {
                const stripped = e.target.value.replace(/\s+/g, "");
                if (stripped !== e.target.value) e.target.value = stripped;
              }}
              maxLength={8}
              defaultValue={draft?.license ?? ""}
            />
          </div>
          <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
            Optional. Your CSLB license number, digits only. We check it
            against the CSLB for a verified badge.
          </p>
        </div>

        {/* Referral codes are the exception, not the rule, so the field stays
            folded away unless the pro says they have one - or unless they
            arrived on a ?ref= link, in which case it is already filled in and
            hiding it would look like the code was dropped. */}
        {showReferral ? (
          <div>
            <label className="label" htmlFor="referral-code">
              Referral code
            </label>
            <div className="relative">
              <FieldIcon>
                <path d="M20 8h-9M20 8a2 2 0 012 2v9a2 2 0 01-2 2H4a2 2 0 01-2-2v-9a2 2 0 012-2h3M20 8V6a2 2 0 00-2-2h-2M9 12h6" />
              </FieldIcon>
              <input
                key={`referral-${restoreKey}`}
                id="referral-code"
                name="referral_code"
                className="input pl-9"
                maxLength={100}
                defaultValue={draft?.referral || defaultReferralCode}
                placeholder="From the pro who invited you"
              />
            </div>
            <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
              You both get $25 of application credit when you win your first
              job.
            </p>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setShowReferral(true)}
            className="text-sm font-medium text-bark-700 hover:underline dark:text-bark-400"
          >
            Have a referral code?
          </button>
        )}
      </div>

      {error && (
        <p
          role="alert"
          className="mt-4 text-sm text-red-600 dark:text-red-400"
        >
          {error}
        </p>
      )}

      <WizardFooter
        step={step}
        onBack={() => goTo(Math.max(step - 1, 0))}
        onNext={advance}
      />
    </form>
  );
}

export default function OnboardingCompanyForm(props: {
  userId: string;
  defaultEmail: string;
  defaultReferralCode?: string;
}) {
  return (
    <Suspense fallback={null}>
      <OnboardingCompanyFormInner {...props} />
    </Suspense>
  );
}
