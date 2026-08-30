"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { cappedField, honeypotTripped, FIELD_MAX } from "@/lib/formFields";
import { err, type ActionResult } from "@/lib/actionResult";
import { trackServerEvent } from "@/lib/trackServer";

// Length caps for an endpoint with no session and no per-user rate limit to
// fall back on - account/help's saveSupportMessageAction (which this mirrors)
// gets that for free by requiring a signed-in user; this one is reachable by
// anyone, so every field needs its own floor and ceiling before anything
// touches the database. The ceilings now live in src/lib/formFields.ts, where
// every other action reads the same numbers; only the floor below is specific
// to this form.
const MIN_MESSAGE = 10;

// Where a successful send lands: a dedicated confirmation page
// (src/app/contact/thanks/page.tsx), not a flash toast. A toast on top of
// whatever page the visitor landed on (home page or dashboard) was easy to
// miss and said nothing about what happens next; the thanks page carries that
// message itself, so no setFlash() call is needed alongside this redirect.
const THANKS_PATH = "/contact/thanks";

// Saves a message from the public /contact form (src/app/contact/page.tsx)
// so the team can read and reply, the same way saveSupportMessageAction
// (src/app/(app)/account/help/actions.ts) does for signed-in homeowners.
export async function sendContactMessageAction(
  formData: FormData
): Promise<ActionResult> {
  // A hand-crafted POST to the action endpoint arrives without a FormData
  // body; reading it threw a TypeError and a 500 (live log, 2026-08-30).
  // Refuse it quietly instead: nothing to store, nothing to learn from.
  if (!(formData instanceof FormData)) {
    return { ok: false, error: "Bad request." } as ActionResult;
  }
  // Honeypot: see src/components/Honeypot.tsx for how "company_website" is
  // hidden from a real visitor. A bot that fills every field in the form fills
  // this one too. Pretend success and store nothing - same redirect as the real
  // success path below - so it gets no signal to adapt on. The read moved to
  // the shared helper when the two in-app help forms got the same field, so
  // all three actions test the same name the same way.
  if (honeypotTripped(formData)) {
    redirect(THANKS_PATH);
  }

  const name = cappedField(formData, "name", FIELD_MAX.name);
  const email = cappedField(formData, "email", FIELD_MAX.email);
  const phone = cappedField(formData, "phone", FIELD_MAX.phone);
  const message = cappedField(formData, "message", FIELD_MAX.message);
  // Optional context the page carried in from ?topic= (see ContactForm.tsx).
  // Display text only: it is prefixed onto the stored message so the inbox can
  // see at a glance that this is, say, a safety report, and it decides nothing
  // here. Capped hard because it arrives from a query string.
  const topic = ((formData.get("topic") as string) || "").trim().slice(0, 120);

  if (message.length < MIN_MESSAGE) {
    return err("Please write a few more words so we know what you need.");
  }
  if (!email && !phone) {
    return err("Please add an email or a phone number so we can reply.");
  }
  if (email && !email.includes("@")) {
    return err("That doesn't look like a valid email address.");
  }

  // Unauthenticated and public, so it needs its own throttle before touching
  // the database at all - same fixed-window rate_limit_hit RPC (migration
  // 0068) and IP derivation as src/app/api/track/route.ts and
  // src/app/(auth)/recordTermsAcceptance.ts. Keyed separately (contact:<ip>)
  // so a burst of analytics beacons or terms-acceptance retries from the same
  // visitor can never exhaust their contact-form budget, or vice versa. Fails
  // open on an RPC hiccup: only an explicit `allowed === false` blocks the
  // message, so an outage never silently eats a real visitor's message.
  const h = await headers();
  const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const admin = createAdminClient();
  const { data: allowed } = await admin.rpc("rate_limit_hit", {
    p_bucket: `contact:${ip ?? "unknown"}`,
    p_limit: 5,
    p_window_seconds: 3600,
  });
  if (allowed === false) {
    return err(
      "You've sent several messages already. Please wait a bit before sending another."
    );
  }

  // Silent account match (migration 0115): most people who write in already
  // have an account, and match_support_contact() finds it from the email or
  // phone they typed - digits-only last 10 on the phone side, across
  // auth.users, the public.users signup mirror, and contractors' business
  // contact details. Nothing the visitor sees depends on the outcome: no
  // gating, no different copy, same redirect either way. Fails open like the
  // rate limiter above - an RPC error logs and the message still gets stored,
  // just without the hint.
  let matchedUserId: string | null = null;
  let matchedVia: string | null = null;
  const { data: matchRows, error: matchError } = await admin.rpc(
    "match_support_contact",
    { p_email: email || null, p_phone: phone || null }
  );
  if (matchError) {
    console.error("sendContactMessageAction: account match failed", matchError);
  } else {
    const match = Array.isArray(matchRows) ? matchRows[0] : matchRows;
    if (match?.user_id) {
      matchedUserId = match.user_id;
      matchedVia = match.matched_via ?? null;
    }
  }

  // ADMIN client, not the normal request-scoped client: a visitor here has no
  // session, and support_messages' RLS only grants insert to the
  // `authenticated` role (supabase/migrations/0024_support_messages.sql) -
  // by design, since the same table backs the signed-in-only Help page.
  // user_id stays null; that alone is how the team tells an anonymous
  // /contact message apart from a signed-in homeowner's, no schema change
  // needed since the column was already nullable.
  // matched_user_id/matched_via are an UNVERIFIED triage hint, nothing more:
  // anyone can type someone else's email or phone into a public form, so a
  // match is a "start looking here" pointer for whoever reads the message. It
  // must never be treated as proof of who sent this. Do not disclose account
  // details, and do not act on account state (billing, plan, cancellation,
  // password, address) on the strength of it - confirm identity separately
  // first, the same way you would with no match at all.
  const { error } = await admin.from("support_messages").insert({
    user_id: null,
    name: name || null,
    email: email || null,
    phone: phone || null,
    message: topic ? `[${topic}]\n\n${message}` : message,
    matched_user_id: matchedUserId,
    matched_via: matchedVia,
  });

  if (error) {
    console.error("sendContactMessageAction: insert failed", error);
    return err("Couldn't send your message. Please try again.");
  }

  // Funnel analytics (docs/ANALYTICS.md). user_id is deliberately null here,
  // not matchedUserId: that match is an unverified triage hint (anyone can
  // type someone else's email or phone into this form), and attributing an
  // analytics event to a guessed identity is worse than leaving it anonymous.
  await trackServerEvent(null, "contact_sent", {});

  // redirect() throws to unwind the action, so nothing may run after it; the
  // error paths above stay put on /contact so the visitor can fix and resend.
  redirect(THANKS_PATH);
}
