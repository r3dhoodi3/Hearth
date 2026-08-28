"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getActiveProperty } from "@/lib/property";
import { setFlash } from "@/lib/flash";
import { ok, err, type ActionResult } from "@/lib/actionResult";

// Saves (or updates) the two numbers the owner copies off their county
// assessment notice. assessed_value and assessed_year are new columns from
// migration 0039 that are not yet in src/lib/database.types.ts, so the update
// payload is cast to any (same pattern as saveHomeValueAction) rather than
// widening the generated types by hand.
//
// Returns { ok } so the client form only collapses on a save that actually
// stuck: a validation reject or soft-fail resolves the promise too, and
// closing on that would show stale values as if the save succeeded.
export async function saveTaxAssessmentAction(
  formData: FormData
): Promise<ActionResult> {
  const property = await getActiveProperty();
  if (!property)
    throw new Error("Couldn't find your home. Try again from the dashboard.");

  const valueRaw = formData.get("assessed_value");
  const yearRaw = formData.get("assessed_year");

  const assessedValue = valueRaw ? Number(valueRaw) : null;
  const assessedYear = yearRaw ? Number(yearRaw) : null;

  if (!assessedValue || assessedValue <= 0 || !assessedYear) {
    return err(
      "Add the assessed value and the assessment year from your notice to continue."
    );
  }

  // Server-side bounds (the form's min/max is client-only and can be
  // bypassed): a year outside 1990..this year, or a wild assessed value,
  // would feed a nonsense comparison shown in a big confident font. Reject
  // rather than clamp so the owner notices the typo.
  const currentYear = new Date(Date.now()).getFullYear();
  if (
    !Number.isInteger(assessedYear) ||
    assessedYear < 1990 ||
    assessedYear > currentYear ||
    !Number.isFinite(assessedValue) ||
    assessedValue > 100_000_000
  ) {
    return err(
      "Those numbers don't look right. Double-check the year and the assessed value."
    );
  }

  const supabase = await createClient();
  try {
    // RLS's existing "owner selects/updates own property" policy covers this,
    // same as saveHomeValueAction in value/actions.ts.
    const { error } = await (supabase.from("properties") as any)
      .update({
        assessed_value: assessedValue,
        assessed_year: assessedYear,
      })
      .eq("id", property.id);
    if (error) throw error;
    setFlash("Assessment saved");
  } catch {
    // Migration 0039 may not have run yet against this database, or the
    // write failed for some other reason. Fail soft: the page keeps the form
    // open with an inline error instead of a 500.
    return err("Couldn't save right now. Please try again in a bit.");
  }
  revalidatePath("/taxes");
  return ok();
}
