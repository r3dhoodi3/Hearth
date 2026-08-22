"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getActiveProperty } from "@/lib/property";
import { setFlash } from "@/lib/flash";
import { ISSUE_CATEGORIES, SEVERITIES, SYSTEM_TYPES } from "@/lib/constants";

// The [[LOGISSUE]] block comes from the AI, so coerce its enum-ish fields to
// known-good values before they hit the row (data integrity).
const CATEGORY_VALUES = ISSUE_CATEGORIES.map((c) => c.value) as string[];
const SEVERITY_VALUES = SEVERITIES.map((s) => s.value) as string[];
const SYSTEM_VALUES = SYSTEM_TYPES.map((s) => s.value) as string[];
const oneOf = (v: string | undefined, allowed: string[], fallback: string) =>
  v && allowed.includes(v) ? v : fallback;

// Ask Hearth proposes these via [[LOGISSUE]] / [[REMINDER]] blocks; the chat
// renders a button that calls one of these to write it to the home record. RLS
// limits writes to the caller's own property.

export async function logIssueFromChat(payload: {
  category: string;
  severity?: string;
  description?: string;
  system_type?: string;
  condition?: number | null;
}) {
  const property = await getActiveProperty();
  if (!property) {
    await setFlash("Add your home first, then I can log this for you.", "error");
    return;
  }
  const supabase = await createClient();

  // Find the matching system first so we can LINK the issue to it. That link is
  // what lets resolving the issue later lift the red flag off the system on the
  // Home page (otherwise a chat-logged issue has no system_id to trace back to).
  let systemId: string | null = null;
  const systemType =
    payload.system_type && SYSTEM_VALUES.includes(payload.system_type)
      ? payload.system_type
      : null;
  if (systemType) {
    const { data: sys } = await supabase
      .from("home_systems")
      .select("id")
      .eq("property_id", property.id)
      .eq("system_type", systemType)
      .maybeSingle();
    systemId = sys?.id ?? null;
  }

  await supabase.from("issues").insert({
    property_id: property.id,
    system_id: systemId,
    category: oneOf(payload.category, CATEGORY_VALUES, "other"),
    severity: oneOf(payload.severity, SEVERITY_VALUES, "medium"),
    description: payload.description || null,
    status: "open",
  });

  // Reflect the problem on the matching system by lowering its condition.
  const condition =
    typeof payload.condition === "number" &&
    payload.condition >= 1 &&
    payload.condition <= 5
      ? payload.condition
      : null;
  if (systemId && condition) {
    await supabase
      .from("home_systems")
      .update({ condition_rating: condition })
      .eq("id", systemId);
  }

  await setFlash("Logged to your home record.", "success");
  revalidatePath("/dashboard");
  revalidatePath("/issues");
  revalidatePath("/forecast");
}

export async function setReminderFromChat(payload: {
  title: string;
  due_date?: string;
}) {
  const property = await getActiveProperty();
  if (!property || !payload.title) {
    await setFlash("Add your home first, then I can set this reminder.", "error");
    return;
  }
  const supabase = await createClient();

  await supabase.from("maintenance_tasks").insert({
    property_id: property.id,
    title: payload.title,
    due_date: payload.due_date || null,
    status: "open",
  });

  await setFlash("Reminder added to your tasks.", "success");
  revalidatePath("/dashboard");
}
