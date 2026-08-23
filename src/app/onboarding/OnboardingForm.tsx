"use client";

import NoticeAtCollection from "@/components/NoticeAtCollection";
import { useCallback, useEffect, useRef, useState } from "react";
import { lookupParcelAction, claimPropertyAction, joinMarketWaitlistAction } from "./actions";
import type { PublicParcelFacts } from "@/lib/parcel";
import {
  clearHomeOnboardingDraft,
  readHomeOnboardingDraft,
  writeHomeOnboardingDraft,
  type HomeOnboardingDraft,
} from "./draft";
import { PROPERTY_TYPES, FOUNDER } from "@/lib/constants";
import {
  isLaunchZip,
  LAUNCH_AREA_LABEL,
  LAUNCH_ONLY_MESSAGE,
} from "@/lib/serviceArea";
import {
  MIN_SUGGEST_QUERY,
  SUGGEST_LIMIT,
  type AddressSuggestion,
} from "@/lib/addressSuggest";
import { Hammer, Bell, FileText } from "lucide-react";

// LAUNCH_ONLY_MESSAGE used to be duplicated here by hand, because ./actions.ts
// is a "use server" file and can only export async functions to a client
// component like this one. It now lives in @/lib/serviceArea alongside the ZIP
// map both sides gate on, so there is exactly one copy of the wording.

// A trimmed length floor for "this is actually an address," not just "this
// field isn't literally empty." Browsers treat a single space as satisfying
// an <input required> constraint, so relying on that alone let a hasty Enter
// press (or a stray keystroke) sail an unusable address like " " or "123"
// straight through to a claimed home. Matches the floor enforced server-side
// in claimPropertyAction/lookupParcelAction (./actions.ts) - the server copy
// is the one that actually matters, this one just gives faster feedback.
const MIN_ADDRESS_LENGTH = 5;

// And a ceiling on the same field, now that it is a real editable input
// posting straight to claimPropertyAction rather than a hidden copy of a
// looked-up value. Generous against any real street line.
const MAX_ADDRESS_LENGTH = 200;

// The condo/townhome unit box. Short by design - a real designator is "4B",
// "Apt 12", "Ste 300" - and matched by MAX_UNIT in ./actions.ts, which is the
// ceiling that actually holds.
const MAX_UNIT_LENGTH = 20;

// How long the street box has to sit still before it asks for suggestions.
// Long enough that a normal typing burst is one request instead of a dozen,
// short enough that the list arrives while the finger is still on the phone.
const SUGGEST_DEBOUNCE_MS = 250;

