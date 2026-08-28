"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getActiveProperty } from "@/lib/property";
import { setFlash } from "@/lib/flash";

// Saves (or updates) the two things the owner copies off their home insurance
// policy: the renewal date and the annual premium. insurance_renewal_date and
// insurance_premium are new columns from migration 0040 that are not yet in
// src/lib/database.types.ts, so the update payload is cast to any (same
// pattern as saveHomeValueAction and saveTaxAssessmentAction) rather than
// widening the generated types by hand.
//
// Returns { ok } so the client form only collapses on a save that actually
// stuck: a validation reject or soft-fail resolves the promise too, and
// closing on that would show stale values as if the save succeeded.
export async function saveInsuranceAction(
  formData: FormData
): Promise<{ ok: boolean }> {
  const property = await getActiveProperty();
  if (!property)
    throw new Error("Couldn't find your home. Try again from the dashboard.");

  const dateRaw = formData.get("insurance_renewal_date");
  const premiumRaw = formData.get("insurance_premium");

  const renewalDate = typeof dateRaw === "string" ? dateRaw.trim() : "";
  const premium = premiumRaw ? Number(premiumRaw) : null;

  if (!renewalDate || !premium || premium <= 0) {
    await setFlash(
      "Add your renewal date and annual premium from your policy to continue.",
      "error"
    );
    revalidatePath("/documents");
    return { ok: false };
  }

  // Server-side bounds (the form's min/max is client-only and can be
  // bypassed): a malformed date, a renewal year far outside the policy's
  // plausible range, or a wild premium would feed nonsense into the renewal
  // nudge and the state comparison. Reject rather than clamp so the owner
  // notices the typo. Renewal dates run from last year (a lapsed policy the
  // owner is about to update) to three years out (multi-year policies are
  // rare but exist).
  const currentYear = new Date(Date.now()).getFullYear();
  const dateMatch = renewalDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const renewalYear = dateMatch ? Number(dateMatch[1]) : null;
  if (
    !dateMatch ||
    renewalYear == null ||
    renewalYear < currentYear - 1 ||
    renewalYear > currentYear + 3 ||
    !Number.isFinite(premium) ||
    premium > 100_000
  ) {
    await setFlash(
      "Those numbers don't look right. Double-check the renewal date and premium.",
      "error"
    );
    revalidatePath("/documents");
    return { ok: false };
  }

  const supabase = await createClient();
  try {
    // RLS's existing "owner selects/updates own property" policy covers this,
    // same as saveHomeValueAction in value/actions.ts.
    const { error } = await (supabase.from("properties") as any)
      .update({
        insurance_renewal_date: renewalDate,
        insurance_premium: premium,
      })
      .eq("id", property.id);
    if (error) throw error;
    await setFlash("Insurance details saved");
  } catch {
    // Migration 0040 may not have run yet against this database, or the
    // write failed for some other reason. Fail soft: the card just shows the
    // setup form again instead of a 500.
    await setFlash("Couldn't save right now. Please try again in a bit.", "error");
    revalidatePath("/documents");
    return { ok: false };
  }
  revalidatePath("/documents");
  return { ok: true };
}
