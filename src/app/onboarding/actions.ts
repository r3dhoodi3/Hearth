"use server";

import { cookies, headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  ACTIVE_HOME_COOKIE,
  getProperties,
  noteUnitColumnMissing,
} from "@/lib/property";
import {
  lookupParcel,
  type ParcelFacts,
  type PublicParcelFacts,
} from "@/lib/parcel";
import {
  deriveOwnershipStatus,
  shouldRecordOwnershipCheck,
} from "@/lib/ownershipMatch";
import { claimAddressGate } from "@/lib/parcelGate";
import { DEFAULT_LIFESPANS } from "@/lib/health";
import { ownsPlus, getExtraHomeSlots } from "@/lib/subscription";
import { setFlash } from "@/lib/flash";
import { safeNextPath } from "@/lib/safeNext";
import { isMissingSchemaError } from "@/lib/dbErrors";
import { isLaunchZip, LAUNCH_ONLY_MESSAGE } from "@/lib/serviceArea";
import { PROPERTY_TYPES, PLUS_INCLUDED_HOMES } from "@/lib/constants";
import { ok, err, type ActionResult } from "@/lib/actionResult";
import { recordTermsAcceptance } from "@/app/(auth)/recordTermsAcceptance";
import { recordSignal } from "@/lib/risk/signals";
import {
  boundedNumber,
  boundedInt,
  cappedField,
  cappedFieldOrNull,
  isAllowedValue,
  FIELD_MAX,
} from "@/lib/formFields";

// Ceiling on the two raw JSON blobs the confirm step carries in as hidden
// fields. They are client input like everything else here, so the string is
// bounded BEFORE JSON.parse rather than after: parsing a multi-megabyte blob
// to then throw it away still costs the parse. Generous enough for a real
// RentCast payload (a handful of tax years, a dozen system facts) and small
// enough that a crafted post can't turn a claim into a memory spike.
const MAX_ENRICHMENT_JSON_CHARS = 20000;

// Systems virtually every home has, auto-added so the owner doesn't start from
// a blank inventory. Install years are ESTIMATED from the build year; real
// install/repair/remodel dates come from permit data once that API is wired.
const STARTER_SYSTEMS = [
  "foundation",
  "plumbing",
  "electrical_panel",
  "roof",
  "hvac",
  "water_heater",
  "windows",
];
const CURRENT_YEAR = new Date().getFullYear();

// What a homeowner is told when the records source ran and came back with
// nothing for the address they typed. Names the two things that actually fix
// it - a typo, or the suggestion list under the street box - rather than
// blaming them or pretending it might work on a retry.
const ADDRESS_NOT_FOUND_MESSAGE =
  "We couldn't find that address. Check the spelling or pick a suggestion.";

// Is a real property-records source configured at all? source: "none" in
// ParcelFacts covers both "the county has no record of this address" and "no
// lookup happened because there is no API key" (see blankFacts in
// src/lib/parcel.ts), and only the first of those may refuse a claim. Without
// this distinction an environment with no RENTCAST_API_KEY would reject every
// address in the launch area, which is the opposite of degrading gracefully.
function hasRecordsSource(): boolean {
  return Boolean(process.env.RENTCAST_API_KEY);
}

// A trimmed length floor for "this is actually an address." An <input
// required> is not enough on its own: browsers treat a single space as a
// non-empty value, so a hasty Enter press (or a stray keystroke) could
// otherwise carry a blank/junk address all the way into a claimed home. This
// is the authoritative check - the matching one in OnboardingForm.tsx is
// only there for faster client-side feedback.
const MIN_ADDRESS_LENGTH = 5;
// The ceiling on the same field. It matters more than it used to: the confirm
// step now posts address_line1 from a real editable input the homeowner can
// correct, not from a hidden copy of a looked-up value.
const MAX_ADDRESS_LENGTH = 200;

// Server-side ceilings for the free-text location columns (city/state/county
// are all `text`). The form's fields are client hints only; a server action
// takes whatever FormData it is handed, so each string is trimmed and capped
// before it lands on the row. Generous vs. any real place name, small enough
// that a crafted post can't stuff the column.
const MAX_CITY = 120;
const MAX_STATE = 60;
const MAX_COUNTY = 120;
// The condo/townhome unit (migration 0127). Short on purpose: a real
// designator is "4B", "Apt 12", "Ste 300" - twenty characters is already
// generous, and the field is shown as a narrow box for the same reason.
const MAX_UNIT = 20;
// The county assessor's parcel number, carried in as a hidden field from the
// lookup. A real APN is a short punctuated string ("934-231-14"); 64 is
// already several times any format in use, and without a ceiling this is an
// unbounded client-supplied string landing straight on the row.
const MAX_PARCEL_ID = 64;

// The purchase date arrives from the form as a plain string. Only store a real
// YYYY-MM-DD with a year between 1900 and today; anything else becomes null so
// a typo (or a forged value) never fails the `date` column and kills the whole
// claim. Mirrors validPurchaseDate in src/app/(app)/profile/actions.ts, kept
// as a local copy rather than importing across the (app) route boundary.
function validPurchaseDate(v: string | null): string | null {
  if (!v) return null;
  const s = v.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const year = Number(s.slice(0, 4));
  if (year < 1900 || year > new Date().getFullYear()) return null;
  // Round-trip through Date to reject impossible days like 2020-02-31, which
  // would otherwise make Postgres reject the whole insert.
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) {
    return null;
  }
  return s;
}

