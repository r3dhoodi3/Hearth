"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { getRole } from "@/lib/contractor";
import { cappedField, FIELD_MAX } from "@/lib/formFields";
import { setFlash } from "@/lib/flash";
import { err, type ActionResult } from "@/lib/actionResult";

// Length caps for an endpoint with no session and no per-user rate limit to
// fall back on - account/help's saveSupportMessageAction (which this mirrors)
// gets that for free by requiring a signed-in user; this one is reachable by
// anyone, so every field needs its own floor and ceiling before anything
// touches the database. The ceilings now live in src/lib/formFields.ts, where
// every other action reads the same numbers; only the floor below is specific
// to this form.
const MIN_MESSAGE = 10;

const HONEST_SUCCESS =
  "Thanks. We read every message and will reach out by phone call or email.";

// Where a successful send lands. Signed-in users go home with the same role
// split as src/app/page.tsx (pros to /pro, everyone else to /dashboard);
// signed-out visitors go back to the landing page. The flash cookie survives
// the redirect, and the root layout (src/app/layout.tsx) reads it on every
// route, so the confirmation toast still shows at the destination.
async function successDestination(): Promise<string> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return "/";
  return (await getRole()) === "contractor" ? "/pro" : "/dashboard";
}

// Saves a message from the public /contact form (src/app/contact/page.tsx)
// so the team can read and reply, the same way saveSupportMessageAction
// (src/app/(app)/account/help/actions.ts) does for signed-in homeowners.
export async function sendContactMessageAction(
  formData: FormData
): Promise<ActionResult> {
  // Honeypot: see ContactForm.tsx for how "company_website" is hidden from a
  // real visitor. A bot that fills every field in the form fills this one
  // too. Pretend success and store nothing - same flash, same redirect as the
  // real success path below - so it gets no signal to adapt on.
  const honeypot = ((formData.get("company_website") as string) || "").trim();
  if (honeypot) {
    setFlash(HONEST_SUCCESS, "success");
    redirect(await successDestination());
  }

  const name = cappedField(formData, "name", FIELD_MAX.name);
  const email = cappedField(formData, "email", FIELD_MAX.email);
  const phone = cappedField(formData, "phone", FIELD_MAX.phone);
  const message = cappedField(formData, "message", FIELD_MAX.message);

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
  // gating, no different copy, same flash and same redirect either way. Fails
  // open like the rate limiter above - an RPC error logs and the message still
  // gets stored, just without the hint.
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
    message,
    matched_user_id: matchedUserId,
    matched_via: matchedVia,
  });

  if (error) {
    console.error("sendContactMessageAction: insert failed", error);
    return err("Couldn't send your message. Please try again.");
  }

  // redirect() throws to unwind the action, so nothing may run after it; the
  // error paths above stay put on /contact so the visitor can fix and resend.
  setFlash(HONEST_SUCCESS, "success");
  redirect(await successDestination());
}
