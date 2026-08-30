"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getActiveProperty } from "@/lib/property";
import { hasPlus } from "@/lib/subscription";
import { cappedField, FIELD_MAX } from "@/lib/formFields";
import { setFlash } from "@/lib/flash";
import { ok, err, type ActionResult } from "@/lib/actionResult";
import { ALWAYS_SCHEDULE, SYSTEM_SCHEDULE } from "@/lib/maintenancePlan";
import { trackServerEvent } from "@/lib/trackServer";

// Mark a reminder (maintenance task) done. RLS limits it to the caller's tasks.
// Called programmatically from ReminderItem, which needs the ActionResult to
// know whether the checkbox should actually flip (a failed update must not
// look done, or the next reload will silently un-check it with no explanation).
export async function completeReminderAction(id: string): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase
    .from("maintenance_tasks")
    .update({ status: "done", completed_at: new Date().toISOString() })
    .eq("id", id);
  if (error) {
    // The raw Postgres message names our tables, columns and constraints. It
    // isn't rendered today, but it still rides back over the wire where it's
    // readable in devtools, so log it server-side and return the same plain
    // copy the flash shows.
    console.error("completeReminderAction failed:", error);
    await setFlash("Couldn't update that reminder. Please try again.", "error");
    return err("Couldn't update that reminder. Please try again.");
  }
  revalidatePath("/dashboard");
  return ok();
}

// Delete a reminder entirely (offered only after it's checked off). Same
// ActionResult contract as completeReminderAction: ReminderItem must not
// remove the row from the list until the delete actually succeeded.
export async function deleteReminderAction(id: string): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase
    .from("maintenance_tasks")
    .delete()
    .eq("id", id);
  if (error) {
    // Generic string over the wire, raw error to the server log: see
    // completeReminderAction above.
    console.error("deleteReminderAction failed:", error);
    await setFlash("Couldn't remove that reminder. Please try again.", "error");
    return err("Couldn't remove that reminder. Please try again.");
  }
  revalidatePath("/dashboard");
  return ok();
}

