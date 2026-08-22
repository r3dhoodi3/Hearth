"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { setFlash } from "@/lib/flash";
import { NOTIFICATION_CHANNELS } from "./channels";

// Save the homeowner's notification toggles onto their own user row. Each
// checkbox posts "on" when checked, so an absent value means the channel is off.
export async function saveNotificationPrefsAction(formData: FormData) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return;

  const prefs: Record<string, boolean> = {};
  for (const c of NOTIFICATION_CHANNELS) {
    prefs[c.key] = formData.get(c.key) === "on";
  }

  // Preserve the email opt-out flag written by the CAN-SPAM one-click
  // unsubscribe route (src/app/unsubscribe). It lives in this same jsonb but
  // is not one of the channel checkboxes, so a plain overwrite would silently
  // re-subscribe someone who opted out. Re-enabling email is meant to be a
  // deliberate action, not a side effect of saving an unrelated channel toggle.
  const { data: current } = await supabase
    .from("users")
    .select("notification_prefs")
    .eq("id", user.id)
    .single();
  if (current?.notification_prefs?.email_opt_out === true) {
    prefs.email_opt_out = true;
  }

  const { error } = await supabase
    .from("users")
    .update({ notification_prefs: prefs })
    .eq("id", user.id);

  if (error) await setFlash("Couldn't update your settings. Please try again.", "error");
  else await setFlash("Notification preferences saved.", "success");
  revalidatePath("/account/notifications");
}
