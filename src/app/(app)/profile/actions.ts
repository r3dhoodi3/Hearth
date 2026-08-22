"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getActiveProperty } from "@/lib/property";
import { DEFAULT_LIFESPANS } from "@/lib/health";
import { setFlash } from "@/lib/flash";
import { ok, err, type ActionResult } from "@/lib/actionResult";
import { labelFor, SYSTEM_TYPES } from "@/lib/constants";
import {
  boundedNumber,
  boundedInt,
  cappedFieldOrNull,
  isAllowedValue,
} from "@/lib/formFields";

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
async function attachPhotos(
  formData: FormData,
  propertyId: string,
  systemId: string
) {
  const urls = (formData.getAll("photo_urls") as string[]).filter(Boolean);
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

  const property = await getActiveProperty();
  if (property) await attachPhotos(formData, property.id, id);
  setFlash("System updated");
  revalidatePath("/dashboard");
  revalidatePath("/home-report");
  return ok();
}

// Not called from anywhere today (no home-details form wires it up yet), but
// kept crash-proof to match the rest of this file rather than left throwing.
export async function updatePropertyAction(formData: FormData) {
  const property = await getActiveProperty();
  if (!property) {
    setFlash("Couldn't save home details. Try again.", "error");
    return;
  }
  const supabase = await createClient();

  // Same finite-and-in-range treatment the systems above get, with the same
  // ranges onboarding uses for these columns: a NaN or a wild value would
  // otherwise be written straight onto the home.
  const num = (k: string, min: number, max: number) =>
    boundedNumber(formData.get(k), min, max);

  const { error } = await supabase
    .from("properties")
    .update({
      year_built: num("year_built", 1700, 2100),
      sqft: num("sqft", 1, 1_000_000),
      beds: num("beds", 0, 100),
      baths: num("baths", 0, 100),
      lot_size_sqft: num("lot_size_sqft", 0, 100_000_000),
      purchase_date: validPurchaseDate(
        (formData.get("purchase_date") as string) || null
      ),
    })
    .eq("id", property.id);

  if (error) {
    setFlash("Couldn't save home details. Try again.", "error");
    return;
  }
  setFlash("Home details saved");
  revalidatePath("/dashboard");
  revalidatePath("/home-report");
}