// Records an out-of-area lead in market_waitlist (0074) for the signed-in
// user, so Hearth can email them when it expands to their ZIP. Shared by
// every launch-city gate below AND by OnboardingForm.tsx's own faster
// client-side ZIP check: that check short-circuits before ever calling
// lookupParcelAction, so without a direct call here someone rejected right
// there would never actually land on the waitlist. Returns an honest
// ActionResult instead of throwing, since the caller needs to tell the user
// plainly if the save itself failed, not just that they're out of area.
export async function joinMarketWaitlistAction(
  zip: string
): Promise<ActionResult<null>> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user?.email) {
    return err("Please sign in to join the waitlist.");
  }

  const admin = createAdminClient();

  // Throttle before the insert. This row is written with the SERVICE-ROLE
  // client (market_waitlist has no policy for `authenticated`), so RLS is not
  // the ceiling here and 0074's uniqueness only covers (lower(email), role) -
  // a reviewer deliberately kept it that way rather than adding an email-only
  // index, which makes this action-level limit the abuse control. Keyed on IP,
  // not user id, because that is what a burst of fresh throwaway accounts
  // actually shares. Same derivation and same fail-open posture as
  // src/app/contact/actions.ts and /api/track: only an explicit
  // `allowed === false` blocks, so a limiter outage never costs a real
  // out-of-area homeowner their place on the list.
  const ip = (await headers()).get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const { data: allowed } = await admin.rpc("rate_limit_hit", {
    p_bucket: `waitlist:${ip ?? "unknown"}`,
    p_limit: 5,
    p_window_seconds: 3600,
  });
  if (allowed === false) {
    return err("We couldn't save you to the waitlist. Please try again later.");
  }

  const { error } = await (admin as any).from("market_waitlist").insert({
    role: "homeowner",
    // Capped like every other stored string, even though this one comes from
    // the auth record rather than the form.
    email: user.email.slice(0, 254),
    zip: zip.trim().slice(0, 5) || null,
  });

  // 23505: the unique index on (lower(email), role) means this email is
  // already on the waitlist - that's the outcome we wanted anyway, not a
  // real failure. Any other error (including the table not existing yet on
  // a live DB that hasn't run 0074) is a genuine save failure.
  if (error && error.code !== "23505") {
    return err("We couldn't save you to the waitlist.");
  }
  return ok(null);
}

// Step 1: pull baseline facts from the parcel layer for the entered address.
//
// Returns a result object instead of throwing, for the same reason
// claimPropertyAction below does. OnboardingForm.tsx calls this
// programmatically (const result = await lookupParcelAction(...)), and in
// PRODUCTION Next masks the message of anything a server action throws - the
// client sees only "An error occurred in the Server Components render". So
// every deliberate, user-facing refusal this action makes - the launch-area
// message, the two validation messages, the two rate-limit messages - reached
// the homeowner in dev and was replaced by the caller's generic "That didn't go
// through. Please try again." in production. The out-of-area case was the worst
// of them: the visitor was silently added to the waitlist and then told to try
// again, with no way to learn Hearth simply isn't in their city.
//
// `waitlisted` rides along on the out-of-area refusal only, so the caller's
// waitlist panel can tell "you're on the list" from "we couldn't save you" -
// the same distinction joinMarketWaitlistAction already gives the client-side
// ZIP check.
export async function lookupParcelAction(
  street: string,
  zip: string,
  // Optional condo/townhome unit (migration 0127). It plays NO part in the
  // records lookup: RentCast matches on the street address and returns the
  // building's record whichever unit is appended, so lookupParcel ignores it
  // (see src/lib/parcel.ts). Still accepted here because the form has the
  // value and this is where it would go if the source ever gained a real
  // unit-level record; the unit itself is stored as display-only on the claim.
  unit?: string | null
): Promise<
  | { ok: true; facts: PublicParcelFacts }
  | { ok: false; error: string; waitlisted?: boolean; notFound?: boolean }
> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { ok: false, error: "Please sign in to look up your address." };
  }

  if (street.trim().length < MIN_ADDRESS_LENGTH) {
    return {
      ok: false,
      error: "Enter your home's street address to continue.",
    };
  }
  if (!/^\d{5}(-\d{4})?$/.test(zip.trim())) {
    return { ok: false, error: "Enter a valid 5-digit ZIP code." };
  }
  // Launch-restriction gate: the launch area only (isLaunchZip), which since
  // 0129 is all of Orange County - Hearth has no pros anywhere else, and the
  // pro-side gates (open_jobs_for_me / apply_to_lead, migrations 0124/0126/
  // 0129) refuse those jobs too, so accepting the address here would strand
  // the homeowner with a job no pro can ever see. Checked before the rate limiter/RentCast call
  // below so an out-of-area address never spends a billed RentCast lookup.
  // OnboardingForm.tsx runs the same check client-side first and normally
  // never lets a rejected ZIP reach this action at all - this is the
  // fallback path (JS disabled, a modified client, or a direct call), so it
  // still logs the lead to the waitlist rather than silently dropping it.
  if (!isLaunchZip(zip.trim())) {
    const waitlist = await joinMarketWaitlistAction(zip.trim());
    return {
      ok: false,
      error: LAUNCH_ONLY_MESSAGE,
      waitlisted: waitlist.ok,
    };
  }

  // Each lookup can make up to 2 billed RentCast calls, so gate abuse per user
  // with a fixed-window limiter (migration 0068). A DB hiccup here fails open:
  // onboarding must never break on the rate limiter, so only an explicit
  // `allowed === false` blocks.
  const admin = createAdminClient();
  const { data: allowed } = await admin.rpc("rate_limit_hit", {
    p_bucket: `parcel:${user.id}`,
    p_limit: 10,
    p_window_seconds: 3600,
  });
  if (allowed === false) {
    return {
      ok: false,
      error: "Too many address lookups. Please try again in a bit.",
    };
  }
  // Daily ceiling on top of the hourly one (security audit finding #6): the
  // hourly limiter alone still lets one account burn 10 * 24 = 240 lookups a
  // day, each up to 2 billed RentCast calls, against a 50-lookups/MONTH free
  // tier. 25/day is generous for any real household (nobody looks up 25
  // addresses in a day) but caps the worst case at ~50 billed calls/day/
  // account instead of ~480. Same fixed-window limiter, same fail-open
  // behavior as the hourly check above - a rate-limiter hiccup must never
  // block a legit onboarding lookup.
  const { data: allowedDay } = await admin.rpc("rate_limit_hit", {
    p_bucket: `parcel-day:${user.id}`,
    p_limit: 25,
    p_window_seconds: 86400,
  });
  if (allowedDay === false) {
    return {
      ok: false,
      error: "Too many address lookups today. Please try again tomorrow.",
    };
  }

  // Strip the county assessor's owner-of-record before returning to the
  // client. owner_names/owner_type/owner_occupied are the values
  // claimPropertyAction later matches the typed name against to verify
  // ownership, so shipping them here (they're visible in the action response
  // in devtools) would hand a forged claim the answer key. claimPropertyAction
  // re-fetches the full ParcelFacts server-side via lookupParcel, so nothing
  // that legitimately needs them loses access.
  const { owner_names, owner_type, owner_occupied, ...publicFacts } =
    await lookupParcel(
      street.trim(),
      zip.trim(),
      // Capped here as well as on the claim: a server action takes whatever
      // it is handed, and this value reaches an outbound request URL.
      (unit ?? "").trim().slice(0, MAX_UNIT) || null
    );

  // The records source ran and knows nothing about this address. Refuse it
  // rather than walking on to the confirm step with an empty form, which is
  // what "123 Fake St, 92648" used to do: every fact blank, the address
  // echoed back as if it had been found, and a home created for a house that
  // does not exist. Everything downstream - the ownership match, the pro
  // matching, the health score, the alerts - is about a real parcel, so the
  // honest answer here is no.
  //
  // Guarded on hasRecordsSource() because source "none" has two meanings (see
  // blankFacts in src/lib/parcel.ts): "the county has no such address" and
  // "no RENTCAST_API_KEY is configured, so nothing was looked up". Only the
  // first is a refusal. Without the guard, an environment with no key would
  // reject every address in Orange County.
  //
  // Written as an explicit `=== "none"` on purpose, NOT as "anything that
  // isn't rentcast". source "unavailable" (a 401 from a bad key, a 429, a 5xx,
  // a timeout - see ParcelFacts in src/lib/parcel.ts) means we never got an
  // answer, and on 2026-08-24 a bad key on the host turned that into a day of
  // real homeowners being told their address does not exist. An "unavailable"
  // now walks on to the confirm step with blank facts and a plain note, which
  // is the manual-entry fallback parcel.ts has always promised.
  if (publicFacts.source === "none" && hasRecordsSource()) {
    return { ok: false, error: ADDRESS_NOT_FOUND_MESSAGE, notFound: true };
  }

  return { ok: true, facts: publicFacts };
}

