"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentContractor } from "@/lib/contractor";
import { hasProPlan } from "@/lib/subscription";
import { cappedField, FIELD_MAX } from "@/lib/formFields";
import { setFlash } from "@/lib/flash";

// Save a pro's support message so the team can read and reply. Contact details
// come from the company record (no extra typing), and messages from active Pro
// members are flagged priority so the team answers them first. The flag is
// computed server-side; it is never taken from the form.
export async function sendProSupportMessageAction(formData: FormData) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  // Require a session: this stores attacker-controllable text that staff later
  // read, so don't accept anonymous writes.
  if (!user) {
    setFlash("Please sign in to contact support.", "error");
    return;
  }

  // Cap support submissions per user with the same fixed-window limiter as
  // onboarding's parcel lookup (migration 0068). Fails open on a DB hiccup:
  // only an explicit `allowed === false` blocks, so a rate-limiter outage
  // never stops a legit pro from reaching support.
  const admin = createAdminClient();
  const { data: allowed } = await admin.rpc("rate_limit_hit", {
    p_bucket: `support:${user.id}`,
    p_limit: 5,
    p_window_seconds: 3600,
  });
  if (allowed === false) {
    setFlash(
      "You've sent several messages already. Please wait a bit before sending another.",
      "error"
    );
    return;
  }

  const contractor = await getCurrentContractor();
  if (!contractor) {
    setFlash("Finish setting up your company first.", "error");
    return;
  }

  // Capped server-side, same ceiling as the homeowner help form and the public
  // contact form, which write to this same table.
  const message = cappedField(formData, "message", FIELD_MAX.message);
  if (!message) {
    setFlash("Please write a short message first.", "error");
    return;
  }

  const base = {
    user_id: user.id,
    name: contractor.name,
    email: contractor.contact_email || user.email || null,
    phone: contractor.contact_phone,
    message,
  };

  // Members go to the front of the line. If the priority column doesn't exist
  // yet (migration 0035 not run), retry without it so support never breaks.
  const priority = await hasProPlan();
  let { error } = await supabase
    .from("support_messages")
    .insert({ ...base, priority } as any);
  if (error) {
    ({ error } = await supabase.from("support_messages").insert(base));
  }

  if (error) setFlash("Couldn't send your message. Please try again.", "error");
  else setFlash("Thanks. We got your message and will get back to you.", "success");
  revalidatePath("/pro/help");
}
