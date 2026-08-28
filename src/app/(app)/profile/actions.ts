"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getActiveProperty } from "@/lib/property";
import { DEFAULT_LIFESPANS } from "@/lib/health";
import { setFlash } from "@/lib/flash";
import { ok, err, type ActionResult } from "@/lib/actionResult";
import { labelFor, PROPERTY_TYPES, SYSTEM_TYPES } from "@/lib/constants";
import {
  boundedNumber,
  boundedInt,
  cappedFieldOrNull,
  isAllowedValue,
} from "@/lib/formFields";
import { isOwnedStoragePath } from "@/lib/ownedStoragePath";

// Server-side ceilings for the free-text columns on home_systems. The form's
// maxLength is a hint; a server action takes whatever FormData it is handed,
// so a paste of arbitrary size would otherwise land in the row. Truncate
// rather than reject: losing the tail of a long note is better than losing
// the whole save.
const MAX_MATERIAL = 120;
const MAX_NOTES = 2000;

// Ranges for the numeric columns. The install-year floor matches
// properties.year_built (which allows back to 1700, see updatePropertyAction
// below and onboarding/actions.ts): an owner of an 1885 home types 1885 as a
// real install year, and a 1900 floor here would silently null it out under a
// "System updated" toast. condition still matches confirmSystemAction
// (src/app/(app)/walkthrough/actions.ts) so a rating means the same thing
// however it was entered.
const INSTALL_YEAR_MIN = 1700;
const INSTALL_YEAR_MAX = 2100;
const CONDITION_MIN = 1;
const CONDITION_MAX = 5;

