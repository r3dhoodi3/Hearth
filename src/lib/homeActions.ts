"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import {
  ACTIVE_HOME_COOKIE,
  formatAddressLine,
  getProperties,
} from "@/lib/property";
import { setFlash } from "@/lib/flash";

const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: "lax" as const,
  path: "/",
  maxAge: 60 * 60 * 24 * 365,
};

// Switch which home is active.
export async function setActiveHomeAction(formData: FormData) {
  const id = formData.get("id") as string;
  const props = await getProperties();
  const home = props.find((p) => p.id === id);
  if (home) {
    (await cookies()).set(ACTIVE_HOME_COOKIE, id, COOKIE_OPTS);
    // formatAddressLine, not address_line1: someone with two units in the
    // same building would otherwise be told "Switched to 123 Main St" either
    // way and have no idea which one they landed on.
    await setFlash(`Switched to ${formatAddressLine(home)}`, "info");
  }
  revalidatePath("/", "layout");
  redirect("/dashboard");
}

// Remove a home (cascades to its systems, issues, leads, etc. via the schema).
export async function removeHomeAction(formData: FormData) {
  const id = formData.get("id") as string;
  const supabase = await createClient();
  // RLS guarantees the row belongs to the caller.
  const { error } = await supabase.from("properties").delete().eq("id", id);
  if (error) throw new Error(error.message);
  await setFlash("Home deleted", "info");

  const remaining = await getProperties();
  if (remaining.length === 0) {
    (await cookies()).delete(ACTIVE_HOME_COOKIE);
    revalidatePath("/", "layout");
    redirect("/onboarding");
  }

  // Keep the current active home unless it was the one just removed.
  const current = (await cookies()).get(ACTIVE_HOME_COOKIE)?.value;
  if (!current || !remaining.some((p) => p.id === current)) {
    (await cookies()).set(ACTIVE_HOME_COOKIE, remaining[0].id, COOKIE_OPTS);
  }
  revalidatePath("/", "layout");
  redirect("/dashboard");
}
