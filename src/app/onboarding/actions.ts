"use server";

import { cookies, headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { ACTIVE_HOME_COOKIE, getProperties } from "@/lib/property";
import { lookupParcel, type PublicParcelFacts } from "@/lib/parcel";
import { deriveOwnershipStatus } from "@/lib/ownershipMatch";
import { DEFAULT_LIFESPANS } from "@/lib/health";
import { ownsPlus, getExtraHomeSlots } from "@/lib/subscription";
import { setFlash } from "@/lib/flash";
import { safeNextPath } from "@/lib/safeNext";
import { isMissingSchemaError } from "@/lib/dbErrors";
import { isOrangeCountyZip } from "@/lib/serviceArea";
import { PROPERTY_TYPES } from "@/lib/constants";
import { ok, err, type ActionResult } from "@/lib/actionResult";
import {
  boundedNumber,
  boundedInt,
  cappedFieldOrNull,
  isAllowedValue,
} from "@/lib/formFields";

// Ceiling on the two raw JSON blobs the confirm step carries in as hidden
// fields. They are client input like everything else here, so the string is
// bounded BEFORE JSON.parse rather than after: parsing a multi-megabyte blob
// to then throw it away still costs the parse. Generous enough for a real
// RentCast payload (a handful of tax years, a dozen system facts) and small
// enough that a crafted post can't turn a claim into a memory spike.
const MAX_ENRICHMENT_JSON_CHARS = 20000;

// The one message shown by every service-area gate (this file's two checks,
// plus
// the fast client-side copy in OnboardingForm.tsx) - kept as a single
// constant so the wording can never drift between them.
const OC_ONLY_MESSAGE =
  "Hearth serves Huntington Beach and Fountain Valley right now. We added you to the waitlist and will email you the moment we expand to your area.";

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

// A trimmed length floor for "this is actually an address." An <input
// required> is not enough on its own: browsers treat a single space as a
// non-empty value, so a hasty Enter press (or a stray keystroke) could
// otherwise carry a blank/junk address all the way into a claimed home. This
// is the authoritative check - the matching one in OnboardingForm.tsx is
// only there for faster client-side feedback.
const MIN_ADDRESS_LENGTH = 5;

// Server-side ceilings for the free-text location columns (city/state/county
// are all `text`). The form's fields are client hints only; a server action
// takes whatever FormData it is handed, so each string is trimmed and capped
// before it lands on the row. Generous vs. any real place name, small enough
// that a crafted post can't stuff the column.
const MAX_CITY = 120;
const MAX_STATE = 60;
const MAX_COUNTY = 120;

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
// every OC-only gate below AND by OnboardingForm.tsx's own faster
// client-side ZIP check: that check short-circuits before ever calling
// lookupParcelAction, so without a direct call here someone rejected right
// there would never actually land on the waitlist. Returns an honest
// ActionResult instead of throwing, since the caller needs to tell the user
// plainly if the save itself failed, not just that they're out of area.
export async function joinMarketWaitlistAction(
  zip: string
): Promise<ActionResult<null>> {
  const supabase = createClient();
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
  const ip = headers().get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
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
export async function lookupParcelAction(
  street: string,
  zip: string
): Promise<PublicParcelFacts> {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Please sign in to look up your address.");

  if (street.trim().length < MIN_ADDRESS_LENGTH) {
    throw new Error("Enter your home's street address to continue.");
  }
  if (!/^\d{5}(-\d{4})?$/.test(zip.trim())) {
    throw new Error("Enter a valid 5-digit ZIP code.");
  }
  // Launch-restriction gate: checked before the rate limiter/RentCast call
  // below so an out-of-area address never spends a billed RentCast lookup.
  // OnboardingForm.tsx runs the same check client-side first and normally
  // never lets a rejected ZIP reach this action at all - this is the
  // fallback path (JS disabled, a modified client, or a direct call), so it
  // still logs the lead to the waitlist rather than silently dropping it.
  if (!isOrangeCountyZip(zip.trim())) {
    await joinMarketWaitlistAction(zip.trim());
    throw new Error(OC_ONLY_MESSAGE);
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
    throw new Error("Too many address lookups. Please try again in a bit.");
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
    throw new Error(
      "Too many address lookups today. Please try again tomorrow."
    );
  }

  // Strip the county assessor's owner-of-record before returning to the
  // client. owner_names/owner_type/owner_occupied are the values
  // claimPropertyAction later matches the typed name against to verify
  // ownership, so shipping them here (they're visible in the action response
  // in devtools) would hand a forged claim the answer key. claimPropertyAction
  // re-fetches the full ParcelFacts server-side via lookupParcel, so nothing
  // that legitimately needs them loses access.
  const { owner_names, owner_type, owner_occupied, ...publicFacts } =
    await lookupParcel(street.trim(), zip.trim());
  return publicFacts;
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
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/signin");

  // Free vs Plus home limits: a free homeowner may claim 1 home; Plus unlocks
  // up to 5 so a landlord/multi-property owner can track them all in one place,
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
  const cap = plus ? 5 + extraSlots : 1;
  if (ownedHomes.length >= cap) {
    if (!plus) {
      redirect("/plus?reason=home_limit");
    }
    setFlash(
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
  const addressLine1 = ((formData.get("address_line1") as string) ?? "").trim();
  if (addressLine1.length < MIN_ADDRESS_LENGTH) {
    return err("Enter your home's address before claiming it.");
  }

  // Launch-restriction gate: the authoritative one, since this is the step
  // that actually commits the address to a claimed home. Log the lead to the
  // waitlist (joinMarketWaitlistAction above) before rejecting - a failed
  // save (e.g. live DB hasn't run 0074 yet) must never block the message
  // itself from being shown, so its result is ignored here, not surfaced.
  const claimZip = ((formData.get("zip") as string) ?? "").trim().slice(0, 5);
  if (!isOrangeCountyZip(claimZip)) {
    await joinMarketWaitlistAction(claimZip);
    return err(OC_ONLY_MESSAGE);
  }

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
  let propertyTaxHistory: { year: number; amount: number }[] | null = null;
  try {
    const raw = enrichmentJson("property_tax_history");
    propertyTaxHistory = raw ? JSON.parse(raw) : null;
  } catch {
    propertyTaxHistory = null;
  }
  let systemFacts: Record<string, string> | null = null;
  try {
    const raw = enrichmentJson("system_facts");
    systemFacts = raw ? JSON.parse(raw) : {};
  } catch {
    systemFacts = {};
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
    parcel_id: (formData.get("parcel_id") as string) || null,
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
    purchase_date: validPurchaseDate(
      (formData.get("purchase_date") as string) || null
    ),
    purchase_price: num("purchase_price", 0, 1_000_000_000),
    assessed_value: num("assessed_value", 0, 1_000_000_000),
    assessed_year: int("assessed_year", 1700, 2100),
  };
  // extendedRow: baseRow plus the columns migration 0066 actually adds.
  // Attempted first, with baseRow as the fallback below if the live DB
  // hasn't run 0066 yet.
  const extendedRow = {
    ...baseRow,
    latitude: num("latitude", -90, 90),
    longitude: num("longitude", -180, 180),
    hoa_fee: num("hoa_fee", 0, 100_000),
    county: cappedFieldOrNull(formData, "county", MAX_COUNTY),
    property_tax_history: propertyTaxHistory,
    market_value: num("market_value", 0, 1_000_000_000),
    market_value_low: num("market_value_low", 0, 1_000_000_000),
    market_value_high: num("market_value_high", 0, 1_000_000_000),
  };

  // extendedRow's enrichment fields (everything migration 0066 adds) aren't
  // in src/lib/database.types.ts yet, so this call is cast to any - same
  // pattern as saveHomeValueAction (value/actions.ts) and
  // saveTaxAssessmentAction (taxes/actions.ts) for their own not-yet-typed
  // columns, rather than widening the generated types by hand.
  let { data: created, error } = await (supabase.from("properties") as any)
    .insert(extendedRow)
    .select("id")
    .single();

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
  }

  if (error || !created) {
    // Log the raw DB error server-side for debugging, but never surface it to
    // the client: return a plain, user-safe message through the same
    // ActionResult path as the checks above.
    console.error("Could not claim property:", error);
    return err("We couldn't claim your home just now. Please try again.");
  }

  // Ownership verification (migration 0093): re-run the same street/zip
  // lookup lookupParcelAction just did moments ago, which hits the fresh
  // parcel_cache row it wrote (0069) instead of billing RentCast again, and
  // match the county assessor's owner-of-record against the account
  // holder's own name (src/lib/ownershipMatch.ts). This is the ONLY place
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
    const submittedName = ((formData.get("full_name") as string) ?? "").trim();
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
    const facts = await lookupParcel(addressLine1, claimZip);
    const status = deriveOwnershipStatus(fullName, facts);
    await createAdminClient().rpc("record_ownership_check", {
      p_property_id: created.id,
      p_status: status,
      p_owner_names: facts.owner_names,
      p_owner_type: facts.owner_type,
      p_owner_occupied: facts.owner_occupied,
    });
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
  cookies().set(ACTIVE_HOME_COOKIE, created.id, {
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
  await supabase.from("home_systems").insert(starterRows);

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
