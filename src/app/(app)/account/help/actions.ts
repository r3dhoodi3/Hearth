"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  cappedField,
  cappedFieldOrNull,
  honeypotTripped,
  FIELD_MAX,
} from "@/lib/formFields";
import { setFlash } from "@/lib/flash";

const HELP_PATH = "/account/help";

// Save a homeowner's support message so the team can read and reply. The
// homeowner's contact details are prefilled from their account, but they can
// edit them here.
//
// Every exit redirects back to HELP_PATH rather than setFlash()+return: the
// flash cookie is only read once, in the root layout, on the next render, so a
// bare return (which re-renders in place) could leave the toast unseen. A
// redirect is how the rest of the account actions surface their result, so
// this matches them.
export async function saveSupportMessageAction(formData: FormData) {
  // Honeypot, matching the public contact form (src/app/contact/actions.ts):
  // SupportForm.tsx renders an off-screen "company_website" input no person can
  // see or tab to, so anything in it came from a script that filled every
  // field. Pretend the send worked - the exact flash and redirect the success
  // path below uses - and store nothing, so the script gets no signal to adapt
  // on. First statement in the action: no session lookup, no rate-limit slot
  // burned, nothing touched.
  if (honeypotTripped(formData)) {
    setFlash("Thanks. We got your message and will get back to you.", "success");
    redirect(`${HELP_PATH}?sent=1`);
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  // Require a session: this endpoint stores attacker-controllable name/email/
  // message that staff later read, so don't accept anonymous writes.
  if (!user) {
    setFlash("Please sign in to contact support.", "error");
    redirect(HELP_PATH);
  }

  // Same caps as the public contact form (src/app/contact/actions.ts): the
  // fields land in the same support_messages table and are read by the same
  // people, so they get the same ceilings. The inputs' maxLength is only a
  // client hint - a server action takes whatever FormData it is handed.
  const message = cappedField(formData, "message", FIELD_MAX.message);
  if (!message) {
    setFlash("Please write a short message first.", "error");
    redirect(HELP_PATH);
  }

  // Cap support submissions per user with the same fixed-window limiter as
  // onboarding's parcel lookup (migration 0068). Charged HERE, right before the
  // insert and only after the empty-message check has passed, so a user whose
  // submit was empty never burns a slot. Fails open on a DB hiccup: only an
  // explicit `allowed === false` blocks, so a rate-limiter outage never stops a
  // legit homeowner from reaching support (this is a spam-class bucket, not a
  // brute-force one).
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
    redirect(HELP_PATH);
  }

  const { error } = await supabase.from("support_messages").insert({
    user_id: user.id,
    name: cappedFieldOrNull(formData, "name", FIELD_MAX.name),
    email: cappedFieldOrNull(formData, "email", FIELD_MAX.email),
    phone: cappedFieldOrNull(formData, "phone", FIELD_MAX.phone),
    message,
  });

  if (error) {
    setFlash("Couldn't send your message. Please try again.", "error");
    redirect(HELP_PATH);
  }

  // ?sent=1 is what tells the page (src/app/(app)/account/help/page.tsx) to
  // swap SupportForm for its confirmation card instead of the plain form -
  // the flash toast alone was easy to miss, and gave no "what now" beyond the
  // message itself. Kept alongside the toast rather than instead of it: it is
  // cheap and gives feedback immediately, before the redirected page finishes
  // loading.
  setFlash("Thanks. We got your message and will get back to you.", "success");
  redirect(`${HELP_PATH}?sent=1`);
}