// The optional facts behind the "know more details" disclosure are all plain
// number fields. An empty one means "I don't know," which is null, not 0.
function numberField(value: FormDataEntryValue | null): number | null {
  const s = String(value ?? "").trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function textField(value: FormDataEntryValue | null, max: number): string {
  return String(value ?? "").slice(0, max);
}

export default function OnboardingForm({
  next,
  referralCode,
  existingName,
}: {
  next?: string | null;
  // The inviter's referral code (migration 0099), carried through from the
  // sign-up link and posted as a hidden field so claimPropertyAction can
  // attribute this first home claim. Null for the ordinary, non-invited signup.
  referralCode?: string | null;
  // The name already on file for this account, if any. Google signups arrive
  // with their name backfilled server-side (src/app/auth/callback/route.ts),
  // and anyone who set a name in account settings has one too. Used to
  // prefill the full-name field once the address is confirmed, so a user with
  // a name on file isn't asked for it again. Empty string for a fresh email
  // signup, which no longer collects a name up front.
  existingName?: string;
}) {
  // One screen, two phases. "address" is the editable street/unit/ZIP entry;
  // "ready" is the same screen with those fields locked read-only and the
  // rest of the claim (name, optional details, the ownership disclosure, the
  // claim button) expanded in place below them. "out_of_area" is the
  // waitlist end state, which replaces the whole card rather than expanding
  // it.
  const [step, setStep] = useState<"address" | "ready" | "out_of_area">(
    "address"
  );
  const [street, setStreet] = useState("");
  // Optional condo/townhome unit. Stored in its own properties.unit column
  // (migration 0127) rather than glued onto the street, so the parcel lookup
  // and the assessor ownership match still run against the street line.
  const [unit, setUnit] = useState("");
  const [zip, setZip] = useState("");
  const [facts, setFacts] = useState<PublicParcelFacts | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The records source ran and knows nothing about the typed address. A
  // separate flag from `error` because this one refusal gets an escape hatch
  // under it ("Try another address") - every other error is something a retry
  // or a correction fixes in place.
  const [notFound, setNotFound] = useState(false);
  // Suggestions for the street box (/api/address-suggest, backed by Photon).
  // Purely a typing aid: the list being empty - Photon down, rate limited,
  // nothing matched - changes nothing about how the form works.
  const [suggestions, setSuggestions] = useState<AddressSuggestion[]>([]);
  // Which suggestion the arrow keys have landed on, -1 for none. Drives
  // aria-activedescendant, so a screen reader announces the option the sighted
  // user sees highlighted.
  const [activeSuggestion, setActiveSuggestion] = useState(-1);
  // The city from a picked suggestion, used only as the fallback default for
  // the optional City box on the ready step when the records lookup didn't
  // return one. The lookup's city wins whenever it has one.
  const [pickedCity, setPickedCity] = useState<string | null>(null);
  // Set right before the street box is changed by something other than a
  // keystroke - picking a suggestion, or the lookup writing back the county's
  // canonical line. Without it, filling the box would immediately fire a
  // search for the value just filled in and re-open the list under it.
  const suppressSuggestRef = useRef(false);
  // Whether the out-of-area waitlist save actually went through - drives the
  // honest vs. "we couldn't save you" copy on the out_of_area panel below.
  const [waitlistSaved, setWaitlistSaved] = useState(true);
  // Set right before a fresh lookup succeeds, if the name field is about to
  // render empty. Consumed by the effect below the moment the ready section
  // actually mounts - never set on a draft restore, only on a lookup that
  // just returned.
  const [autofocusName, setAutofocusName] = useState(false);
  const fullNameRef = useRef<HTMLInputElement>(null);

  // The saved draft (./draft.ts), in two shapes with two different jobs.
  //
  // `draft` state: the value the ready section's UNCONTROLLED name field
  // seeds itself with when it mounts. Set once on restore and again on a
  // fresh lookup, never on a keystroke, so typing never fights the input.
  //
  // `draftRef`: the live mirror that gets written to storage. A ref, because a
  // keystroke should cost a localStorage write and nothing else - no re-render.
  const [draft, setDraft] = useState<HomeOnboardingDraft | null>(null);
  const draftRef = useRef({
    step: "address" as "address" | "ready",
    street: "",
    unit: "",
    zip: "",
    fullName: "",
    addressLine1: "",
    facts: null as PublicParcelFacts | null,
  });
  // Bumped when a draft is restored, so the ready section's uncontrolled name
  // field remounts and picks up the saved value as its default. Same trick as
  // the pro wizard (src/app/pro/onboarding/OnboardingCompanyForm.tsx): restoring
  // in an effect keeps the first client render identical to the server's, so
  // there is no hydration mismatch.
  const [restoreKey, setRestoreKey] = useState(0);

  const persist = useCallback(
    (patch: Partial<typeof draftRef.current>) => {
      const next = { ...draftRef.current, ...patch };
      draftRef.current = next;
      // An emptied-out form is not a draft. Clearing rather than saving
      // "" keeps a stale key from sitting in storage for a week after someone
      // deliberately wipes the fields or starts over.
      if (
        next.step === "address" &&
        !next.facts &&
        !next.street.trim() &&
        !next.unit.trim() &&
        !next.zip.trim() &&
        !next.fullName.trim()
      ) {
        clearHomeOnboardingDraft();
        return;
      }
      writeHomeOnboardingDraft(next, Date.now());
    },
    []
  );

  // Restore on mount, in an effect rather than in the initial state, so the
  // server-rendered blank form and the first client render still match.
  useEffect(() => {
    const saved = readHomeOnboardingDraft(Date.now());
    if (!saved) return;
    draftRef.current = {
      step: saved.step,
      street: saved.street,
      unit: saved.unit,
      zip: saved.zip,
      fullName: saved.fullName,
      addressLine1: saved.addressLine1,
      facts: saved.facts,
    };
    setDraft(saved);
    setRestoreKey((k) => k + 1);
    setStreet(saved.street);
    setUnit(saved.unit);
    setZip(saved.zip);
    // Only a draft that carries the looked-up facts can resume expanded;
    // parseHomeOnboardingDraft already downgrades the rest to "address".
    if (saved.step === "ready" && saved.facts) {
      setFacts(saved.facts);
      setStep("ready");
    }
  }, []);

  // Save the address fields as they are typed. The comparison against the
  // mirror is what keeps this effect from writing on mount (and from
  // overwriting a just-restored draft with the empty values of the render
  // before it): it only fires once the fields actually differ from what was
  // last saved. Once the fields are locked read-only (step "ready") nothing
  // changes them, so this simply stops firing.
  useEffect(() => {
    if (
      street === draftRef.current.street &&
      unit === draftRef.current.unit &&
      zip === draftRef.current.zip
    ) {
      return;
    }
    persist({ street, unit, zip });
  }, [street, unit, zip, persist]);

  // Save the expanded section as it is edited - the name, and the optional
  // facts behind the disclosure - so nothing typed there is lost either.
  // Reads the form rather than mirroring every field into state. Only called
  // while the ready section is actually mounted (see the form's onChange
  // below), so it never fires for a keystroke on the still-editable address
  // fields.
  const persistReady = useCallback(
    (form: HTMLFormElement) => {
      const data = new FormData(form);
      const current = draftRef.current.facts;
      persist({
        step: "ready",
        fullName: textField(data.get("full_name"), 200),
        facts: current
          ? {
              ...current,
              city: textField(data.get("city"), 120) || null,
              state: textField(data.get("state"), 60) || null,
              zip: textField(data.get("zip"), 10) || null,
              year_built: numberField(data.get("year_built")),
              sqft: numberField(data.get("sqft")),
              beds: numberField(data.get("beds")),
              baths: numberField(data.get("baths")),
              lot_size_sqft: numberField(data.get("lot_size_sqft")),
              property_type: textField(data.get("property_type"), 60) || null,
            }
          : null,
      });
    },
    [persist]
  );

  // Ask for suggestions once the street box has been still for a moment.
  //
  // Only while the address fields are actually editable (step "address") -
  // after the lookup the street box is a correction field for a line the
  // county already returned, and dropping an autocomplete list over it there
  // would invite re-picking a different house than the one on screen.
  //
  // Every failure path lands on an empty list, never an error: this is a
  // convenience over a free third-party geocoder, and the address has always
  // been typeable by hand.
  useEffect(() => {
    if (step !== "address") {
      setSuggestions([]);
      setActiveSuggestion(-1);
      return;
    }
    // The box was filled in programmatically. Consume the flag and stay quiet
    // for this one change; the next real keystroke searches normally.
    if (suppressSuggestRef.current) {
      suppressSuggestRef.current = false;
      setSuggestions([]);
      setActiveSuggestion(-1);
      return;
    }
    const q = street.trim();
    if (q.length < MIN_SUGGEST_QUERY) {
      setSuggestions([]);
      setActiveSuggestion(-1);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const params = new URLSearchParams({ q });
        // The ZIP is often typed before the street is finished, and it is what
        // lets the route name a city in the Photon query - which is the
        // difference between "9832 Bol" matching nothing and matching Bolsa
        // Avenue. Sent when present, never required.
        const z = zip.trim();
        if (z) params.set("zip", z);
        const res = await fetch(`/api/address-suggest?${params.toString()}`, {
          signal: controller.signal,
        });
        if (!res.ok) {
          setSuggestions([]);
          return;
        }
        const body = await res.json();
        setSuggestions(
          Array.isArray(body?.suggestions)
            ? body.suggestions.slice(0, SUGGEST_LIMIT)
            : []
        );
        setActiveSuggestion(-1);
      } catch {
        // Aborted by the next keystroke, or the network failed. Either way
        // there is nothing to show and nothing to say about it.
        setSuggestions([]);
      }
    }, SUGGEST_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [street, zip, step]);

  // Fill the street, ZIP and city from a chosen suggestion. The lookup is NOT
  // run here: Continue still does that, so picking a suggestion is exactly as
  // reversible as typing one.
  const pickSuggestion = useCallback((s: AddressSuggestion) => {
    suppressSuggestRef.current = true;
    setStreet(s.line1);
    setZip(s.zip);
    setPickedCity(s.city);
    setSuggestions([]);
    setActiveSuggestion(-1);
    setError(null);
    setNotFound(false);
  }, []);

  const closeSuggestions = useCallback(() => {
    setSuggestions([]);
    setActiveSuggestion(-1);
  }, []);

  // "Start over": drop the saved draft and every field with it, back to a
  // blank address entry.
  const startOver = useCallback(() => {
    draftRef.current = {
      step: "address",
      street: "",
      unit: "",
      zip: "",
      fullName: "",
      addressLine1: "",
      facts: null,
    };
    clearHomeOnboardingDraft();
    setDraft(null);
    setRestoreKey((k) => k + 1);
    setStreet("");
    setUnit("");
    setZip("");
    setFacts(null);
    setError(null);
    setNotFound(false);
    setPickedCity(null);
    setSuggestions([]);
    setActiveSuggestion(-1);
    setStep("address");
  }, []);

  // "Edit": collapses the expanded section back and unlocks the address
  // fields, without losing what was typed below - a fresh Continue re-runs
  // the lookup (a cache hit if the address didn't actually change) and
  // re-expands with everything still in place.
  const handleEdit = useCallback(() => {
    setError(null);
    setNotFound(false);
    // Coming back from the ready step, the street box already holds the
    // county's canonical line. Don't drop a list of alternatives over it the
    // instant the fields unlock - the next keystroke opens one normally.
    suppressSuggestRef.current = true;
    persist({ step: "address" });
    setStep("address");
  }, [persist]);

  // Once the ready section actually mounts with an empty name field, put the
  // cursor there - one fewer tap than making someone find and click it
  // themselves right after a lookup.
  useEffect(() => {
    if (step === "ready" && autofocusName) {
      fullNameRef.current?.focus();
      setAutofocusName(false);
    }
  }, [step, autofocusName]);

  async function runLookup() {
    setError(null);
    setNotFound(false);
    closeSuggestions();

    // Catch the "just whitespace" / "a few stray characters" case here before
    // it ever reaches the expanded, claim-ready section.
    const s = street.trim();
    if (s.length < MIN_ADDRESS_LENGTH) {
      setError("Enter your home's street address to continue.");
      return;
    }
    const z = zip.trim();
    if (!/^\d{5}(-\d{4})?$/.test(z)) {
      setError("Enter a valid 5-digit ZIP code.");
      return;
    }
    // Fast client-side feedback for the launch restriction - the launch
    // cities only (isLaunchZip), not all of Orange County - so an out-of-area
    // ZIP never even reaches the server lookup. lookupParcelAction enforces
    // the same check server-side (before its RentCast call) - that's the
    // real gate, this is just quicker, kinder feedback. Because this check
    // short-circuits BEFORE lookupParcelAction ever runs, the waitlist save
    // has to happen right here too, or a rejected visitor would never
    // actually land on the list despite being told they had.
    if (!isLaunchZip(z)) {
      setBusy(true);
      try {
        const result = await joinMarketWaitlistAction(z);
        setWaitlistSaved(result.ok);
      } catch {
        // A rejected server action (network blip, server hiccup) must not
        // strand the button in its busy state - still land on the
        // out_of_area step, just with the honest "couldn't save you" copy.
        setWaitlistSaved(false);
      } finally {
        setBusy(false);
      }
      // The waitlist panel is an end state, not a step to resume into: a
      // reload should put them back on the address fields, ZIP still typed,
      // so they can try a different address.
      persist({ step: "address", facts: null });
      setStep("out_of_area");
      return;
    }

    // The unit is optional and never blocks the lookup - a blank one behaves
    // exactly as it did before this field existed.
    const u = unit.trim().slice(0, MAX_UNIT_LENGTH);

    setBusy(true);
    try {
      const result = await lookupParcelAction(s, z, u || null);
      // lookupParcelAction RETURNS its refusals rather than throwing them
      // (./actions.ts): a thrown server-action message is masked by Next in
      // production, so the launch-area message, the validation messages and the
      // rate-limit messages all used to collapse into the generic catch below.
      // Handled first, before anything reads result.facts.
      if (!result.ok) {
        // Out of area is an end state with its own panel, not an inline error.
        // The action already logged the waitlist attempt and says whether it
        // stuck, so the panel's copy is honest either way - the same signal the
        // client-side ZIP check above gets from joinMarketWaitlistAction.
        if (result.waitlisted !== undefined) {
          setWaitlistSaved(result.waitlisted);
          persist({ step: "address", facts: null });
          setStep("out_of_area");
          return;
        }
        // The records source ran and has no such address. Keep the fields
        // exactly as typed - the fix is usually one character - and mark it so
        // the message can offer a clean way out. Deliberately NOT advanced to
        // the ready step: an address nothing can find must not become a home.
        if (result.notFound) setNotFound(true);
        setError(result.error);
        return;
      }
      const nextFacts = result.facts;
      setFacts(nextFacts);
      // The line below is set programmatically, so don't let it re-trigger a
      // suggestion search for the value that was just filled in.
      suppressSuggestRef.current = true;
      // Show the county's canonical street line in the (still editable) street
      // box, rather than only in a read-only summary. RentCast normalizes
      // "17361 ash street" to "17361 Ash St", which is usually an improvement
      // and occasionally wrong - a new build the assessor still files under
      // the lot number, a street the county spells differently. Either way the
      // person who lives there is the authority, so what gets claimed is
      // whatever is in this field when they press the button.
      setStreet(nextFacts.address_line1);
      // Save the looked-up facts with the draft. A lookup can spend a billed
      // parcel call (./actions.ts), so a reload restores what came back rather
      // than quietly buying it again.
      persist({
        step: "ready",
        // The canonical line, matching what the street box now shows - so a
        // reload restores the same value the field was seeded with instead of
        // reverting to what was typed before the lookup.
        street: nextFacts.address_line1,
        unit: u,
        zip: z,
        addressLine1: nextFacts.address_line1,
        facts: nextFacts,
      });
      setDraft({ ...draftRef.current, savedAt: Date.now() });
      // Autofocus only if the name field is about to render empty - a name
      // already on file (or carried over from before an Edit) needs no cursor
      // stolen from it.
      const prefillName = draftRef.current.fullName.trim() || existingName?.trim() || "";
      setAutofocusName(!prefillName);
      setStep("ready");
    } catch {
      // A rejected server action (network blip, server hiccup) should never
      // strand the button in its busy state with no explanation.
      setError("That didn't go through. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  // Wraps the claim server action so a failure shows a friendly inline
  // message instead of throwing raw to the error boundary. A successful
  // claim redirects server-side, which is handled by the framework, not
  // caught here.
  async function onClaim(formData: FormData) {
    setError(null);

    // Fast client-side check so a blank/whitespace address never even makes
    // the round trip. claimPropertyAction enforces the same floor
    // server-side - that's the real gate, this is just quicker feedback.
    const addressLine1 = ((formData.get("address_line1") as string) ?? "").trim();
    if (addressLine1.length < MIN_ADDRESS_LENGTH) {
      setError("Enter your home's address before claiming it.");
      return;
    }

    // The claim is on its way, so the draft has done its job: drop it here
    // rather than after the fact, since a successful claim leaves this page by
    // a server-side redirect that never comes back to this function. The error
    // paths below put it back, so a claim the server refuses doesn't cost the
    // form its safety net.
    clearHomeOnboardingDraft();

    setBusy(true);
    try {
      const result = await claimPropertyAction(formData);
      // claimPropertyAction redirects to the dashboard on success (redirect()
      // throws a NEXT_REDIRECT-digest error for Next's router to catch higher
      // up), so anything it actually RETURNS here is a user-facing failure -
      // its own launch-area / validation / DB-error message. Render it inline.
      // This is the path that keeps the intentional out-of-area message
      // visible: a thrown message would be masked by Next in production.
      if (result && !result.ok) {
        setError(result.error);
        // Refused, so they are still standing on this form: give the draft
        // back before a reload can lose it.
        persist({});
      }
    } catch (err: any) {
      // Trap: the successful-claim redirect() surfaces as a NEXT_REDIRECT-digest
      // throw. A bare catch here would swallow it and report a successful claim
      // as "that didn't go through" - rethrow it so the redirect still happens.
      // Anything else is a genuine network/server blip.
      if (err?.digest?.startsWith("NEXT_REDIRECT")) throw err;
      setError("That didn't go through. Please try again.");
      persist({});
    } finally {
      setBusy(false);
    }
  }

  const readOnlyField =
    "cursor-not-allowed bg-stone-100 text-stone-500 dark:bg-stone-700 dark:text-stone-400";

  // A unit number means the county's record for this street line describes the
  // whole building, not this home - so the ownership copy below has to say
  // something different, and claimPropertyAction records the claim as
  // unverified rather than matching against the building's owner of record.
  const hasUnit = unit.trim().length > 0;

  // The list only ever exists over the editable address phase. Guarded on the
  // step as well as on the array so nothing can leave a stale list rendered
  // over the locked fields of the ready step.
  const suggestOpen = step === "address" && suggestions.length > 0;

  return (
    <div className="card">
      {step !== "out_of_area" && (
        <form
          action={onClaim}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            const target = e.target as HTMLElement | null;
            // Only single-line inputs. A <textarea> needs its newline and a
            // <select> needs its native Enter, neither of which is ours to
            // take.
            if (!target || target.tagName !== "INPUT") return;

            // Address phase: Enter belongs to the lookup, not to a native
            // submit - there is no submit button on screen yet to implicitly
            // trigger anyway.
            if (step === "address") {
              e.preventDefault();
              runLookup();
              return;
            }

            // Ready phase: exactly ONE field submits on Enter, the name box,
            // because that is the last thing a person types before claiming.
            // Everywhere else Enter is a mistake waiting to happen: the
            // optional details are eight number boxes someone tabs through,
            // and a stray Enter in "Year built" used to fire the claim mid-
            // edit with the rest of the block still blank. The street, unit
            // and ZIP boxes are the same story - Enter there reads as "I'm
            // done with this field", not "claim this house".
            if (target.id === "full_name") return;
            e.preventDefault();
          }}
          onChange={(e) => {
            if (step === "ready") persistReady(e.currentTarget);
          }}
          className="space-y-4"
        >
          {step === "address" && (
            <div>
              <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
                What&apos;s your home address?
              </h2>
              <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">
                Tell us your home&apos;s year built, size, and a few other
                details, or skip them and add them later.
              </p>
            </div>
          )}

          {step === "address" && (
            <ul className="space-y-1.5 rounded-lg bg-bark-50 p-3 text-sm text-bark-700 dark:bg-bark-700/40 dark:text-stone-300">
              <li className="flex items-start gap-2">
                <Hammer className="h-4 w-4 shrink-0 translate-y-0.5" aria-hidden="true" />
                <span>Track every system and know what needs attention</span>
              </li>
              <li className="flex items-start gap-2">
                <Bell className="h-4 w-4 shrink-0 translate-y-0.5" aria-hidden="true" />
                <span>
                  Proactive freeze, heat, and recall alerts for YOUR home
                </span>
              </li>
              <li className="flex items-start gap-2">
                <FileText className="h-4 w-4 shrink-0 translate-y-0.5" aria-hidden="true" />
                <span>
                  Scan a warranty or receipt and Hearth files it for you
                </span>
              </li>
            </ul>
          )}

          {/* Three fields on one 12-column grid. items-end bottom-aligns the
              cells, so the unit's two-line label on a narrow phone can't push
              its input out of line with the other two. Below sm the street
              takes its own row and unit + ZIP share the next one.
              They stay on screen after the lookup rather than being replaced
              by a second copy of the address on a confirm step. Street and
              unit stay EDITABLE there; only the ZIP locks (see below). */}
          <div className="grid grid-cols-12 items-end gap-3">
            <div className="relative col-span-12 sm:col-span-6">
              <label className="label" htmlFor="street">
                Street address
              </label>
              {/* name="address_line1" is what claimPropertyAction reads, so
                  this box IS the claimed address - not a display copy of a
                  hidden field. It used to be read-only after the lookup with
                  the real value carried in a hidden input, which meant a
                  homeowner who could see the county had their street wrong had
                  no way at all to correct it: the only escape was Edit, and
                  Edit re-ran the same lookup that produced the wrong line. */}
              <input
                id="street"
                name="address_line1"
                className="input"
                placeholder="123 Oak St"
                // "off", not "address-line1": the browser's own address
                // autofill panel and this suggestion list would otherwise
                // stack on top of each other over the same box, and only one
                // of them knows which addresses Hearth can actually serve.
                autoComplete="off"
                maxLength={MAX_ADDRESS_LENGTH}
                value={street}
                onChange={(e) => setStreet(e.target.value)}
                required
                // Combobox pattern: the input keeps focus and the arrow keys
                // move a highlight through the list, which is what makes this
                // usable without a mouse and announceable by a screen reader.
                role="combobox"
                aria-expanded={suggestOpen}
                aria-controls="street-suggestions"
                aria-autocomplete="list"
                aria-activedescendant={
                  suggestOpen && activeSuggestion >= 0
                    ? `street-suggestion-${activeSuggestion}`
                    : undefined
                }
                onKeyDown={(e) => {
                  if (!suggestOpen) return;
                  // stopPropagation on every key this list owns: the FORM's
                  // own onKeyDown treats Enter in the address phase as "run
                  // the lookup", which would fire instead of choosing the
                  // highlighted suggestion. Enter with nothing highlighted is
                  // deliberately left to bubble, so Enter still means
                  // Continue when the list is only sitting there.
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    e.stopPropagation();
                    setActiveSuggestion((i) => (i + 1) % suggestions.length);
                  } else if (e.key === "ArrowUp") {
                    e.preventDefault();
                    e.stopPropagation();
                    setActiveSuggestion((i) =>
                      i <= 0 ? suggestions.length - 1 : i - 1
                    );
                  } else if (e.key === "Enter" && activeSuggestion >= 0) {
                    e.preventDefault();
                    e.stopPropagation();
                    pickSuggestion(suggestions[activeSuggestion]);
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    e.stopPropagation();
                    closeSuggestions();
                  }
                }}
                // Tabbing away closes the list. A tap on an option can't lose
                // it: the option's onMouseDown cancels the blur (see below).
                onBlur={closeSuggestions}
              />
              {suggestOpen && (
                <ul
                  id="street-suggestions"
                  role="listbox"
                  aria-label="Address suggestions"
                  // Absolutely positioned so the fields below don't jump every
                  // time the list opens and closes mid-typing. z-20 clears the
                  // unit and ZIP boxes it overlaps on a phone.
                  className="absolute left-0 right-0 top-full z-20 mt-1 overflow-hidden rounded-lg border border-stone-200 bg-white shadow-lg dark:border-stone-700 dark:bg-stone-800"
                >
                  {suggestions.map((s, i) => (
                    <li
                      key={`${s.line1}-${s.zip}`}
                      id={`street-suggestion-${i}`}
                      role="option"
                      aria-selected={i === activeSuggestion}
                      // Keep focus in the input so the blur above doesn't tear
                      // the list down before the click lands.
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => pickSuggestion(s)}
                      onMouseEnter={() => setActiveSuggestion(i)}
                      className={`cursor-pointer px-3 py-2.5 text-sm ${
                        i === activeSuggestion
                          ? "bg-bark-50 dark:bg-bark-700/40"
                          : ""
                      }`}
                    >
                      <span className="block font-medium text-stone-900 dark:text-stone-100">
                        {s.line1}
                      </span>
                      <span className="block text-xs text-stone-500 dark:text-stone-400">
                        {s.city}, {s.state} {s.zip}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            {/* Condos and townhomes. Without this the address model had no
                unit at all, so "123 Main St Unit 4" read as the whole
                building - and two neighbours looked like the same home. Kept
                deliberately narrow: a real designator is "4B" or "Apt 12". */}
            <div className="col-span-4 sm:col-span-2">
              <label className="label" htmlFor="unit">
                Unit or apt (optional)
              </label>
              {/* Editable after the lookup too: the unit never reached the
                  records source anyway (see src/lib/parcel.ts), so there is
                  nothing about it for the county to have confirmed and no
                  reason to lock it. */}
              <input
                id="unit"
                name="unit"
                className="input"
                placeholder="4B"
                autoComplete="address-line2"
                maxLength={MAX_UNIT_LENGTH}
                value={unit}
                onChange={(e) => setUnit(e.target.value)}
              />
            </div>
            <div className="col-span-8 sm:col-span-4">
              <label className="label" htmlFor="zip">
                ZIP code
              </label>
              {/* The one field that locks. Street and unit are just text on
                  the row, but the ZIP is an INPUT to the lookup: change it and
                  every fact on screen below - the county record, the year
                  built, the assessed value, the owner of record the claim
                  matches your name against - belongs to a different address.
                  So it takes the honest route through "Edit ZIP", which
                  re-runs the lookup rather than quietly leaving stale facts
                  attached to a new ZIP. */}
              <input
                id="zip"
                className={`input ${step === "ready" ? readOnlyField : ""}`}
                placeholder="92646"
                inputMode="numeric"
                maxLength={10}
                value={zip}
                onChange={(e) => setZip(e.target.value)}
                readOnly={step === "ready"}
                required
              />
            </div>
          </div>

          {step === "ready" && (
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="text-xs text-stone-500 dark:text-stone-400">
                Correct the street or unit here if we got them wrong.
              </p>
              <button
                type="button"
                onClick={handleEdit}
                className="ml-auto text-sm font-medium text-bark-700 hover:underline dark:text-stone-300"
              >
                Edit ZIP
              </button>
            </div>
          )}

          {step === "address" && (
            <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
              We ask so we can personalize maintenance and local pricing for
              your home, it takes about 30 seconds.
            </p>
          )}

          {/* Notice at collection. This is the screen where the address goes
              in, and the address is what the parcel lookup turns into stored
              latitude/longitude - precise geolocation, which the CPRA treats
              as sensitive. It has to be disclosed here, not only in the
              policy three clicks away. Shown once, at the moment of
              collection - once the lookup succeeds the address has already
              been disclosed and collected, so it doesn't repeat below. */}
          {step === "address" && (
            <NoticeAtCollection
              collects="Your home's street address and ZIP code, plus the public records we look up from them: year built, size, assessed value, and your home's coordinates."
              purpose="build your home profile, plan your maintenance, and match you with pros who serve your area."
              sensitive="Your home's coordinates are precise geolocation, which California treats as sensitive. We use them only to serve your area and localize your home alerts, never to track your device and never for advertising."
            />
          )}

          {step === "address" && error && (
            <div
              role="alert"
              className="rounded-lg border border-red-200 bg-red-50 p-3 text-center text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200"
            >
              <p>{error}</p>
              {/* The address stays in the box on a miss, because a typo is
                  usually one character from right. This is the other half of
                  that: a way to wipe it and start clean without hunting for
                  the select-all. Only on the not-found refusal - the other
                  errors here are fixed in place, not by clearing. */}
              {notFound && (
                <button
                  type="button"
                  onClick={startOver}
                  className="mt-2 font-medium underline"
                >
                  Try another address
                </button>
              )}
            </div>
          )}

          {/* RentCast IS wired up as the parcel source (src/lib/parcel.ts) -
              it just needs RENTCAST_API_KEY set in the environment. Without
              a key (or on a lookup miss), lookupParcelAction quietly falls
              back to parsing the typed address into the expanded section
              instead of a real records lookup, so the button stays
              "Continue" rather than "Find my home" / "Looking up…": promising
              a search that might silently not happen would be dishonest. A
              plain type="button" (not a submit) - the only thing that ever
              submits this form is the Claim button below, once the lookup has
              expanded the rest of it into view. */}
          {step === "address" && (
            <button
              type="button"
              onClick={runLookup}
              className="btn-primary w-full"
              disabled={busy}
            >
              {busy ? "One moment…" : "Continue"}
            </button>
          )}

          {step === "ready" && facts && (
            <>
              <div>
                {/* source === "none" means no records lookup happened (see
                    src/lib/parcel.ts): the form only echoed the typed address,
                    so don't present it as a found result. The "Does this look
                    right?" copy is reserved for when a real source returns
                    data. */}
                <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
                  {facts.source === "none"
                    ? "Tell us about your home"
                    : "Does this look right?"}
                </h2>
                <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">
                  {facts.source === "none"
                    ? "Fill in what you know. Everything is optional."
                    : "Fill in what you know. Anything you skip you can add later."}
                </p>
              </div>

              {/* ADVISORY, not the value being claimed. This is what the
                  county record says; the fields above are what actually gets
                  saved, and they win. Before, this box was the only place the
                  canonical address appeared and a hidden input posted it, so
                  the two could never disagree - and a homeowner reading a
                  wrong line here had nothing to do about it. Now it is a
                  reference to check the street box against. No unit on this
                  line on purpose: the unit is the homeowner's own answer, not
                  something the assessor record confirmed. */}
              <div className="rounded-lg bg-bark-50 p-3 text-sm text-bark-700 dark:bg-bark-700/40 dark:text-stone-300">
                <p className="font-medium text-stone-900 dark:text-stone-100">
                  {facts.source === "rentcast" ? "County record: " : "You entered: "}
                  {facts.address_line1}
                </p>
                {(facts.city || facts.state || facts.zip) && (
                  <p className="mt-0.5">
                    {[facts.city, facts.state, facts.zip]
                      .filter(Boolean)
                      .join(", ")}
                  </p>
                )}
                {facts.source === "rentcast" &&
                  (facts.year_built || facts.sqft || facts.beds || facts.baths) && (
                    <p className="mt-1 text-xs">
                      {[
                        facts.year_built ? `Built ${facts.year_built}` : null,
                        facts.sqft ? `${facts.sqft.toLocaleString()} sqft` : null,
                        facts.beds ? `${facts.beds} bed` : null,
                        facts.baths ? `${facts.baths} bath` : null,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                  )}
              </div>

              {/* address_line1 is NOT hidden here - it is the visible,
                  editable street box at the top of this form.

                  This is the line the LOOKUP returned, which is what the street
                  box was seeded with. claimPropertyAction compares the two: if
                  the homeowner corrected the street, every parcel fact below is
                  about the wrong property, so the claim re-runs the lookup on
                  the address actually being claimed and ignores these hidden
                  fields outright. */}
              <input
                type="hidden"
                name="looked_up_address"
                value={facts.address_line1}
              />
              <input type="hidden" name="parcel_id" value={facts.parcel_id ?? ""} />
              <input type="hidden" name="next" value={next ?? ""} />
              <input type="hidden" name="ref" value={referralCode ?? ""} />

              {/* RentCast enrichment (src/lib/parcel.ts) the owner can't edit and
                  isn't shown on this screen: carried through as hidden fields so
                  claimPropertyAction can persist them alongside the visible
                  facts above. */}
              <input type="hidden" name="latitude" value={facts.latitude ?? ""} />
              <input type="hidden" name="longitude" value={facts.longitude ?? ""} />
              <input type="hidden" name="hoa_fee" value={facts.hoa_fee ?? ""} />
              <input type="hidden" name="county" value={facts.county ?? ""} />
              <input
                type="hidden"
                name="assessed_value"
                value={facts.assessed_value ?? ""}
              />
              <input
                type="hidden"
                name="assessed_year"
                value={facts.assessed_year ?? ""}
              />
              <input
                type="hidden"
                name="purchase_date"
                value={facts.purchase_date ?? ""}
              />
              <input
                type="hidden"
                name="purchase_price"
                value={facts.purchase_price ?? ""}
              />
              <input
                type="hidden"
                name="market_value"
                value={facts.market_value ?? ""}
              />
              <input
                type="hidden"
                name="market_value_low"
                value={facts.market_value_low ?? ""}
              />
              <input
                type="hidden"
                name="market_value_high"
                value={facts.market_value_high ?? ""}
              />
              <input
                type="hidden"
                name="property_tax_history"
                value={JSON.stringify(facts.property_tax_history ?? null)}
              />
              <input
                type="hidden"
                name="system_facts"
                value={JSON.stringify(facts.system_facts ?? null)}
              />

              {/* Full name lives here, not on the sign-up form: this is the first
                  point it's actually used - claimPropertyAction (./actions.ts)
                  matches it against the county's owner-of-record for this address.
                  Prefilled from existingName when a name is already on file (Google
                  signups, or anyone who set one in account settings) so they aren't
                  asked twice; required, since the ownership check needs a name. */}
              <div>
                <label className="label" htmlFor="full_name">
                  Your full name
                </label>
                <input
                  key={`full_name-${restoreKey}`}
                  ref={fullNameRef}
                  id="full_name"
                  name="full_name"
                  className="input"
                  type="text"
                  autoComplete="name"
                  placeholder="e.g. Alex Rivera"
                  // Matches FIELD_MAX.name, the ceiling claimPropertyAction
                  // actually enforces on the way to users.full_name.
                  maxLength={200}
                  defaultValue={draft?.fullName?.trim() ? draft.fullName : existingName ?? ""}
                  required
                />
                <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
                  {hasUnit
                    ? "We use this for your account and on jobs you post, so pros know who they're talking to."
                    : "We check this against the county's owner-of-record for this address, so pros know a job here is real."}
                </p>
              </div>

              {/* The rest of the property facts are all optional and mostly
                  auto-filled from public records. Tucked behind a disclosure (same
                  pattern as NoticeAtCollection) so the expanded section stays
                  short: name is all that's actually needed on top of the address
                  to claim. */}
              <details className="group">
                <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-sm font-medium text-bark-700 hover:underline dark:text-stone-300 [&::-webkit-details-marker]:hidden">
                  Know more details? Add them (optional)
                  <span
                    aria-hidden
                    className="text-stone-400 transition-transform group-open:rotate-180 dark:text-stone-500"
                  >
                    &#9662;
                  </span>
                </summary>

                <div className="mt-3 space-y-4">
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                    <div>
                      <label className="label">State</label>
                      <input name="state" className="input" defaultValue={facts.state ?? ""} />
                    </div>
                    <div>
                      <label className="label">City</label>
                      {/* pickedCity is the fallback for a records lookup that
                          returned no city: the suggestion the homeowner
                          tapped already named one, and re-typing it would be
                          busywork. The lookup's own value always wins. */}
                      <input
                        name="city"
                        className="input"
                        defaultValue={facts.city ?? pickedCity ?? ""}
                      />
                    </div>
                    <div>
                      <label className="label">ZIP</label>
                      <input
                        name="zip"
                        className="input"
                        defaultValue={facts.zip ?? ""}
                        placeholder="Auto-filled from city"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="label">Year built (optional)</label>
                      <input
                        name="year_built"
                        type="number"
                        className="input"
                        placeholder="Skip if you're not sure"
                        defaultValue={facts.year_built ?? ""}
                      />
                    </div>
                    <div>
                      <label className="label">Square feet</label>
                      <input
                        name="sqft"
                        type="number"
                        className="input"
                        defaultValue={facts.sqft ?? ""}
                      />
                    </div>
                    <div>
                      <label className="label">Beds</label>
                      <input
                        name="beds"
                        type="number"
                        className="input"
                        defaultValue={facts.beds ?? ""}
                      />
                    </div>
                    <div>
                      <label className="label">Baths</label>
                      <input
                        name="baths"
                        type="number"
                        step="0.5"
                        className="input"
                        defaultValue={facts.baths ?? ""}
                      />
                    </div>
                    <div>
                      <label className="label">Lot size (sqft)</label>
                      <input
                        name="lot_size_sqft"
                        type="number"
                        className="input"
                        defaultValue={facts.lot_size_sqft ?? ""}
                      />
                    </div>
                    <div>
                      <label className="label">Property type</label>
                      <select
                        name="property_type"
                        className="select"
                        defaultValue={facts.property_type ?? "single_family"}
                      >
                        {PROPERTY_TYPES.map((t) => (
                          <option key={t.value} value={t.value}>
                            {t.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                </div>
              </details>

              {/* Two versions on purpose, because only one of them is true.
                  The county record for a street address with a unit on it is
                  the BUILDING's - the assessor's owner of record there is the
                  developer or the HOA, not the person who owns unit 4B (see
                  claimPropertyAction in ./actions.ts, which refuses to match
                  against it). Promising a check that is not run, and could not
                  mean anything if it were, is the kind of small lie that turns
                  into "Hearth said it verified me" later. */}
              <p className="rounded-lg bg-bark-50 p-3 text-xs text-bark-700 dark:bg-bark-700/40 dark:text-stone-300">
                {hasUnit ? (
                  <>
                    By claiming this home you&apos;re confirming you own or manage
                    it. Public records only go down to the building for a unit
                    like yours, so there&apos;s nothing for us to check your name
                    against and we won&apos;t pretend otherwise. Everything here
                    works the same either way.
                  </>
                ) : (
                  <>
                    By claiming this home you&apos;re confirming you own or manage
                    it. We also quietly compare the name on your account against
                    the county&apos;s public owner-of-record for this address. It
                    helps pros trust that jobs here are real, and nothing bad
                    happens if it doesn&apos;t match.
                  </>
                )}
              </p>

              {error && (
                <p
                  role="alert"
                  className="rounded-lg border border-red-200 bg-red-50 p-3 text-center text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200"
                >
                  {error}
                </p>
              )}

              <button className="btn-primary w-full" disabled={busy}>
                {busy ? "One moment…" : "Claim my home"}
              </button>

              {/* We keep this form filled in across a reload, so there has to be a
                  way to say "not that home" and get a blank one back. */}
              <div className="text-center">
                <button
                  type="button"
                  onClick={startOver}
                  className="text-sm text-stone-500 hover:underline dark:text-stone-400"
                >
                  Start over with a different address
                </button>
              </div>
            </>
          )}
        </form>
      )}

      {/* Out-of-area: an honest end state, not a form that keeps rejecting
          the same visitor with nowhere to go. States plainly what happened,
          confirms (or corrects) the waitlist claim, and always leaves a
          working way out - either try again with a different address, or
          sign out entirely. */}
      {step === "out_of_area" && (
        <div className="space-y-4 text-center">
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
            Hearth isn&apos;t in your area yet
          </h2>
          <p className="break-words text-sm text-stone-600 dark:text-stone-300">
            {waitlistSaved
              ? LAUNCH_ONLY_MESSAGE
              : `We couldn't save you to the waitlist. Email us at ${FOUNDER.email} and we'll add you by hand.`}
          </p>
          <p className="text-sm text-stone-500 dark:text-stone-400">
            There&apos;s nothing else to set up here yet since Hearth covers{" "}
            {LAUNCH_AREA_LABEL} right now. Don&apos;t see your city yet? You
            will soon.
          </p>
          <button
            type="button"
            className="btn-secondary w-full"
            onClick={() => {
              setError(null);
              setStep("address");
            }}
          >
            Try a different address
          </button>
          <form action="/auth/signout" method="post">
            <button
              type="submit"
              className="text-sm text-stone-500 hover:underline dark:text-stone-400"
            >
              Sign out
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