// "MM/YYYY" from the simple text field back to a "YYYY-MM-01" date for storage.
// Returns null if blank, not in that format, or the month isn't 1-12. The
// month check matters: without it "13/2024" became "2024-13-01", which
// Postgres rejects with 22008 (datetime field overflow) and kills the WHOLE
// update - and the retry that only drops optional columns still carried the
// bad date, so the owner got "Couldn't save" forever with no field named.
// Catching a bad month here turns that dead end into a clear, recoverable
// error at the call site instead.
function mmYyyyToDate(v: string | null): string | null {
  if (!v) return null;
  const m = v.trim().match(/^(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const month = Number(m[1]);
  if (month < 1 || month > 12) return null;
  return `${m[2]}-${m[1].padStart(2, "0")}-01`;
}

// The purchase date arrives from the form as a plain string. Only store a
// real YYYY-MM-DD with a year between 1900 and today; anything else becomes
// null so a typo never blocks the rest of the property update. (The /value
// feature stores this column as YYYY-01-01 and only reads the year, so any
// valid date works for it.)
function validPurchaseDate(v: string | null): string | null {
  if (!v) return null;
  const s = v.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const year = Number(s.slice(0, 4));
  if (year < 1900 || year > new Date().getFullYear()) return null;
  // Round-trip through Date to reject impossible days like 2020-02-31,
  // which would otherwise make Postgres reject the whole update.
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) {
    return null;
  }
  return s;
}

// HVAC filter reminder fields (consumables autopilot, migration 0042).
// Returns null when the form did not include them (non-hvac forms), so we
// never null out columns the owner could not see. Values are validated here:
// size capped at 20 chars, interval must be one of the offered choices.
const FILTER_INTERVAL_CHOICES = [1, 2, 3, 6, 12];

function filterFields(
  formData: FormData
): { filter_size: string | null; filter_interval_months: number | null } | null {
  if (!formData.has("filter_size") && !formData.has("filter_interval_months")) {
    return null;
  }
  const rawSize = ((formData.get("filter_size") as string) || "").trim();
  const size = rawSize && rawSize.length <= 20 ? rawSize : null;
  const rawInterval = (formData.get("filter_interval_months") as string) || "";
  const interval = rawInterval ? Number(rawInterval) : null;
  return {
    filter_size: size,
    filter_interval_months:
      interval != null && FILTER_INTERVAL_CHOICES.includes(interval)
        ? interval
        : null,
  };
}

// Exact model number + capacity / size (migration 0102), both optional free
// text. Returns null when the form did not include them (e.g. the dashboard
// quick-add chips), so we never null out columns the owner could not see.
// Each value is trimmed and capped so a stray huge paste can't land in the DB.
function modelCapacityFields(
  formData: FormData
): { model_number: string | null; capacity: string | null } | null {
  if (!formData.has("model_number") && !formData.has("capacity")) {
    return null;
  }
  const clean = (v: string) => {
    const t = v.trim();
    return t && t.length <= 60 ? t : t ? t.slice(0, 60) : null;
  };
  return {
    model_number: clean((formData.get("model_number") as string) || ""),
    capacity: clean((formData.get("capacity") as string) || ""),
  };
}

// Save any photos the owner uploaded (the PhotoUpload component already pushed
// them to storage and put the public URLs in the form as `photo_urls`). Photos
// are polymorphic, so we tag them with related_type "system".
//
// `photo_urls` is a hidden form field, so the key is client-chosen and nothing
// downstream re-derives it: the stored string is handed straight to /api/img
// to be signed. isOwnedStoragePath is the shared guard the issue tracker and
// the job poster already use, and it says the key must sit under this
// property's own folder - exactly what the uploader writes, so no legitimate
// save changes.
async function attachPhotos(
  formData: FormData,
  propertyId: string,
  systemId: string
) {
  const urls = (formData.getAll("photo_urls") as string[]).filter((u) =>
    isOwnedStoragePath(u, propertyId)
  );
  if (!urls.length) return;
  const supabase = await createClient();
  await supabase.from("photos").insert(
    urls.map((url) => ({
      property_id: propertyId,
      related_type: "system",
      related_id: systemId,
      url,
    }))
  );
}

// Used two ways: as a plain <form action> for the dashboard's one-tap quick-add
// chips (which never look at the return value, only the setFlash toast), and
// as a programmatic `await` from SystemForm's submit wrapper (which needs the
// ActionResult to keep the panel open and show an inline error on failure).
// Both paths get a flash + a typed result so neither call site is left guessing.
export async function addSystemAction(
  formData: FormData
): Promise<ActionResult<{ id: string }>> {
  const property = await getActiveProperty();
  if (!property) {
    setFlash("Add your home first, then you can add its systems.", "error");
    return err("Add your home first, then you can add its systems.");
  }
  const supabase = await createClient();

  const systemType = formData.get("system_type") as string;
  // The type drives the default lifespan, the icon, the label, and the "find a
  // pro" category, so an unknown value would write a system nothing in the app
  // can read back. Re-checked here because the <select> is only a client hint.
  if (!isAllowedValue(SYSTEM_TYPES, systemType)) {
    setFlash("Couldn't add that system. Try again.", "error");
    return err("Couldn't add that system. Please pick a type from the list.");
  }

  const baseRow = {
    property_id: property.id,
    system_type: systemType,
    material_or_model: cappedFieldOrNull(
      formData,
      "material_or_model",
      MAX_MATERIAL
    ),
    install_year: boundedInt(
      formData.get("install_year"),
      INSTALL_YEAR_MIN,
      INSTALL_YEAR_MAX
    ),
    last_serviced: mmYyyyToDate(formData.get("last_serviced") as string),
    condition_rating: boundedInt(
      formData.get("condition_rating"),
      CONDITION_MIN,
      CONDITION_MAX
    ),
    // Seed the expected lifespan from the type default so the dashboard works
    // immediately; the owner never has to know typical lifespans.
    expected_lifespan_years: DEFAULT_LIFESPANS[systemType] ?? null,
    notes: cappedFieldOrNull(formData, "notes", MAX_NOTES),
  };

  // Optional columns that a live DB might not have yet (HVAC filter reminder
  // fields, migration 0042; exact model_number + capacity, migration 0102).
  // Bundled together so that if EITHER migration has not run, a single retry
  // without them keeps adding a system working - same pattern as pro/actions.
  const filter = filterFields(formData);
  const modelCapacity = modelCapacityFields(formData);
  const extras =
    filter || modelCapacity
      ? { ...(filter ?? {}), ...(modelCapacity ?? {}) }
      : null;
  let { data: row, error } = extras
    ? await supabase
        .from("home_systems")
        .insert({ ...baseRow, ...extras } as any)
        .select("id")
        .single()
    : await supabase.from("home_systems").insert(baseRow).select("id").single();
  if (error && extras) {
    ({ data: row, error } = await supabase
      .from("home_systems")
      .insert(baseRow)
      .select("id")
      .single());
  }

  if (error || !row) {
    // Any photos the owner already picked were uploaded straight to storage
    // by PhotoUpload before this insert ran, so a failure here leaves them
    // orphaned (no DB row references them yet). Keeping this simple: surface
    // the error and let the owner retry from the still-open form, which will
    // attach those same photo URLs once the insert succeeds. Sweeping up
    // true orphans (the owner gives up instead of retrying) is left to
    // future janitor work, not built here.
    setFlash("Couldn't add that system. Try again.", "error");
    return err("Couldn't add that system just now. Please try again.");
  }
  await attachPhotos(formData, property.id, row.id);
  setFlash(`Added ${labelFor(SYSTEM_TYPES, systemType)}`);
  revalidatePath("/dashboard");
  revalidatePath("/home-report");
  return ok({ id: row.id });
}

// Form-action wrapper, toast-only callers: a plain <form action> prop needs a
// void-returning function, but addSystemAction returns an ActionResult for
// SystemForm's programmatic await. This just discards the result; the flash
// set inside addSystemAction is the only feedback these callers show.
export async function addSystemFormAction(formData: FormData): Promise<void> {
  await addSystemAction(formData);
}

// One-tap add: create a system with just its type + default lifespan. The owner
// can fill in year/condition later. Powers the quick-add chips on the profile.
export async function quickAddSystemAction(formData: FormData) {
  const property = await getActiveProperty();
  if (!property) {
    setFlash("Couldn't add that system. Try again.", "error");
    return;
  }
  const supabase = await createClient();

  const systemType = formData.get("system_type") as string;
  // Same allow-list as addSystemAction: the quick-add chips post a known type,
  // but the action itself will take any FormData.
  if (!isAllowedValue(SYSTEM_TYPES, systemType)) {
    setFlash("Couldn't add that system. Try again.", "error");
    return;
  }
  const { error } = await supabase.from("home_systems").insert({
    property_id: property.id,
    system_type: systemType,
    expected_lifespan_years: DEFAULT_LIFESPANS[systemType] ?? null,
  });
  if (error) {
    setFlash("Couldn't add that system. Try again.", "error");
    return;
  }
  setFlash(`Added ${labelFor(SYSTEM_TYPES, systemType)}`);
  revalidatePath("/dashboard");
  revalidatePath("/home-report");
}

// Plain <form action>, not called programmatically anywhere, so a setFlash
// error (rather than an ActionResult no one reads) is the right signal.
export async function deleteSystemAction(formData: FormData) {
  const id = formData.get("id") as string;
  const supabase = await createClient();
  // RLS guarantees the row belongs to the caller's property.
  const { error } = await supabase.from("home_systems").delete().eq("id", id);
  if (error) {
    setFlash("Couldn't remove that system. Try again.", "error");
    return;
  }
  setFlash("System removed", "info");
  revalidatePath("/dashboard");
  revalidatePath("/home-report");
}

// Called programmatically from SystemRow's edit form so it can keep the panel
// open with the owner's edits intact and show an inline error on failure.
export async function updateSystemAction(
  formData: FormData
): Promise<ActionResult> {
  const id = formData.get("id") as string;
  const supabase = await createClient();

  // The system id is a hidden form field, so it is whatever the caller sends.
  // RLS ("home_systems owner all", 0002) already keeps the update below inside
  // homes this account can reach, but an account can hold SEVERAL homes and
  // attachPhotos at the end of this action tags its rows with the ACTIVE
  // home's id - so an id belonging to a different home would file that home's
  // photos under this one, and an id belonging to nobody would sail through
  // the update as a silent zero-row no-op under a "System updated" toast.
  // Pin the row to the active home first. A miss gets the same answer a
  // deleted row gets, so this never reports whether some other id exists.
  const property = await getActiveProperty();
  if (!property) {
    return err("Couldn't find that system. Please refresh and try again.");
  }
  const { data: ownedSystem } = await supabase
    .from("home_systems")
    .select("id")
    .eq("id", id)
    .eq("property_id", property.id)
    .maybeSingle();
  if (!ownedSystem) {
    return err("Couldn't find that system. Please refresh and try again.");
  }

  // Edit-specific guard against a silent field wipe. On an EDIT the owner
  // usually already has a good value in these fields, so a non-empty entry
  // that fails validation - an out-of-range install year, or a bad month like
  // 13/2024 - must NOT be quietly written as null under a "System updated"
  // toast the way an intentionally-cleared field is. Return a named,
  // recoverable error instead; SystemRow renders it inline (res.error) and
  // keeps the edit form open with the owner's entry intact. A genuinely blank
  // field still means "clear this" and parses to null with no error, exactly
  // as before.
  const rawInstallYear = formData.get("install_year");
  const installYear = boundedInt(
    rawInstallYear,
    INSTALL_YEAR_MIN,
    INSTALL_YEAR_MAX
  );
  if (
    typeof rawInstallYear === "string" &&
    rawInstallYear.trim() !== "" &&
    installYear === null
  ) {
    return err(
      `Install year should be a 4-digit year between ${INSTALL_YEAR_MIN} and ${INSTALL_YEAR_MAX}. Please check it and try again.`
    );
  }

  const rawLastServiced = formData.get("last_serviced");
  const lastServiced = mmYyyyToDate(rawLastServiced as string);
  if (
    typeof rawLastServiced === "string" &&
    rawLastServiced.trim() !== "" &&
    lastServiced === null
  ) {
    return err(
      "Last serviced should be a month and year like 03/2024. Please check it and try again."
    );
  }

  // Same caps and ranges as addSystemAction: an edit is just as forgeable as
  // the original add, so it gets the same treatment. system_type isn't
  // editable here, so there is nothing to allow-list on this path.
  const baseUpdate = {
    material_or_model: cappedFieldOrNull(
      formData,
      "material_or_model",
      MAX_MATERIAL
    ),
    install_year: installYear,
    last_serviced: lastServiced,
    condition_rating: boundedInt(
      formData.get("condition_rating"),
      CONDITION_MIN,
      CONDITION_MAX
    ),
    notes: cappedFieldOrNull(formData, "notes", MAX_NOTES),
  };

  // Optional columns a live DB might not have yet (filter reminder fields,
  // migration 0042; model_number + capacity, migration 0102). Only written
  // when the edit form actually sent them; if the columns are missing
  // (migration not run), retry without them so saving never breaks.
  // RLS guarantees the row belongs to the caller's property.
  const filter = filterFields(formData);
  const modelCapacity = modelCapacityFields(formData);
  const extras =
    filter || modelCapacity
      ? { ...(filter ?? {}), ...(modelCapacity ?? {}) }
      : null;
  let { error } = extras
    ? await supabase
        .from("home_systems")
        .update({ ...baseUpdate, ...extras } as any)
        .eq("id", id)
    : await supabase.from("home_systems").update(baseUpdate).eq("id", id);
  if (error && extras) {
    ({ error } = await supabase
      .from("home_systems")
      .update(baseUpdate)
      .eq("id", id));
  }
  if (error) {
    // As with addSystemAction, any newly-picked photos already sit in
    // storage by this point; a failed update just leaves them unattached.
    // Simple path: report the error, keep the edit form open so the owner
    // can retry (same photo URLs re-attach on success). Orphan cleanup is
    // future janitor work, not built here.
    return err("Couldn't save those changes just now. Please try again.");
  }

  await attachPhotos(formData, property.id, id);
  setFlash("System updated");
  revalidatePath("/dashboard");
  revalidatePath("/home-report");
  return ok();
}

// One int field off the home-details form (year_built, sqft, beds,
// lot_size_sqft are all `int` in properties, migration 0001 - baths is
// `numeric(3,1)` and gets its own handling below). Blank means "the owner
// didn't touch this box" and is left OUT of the return value entirely, so the
// caller can skip the column rather than writing null over a real fact - see
// the blank-field comment on updatePropertyAction below for why. A non-blank
// value that fails the range/finite check is a real typo, not a "clear this"
// signal, so it comes back as a named error instead of being silently
// dropped to null.
function intFieldOrOmit(
  formData: FormData,
  key: string,
  min: number,
  max: number,
  label: string,
  rangeText: string
): { value?: number; error?: string } {
  const raw = formData.get(key);
  if (typeof raw !== "string" || raw.trim() === "") return {};
  const n = boundedInt(raw, min, max);
  if (n === null) {
    return {
      error: `${label} should be ${rangeText}. Please check it and try again.`,
    };
  }
  return { value: n };
}

// Called programmatically from HomeDetailsForm so it can show an inline error
// (a bad year, an impossible date) without losing the owner's other entries,
// the same way updateSystemAction does above.
export async function updatePropertyAction(
  formData: FormData
): Promise<ActionResult> {
  const property = await getActiveProperty();
  if (!property) {
    return err("Couldn't find your home. Please refresh and try again.");
  }
  const supabase = await createClient();

  // OWNER ONLY, and said out loud rather than discovered.
  //
  // getActiveProperty returns a home the caller is an active HOUSEHOLD MEMBER
  // of as well as one they own ("properties member select", migration 0051),
  // but the only UPDATE policy on properties is "properties owner update"
  // (user_id = auth.uid(), migration 0002). Without this check a member's save
  // ran through their own session client, RLS filtered the row out, PostgREST
  // returned zero rows and NO error, and the action fell through to "Home
  // details saved" - the edit silently discarded under a success toast.
  //
  // Refusing in words is the honest fix while members are read-only. If
  // members are ever meant to edit the home's facts, the change is a member
  // UPDATE policy in SQL, and this guard comes out with it.
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return err("Please sign in first.");
  if (property.user_id !== user.id) {
    return err("Only the home's owner can change this.");
  }

  // BLANK-FIELD DECISION: on this form, a blank box means "leave it as it
  // was," not "clear this fact." Every field here is prefilled from the
  // current row, so the only way to see a blank box is to have deliberately
  // deleted a value that was already there - far more likely a stray
  // backspace (especially on a phone) than an owner asking to forget their
  // home's square footage. These facts also took real effort to get right
  // (typed at onboarding, or pulled from the assessor/RentCast lookup), and
  // several other pages read them (home-report's facts line, the dashboard
  // and forecast system-age estimates, the value page's purchase-price
  // trend) - silently nulling one out from an unrelated edit would be a
  // confusing way to lose real data. This is the opposite choice from
  // updateSystemAction's install_year/last_serviced fields above, where a
  // blank genuinely does mean "clear it": those are per-system notes an
  // owner adds over time, not facts about the home itself. So: each field
  // below is only added to the update object when the owner actually typed
  // something in it; a field left blank is simply never mentioned in the
  // update, and Postgres leaves the stored value untouched.
  const yearBuilt = intFieldOrOmit(
    formData,
    "year_built",
    1700,
    2100,
    "Year built",
    "a 4-digit year between 1700 and 2100"
  );
  if (yearBuilt.error) return err(yearBuilt.error);
  const sqft = intFieldOrOmit(
    formData,
    "sqft",
    1,
    1_000_000,
    "Square feet",
    "between 1 and 1,000,000"
  );
  if (sqft.error) return err(sqft.error);
  const beds = intFieldOrOmit(
    formData,
    "beds",
    0,
    100,
    "Bedrooms",
    "between 0 and 100"
  );
  if (beds.error) return err(beds.error);
  const lotSize = intFieldOrOmit(
    formData,
    "lot_size_sqft",
    0,
    100_000_000,
    "Lot size",
    "between 0 and 100,000,000 square feet"
  );
  if (lotSize.error) return err(lotSize.error);

  // baths is numeric(3,1), so half-baths (2.5) are real values here, unlike
  // the int fields above - boundedNumber (not boundedInt) keeps the decimal.
  //
  // 99.9, NOT 100: numeric(3,1) is three digits with one after the point, so
  // 99.9 is the largest value the column can hold. 100 passed the old bound
  // (and so did 99.95, which Postgres rounds up to 100.0), reached the database
  // as 22003 "numeric field value out of range", and came back as the generic
  // "Couldn't save your home details just now" on every retry with no hint
  // which box was wrong - taking every other edit in the same submit down with
  // it. The ceiling is named in the message so the fix is obvious.
  const rawBaths = formData.get("baths");
  let baths: number | undefined;
  if (typeof rawBaths === "string" && rawBaths.trim() !== "") {
    const n = boundedNumber(rawBaths, 0, 99.9);
    if (n === null) {
      return err(
        "Bathrooms should be a number between 0 and 99.9. Please check it and try again."
      );
    }
    baths = n;
  }

  const rawPurchaseDate = formData.get("purchase_date");
  let purchaseDate: string | undefined;
  if (typeof rawPurchaseDate === "string" && rawPurchaseDate.trim() !== "") {
    const d = validPurchaseDate(rawPurchaseDate);
    if (d === null) {
      return err(
        "Purchase date doesn't look right. Please check it and try again."
      );
    }
    purchaseDate = d;
  }

  // property_type is a <select> that renders exactly PROPERTY_TYPES (the same
  // allow-list onboarding uses), with a blank "Leave as is" option for when
  // the owner doesn't want to touch it. Same blank-means-unchanged rule as
  // every other field on this form: only a recognized value gets written. A
  // forged value would pick a fee tier and a set of building-record rules
  // (isBuildingLevelHome, src/lib/parcelSanity.ts) the rest of the app has no
  // entry for, so - unlike the other fields - a value that fails the check is
  // treated the same as blank rather than returned as a named error; the
  // <select> itself can never produce anything but a listed value or blank.
  const rawPropertyType = formData.get("property_type");
  const propertyType =
    typeof rawPropertyType === "string" &&
    isAllowedValue(PROPERTY_TYPES, rawPropertyType)
      ? rawPropertyType
      : undefined;

  // A plain object literal type, not Record<string, ...>: the generated
  // Supabase Update type rejects any argument with a string index signature
  // (it can't tell that signature only ever holds real column names), so a
  // Record here fails tsc even though every key it can hold is a real column.
  const update: Partial<{
    property_type: string;
    year_built: number;
    sqft: number;
    beds: number;
    baths: number;
    lot_size_sqft: number;
    purchase_date: string;
  }> = {};
  if (propertyType !== undefined) update.property_type = propertyType;
  if (yearBuilt.value !== undefined) update.year_built = yearBuilt.value;
  if (sqft.value !== undefined) update.sqft = sqft.value;
  if (beds.value !== undefined) update.beds = beds.value;
  if (baths !== undefined) update.baths = baths;
  if (lotSize.value !== undefined) update.lot_size_sqft = lotSize.value;
  if (purchaseDate !== undefined) update.purchase_date = purchaseDate;

  // Every box was left blank, so there is nothing to write. Short-circuit
  // rather than sending an empty PATCH: it saves a round trip, and it keeps
  // the zero-row check below meaning one thing only ("the write was filtered
  // out") instead of two.
  if (Object.keys(update).length === 0) {
    setFlash("Home details saved");
    return ok();
  }

  // .select("id") is what makes a REFUSED write visible. PostgREST reports an
  // update that matched no rows as a plain success with an empty result set,
  // so without asking for the rows back this action cannot tell "saved" from
  // "RLS filtered it out and nothing happened" - and it used to report the
  // second as the first. The owner check above should mean this never fires;
  // it stays because a wrong success on a save is the worst possible answer.
  const { data: saved, error } = await supabase
    .from("properties")
    .update(update)
    .eq("id", property.id)
    .select("id");

  if (error) {
    console.error("updatePropertyAction: save failed", error);
    return err("Couldn't save your home details just now. Please try again.");
  }
  if (!saved || saved.length === 0) {
    console.error(
      "updatePropertyAction: update matched no rows for property",
      property.id
    );
    return err("Couldn't save your home details just now. Please try again.");
  }
  setFlash("Home details saved");
  revalidatePath("/dashboard");
  revalidatePath("/home-report");
  revalidatePath("/forecast");
  revalidatePath("/value");
  revalidatePath("/home-details");
  return ok();
}
