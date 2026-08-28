"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getActiveProperty } from "@/lib/property";
import { SYSTEM_TYPES, ISSUE_CATEGORIES, SEVERITIES } from "@/lib/constants";
import { setFlash } from "@/lib/flash";

const SYSTEM_VALUES = SYSTEM_TYPES.map((s) => s.value) as readonly string[];
const ISSUE_VALUES = ISSUE_CATEGORIES.map((c) => c.value) as readonly string[];
const SEVERITY_VALUES = SEVERITIES.map((s) => s.value) as readonly string[];

type ConfirmedSystem = {
  system_type: string;
  condition_rating: number | null;
  install_year: number | null;
  notes: string | null;
};

type ConfirmedIssue = {
  category: string;
  severity: string;
  description: string | null;
};

// Result the client branches on, so the "Added to your home" panel only shows
// when something was actually written, and the nothing-selected / save-failed
// cases are reported honestly instead of faking success.
export type SaveFindingsResult =
  | { ok: true; added: number; skipped: number }
  | { ok: false; reason: "nothing_selected" }
  | { ok: false; reason: "error"; message: string };

function parseJsonArray(raw: FormDataEntryValue | null): any[] {
  if (typeof raw !== "string" || !raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// Save the systems and issues an owner confirmed from an AI-read inspection
// report (InspectionUpload's review step). Everything is re-validated
// against the same value lists the rest of the app uses, so a tampered
// hidden field can't write an invalid system_type, category, or severity
// into the home record.
export async function saveInspectionFindingsAction(
  formData: FormData
): Promise<SaveFindingsResult> {
  const property = await getActiveProperty();
  if (!property)
    throw new Error("Couldn't find your home. Try again from the dashboard.");
  const supabase = await createClient();

  const rawSystems = parseJsonArray(formData.get("systems_json"));
  const rawIssues = parseJsonArray(formData.get("issues_json"));

  const systems: ConfirmedSystem[] = [];
  for (const s of rawSystems) {
    const system_type = typeof s?.system_type === "string" ? s.system_type : "";
    if (!SYSTEM_VALUES.includes(system_type)) continue;

    const ratingNum = Number(s?.condition_rating);
    const condition_rating =
      Number.isInteger(ratingNum) && ratingNum >= 1 && ratingNum <= 5 ? ratingNum : null;

    const yearNum = Number(s?.install_year);
    const install_year =
      Number.isInteger(yearNum) && yearNum >= 1900 && yearNum <= 2100 ? yearNum : null;

    const notes =
      typeof s?.notes === "string" && s.notes.trim() ? s.notes.trim() : null;

    systems.push({ system_type, condition_rating, install_year, notes });
  }

  const issues: ConfirmedIssue[] = [];
  for (const i of rawIssues) {
    const category = typeof i?.category === "string" ? i.category : "";
    const severity = typeof i?.severity === "string" ? i.severity : "";
    if (!ISSUE_VALUES.includes(category) || !SEVERITY_VALUES.includes(severity)) continue;

    const description =
      typeof i?.description === "string" && i.description.trim()
        ? i.description.trim()
        : null;

    issues.push({ category, severity, description });
  }

  if (!systems.length && !issues.length) {
    await setFlash("Nothing was selected to add.", "info");
    return { ok: false, reason: "nothing_selected" };
  }

  const SAVE_ERROR =
    "Couldn't save those findings right now. Please try again in a bit.";

  // Skip a system_type that already exists on this property, so re-adding a
  // report (or confirming twice) never creates duplicate system rows.
  const { data: existing } = await supabase
    .from("home_systems")
    .select("system_type")
    .eq("property_id", property.id);
  const existingTypes = new Set((existing ?? []).map((s) => s.system_type));
  const newSystems = systems.filter((s) => !existingTypes.has(s.system_type));

  if (newSystems.length) {
    const { error } = await supabase.from("home_systems").insert(
      newSystems.map((s) => ({
        property_id: property.id,
        system_type: s.system_type,
        condition_rating: s.condition_rating,
        install_year: s.install_year,
        notes: s.notes,
      }))
    );
    if (error) {
      console.error("saveInspectionFindingsAction systems insert failed:", error.message);
      await setFlash(SAVE_ERROR, "error");
      revalidatePath("/dashboard");
      return { ok: false, reason: "error", message: SAVE_ERROR };
    }
  }

  if (issues.length) {
    const { error } = await supabase.from("issues").insert(
      issues.map((i) => ({
        property_id: property.id,
        category: i.category,
        severity: i.severity,
        description: i.description,
        status: "open",
      }))
    );
    if (error) {
      console.error("saveInspectionFindingsAction issues insert failed:", error.message);
      await setFlash(SAVE_ERROR, "error");
      revalidatePath("/dashboard");
      return { ok: false, reason: "error", message: SAVE_ERROR };
    }
  }

  const skipped = systems.length - newSystems.length;
  const added = newSystems.length + issues.length;

  // Everything the owner picked already existed on the home: honest info, not a
  // green "Added" panel.
  if (added === 0) {
    await setFlash(
      "Those were already in your home, so nothing new was added.",
      "info"
    );
    revalidatePath("/dashboard");
    return { ok: true, added: 0, skipped };
  }

  await setFlash(
    skipped
      ? `Added to your home. ${skipped} system${skipped === 1 ? "" : "s"} already existed and were skipped.`
      : "Added to your home.",
    "success"
  );
  revalidatePath("/dashboard");
  return { ok: true, added, skipped };
}
