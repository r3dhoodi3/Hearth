"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentContractor } from "@/lib/contractor";
import { hasProPlan } from "@/lib/subscription";
import {
  cappedField,
  cappedFieldOrNull,
  honeypotTripped,
  FIELD_MAX,
} from "@/lib/formFields";
import { setFlash } from "@/lib/flash";

// Save a pro's support message so the team can read and reply. Contact details
// are prefilled from the company record and editable on the form, falling back
// to the record when a field is left empty. Messages from active Pro members
// are flagged priority so the team answers them first. The flag is computed
// server-side; it is never taken from the form.
export async function sendProSupportMessageAction(formData: FormData) {
  // Honeypot, matching the public contact form and the homeowner help form:
  // ProSupportForm.tsx renders an off-screen "company_website" input no person
  // can see or tab to, so anything in it came from a script. Pretend the send
  // worked - the exact flash and redirect the success path below uses - and
  // store nothing. First statement in the action: no session lookup, no
  // rate-limit slot burned, nothing touched.
  if (honeypotTripped(formData)) {
    await setFlash("Thanks. We got your message and will get back to you.", "success");
    redirect("/pro/help?sent=1");
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  // Require a session: this stores attacker-controllable text that staff later
  // read, so don't accept anonymous writes.
  if (!user) {
    await setFlash("Please sign in to contact support.", "error");
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
    await setFlash(
      "You've sent several messages already. Please wait a bit before sending another.",
      "error"
    );
    return;
  }

  const contractor = await getCurrentContractor();
  if (!contractor) {
    await setFlash("Finish setting up your company first.", "error");
    return;
  }

  // Capped server-side, same ceiling as the homeowner help form and the public
  // contact form, which write to this same table.
  const message = cappedField(formData, "message", FIELD_MAX.message);
  if (!message) {
    await setFlash("Please write a short message first.", "error");
    return;
  }

  // The form now prefills these three from the company record and lets the pro
  // edit them, so take what was submitted and fall back to the record when a
  // field comes back empty. Capped server-side with the same ceilings the
  // homeowner help form and the public contact form use: they write to this
  // same table and are read by the same people, and an <input maxLength> is
  // only a client hint.
  const base = {
    user_id: user.id,
    name: cappedFieldOrNull(formData, "name", FIELD_MAX.name) ?? contractor.name,
    email:
      cappedFieldOrNull(formData, "email", FIELD_MAX.email) ??
      contractor.contact_email ??
      user.email ??
      null,
    phone:
      cappedFieldOrNull(formData, "phone", FIELD_MAX.phone) ??
      contractor.contact_phone,
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

  if (error) {
    await setFlash("Couldn't send your message. Please try again.", "error");
    revalidatePath("/pro/help");
    return;
  }

  // ?sent=1 is what tells the page (src/app/pro/help/page.tsx) to swap
  // ProSupportForm for its confirmation card instead of the plain form - the
  // flash toast alone was easy to miss and said nothing about what happens
  // next. Kept alongside the toast rather than instead of it: it is cheap and
  // gives feedback immediately, before the redirected page finishes loading.
  // This used to be a bare revalidatePath() with no redirect at all (a plain
  // in-place re-render); the redirect below still lands on the same route, so
  // it does not change how the form POST behaves for anyone with JS off.
  await setFlash("Thanks. We got your message and will get back to you.", "success");
  redirect("/pro/help?sent=1");
}