// Step 2: create the property (self-attested ownership for MVP).
//
// Returns an ActionResult on any user-facing failure rather than throwing:
// Next masks a thrown server-action message in production, which would hide
// not just a raw DB error but the intentional out-of-area launch message too,
// leaving an out-of-area homeowner with a generic "digest" instead of the real
// explanation. OnboardingForm renders result.error directly. The happy path
// still ends in redirect() (which throws NEXT_REDIRECT for the framework to
// catch), so a normal successful claim never returns here.
export async function claimPropertyAction(
  formData: FormData
): Promise<ActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/signin");

  // Free vs Plus home limits: a free homeowner may claim 1 home; Plus unlocks
  // PLUS_INCLUDED_HOMES (src/lib/constants.ts, the same number the /plus card
  // advertises) so a landlord/multi-property owner can track them all at once,
  // plus any paid extra-home slots the member bought on top (the Plus-only
  // pay-per-extra-home add-on, see setExtraHomesAction/getExtraHomeSlots).
  // Homes merely shared with the user as a household member do not count
  // against their own limit, so only owned homes are tallied here. This mirrors
  // the DB backstop in supabase/migrations/0108_extra_home_slots.sql, which
  // must agree on the same formula. ownsPlus, not hasPlus: the cap is on homes
  // the claimer OWNS, and the 0108 trigger checks the claimer's own row, so
  // household Plus (a shared home's owner has Plus) must not raise it.
  const [existingHomes, plus, extraSlots] = await Promise.all([
    getProperties(),
    ownsPlus(),
    getExtraHomeSlots(),
  ]);
  const ownedHomes = existingHomes.filter((h) => !h.isShared);
  // getExtraHomeSlots already returns 0 unless Plus is live, so the free-tier
  // cap of 1 can never be inflated by a stale slot count.
  const cap = plus ? PLUS_INCLUDED_HOMES + extraSlots : 1;
  if (ownedHomes.length >= cap) {
    if (!plus) {
      redirect("/plus?reason=home_limit");
    }
    // Awaited: setFlash writes a cookie through the async cookies() store, and
    // redirect() throws immediately. Without the await the redirect unwound the
    // action before the cookie was ever set, so the toast explaining WHY they
    // landed on /plus was a coin flip.
    await setFlash(
      `You're using all ${cap} of your homes. You can add more homes anytime from the Plus page.`,
      "error"
    );
    redirect("/plus");
  }

  // The authoritative address check: an <input required> alone is not enough
  // (a browser treats a single space as a non-empty value), so without this a
  // hasty Enter press or a stray keystroke could carry a blank/junk address
  // all the way into a claimed home. The matching check in OnboardingForm.tsx
  // is only there for faster client-side feedback - this one is what actually
  // guards the insert below.
  const addressLine1 = cappedField(formData, "address_line1", MAX_ADDRESS_LENGTH);
  if (addressLine1.length < MIN_ADDRESS_LENGTH) {
    return err("Enter your home's address before claiming it.");
  }

  // Launch-restriction gate: the authoritative one, since this is the step
  // that actually commits the address to a claimed home. Launch area only
  // (isLaunchZip), same reasoning as lookupParcelAction above. Log the lead to the
  // waitlist (joinMarketWaitlistAction above) before rejecting - a failed
  // save (e.g. live DB hasn't run 0074 yet) must never block the message
  // itself from being shown, so its result is ignored here, not surfaced.
  const claimZip = ((formData.get("zip") as string) ?? "").trim().slice(0, 5);
  if (!isLaunchZip(claimZip)) {
    await joinMarketWaitlistAction(claimZip);
    return err(LAUNCH_ONLY_MESSAGE);
  }

  // The condo/townhome unit (migration 0127), kept in its own column rather
  // than folded into address_line1: address_line1 is the street line the
  // parcel lookup and the assessor ownership match run against, and the unit
  // is appended for display by formatAddressLine (src/lib/property.ts).
  // Empty means single-family, which is null, not "".
  // Read early because the ownership decision below turns on it.
  const unit = cappedFieldOrNull(formData, "unit", MAX_UNIT);

  // =========================================================================
  // DID THE HOMEOWNER EDIT THE ADDRESS AFTER THE LOOKUP?
  //
  // The confirm step's street box is a real, editable input (OnboardingForm.tsx)
  // - a homeowner who can see the county has their street wrong is meant to fix
  // it there. But every parcel-derived fact on that screen rides along in HIDDEN
  // fields captured from the ORIGINAL lookup: the APN, the coordinates, the
  // county, the assessed value and year, the last sale, the tax history, the
  // AVM. Correcting the street and pressing claim therefore wrote a home whose
  // address says one property and whose parcel facts describe another - and the
  // coordinates in particular are what /value, the weather alerts, and the pro
  // matching all key off, so this is not a cosmetic mismatch.
  //
  // So the claim compares the submitted street against the line the lookup
  // actually returned (`looked_up_address`, a hidden field). Same normalization
  // parcelCacheKey uses, so a whitespace or casing difference is not an edit.
  // When they differ, every frozen fact is re-derived from a fresh lookup of
  // the address being claimed and the posted hidden fields are ignored outright
  // - they describe a property this claim is no longer about.
  //
  // A missing looked_up_address counts as edited. A browser always sends it
  // whenever those hidden fields exist, so its absence means a hand-made post,
  // and re-deriving is the safe reading of one.
  //
  // Only the FROZEN facts are re-derived. The fields the confirm step puts on
  // screen - city, state, year built, size, beds, baths, lot size, property
  // type - keep whatever was submitted either way, because the person who
  // lives there is the authority on those and overwriting their typing with a
  // records value is the bug this whole screen exists to avoid. The ZIP is
  // locked on the ready step, so the re-lookup runs against the same ZIP the
  // original one did.
  // =========================================================================
  const normalizeStreet = (s: string) =>
    s.trim().replace(/\s+/g, " ").toLowerCase();
  const lookedUpAddress = cappedField(
    formData,
    "looked_up_address",
    MAX_ADDRESS_LENGTH
  );
  const addressEdited =
    !lookedUpAddress ||
    normalizeStreet(lookedUpAddress) !== normalizeStreet(addressLine1);

  // The fresh facts for an edited address. Null means "no facts to use": either
  // the re-lookup was refused by the rate limiter or it failed outright, in
  // which case every frozen field below lands as null. That is the deliberate
  // choice - a claim with no assessed value is a gap the owner can fill in from
  // Home Profile, while a claim carrying another address's assessed value is
  // wrong data that nothing downstream can tell apart from real data.
  let relookupFacts: ParcelFacts | null = null;
  // Distinguished from "the lookup ran and failed": a limiter refusal means
  // nothing has EVER looked at this street, and the gate below turns that into
  // a refusal rather than storing an unchecked address.
  let relookupBlocked = false;
  if (addressEdited) {
    // The same per-user buckets lookupParcelAction spends (migration 0068),
    // because this is the same thing: a lookup of an address nothing has
    // fetched yet, which costs a billed RentCast call. An unedited claim keeps
    // hitting the cache row the lookup just wrote and still spends nothing, so
    // only the edited path is metered. Fail-open on a limiter hiccup, same as
    // every other rate_limit_hit call in this file.
    const limiter = createAdminClient();
    const { data: allowedHour } = await limiter.rpc("rate_limit_hit", {
      p_bucket: `parcel:${user.id}`,
      p_limit: 10,
      p_window_seconds: 3600,
    });
    const { data: allowedDay } = await limiter.rpc("rate_limit_hit", {
      p_bucket: `parcel-day:${user.id}`,
      p_limit: 25,
      p_window_seconds: 86400,
    });
    if (allowedHour !== false && allowedDay !== false) {
      try {
        relookupFacts = await lookupParcel(addressLine1, claimZip);
      } catch (err) {
        // Never fatal. The home is still theirs to claim; it just arrives
        // without the county's numbers on it.
        console.error("Corrected-address parcel lookup failed:", err);
      }
    } else {
      relookupBlocked = true;
    }
  }

  // =========================================================================
  // GATE: the records source has to actually know this address.
  //
  // lookupParcelAction already refuses a miss on the Continue step, so the
  // form never reaches the claim with an unknown address. This is the copy of
  // that rule that holds against a hand-made POST, which is the only way to
  // get here otherwise - a server action takes whatever FormData it is
  // handed, and a forged post can set looked_up_address to match address_line1
  // and skip the lookup step entirely. Without this, "123 Fake St" still
  // creates a real home row.
  //
  // The lookup itself is nearly free either way: an edited address already
  // paid for relookupFacts above, and an unedited one hits the parcel_cache
  // row (migration 0069) the Continue step just wrote - the same cached read
  // the ownership check further down already makes.
  //
  // The decision itself is claimAddressGate (src/lib/parcelGate.ts), which is
  // where its reasoning and its tests live. In short: only an explicit
  // `source: "none"` from a CONFIGURED source refuses as "no such address". A
  // lookup that threw, or one that came back "unavailable" (401/429/5xx/
  // timeout - see ParcelFacts in src/lib/parcel.ts) keeps the tolerant
  // behavior, because "we couldn't check" is not "this address does not
  // exist" - that conflation is what refused every real address for a day on
  // 2026-08-24. The one intolerant case is an EDITED street whose re-lookup
  // the rate limiter refused: nothing has ever looked at that string, so
  // storing it would create a home from unverified typing.
  //
  // claimFacts is also what the ownership check at the end of this action
  // uses, instead of a third lookupParcel with identical arguments. Each call
  // waits out its own 8s timeout when the source is down, and three of them
  // meant up to 24 seconds on the claim button.
  // =========================================================================
  let claimFacts: ParcelFacts | null = relookupFacts;
  if (hasRecordsSource()) {
    if (!addressEdited) {
      try {
        claimFacts = await lookupParcel(addressLine1, claimZip);
      } catch (err) {
        console.error("Claim-time address verification lookup failed:", err);
        claimFacts = null;
      }
    }
    const gate = claimAddressGate({
      hasRecordsSource: true,
      addressEdited,
      relookupBlocked,
      facts: claimFacts,
    });
    if (gate.action === "refuse") {
      return err(
        gate.reason === "lookup_blocked"
          ? "Too many address lookups right now. Please try again in a bit."
          : ADDRESS_NOT_FOUND_MESSAGE
      );
    }
  }

  // A parcel-derived field: from the fresh lookup when the address was edited,
  // from the posted hidden field when it was not. Three shapes, because the
  // columns are numeric, integer and text respectively.
  const factString = (v: number | string | null | undefined): string | null =>
    v === null || v === undefined ? null : String(v);
  const parcelNum = (
    key: string,
    value: number | null | undefined,
    min: number,
    max: number
  ) =>
    boundedNumber(
      addressEdited ? factString(value) : formData.get(key),
      min,
      max
    );
  const parcelInt = (
    key: string,
    value: number | null | undefined,
    min: number,
    max: number
  ) =>
    boundedInt(addressEdited ? factString(value) : formData.get(key), min, max);
  const parcelText = (
    key: string,
    value: string | null | undefined,
    max: number
  ) =>
    addressEdited
      ? (value ?? "").trim().slice(0, max) || null
      : cappedFieldOrNull(formData, key, max);

  // Every number on the claim is client input (the confirm step posts the
  // RentCast figures as hidden fields, and the owner can edit the visible
  // ones), so each one has to be finite AND plausible before it lands on the
  // home. Without the Number.isFinite half, a non-numeric value became NaN and
  // sailed past the old `v ? Number(v) : null` guard; without the range, a
  // typo'd year or a forged price wrote a home nothing downstream can reason
  // about (the forecast, the health score, and /value all read these).
  // Out-of-range stores null, same as a blank field: an implausible number is
  // worse than no number.
  const num = (key: string, min: number, max: number) =>
    boundedNumber(formData.get(key), min, max);
  // int() for the columns that store whole numbers (year_built, sqft, beds,
  // lot_size_sqft, assessed_year are all `int`): a fractional value like
  // 8712.5 passes a plain range check but Postgres then rejects the whole
  // insert, so truncate to an integer after the range check via boundedInt.
  const int = (key: string, min: number, max: number) =>
    boundedInt(formData.get(key), min, max);

  // The RentCast enrichment carried in as hidden JSON fields (see
  // OnboardingForm.tsx's confirm step): parsed defensively since it's still
  // client-controlled form input, not a trusted server value. A parse
  // failure degrades to "nothing extra to store" rather than failing the
  // whole claim.
  // Bounded before the parse (see MAX_ENRICHMENT_JSON_CHARS): an oversized
  // blob is dropped whole rather than truncated, because half a JSON string
  // only throws inside the try below anyway.
  const enrichmentJson = (key: string): string | null => {
    const raw = formData.get(key);
    if (typeof raw !== "string" || !raw) return null;
    return raw.length > MAX_ENRICHMENT_JSON_CHARS ? null : raw;
  };
  // Both blobs are parcel-derived, so an edited address takes them from the
  // fresh lookup and never parses the posted copy at all.
  let propertyTaxHistory: { year: number; amount: number }[] | null = null;
  if (addressEdited) {
    propertyTaxHistory = relookupFacts?.property_tax_history ?? null;
  } else {
    try {
      const raw = enrichmentJson("property_tax_history");
      propertyTaxHistory = raw ? JSON.parse(raw) : null;
    } catch {
      propertyTaxHistory = null;
    }
  }
  let systemFacts: Record<string, string> | null = null;
  if (addressEdited) {
    systemFacts = relookupFacts?.system_facts ?? {};
  } else {
    try {
      const raw = enrichmentJson("system_facts");
      systemFacts = raw ? JSON.parse(raw) : {};
    } catch {
      systemFacts = {};
    }
  }

  // baseRow: the columns this insert has always written, guaranteed to exist
  // on every deployed DB regardless of whether migration 0066 has run yet.
  // purchase_date/purchase_price/assessed_value/assessed_year belong here too
  // (not in the 0066-only delta below): they're pre-existing columns from
  // 0001/0029/0039, unrelated to 0066, so a DB missing only 0066 can still
  // take them - dropping them into the fallback would lose data for no
  // reason.
  // property_type is a <select> that renders exactly PROPERTY_TYPES, but a
  // server action takes whatever FormData it is handed, so validate against
  // that same list and drop an unrecognized value to null rather than writing
  // a type the rest of the app has no entry for.
  const rawPropertyType = (formData.get("property_type") as string) || null;
  const propertyType = isAllowedValue(PROPERTY_TYPES, rawPropertyType)
    ? rawPropertyType
    : null;

  const baseRow = {
    user_id: user.id,
    // Frozen fact: the assessor's parcel number belongs to whichever address
    // the lookup actually resolved, so it is re-derived when the street was
    // corrected rather than carried over from the old one.
    parcel_id: parcelText("parcel_id", relookupFacts?.parcel_id, MAX_PARCEL_ID),
    address_line1: addressLine1,
    city: cappedFieldOrNull(formData, "city", MAX_CITY),
    state: cappedFieldOrNull(formData, "state", MAX_STATE),
    // claimZip, not the raw form field: it's already trimmed/sliced to 5
    // digits (the same value the launch-restriction gate above checked and
    // the ownership check below looks up with), so the persisted zip and
    // the ownership-check input can never diverge.
    zip: claimZip || null,
    year_built: int("year_built", 1700, 2100),
    sqft: int("sqft", 1, 1_000_000),
    beds: int("beds", 0, 100),
    // numeric(3,1): 100 overflows the column and kills the whole insert (and
    // the fallback retry would carry the same value and fail again), so the
    // ceiling is 99.9. num(), not int(): baths is a fractional column.
    baths: num("baths", 0, 99.9),
    lot_size_sqft: int("lot_size_sqft", 0, 100_000_000),
    property_type: propertyType,
    // ownership_verified was self-attested for MVP and is now dead: it's
    // server-locked to false by migration 0093's trigger regardless of what
    // this insert asks for. ownership_status (set below, after the insert,
    // via the server-side assessor-record check) supersedes it.
    // Frozen facts, all four: the last recorded sale and the county
    // assessment are statements about a specific parcel, not about whatever
    // street line the form happens to be carrying.
    purchase_date: validPurchaseDate(
      addressEdited
        ? (relookupFacts?.purchase_date ?? null)
        : (formData.get("purchase_date") as string) || null
    ),
    purchase_price: parcelNum(
      "purchase_price",
      relookupFacts?.purchase_price,
      0,
      1_000_000_000
    ),
    assessed_value: parcelNum(
      "assessed_value",
      relookupFacts?.assessed_value,
      0,
      1_000_000_000
    ),
    assessed_year: parcelInt(
      "assessed_year",
      relookupFacts?.assessed_year,
      1700,
      2100
    ),
  };
  // Written as a spread-in delta, not a field on the row, so a single-family
  // claim (by far the common case) posts exactly the same shape it always has
  // and can never take the missing-column retry path below.
  const unitWrite = unit ? { unit } : {};

  // extendedRow: baseRow plus the columns migration 0066 actually adds.
  // Attempted first, with baseRow as the fallback below if the live DB
  // hasn't run 0066 yet.
  //
  // Every field here is parcel-derived and none of them is on screen, so all of
  // them are frozen facts (see the addressEdited block above). The coordinates
  // matter most: /value, the weather alerts and the pro matching all key off
  // them, so a corrected street line with the old address's latitude on it
  // would quietly point the whole product at the wrong house.
  const extendedRow = {
    ...baseRow,
    latitude: parcelNum("latitude", relookupFacts?.latitude, -90, 90),
    longitude: parcelNum("longitude", relookupFacts?.longitude, -180, 180),
    hoa_fee: parcelNum("hoa_fee", relookupFacts?.hoa_fee, 0, 100_000),
    county: parcelText("county", relookupFacts?.county, MAX_COUNTY),
    property_tax_history: propertyTaxHistory,
    market_value: parcelNum(
      "market_value",
      relookupFacts?.market_value,
      0,
      1_000_000_000
    ),
    market_value_low: parcelNum(
      "market_value_low",
      relookupFacts?.market_value_low,
      0,
      1_000_000_000
    ),
    market_value_high: parcelNum(
      "market_value_high",
      relookupFacts?.market_value_high,
      0,
      1_000_000_000
    ),
  };

  // extendedRow's enrichment fields (everything migration 0066 adds) aren't
  // in src/lib/database.types.ts yet, so this call is cast to any - same
  // pattern as saveHomeValueAction (value/actions.ts) and
  // saveTaxAssessmentAction (taxes/actions.ts) for their own not-yet-typed
  // columns, rather than widening the generated types by hand.
  let { data: created, error } = await (supabase.from("properties") as any)
    .insert({ ...extendedRow, ...unitWrite })
    .select("id")
    .single();

  // Set when the claim went through but the unit did not, so the homeowner is
  // told rather than left to notice on their own that the number they typed
  // vanished. Raised after the redirect target is decided, at the end.
  let unitDropped = false;

  if (error && unit && isMissingSchemaError(error)) {
    // Live DB hasn't run migration 0127 yet, so `unit` is not a column.
    // Retry without it: a condo owner still gets their home, just filed under
    // the street line until the migration is applied. Same missing-column-safe
    // convention as the contractor signup insert (src/app/pro/actions.ts).
    // Logged rather than silent - this is the signal that 0127 is still
    // pending on the live DB, and the unit the homeowner typed is being
    // dropped.
    console.error(
      "properties insert: `unit` column missing (run migration 0127); retrying without it:",
      error.message
    );
    ({ data: created, error } = await (supabase.from("properties") as any)
      .insert(extendedRow)
      .select("id")
      .single());
    if (!error) {
      // The insert failed WITH `unit` and succeeded WITHOUT it, which is proof
      // the column is missing rather than a guess. Tell src/lib/property.ts so
      // getProperties stops paying a doomed select plus a retry on every
      // request for the rest of this process's life.
      noteUnitColumnMissing();
      unitDropped = true;
    }
  }

  if (error && isMissingSchemaError(error)) {
    // Live DB hasn't run migration 0066 yet (one of the enrichment columns
    // is missing): fall back to the columns that have always existed so
    // onboarding still succeeds, same graceful-degradation convention as
    // confirmSystemAction (walkthrough/actions.ts). Cast to any for the same
    // reason as the extendedRow insert above: purchase_price/assessed_value/
    // assessed_year (0029/0039) aren't in database.types.ts either.
    ({ data: created, error } = await (supabase.from("properties") as any)
      .insert(baseRow)
      .select("id")
      .single());
    // baseRow carries no unit either, so a condo claim that lands here loses
    // it the same way. Worth the same warning, but NOT worth marking the
    // column missing: what failed here was a 0066 column, and `unit` was
    // never separately proven absent.
    if (!error && unit) unitDropped = true;
  }

  if (error || !created) {
    // Log the raw DB error server-side for debugging, but never surface it to
    // the client: return a plain, user-safe message through the same
    // ActionResult path as the checks above.
    console.error("Could not claim property:", error);
    return err("We couldn't claim your home just now. Please try again.");
  }

  // Homeowner terms, recorded at the moment a home is actually claimed. The
  // signup pages and /auth/callback already record this for anyone who came
  // through the homeowner door, and recordTermsAcceptance is idempotent, so
  // for them this is a no-op existence check. It matters for the account that
  // reached here another way: a pro adding a home is agreeing to the homeowner
  // terms now, and before this there was no row saying so.
  await recordTermsAcceptance(user.id, "terms");

  // Trial-abuse signals (src/lib/risk, migration 0130). Two accounts claiming
  // the SAME county parcel is one of the more telling links there is: a house
  // has one owner, and a second account on it is either the same person or
  // somebody who should be joining the household instead. Worth 20 points, not
  // a block - a genuine sale, a divorce, or a landlord and a tenant all produce
  // it honestly.
  //
  // The parcel id is hashed with the server salt before storage, like every
  // other signal. Best-effort: it cannot throw and cannot fail a claim.
  await recordSignal(user.id, "parcel", baseRow.parcel_id, "claim_property");

  // Ownership verification (migration 0093): match the county assessor's
  // owner-of-record for this address against the account holder's own name
  // (src/lib/ownershipMatch.ts). A claim that carries a unit skips the match
  // entirely and records an honest "unverified" instead - see below. This is the ONLY place
  // owner data is read - the client-submitted parcel JSON above never
  // carried it (OnboardingForm.tsx only forwards a fixed, named set of
  // hidden fields, none of them owner_names/owner_type), so there is
  // nothing here for a modified client to forge. Best-effort: any failure
  // just leaves the property unverified, never blocks onboarding.
  try {
    // The name is collected on the confirm step now (OnboardingForm.tsx's
    // full_name field), not at sign-up. Prefer that submitted value; fall back
    // to whatever is already on the account (a Google user's backfilled
    // metadata, or a name set in account settings) if the field somehow came
    // through empty.
    // Capped like every other stored string: this one is written to
    // users.full_name AND to the auth metadata, so an unbounded value would
    // land in two places at once.
    const submittedName = cappedFieldOrNull(
      formData,
      "full_name",
      FIELD_MAX.name
    );
    const fullName =
      submittedName ||
      (user.user_metadata?.full_name as string | undefined)?.trim() ||
      null;
    if (fullName) {
      // Persist to BOTH stores so every later reader sees the same name:
      // users.full_name (the greeting and account settings read it; the "users
      // self update" RLS policy from 0002 has no column restrictions, so the
      // ordinary user-scoped client can write it) AND the auth metadata (what
      // auth/callback backfills for Google users and what account settings
      // keeps in sync). Only touch metadata when it actually changed.
      await supabase.from("users").update({ full_name: fullName }).eq("id", user.id);
      const metaName =
        (user.user_metadata?.full_name as string | undefined)?.trim() || "";
      if (fullName !== metaName) {
        await supabase.auth.updateUser({ data: { full_name: fullName } });
      }
    }
    if (unit) {
      // A UNIT HAS NO OWNER OF RECORD HERE, so nothing is matched against.
      //
      // RentCast matches /v1/properties on the street and hands back the
      // BUILDING's record whichever unit rides along (see parcelCacheKey in
      // src/lib/parcel.ts). For a condo or townhome that record's owner of
      // record is the developer, the HOA, or whoever holds the master parcel -
      // it is not unit 4B's owner, and it is not evidence about the person
      // claiming 4B either way. Matching against it was wrong in both
      // directions: a "verified" from a lucky surname collision with the
      // building's owner, and a silent non-match for the honest owner of a unit
      // the county files separately.
      //
      // So the check is recorded as explicitly UNVERIFIED with its reason,
      // rather than skipped. Skipping would leave ownership_checked_at null,
      // and a null is what the lazy re-check in
      // src/app/(app)/contractors/actions.ts treats as "never checked" - it
      // would run the very building-level match this is refusing, on the first
      // job post.
      //
      // 'unverified' is one of the two statuses record_ownership_check accepts
      // (migration 0095); there is no third value and no reason column, so the
      // reason goes in p_owner_names, the one jsonb slot the RPC exposes. No
      // read path consults that column today (src/lib/property.ts deliberately
      // leaves it out of every select), so this stores the WHY for a human
      // reading the row without misleading anything that runs. A real
      // ownership_unverified_reason column is the proper home for it whenever
      // the next migration touches this table.
      await createAdminClient().rpc("record_ownership_check", {
        p_property_id: created.id,
        p_status: "unverified",
        p_owner_names: { reason: "unit-level records not available" },
        p_owner_type: null,
        p_owner_occupied: null,
      });
    } else {
      // Single-family: the street address IS the parcel, so the county's owner
      // of record is a real statement about this home.
      //
      // The very same facts the gate above already verified, rather than a
      // third lookupParcel call with identical arguments: the gate ran either
      // the corrected-address lookup or the cached re-check, and both of them
      // answered this exact question already.
      const facts = claimFacts;
      // Record nothing unless there is a verdict worth keeping.
      // shouldRecordOwnershipCheck (src/lib/ownershipMatch.ts) says no for a
      // null lookup AND for source "unavailable", because
      // record_ownership_check stamps ownership_checked_at and a null
      // ownership_checked_at is the only thing that keeps the lazy re-check on
      // first job post eligible to run. Writing "unverified" during an outage
      // would burn that retry and leave the home permanently unverified.
      if (shouldRecordOwnershipCheck(facts) && facts) {
        const status = deriveOwnershipStatus(fullName, facts);
        await createAdminClient().rpc("record_ownership_check", {
          p_property_id: created.id,
          p_status: status,
          p_owner_names: facts.owner_names,
          p_owner_type: facts.owner_type,
          p_owner_occupied: facts.owner_occupied,
        });
      }
    }
  } catch (err) {
    console.error("Ownership verification check failed:", err);
  }

  // Homeowner referral attribution (migration 0100). If a ?ref= code rode all
  // the way here from an invite link (threaded through /homeowner-signup ->
  // /onboarding -> OnboardingForm's hidden field) AND this is the claimer's
  // first owned home, credit the neighbor who invited them - once, ever.
  //
  // Gated to the first owned home (ownedHomes.length === 0 above): a code only
  // attributes a genuinely new homeowner, never someone adding a second
  // property later. Resolving another user's code requires the admin client
  // (RLS "users self select" hides every row but the caller's own), and the
  // write is guarded three ways: skip self-referral, skip if the code doesn't
  // resolve, and only set referred_by when it is still null so it can never be
  // overwritten. v1 attaches no reward to this - it is an honest record only.
  //
  // Entirely best-effort: any failure is swallowed. Attribution must never
  // affect whether a signup or home claim succeeds.
  if (ownedHomes.length === 0) {
    try {
      const rawRef = ((formData.get("ref") as string) ?? "").trim();
      // Bound and normalize before it touches a query: the generator only ever
      // emits [A-Z2-9]{8}, so anything outside that shape can't be a real code.
      const refCode = /^[A-Z0-9]{4,16}$/.test(rawRef) ? rawRef : null;
      if (refCode) {
        const admin = createAdminClient();
        const { data: inviter } = await (admin.from("users") as any)
          .select("id")
          .eq("referral_code", refCode)
          .maybeSingle();
        if (inviter?.id && inviter.id !== user.id) {
          await (admin.from("users") as any)
            .update({ referred_by: inviter.id })
            .eq("id", user.id)
            .is("referred_by", null);
        }
      }
    } catch (err) {
      console.error("Homeowner referral attribution failed:", err);
    }
  }

  // Make the new home the active one.
  (await cookies()).set(ACTIVE_HOME_COOKIE, created.id, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });

  // Surface research: pre-build a starter inventory so the owner doesn't add
  // every system manually. Year is estimated from the build year (assuming each
  // system was replaced around the end of its typical life). Every row is
  // created UNCONFIRMED: confirmed_at stays at its null default (migration
  // 0056: null = still an estimate), which is what lets the UI treat these
  // years as guesses rather than owner-verified facts. Don't set the column
  // explicitly here - the live DB may not have run 0056 yet (see the fallback
  // in walkthrough/actions.ts), and the default is already correct.
  const yearBuilt = int("year_built", 1700, 2100);
  const starterRows = STARTER_SYSTEMS.map((system_type) => {
    const lifespan = DEFAULT_LIFESPANS[system_type] ?? 20;
    let install_year: number | null = null;
    if (yearBuilt) {
      const age = CURRENT_YEAR - yearBuilt;
      if (age <= 0) {
        // Brand-new (or future-dated) build: everything installed at build.
        install_year = yearBuilt;
      } else {
        // Years since the most recent assumed replacement. When home age is
        // an exact multiple of the lifespan, the system is at the END of its
        // life, not brand new: a 75-year-old home does not get a brand-new
        // 75-year foundation.
        const yearsIntoCycle = age % lifespan || lifespan;
        install_year = CURRENT_YEAR - yearsIntoCycle;
      }
    }
    return {
      property_id: created.id,
      system_type,
      install_year,
      expected_lifespan_years: lifespan,
      // No per-system note: confirmed_at null already marks the row as an
      // estimate, and the "auto-estimated" notice lives at the top of the
      // Home Profile page instead.
      notes: null as string | null,
      // Real material read off the RentCast property record when available
      // (roof/foundation/hvac - see deriveSystemFacts in src/lib/parcel.ts),
      // otherwise left null same as before.
      material_or_model: systemFacts?.[system_type] ?? null,
    };
  });
  // A silent failure here is the difference between a dashboard that shows
  // seven systems and their first issues on day one and one that shows an
  // empty inventory with no explanation - and this insert used to swallow its
  // error entirely. It still must never fail the claim (the home is already
  // saved), so the fallback is a second, narrower insert with only the columns
  // that have existed since 0001, then a logged give-up.
  const { error: seedError } = await supabase
    .from("home_systems")
    .insert(starterRows);
  if (seedError) {
    console.error("Starter system seed failed, retrying minimal:", seedError);
    const { error: retryError } = await supabase.from("home_systems").insert(
      starterRows.map((row) => ({
        property_id: row.property_id,
        system_type: row.system_type,
        install_year: row.install_year,
      }))
    );
    if (retryError) {
      console.error("Starter system seed failed outright:", retryError);
    }
  }

  // The home is claimed, but the unit number never made it onto the row (the
  // live DB has not run 0127). Say so plainly instead of letting a condo owner
  // discover their address reads as the whole building.
  //
  // The old wording ended "add it later from Household", which was an
  // instruction to do something impossible: Household has no unit field, and
  // could not have one until the column exists - which is the very thing that
  // is missing here. Sending someone hunting for a box that isn't there is
  // worse than saying nothing, so the message now stops at the honest half.
  if (unitDropped) {
    await setFlash(
      "Your home is saved. We couldn't save the unit number yet.",
      "warning"
    );
  }

  revalidatePath("/", "layout");
  // Send them where they were originally headed (?next=, carried here from
  // the sign-up funnel via a hidden field - see OnboardingForm.tsx), now that
  // they have a claimed home to get there with. Re-validate with the same
  // guard used everywhere else ?next= is read: a form field is still
  // attacker-influenced input, not any more trustworthy than a query string.
  // No original destination - the ordinary path - lands on the Home page to
  // add systems next.
  const next = safeNextPath(formData.get("next") as string | null);
  redirect(next ?? "/dashboard?welcome=1");
}