// Only store a real calendar date, or null. The shape regex alone was not
// enough: it accepts "2026-13-45", which Postgres then rejects (22008),
// killing the whole update. Round-trip through Date so an impossible month or
// day (2026-13-45, 2026-02-31) is caught here and degrades to null instead.
// No year bounds - a reminder's due date is legitimately in the future.
function validDueDate(v: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const d = new Date(`${v}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) {
    return null;
  }
  return v;
}

// Edit a reminder's title / due date.
export async function editReminderAction(formData: FormData) {
  const id = formData.get("id") as string;
  const supabase = await createClient();

  // Both fields are client input, so the <input maxLength> and the date picker
  // are hints, not guards. A title is capped rather than rejected (nobody
  // should lose an edit to a long paste), and a date that isn't a real
  // YYYY-MM-DD becomes null rather than being handed to a `date` column that
  // would reject the whole update.
  const rawDate = ((formData.get("due_date") as string) || "").trim();
  const dueDate = validDueDate(rawDate);

  const { error } = await supabase
    .from("maintenance_tasks")
    .update({
      title: cappedField(formData, "title", FIELD_MAX.title) || "Reminder",
      due_date: dueDate,
    })
    .eq("id", id);
  if (error)
    await setFlash("Couldn't save your changes. Please try again.", "error");
  revalidatePath("/dashboard");
}

// Undo: put a reminder back to open (in case it was checked off by accident).
export async function uncompleteReminderAction(id: string): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase
    .from("maintenance_tasks")
    .update({ status: "open", completed_at: null })
    .eq("id", id);
  if (error) {
    // Generic string over the wire, raw error to the server log: see
    // completeReminderAction above.
    console.error("uncompleteReminderAction failed:", error);
    await setFlash("Couldn't update that reminder. Please try again.", "error");
    return err("Couldn't update that reminder. Please try again.");
  }
  revalidatePath("/dashboard");
  return ok();
}

// --- Hearth Plus: personalized maintenance plan ---
//
// The plan stays small and encouraging. Each scheduled task becomes ONE upcoming
// reminder, staggered so quick checks land within a couple of weeks and bigger
// jobs a month or two out. Re-running only adds task types you do not already
// have open, so the list never balloons and never duplicates.

// Schedule content (ALWAYS_SCHEDULE / SYSTEM_SCHEDULE) lives in
// @/lib/maintenancePlan so the dashboard page can share it. "use server" files
// may only export async functions.

// Keep the plan digestible.
const MAX_PLAN_TASKS = 12;

function addDays(base: Date, days: number): string {
  const d = new Date(base.getTime());
  d.setDate(d.getDate() + days);
  // Local date parts, not toISOString (UTC), so due dates match the real calendar.
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// Builds a short, staggered set of maintenance reminders tailored to the
// active property's systems, adding only task types not already open.
//
// Plus members rebuild freely (that ongoing "keep it fresh as the home
// changes" is the paid value). A non-Plus homeowner gets exactly ONE free
// build as a taste, tracked the same way the free quote check is
// (users.free_plan_used_at, migration 0099). The credit is claimed ATOMICALLY
// up front: a conditional update that only matches while the column is still
// null, so parallel submits can't farm extra free builds. It's refunded below
// if the build adds no new tasks, so a click that changes nothing never burns
// the one free build.
export async function generateMaintenancePlanAction() {
  const plus = await hasPlus();

  let claimedFreeCredit = false;
  if (!plus) {
    const {
      data: { user },
    } = await (await createClient()).auth.getUser();
    if (!user) redirect("/plus?reason=plan");
    try {
      const admin = createAdminClient();
      const { data: claimed, error } = await admin
        .from("users")
        .update({ free_plan_used_at: new Date().toISOString() })
        .eq("id", user.id)
        .is("free_plan_used_at", null)
        .select("id");
      if (error) throw error;
      claimedFreeCredit = !!claimed && claimed.length > 0;
    } catch {
      // Column missing (migration 0099 not run yet) or write failed: fall
      // back to the old Plus-only behavior so nothing breaks.
      claimedFreeCredit = false;
    }
    // Already spent the free build (or the claim couldn't be recorded):
    // back to the Plus pitch, same as before.
    if (!claimedFreeCredit) redirect("/plus?reason=plan");
  }

  // Hand the free build back if this run adds nothing, so only a build that
  // actually schedules new tasks spends it. Best-effort: if the refund fails,
  // the credit stays spent.
  const refundFreeCredit = async () => {
    if (!claimedFreeCredit) return;
    try {
      const {
        data: { user },
      } = await (await createClient()).auth.getUser();
      if (!user) return;
      await createAdminClient()
        .from("users")
        .update({ free_plan_used_at: null })
        .eq("id", user.id);
    } catch {
      // ignore: the plan outcome still goes back to the user
    }
  };

  const property = await getActiveProperty();
  if (!property) {
    await refundFreeCredit();
    redirect("/dashboard");
  }

  const supabase = await createClient();
  const { data: systems } = await supabase
    .from("home_systems")
    .select("system_type")
    .eq("property_id", property.id);
  const systemTypes = new Set((systems ?? []).map((s) => s.system_type));

  const schedule = [
    ...ALWAYS_SCHEDULE,
    ...[...systemTypes].flatMap((t) => SYSTEM_SCHEDULE[t] ?? []),
  ];

  // Task types already open, so re-running never piles on a duplicate.
  const { data: existing } = await supabase
    .from("maintenance_tasks")
    .select("title")
    .eq("property_id", property.id)
    .eq("status", "open");
  const openTitles = new Set((existing ?? []).map((t) => t.title));

  const today = new Date(Date.now());
  const seen = new Set<string>();
  const rows = schedule
    .filter((s) => {
      if (openTitles.has(s.title) || seen.has(s.title)) return false;
      seen.add(s.title);
      return true;
    })
    .slice(0, MAX_PLAN_TASKS)
    .map((s) => ({
      property_id: property.id,
      title: s.title,
      due_date: addDays(today, s.dueInDays),
      status: "open",
    }));

  // Both confirmations get 2 extra seconds over the 4s success/info default in
  // ToastProvider: the owner reported this one vanishing before it could be
  // read, and it is the only feedback that the build actually did anything
  // (the new tasks are further up the page). Targeted rather than raising the
  // global default, so every other terse toast keeps its snappy timing.
  const PLAN_TOAST_MS = 6000;
  if (rows.length > 0) {
    await supabase.from("maintenance_tasks").insert(rows);
    await setFlash(
      "Your maintenance plan is ready. Check your reminders.",
      "success",
      { duration: PLAN_TOAST_MS }
    );
    // Funnel analytics (docs/ANALYTICS.md), only when the build actually
    // scheduled something - a no-op re-run (the else branch) never fires
    // this. task_count is a number, not a task title, so no free text.
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (user) {
      await trackServerEvent(user.id, "plan_built", {
        task_count: rows.length,
      });
    }
  } else {
    // Nothing new to add: don't let the one free build be spent on a no-op.
    await refundFreeCredit();
    await setFlash("Your maintenance plan is already up to date.", "info", {
      duration: PLAN_TOAST_MS,
    });
  }
  revalidatePath("/dashboard");
}
