"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { homeHealthScore } from "@/lib/health";
import { isMissingSchemaError } from "@/lib/dbErrors";
import type { HomeSystem, Issue } from "@/lib/database.types";

// Trim, cap, and normalize empty to null. The cap matters because the values
// arrive from a vision read the client can edit before confirming, and a
// server action takes whatever FormData it is handed: without it, an arbitrary
// paste lands in material_or_model / model_number / the notes column. Numeric
// fields get their own range check below rather than a length one.
const MAX_FIELD = 120;

function s(formData: FormData, key: string, max = MAX_FIELD): string | null {
  const v = formData.get(key);
  const t = typeof v === "string" ? v.trim().slice(0, max) : "";
  return t.length ? t : null;
}

// Confirm one system's details from a walkthrough scan. Draft-then-approve:
// the vision suggestion from /api/confirm-system never writes on its own -
// this action, on the owner's explicit confirm, is the only thing that
// updates home_systems.
//
// Returns the Home Health Score before and after so the card can show the
// real payoff of confirming. confirmed_at alone does not move the score (see
// homeHealthScore in src/lib/health.ts, which never reads it); the score only
// moves when a field it DOES read changes, so this fills install_year and/or
// condition_rating from the confirm form rather than just stamping
// confirmed_at. Some scans genuinely move the score down (a data plate can
// reveal a system is older or worse than the onboarding estimate assumed) -
// this always reports the real before/after, never a made-up "win".
export type ConfirmSystemResult =
  | { ok: true; before: number; after: number }
  | { ok: false; error: string };

export async function confirmSystemAction(
  formData: FormData
): Promise<ConfirmSystemResult> {
  const supabase = createClient();
  const systemId = s(formData, "system_id");
  if (!systemId)
    return { ok: false, error: "Something went wrong. Please try again." };

  // RLS ("home_systems owner all", gated by owns_property()) scopes this to a
  // system on a property the caller owns or shares; a miss means "not yours".
  const { data: target } = await supabase
    .from("home_systems")
    .select("*")
    .eq("id", systemId)
    .maybeSingle();
  if (!target)
    return {
      ok: false,
      error: "That system couldn't be found. Please refresh and try again.",
    };

  const propertyId = target.property_id;
  const [{ data: systems }, { data: issues }] = await Promise.all([
    supabase.from("home_systems").select("*").eq("property_id", propertyId),
    supabase
      .from("issues")
      .select("*")
      .eq("property_id", propertyId)
      .eq("status", "open"),
  ]);
  const allSystems = (systems ?? []) as HomeSystem[];
  const openIssues = (issues ?? []) as Issue[];
  const before = homeHealthScore(allSystems, openIssues);

  const brand = s(formData, "brand");
  const model = s(formData, "model");
  const serial = s(formData, "serial");
  // Server actions are callable with arbitrary FormData, so the client's
  // input types are not a guard. Same 1700-2100 range the profile edit and
  // vision route use (properties.year_built accepts back to 1700, so a real
  // 1885 home's install year is kept, not ignored); Number.isFinite also
  // screens out NaN, which would otherwise slip through the ?? fallback below
  // (NaN is not nullish) and null out a good value.
  const yearNum = Number(s(formData, "install_year"));
  const install_year =
    Number.isFinite(yearNum) && yearNum >= 1700 && yearNum <= 2100
      ? Math.trunc(yearNum)
      : null;
  const conditionNum = Number(s(formData, "condition_rating"));
  const condition_rating =
    Number.isFinite(conditionNum) && conditionNum >= 1 && conditionNum <= 5
      ? Math.trunc(conditionNum)
      : null;

  // Brand + model become the system's material_or_model, same join the
  // documents vault uses (src/lib/document-actions.ts). Leave it as-is if the
  // owner didn't type either.
  const material = [brand, model].filter(Boolean).join(" ") || null;

  // No dedicated serial column (migration 0056 only adds confirmed_at, kept
  // to the one thing genuinely needed) - fold it into notes as a labeled line
  // rather than overwriting any note the owner already wrote.
  let notes = target.notes as string | null;
  if (serial) {
    const serialLine = `Serial: ${serial}`;
    notes = notes
      ? notes.includes(serialLine)
        ? notes
        : `${notes}\n${serialLine}`
      : serialLine;
  }

  const update = {
    material_or_model: material ?? target.material_or_model,
    // The scanned model number also lands in the dedicated model_number column
    // (migration 0102), trivially available since the confirm form already
    // reads it. Kept alongside material_or_model (brand + model), which the
    // rest of the app still reads.
    model_number: model ?? (target as { model_number?: string | null }).model_number ?? null,
    install_year: install_year ?? target.install_year,
    condition_rating: condition_rating ?? target.condition_rating,
    notes,
    confirmed_at: new Date().toISOString(),
  };

  let { error } = await supabase
    .from("home_systems")
    .update(update)
    .eq("id", systemId);
  if (error && isMissingSchemaError(error)) {
    // Live DB hasn't run a needed migration yet: confirmed_at (0056) or the
    // model_number column (0102). Drop both brand-new columns and save the
    // rest rather than losing the owner's typed values; the row just stays
    // "estimated" until the migration runs. Same graceful degradation
    // convention as saveCompanyAction and proAlerts.
    const { confirmed_at: _dropped, model_number: _droppedModel, ...withoutNewCols } =
      update;
    ({ error } = await supabase
      .from("home_systems")
      .update(withoutNewCols)
      .eq("id", systemId));
  }
  if (error) {
    console.error("confirmSystemAction failed:", error.message);
    return {
      ok: false,
      error: "Couldn't save that right now. Please try again in a bit.",
    };
  }

  const updatedSystems = allSystems.map((sys) =>
    sys.id === systemId ? { ...sys, ...update } : sys
  );
  const after = homeHealthScore(updatedSystems, openIssues);

  revalidatePath("/walkthrough");
  revalidatePath("/dashboard");

  return { ok: true, before, after };
}
