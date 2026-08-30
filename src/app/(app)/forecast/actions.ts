"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getActiveProperty } from "@/lib/property";
import { hasPlus } from "@/lib/subscription";
import { setFlash } from "@/lib/flash";
import { isMissingSchemaError } from "@/lib/dbErrors";
import { trackServerEvent } from "@/lib/trackServer";
import { forecastActionFor } from "@/lib/forecastActions";
import { parseReserveInput } from "@/lib/forecastReserve";

// Server actions behind the two new writable pieces of the cost forecast: the
// "Add to my plan" button under each system's push-it-out step, and the repair
// reserve figure.
//
// NOTHING HERE TRUSTS AN ID FROM THE BROWSER. The only thing either action
// reads off the form is a system_type (looked up in a curated table, so an
// unknown value simply finds nothing) and a typed dollar amount. The property
// comes from getActiveProperty() on the server, so a forged property_id in the
// POST body has nowhere to land.

function addDays(base: Date, days: number): string {
  const d = new Date(base.getTime());
  d.setDate(d.getDate() + days);
  // Local date parts, not toISOString (UTC), so due dates match the real
  // calendar. Same helper shape as generateMaintenancePlanAction.
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// Adds the one curated life-extending step for a system to the owner's
// reminders, as a maintenance_task, so the forecast's advice lands somewhere
// they will actually see it again.
//
// Reuses the maintenance plan's own titles wherever the plan has one for that
// system (see the taskTitle comment in src/lib/forecastActions.ts), which means
// the same dedupe works in both directions: a step already scheduled by the
// plan is not added twice here, and a step added here is skipped by a later
// plan build.
export async function addForecastStepAction(formData: FormData): Promise<void> {
  // Plus-gated, same as the forecast detail this button lives inside. A free
  // reader never sees the button, so this is the belt to that suspenders: it
  // fails quietly rather than redirecting, because a POST that only got here by
  // being replayed deserves nothing more than a no-op.
  if (!(await hasPlus())) return;

  const systemType = String(formData.get("system_type") ?? "");
  const action = forecastActionFor(systemType);
  if (!action) return;

  const property = await getActiveProperty();
  if (!property) return;

  const supabase = await createClient();

  // Already on the list? Say so instead of stacking a duplicate. Matched on
  // title against this property's OPEN tasks, exactly the way the plan
  // generator matches, so the two features cannot fight over the same reminder.
  const { data: existing } = await supabase
    .from("maintenance_tasks")
    .select("id")
    .eq("property_id", property.id)
    .eq("status", "open")
    .eq("title", action.taskTitle)
    .limit(1);

  if (existing && existing.length > 0) {
    await setFlash("That is already on your reminders.", "info");
    revalidatePath("/forecast");
    return;
  }

  const { error } = await supabase.from("maintenance_tasks").insert({
    property_id: property.id,
    title: action.taskTitle,
    due_date: addDays(new Date(Date.now()), action.dueInDays),
    status: "open",
  });

  if (error) {
    await setFlash("Could not add that to your plan. Please try again.", "error");
    revalidatePath("/forecast");
    return;
  }

  await setFlash("Added to your reminders.", "success");

  // Funnel analytics (docs/ANALYTICS.md). The system type is one of the
  // SYSTEM_TYPES enum values, never free text.
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (user) {
    await trackServerEvent(user.id, "forecast_action_added", {
      system: systemType,
    });
  }

  revalidatePath("/forecast");
  revalidatePath("/dashboard");
}

// Saves what the owner has set aside toward the next big repair, on the home
// they are currently looking at.
//
// An empty field CLEARS the figure back to null, which is not the same as zero:
// null means "has not told us" and shows an invitation, zero means "nothing
// saved" and shows how far behind they are. See reservePlan() for why that
// difference is load bearing.
export async function saveRepairReserveAction(formData: FormData): Promise<void> {
  if (!(await hasPlus())) return;

  const property = await getActiveProperty();
  if (!property) return;

  const parsed = parseReserveInput(String(formData.get("reserve") ?? ""));
  if (parsed === "invalid") {
    await setFlash("Enter a dollar amount, like 4500.", "error");
    revalidatePath("/forecast");
    return;
  }

  const supabase = await createClient();
  // The `any` cast is the same convention every post-0029 properties column
  // uses (see src/lib/property.ts): repair_reserve_cents is real (migration
  // 0147) but src/lib/database.types.ts has not been regenerated for it, and
  // the typed client rejects an update naming a column it does not know.
  const { error } = await (supabase.from("properties") as any)
    .update({ repair_reserve_cents: parsed })
    .eq("id", property.id);

  if (error) {
    // A database that has not run 0147 yet answers with 42703. That is a
    // missing migration, not a bug the owner caused, so it gets its own plain
    // sentence instead of a generic failure.
    await setFlash(
      isMissingSchemaError(error)
        ? "Saving your reserve is not switched on yet. Nothing else on this page is affected."
        : "Could not save that. Please try again.",
      "error"
    );
    revalidatePath("/forecast");
    return;
  }

  await setFlash(
    parsed == null ? "Cleared what you had saved." : "Saved.",
    "success"
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (user) {
    // No dollar figure in the payload: this is the owner's savings balance, and
    // docs/ANALYTICS.md's rule is ids and enums only. Whether they set or
    // cleared it is all the funnel needs.
    await trackServerEvent(user.id, "forecast_reserve_saved", {
      cleared: parsed == null,
    });
  }

  revalidatePath("/forecast");
}
