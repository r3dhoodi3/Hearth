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
import { plausibleHomeFigure } from "@/lib/parcelSanity";
import { sameStreetAddress } from "@/lib/addressMatch";
import { verifyAddressExists } from "@/lib/addressVerify";
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
import { trackServerEvent } from "@/lib/trackServer";
import { clientIpFromHeaders } from "@/lib/clientIp";
import {
  boundedNumber,
  boundedInt,
  cappedField,
  cappedFieldOrNull,
  isAllowedValue,
  FIELD_MAX,
} from "@/lib/formFields";

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
// The county assessor's parcel number, as returned by the records source. A
// real APN is a short punctuated string ("934-231-14"); 64 is already several
// times any format in use, and without a ceiling a provider field lands on the
// row (and into the risk-signal hash) at whatever length it likes.
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
  const ip = clientIpFromHeaders(await headers());
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
  // Capped before it reaches the RentCast call below, same ceiling
  // claimPropertyAction enforces on address_line1: a server action takes
  // whatever it is handed, and an uncapped street here would let a crafted
  // post pay for an outbound request URL of unbounded length (persona H4).
  const cappedStreet = street.trim().slice(0, MAX_ADDRESS_LENGTH);
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
      cappedStreet,
      zip.trim(),
      // Capped here as well as on the claim: a server action takes whatever
      // it is handed, and this value reaches an outbound request URL.
      (unit ?? "").trim().slice(0, MAX_UNIT) || null
    );

  // IS THIS A REAL ADDRESS?
  //
  // A records MISS is no longer the test. It used to be: source "none" from a
  // configured RentCast refused the address outright, on the reading that the
  // county would know every real home. It does not. On 2026-08-27 five of ten
  // personas were stopped on plausible Orange County addresses, and the
  // follow-up measured four of them straight against the API - 1920 Main St
  // Irvine, 800 Baker St Costa Mesa, 1201 Magnolia Ave Anaheim, 1620 E 1st St
  // Santa Ana - each a hard 404 in every address format tried, while a
  // known-good address answered in a second. RentCast's coverage of the launch
  // metro is patchy, so refusing on its silence turns one vendor's data gap
  // into a locked front door.
  //
  // So a miss now walks on to the confirm step as manual entry, with copy that
  // says exactly that (OnboardingForm.tsx), no parcel facts attached, and
  // ownership left unverified rather than recorded (shouldRecordOwnershipCheck
  // in src/lib/ownershipMatch.ts).
  //
  // The fake-address job moves to the geocoder, which is a better fit for it:
  // Photon knows all four of those addresses with a house number and knows no
  // invented one. Only asked when RentCast did NOT confirm the address - a
  // record IS confirmation, and there is no sense spending a second lookup to
  // re-learn it.
  //
  // FAILS OPEN by construction: verifyAddressExists returns "unavailable" for
  // a timeout, a non-ok status, or an empty answer, and only "no_match"
  // refuses. Conflating "we couldn't check" with "this does not exist" is the
  // 2026-08-24 outage, and it is not getting repeated with a new vendor.
  if (publicFacts.source !== "rentcast") {
    const verdict = await verifyAddressExists(cappedStreet, zip.trim());
    if (verdict === "no_match") {
      return { ok: false, error: ADDRESS_NOT_FOUND_MESSAGE, notFound: true };
    }
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
  // it there. Correcting it means the record the Continue step found is about a
  // different property than the one being claimed, and the coordinates in
  // particular are what /value, the weather alerts, and the pro matching all
  // key off, so this is not a cosmetic mismatch.
  //
  // So the claim compares the submitted street against the line the lookup
  // actually returned (`looked_up_address`, a hidden field). Same normalization
  // parcelCacheKey uses, so a whitespace or casing difference is not an edit.
  // When they differ, the facts are re-derived from a fresh lookup of the
  // address actually being claimed rather than reusing the cached record for
  // the old line.
  //
  // A missing looked_up_address counts as edited. A browser always sends it,
  // so its absence means a hand-made post, and re-deriving is the safe reading
  // of one.
  //
  // What this flag no longer decides is WHERE the parcel facts come from: as of
  // 2026-08-28 they come from the server's own lookup on both branches (see
  // parcelNum below), never from a hidden field, so an unedited claim is no
  // longer trusted to echo its own numbers back.
  //
  // Only the FROZEN facts are re-derived. The fields the confirm step puts on
  // screen - city, state, year built, size, beds, baths, lot size, property
  // type - keep whatever was submitted either way, because the person who
  // lives there is the authority on those and overwriting their typing with a
  // records value is the bug this whole screen exists to avoid.
  //
  // The ZIP is read-only on the ready step AND is the only `zip` the form
  // posts, so the re-lookup runs against the same ZIP the original one did.
  // Both halves of that sentence had to be made true on 2026-08-28: the
  // locked, visible ZIP box carried no `name` at all, so the only `zip` in the
  // POST came from a second, freely editable box inside the optional-details
  // disclosure - clearing that box refused the homeowner's own claim with
  // "Hearth isn't in your area yet" and filed them on the out-of-area
  // waitlist. See OnboardingForm.tsx.
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

  // =========================================================================
  // METER BEFORE ANY OUTBOUND CALL, ON BOTH BRANCHES.
  //
  // Everything below this point can reach a third party: lookupParcel makes a
  // billed RentCast call for any street nothing has fetched yet, and
  // verifyAddressExists asks Photon whenever there is no county record.
  //
  // Both used to be metered only on the EDITED branch, on the reasoning that
  // an unedited claim re-reads the parcel_cache row the Continue step just
  // wrote and therefore spends nothing. That reasoning holds for the form, and
  // only for the form. address_line1, zip and looked_up_address all arrive as
  // FormData, so a hand-made POST that sets looked_up_address equal to a fresh
  // street on every request takes the "unedited" branch every time, spends a
  // billed RentCast lookup and an uncached Photon call every time, and never
  // consumes a home row to do it - the claim is free to fail afterwards for
  // any reason at all.
  //
  // So the same two per-user buckets lookupParcelAction spends (migration
  // 0068) are spent here first, whichever branch runs. A real signup pays one
  // extra token per claim against a 10/hour, 25/day budget, which no
  // household comes near.
  //
  // FAIL-OPEN on a limiter hiccup, same as every other rate_limit_hit call in
  // this file: only an explicit `allowed === false` blocks.
  // =========================================================================
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
  // Distinguished from "the lookup ran and failed": a limiter refusal means
  // nothing has EVER looked at this street, and the gate below turns that into
  // a refusal rather than storing an unchecked address.
  const lookupBlocked = allowedHour === false || allowedDay === false;

  // The fresh facts for an edited address. Null means "no facts to use": either
  // the re-lookup was refused by the rate limiter or it failed outright, in
  // which case every frozen field below lands as null. That is the deliberate
  // choice - a claim with no assessed value is a gap the owner can fill in from
  // Home Profile, while a claim carrying another address's assessed value is
  // wrong data that nothing downstream can tell apart from real data.
  let relookupFacts: ParcelFacts | null = null;
  if (addressEdited && !lookupBlocked) {
    try {
      relookupFacts = await lookupParcel(addressLine1, claimZip);
    } catch (lookupError) {
      // Never fatal. The home is still theirs to claim; it just arrives
      // without the county's numbers on it.
      console.error("Corrected-address parcel lookup failed:", lookupError);
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
  // The lookup itself is usually free: an edited address already paid for
  // relookupFacts above, and an unedited one hits the parcel_cache row
  // (migration 0069) the Continue step just wrote - the same cached read the
  // ownership check further down already makes. "Usually" is why it is metered
  // anyway a few lines up: a POST that never went through the Continue step
  // has no cache row waiting for it.
  //
  // The decision itself is claimAddressGate (src/lib/parcelGate.ts), which is
  // where its reasoning and its tests live. In short: the GEOCODER decides
  // whether the address is real, and only its explicit "no_match" refuses. A
  // records miss does not refuse any more - RentCast's coverage of the launch
  // metro was measured on 2026-08-28 and is patchy enough that its silence
  // says nothing about whether a home exists (see lookupParcelAction above).
  // Neither does a records outage, or a geocoder outage, or a lookup that
  // threw: "we couldn't check" is not "this address does not exist", and that
  // conflation is what refused every real address for a day on 2026-08-24. The
  // one other intolerant case is a street the rate limiter would not let us
  // look up at all: no records call has ever been spent on it, so there are no
  // facts to attach and nothing to decide on.
  //
  // claimFacts is also what the ownership check at the end of this action
  // uses, instead of a third lookupParcel with identical arguments. Each call
  // waits out its own timeout when the source is down, and three of them meant
  // the better part of a minute on the claim button.
  // =========================================================================
  let claimFacts: ParcelFacts | null = relookupFacts;
  if (hasRecordsSource() && !addressEdited && !lookupBlocked) {
    try {
      claimFacts = await lookupParcel(addressLine1, claimZip);
    } catch (error) {
      console.error("Claim-time address verification lookup failed:", error);
      claimFacts = null;
    }
  }
  // Same rule as the Continue step: a confirmed county record IS proof the
  // address is real, so the geocoder is only asked when there is no record.
  // Both calls hit the same 10-minute verdict cache (src/lib/addressVerify.ts),
  // so a normal signup asks Photon once, not twice.
  //
  // A limiter refusal skips the geocoder outright: Photon is the OTHER
  // outbound call the hoisted budget above exists to protect, so spending one
  // on a claim that is about to be refused anyway would defeat the meter.
  const addressVerdict = lookupBlocked
    ? ("unavailable" as const)
    : claimFacts?.source === "rentcast"
      ? ("match" as const)
      : await verifyAddressExists(addressLine1, claimZip);
  // claimAddressGate's own lookup_blocked rule is written for the edited
  // branch, which was the only branch that could be blocked when the limiter
  // lived inside it. Now that the budget is spent before both lookups, an
  // unedited claim can be blocked too, and it is the same situation with the
  // same answer: nothing was looked up, so there is nothing to decide on and
  // no facts to attach.
  const gate = lookupBlocked
    ? ({ action: "refuse", reason: "lookup_blocked" } as const)
    : claimAddressGate({
        hasRecordsSource: hasRecordsSource(),
        addressEdited,
        // Always false on this branch: a blocked lookup was answered above,
        // so anything reaching claimAddressGate got the lookup it needed.
        relookupBlocked: false,
        addressVerdict,
      });
  if (gate.action === "refuse") {
    return err(
      gate.reason === "lookup_blocked"
        ? "Too many address lookups right now. Please try again in a bit."
        : ADDRESS_NOT_FOUND_MESSAGE
    );
  }

  const factString = (v: number | string | null | undefined): string | null =>
    v === null || v === undefined ? null : String(v);
  // =========================================================================
  // DOES THE RECORD WE FOUND ACTUALLY DESCRIBE THE ADDRESS BEING CLAIMED?
  //
  // A tester picked "1770 South Harbor Boulevard" from the suggestion list.
  // RentCast answered with a record for 2170 S Harbor Blvd - a real record,
  // for a different property - and the form swapped it in silently, so the
  // claim step and every page after it showed an address she had never typed.
  // The confirm step now keeps HER line in the street box and offers the
  // county's as a choice (OnboardingForm.tsx); this is the server half, and it
  // is deliberately not a posted flag but a comparison the server makes for
  // itself, so a hand-made post cannot decide it either way.
  //
  // sameStreetAddress (src/lib/addressMatch.ts) compares house number and
  // street tokens and ignores the unit, so "1770 South Harbor Boulevard" and
  // "1770 S Harbor Blvd Unit 204" are the same address and "2170 S Harbor
  // Blvd" is not.
  //
  // An UNEDITED claim needs no comparison: unedited means the street being
  // claimed IS the line the lookup returned, so the facts describe it by
  // definition. Only an edited one - which is what keeping your own address
  // over the county's amounts to - is checked.
  //
  // THERE ALSO HAS TO BE A RECORD. The `source === "rentcast"` half applies to
  // both branches as of 2026-08-28: a records miss used to be refused outright
  // a few lines up, so no claim could reach here without a real record behind
  // it, and misses walk on now. If nothing was found, nothing is written.
  //
  // Note what this check does NOT prove, which is why every parcel value below
  // is read from claimFacts rather than from the post: it says a record exists
  // for this street, not that any particular number came from that record.
  //
  // When it does not match, every parcel-derived field below lands as null.
  // The home is still theirs to claim; it just arrives with none of another
  // property's numbers on it. The visible fields they can see and correct -
  // city, state, year built, size, beds, baths, lot size, property type - are
  // unaffected, same as everywhere else on this screen.
  const parcelFactsMatchClaim =
    claimFacts != null &&
    claimFacts.source === "rentcast" &&
    (!addressEdited ||
      sameStreetAddress(addressLine1, claimFacts.address_line1));

  // A parcel-derived field, read from the SERVER's own lookup (claimFacts) on
  // BOTH branches. Never from the post.
  //
  // Until 2026-08-28 an unedited claim read every one of these back out of a
  // hidden form field, on the reasoning that the hidden fields were the
  // lookup's own answer echoed back. They are not. A server action takes
  // whatever FormData it is handed, so a hand-made POST could set parcel_id,
  // latitude, longitude, county, the assessed value and year, the last sale,
  // the tax history and the system facts to anything at all - and
  // parcelFactsMatchClaim above only proved that SOME record exists for the
  // street, never that the posted numbers came out of it. The coordinates were
  // the worst of it: /value, the weather alerts and the pro matching all key
  // off latitude/longitude, so a forged pair quietly points the whole product
  // at a house of the poster's choosing.
  //
  // claimFacts is already fetched on both branches (the corrected-address
  // lookup, or the unedited re-check the gate above made), so reading from it
  // costs nothing extra. Three shapes, because the columns are numeric,
  // integer and text respectively.
  const parcelNum = (
    value: number | null | undefined,
    min: number,
    max: number
  ) =>
    !parcelFactsMatchClaim ? null : boundedNumber(factString(value), min, max);
  const parcelInt = (
    value: number | null | undefined,
    min: number,
    max: number
  ) => (!parcelFactsMatchClaim ? null : boundedInt(factString(value), min, max));
  const parcelText = (value: string | null | undefined, max: number) =>
    !parcelFactsMatchClaim ? null : (value ?? "").trim().slice(0, max) || null;

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

  // The two RentCast enrichment blobs, from the same server-side facts as
  // every other parcel value above. They used to ride in as hidden JSON
  // fields and be JSON.parse'd back out of the post on an unedited claim,
  // which was the same forgery hole as the scalars - with a longer reach, as
  // system_facts lands in home_systems.material_or_model on all seven starter
  // rows. Nothing is parsed from the client any more, so there is no blob-size
  // ceiling to enforce and no parse to fail.
  const propertyTaxHistory: { year: number; amount: number }[] | null =
    parcelFactsMatchClaim ? (claimFacts?.property_tax_history ?? null) : null;
  // An empty map rather than null when the record does not describe this
  // claim: the other building's roof and foundation are not this home's, and
  // the starter systems seed blank instead - which is what they did before
  // RentCast was wired up.
  const systemFacts: Record<string, string> = parcelFactsMatchClaim
    ? (claimFacts?.system_facts ?? {})
    : {};

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

  // THE BUILDING-RECORD GATE (src/lib/parcelSanity.ts), applied at the WRITE,
  // not only at the read. RentCast returns the building's record for a street
  // line, so a condo claim can arrive carrying the parcel's own sale price and
  // county assessment: a real tester's home was stored with a $34,000,000
  // purchase price and a $36,410,541 assessed value, which /value and /taxes
  // then printed as hers. Storing them and hiding them later would leave the
  // wrong numbers on the row for every future reader (the digest cron, the
  // appeal letter, an export), so they are refused here as well.
  //
  // NOTHING THE POST CAN SET REACHES THE GATE'S OWN YARDSTICK.
  //
  // The gate measures a figure against the home's estimate and its size, and
  // both of those used to come from the claim itself: `estimate` was the
  // posted market_value hidden field, and `sqft` was the visible size box. So
  // a forged post could hand itself a $500,000,000 estimate (raising the
  // building-level ceiling to $5,000,000,000) or a 900,000 sqft size (which
  // switches the absolute-ceiling rule off entirely, since it only fires under
  // SMALL_HOME_SQFT) and walk a $34,000,000 building price straight onto the
  // row - which is the exact number this gate exists to refuse.
  //
  // So the estimate is null and the size is the server's own. A null estimate
  // is not a loss: onboarding never had a real one to measure against anyway
  // (see market_value on extendedRow below), so this only drops the
  // building-level test to its IMPLAUSIBLE_FLOOR, which is where it already
  // sat in practice.
  const sanityContext = {
    unit,
    propertyType,
    sqft: parcelInt(claimFacts?.sqft, 1, 1_000_000),
    estimate: null,
  };
  const claimPurchasePrice = plausibleHomeFigure(
    parcelNum(claimFacts?.purchase_price, 0, 1_000_000_000),
    sanityContext
  );
  const claimAssessedValue = plausibleHomeFigure(
    parcelNum(claimFacts?.assessed_value, 0, 1_000_000_000),
    sanityContext
  );

  const baseRow = {
    user_id: user.id,
    // Frozen fact: the assessor's parcel number belongs to whichever address
    // the lookup actually resolved, so it is re-derived when the street was
    // corrected rather than carried over from the old one.
    parcel_id: parcelText(claimFacts?.parcel_id, MAX_PARCEL_ID),
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
    // The sale DATE goes only where the sale PRICE goes: a purchase year with
    // no price behind it is the building's transfer date, and /value would
    // still model from it.
    purchase_date:
      claimPurchasePrice == null
        ? null
        : validPurchaseDate(claimFacts?.purchase_date ?? null),
    purchase_price: claimPurchasePrice,
    assessed_value: claimAssessedValue,
    // Same rule for the assessment year: it labels a figure that is not being
    // stored.
    assessed_year:
      claimAssessedValue == null
        ? null
        : parcelInt(claimFacts?.assessed_year, 1700, 2100),
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
    latitude: parcelNum(claimFacts?.latitude, -90, 90),
    longitude: parcelNum(claimFacts?.longitude, -180, 180),
    hoa_fee: parcelNum(claimFacts?.hoa_fee, 0, 100_000),
    county: parcelText(claimFacts?.county, MAX_COUNTY),
    property_tax_history: propertyTaxHistory,
    // THE AVM IS NOT WRITTEN AT CLAIM TIME AT ALL.
    //
    // lookupParcel makes one call, for the property record, and never asks for
    // an estimate - so market_value/_low/_high on ParcelFacts are null on
    // every path through onboarding (blankFacts and the record mapper in
    // src/lib/parcel.ts both hard-code them null). The only values that ever
    // filled these three columns here came out of hidden form fields, which
    // means they came from the poster, and they did double duty as the sanity
    // gate's own yardstick above. /value fetches the real AVM lazily
    // (lookupMarketValue) and stores it then, which is the only place an
    // estimate is ever known.
    market_value: null,
    market_value_low: null,
    market_value_high: null,
  };

  // =========================================================================
  // DUPLICATE-CLAIM GUARD (double-submit / two tabs).
  //
  // properties has no unique constraint (0001 only sets the id PK), and the
  // home-cap trigger (0108) only counts rows, it does not dedupe them - so a
  // double-tap on "Claim my home", or the same account submitting from two
  // browser tabs, could reach this insert twice with the same address and
  // create two property rows for one house: two seed system sets, two billed
  // RentCast lookups already spent above, and (for a Plus landlord) two of
  // their paid home slots burned on a single claim.
  //
  // A fresh, un-cached read right here - not the `existingHomes` fetched at
  // the top of this action for the cap check, which is already stale by the
  // time execution reaches the insert - narrows the race to the gap between
  // this select and the insert below. It cannot close that gap outright
  // (only a DB-level lock or constraint can: see the unique-index backstop
  // planned for a follow-up migration on (user_id, lower(address_line1),
  // zip)), but it turns the common case - a client-side double-submit, or a
  // second tab that was already open when the first claim finished - into a
  // no-op that lands the person on the home they already have instead of a
  // second row for it.
  //
  // Normalized the same way addressEdited compares street lines above, so
  // "123 Oak St" and "123 oak st" read as the same claim. Scoped to this
  // user's OWN rows only, same as the cap check - a home shared with this
  // user as a household member belongs to a different user_id and is neither
  // a duplicate of, nor a block on, their own claim.
  const normalizedClaimStreet = addressLine1
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
  const { data: ownRows } = await supabase
    .from("properties")
    .select("id, address_line1, zip, unit")
    .eq("user_id", user.id);
  const duplicateHome = (ownRows ?? []).find(
    (row: any) =>
      (row.zip ?? null) === (claimZip || null) &&
      // Unit is part of the identity (migration 0127): a landlord who owns
      // unit 4 and unit 5 at one street address holds two distinct homes, so
      // they must NOT collapse into one. Compared with coalesce-to-empty, the
      // same normalization the properties_owner_address_unique index (0151)
      // uses, so this code guard and the DB backstop agree exactly.
      (row.unit ?? "") === (unit ?? "") &&
      String(row.address_line1 ?? "")
        .trim()
        .replace(/\s+/g, " ")
        .toLowerCase() === normalizedClaimStreet
  );
  if (duplicateHome) {
    // Not an error: the claim they asked for already exists, so send them to
    // it rather than refusing outright or, worse, creating a second row for
    // it. Same cookie-set-then-redirect shape as a fresh successful claim
    // below.
    (await cookies()).set(ACTIVE_HOME_COOKIE, duplicateHome.id, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 365,
    });
    revalidatePath("/", "layout");
    const nextDup = safeNextPath(formData.get("next") as string | null);
    redirect(nextDup ?? "/dashboard?welcome=1");
  }

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
    // A LOST RACE against the cap trigger's own advisory lock (0108): the
    // app-level cap check at the top of this action already read
    // ownedHomes.length < cap, but a concurrent claim from the same account
    // (another tab, or a request that started just before this one) can
    // still land its insert first and push the count over the cap by the
    // time THIS insert reaches the trigger. Postgres then raises with
    // errcode = 'check_violation' (SQLSTATE 23514, see
    // enforce_properties_home_cap in supabase/migrations/0108_home_cap.sql),
    // which lands here as error.code === "23514" - not as a generic insert
    // failure. Route to the same place the app-level cap check above sends a
    // free account, instead of the flat "couldn't claim" message that hides
    // WHY it actually failed.
    if (error?.code === "23514") {
      // Plan-aware, mirroring the app-level cap check above: a free account
      // gets the upsell; a Plus account genuinely at its (higher) cap gets the
      // "using all N homes" flash, not free-tier copy.
      if (!plus) {
        redirect("/plus?reason=home_limit");
      }
      await setFlash(
        `You're using all ${cap} of your homes. You can add more homes anytime from the Plus page.`,
        "error"
      );
      redirect("/plus");
    }
    return err("We couldn't claim your home just now. Please try again.");
  }

  // Funnel analytics (docs/ANALYTICS.md): ids and enums only, never the
  // address itself. match_source is the same signal deriveOwnershipStatus
  // above reads: parcelFactsMatchClaim is true only when the county assessor
  // has a record for this exact street, so "real" here means a records-backed
  // claim, not a name-verified one - a claim on an unmatched street is still
  // "manual" even when the ownership check later says verified.
  await trackServerEvent(user.id, "home_claimed", {
    match_source: parcelFactsMatchClaim ? "real" : "manual",
  });

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
  // entirely and records an honest "unverified" instead - see below. The owner
  // of record is read from claimFacts, the server's own lookup, and there is
  // no client-supplied parcel data left anywhere in this action for a modified
  // client to forge (lookupParcelAction strips owner_names/owner_type/
  // owner_occupied before the browser ever sees them). Best-effort: any
  // failure just leaves the property unverified, never blocks onboarding.
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
      // Null when the record we found describes a DIFFERENT street than the
      // one being claimed (parcelFactsMatchClaim above): that record's owner
      // of record belongs to another property, so matching a name against it
      // would be worse than not checking. A null here leaves
      // ownership_checked_at null, which is exactly right - this home has
      // never been checked, and the lazy re-check on first job post stays
      // eligible to try again.
      const facts = parcelFactsMatchClaim ? claimFacts : null;
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
    // Real material read off the RentCast property record when available
    // (roof/foundation/hvac - see deriveSystemFacts in src/lib/parcel.ts),
    // otherwise left null same as before.
    //
    // Coerced rather than trusted even now that the map comes from the server:
    // system_facts is TYPED Record<string, string>, but its values are built
    // out of a third-party JSON body, and a type annotation is not a runtime
    // check - a number, an object, or a page-long string would land on the
    // column exactly as it arrived. Same coercion parseFacts uses in
    // ./draft.ts, with the tighter 120-char cap this column wants.
    const material = systemFacts[system_type];
    return {
      property_id: created.id,
      system_type,
      install_year,
      expected_lifespan_years: lifespan,
      // No per-system note: confirmed_at null already marks the row as an
      // estimate, and the "auto-estimated" notice lives at the top of the
      // Home Profile page instead.
      notes: null as string | null,
      material_or_model:
        typeof material === "string" ? material.slice(0, 120) : null,
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
