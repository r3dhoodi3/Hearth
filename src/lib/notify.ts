// Build-time guard: this module reads the Resend/Twilio secrets and pulls in
// the service-role client, so importing it from a Client Component must fail
// the build, not ship any of that.
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import { createAdminClient } from "@/lib/supabase/admin";
import { signUnsubscribeToken } from "@/lib/unsubscribeToken";

// Single entry point for notifying a homeowner. Always writes the in-app
// notification row (what the bell in the nav shows), then tries the email and
// SMS channels - which stay dormant until their provider env vars exist, so
// wiring up a provider later is just adding keys, no code changes.
//
// To activate email: create a Resend account (resend.com) and set
//   RESEND_API_KEY - from resend.com/api-keys
//   RESEND_FROM    - a verified sender, e.g. "Hearth <hello@yourdomain.com>"
// To activate SMS: create a Twilio account (twilio.com) and set
//   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER
//
// TCPA gate: SMS is a strictly opt-in channel (statutory damages of $500-1500
// PER TEXT for sending without consent, per user_id.sms_consent - migration
// 0073). sendSms requires smsConsent === true in addition to the env vars and
// a phone number; any other value (undefined, false, null) is treated as "no
// consent on file" and the text is skipped. Callers must read sms_consent off
// the users row themselves and pass it through - this module never queries
// the DB for it, so a caller that forgets to pass it simply gets no SMS
// rather than an accidental send.

export type NotificationInput = {
  userId: string;
  kind: string;
  title: string;
  body?: string | null;
  url?: string | null;
  // Optional contact details for the email / SMS channels. Ignored until the
  // provider env vars above are set.
  email?: string | null;
  phone?: string | null;
  // Must be exactly `true` (the caller's users.sms_consent value) for the SMS
  // channel to fire at all. See the TCPA gate note above.
  smsConsent?: boolean | null;
};

// Returns true if the in-app notification was written. Email / SMS delivery
// is best-effort and never fails the caller.
export async function sendNotification(
  supabase: SupabaseClient<Database>,
  input: NotificationInput
): Promise<boolean> {
  const { error } = await supabase.from("notifications").insert({
    user_id: input.userId,
    kind: input.kind,
    title: input.title,
    body: input.body ?? null,
    url: input.url ?? null,
  });
  if (error) {
    // Was a silent no-op: the in-app row is the source of truth, so a failed
    // insert here means the recipient gets nothing and nothing says why.
    console.error("sendNotification: insert failed:", error.message ?? error);
    return false;
  }

  await Promise.all([sendEmail(input), sendSms(input)]);
  return true;
}

// CAN-SPAM footer appended to every outgoing email: sender identity, a
// physical mailing address, and a working per-user unsubscribe link. The
// address is a deliberate TODO(legal) placeholder in the same bracketed
// convention as src/app/dmca/page.tsx, so the pre-launch legal sweep's
// grep for TODO(legal) catches it before real mail goes out (email is
// dormant until RESEND_API_KEY is set regardless).
//
// Uniform footer on ALL emails, including transactional-critical ones: that
// is the safe default. CAN-SPAM's transactional exemption from the unsubscribe
// requirement is a per-category call that can be layered on later (skip the
// unsubscribe line for a specific `input.kind`); it is not worth risking a
// missing footer on a message that should have carried one tonight.
function emailFooter(unsubscribeUrl: string): string {
  return [
    "",
    "--",
    "Hearth",
    "[TODO(legal): registered business address]",
    `Unsubscribe from these emails: ${unsubscribeUrl}`,
  ].join("\n");
}

// Fires once per process: warns that emails will only reach the account
// owner until RESEND_FROM is set to a verified-domain sender, instead of the
// Resend sandbox default below. A module-level flag, not a per-call check,
// so a hot path doesn't re-log this on every notification.
let warnedSandboxFrom = false;

// Email via the Resend REST API. Plain fetch, no SDK, so there is no new
// dependency to install. Dormant until RESEND_API_KEY is set.
async function sendEmail(input: NotificationInput): Promise<void> {
  if (!process.env.RESEND_API_KEY || !input.email) return;

  if (!process.env.RESEND_FROM && !warnedSandboxFrom) {
    warnedSandboxFrom = true;
    console.warn(
      "sendEmail: RESEND_FROM is not set, falling back to the Resend sandbox " +
        "sender (onboarding@resend.dev), which only delivers to the account " +
        "owner. Set RESEND_FROM to a verified-domain sender to reach real " +
        "recipients."
    );
  }

  // Honor the CAN-SPAM opt-out centrally. Unlike sms_consent (which the caller
  // passes, so a forgotten field fails safe to no-send), the email opt-out is
  // enforced here by reading the recipient's own notification_prefs - so the
  // unsubscribe link in the footer is real without threading a flag through
  // every caller. A lookup hiccup falls open and still sends: the footer's
  // unsubscribe link remains the recipient's guaranteed exit either way.
  try {
    const admin = createAdminClient();
    const { data: prefRow } = await admin
      .from("users")
      .select("notification_prefs")
      .eq("id", input.userId)
      .single();
    if (prefRow?.notification_prefs?.email_opt_out === true) return;
  } catch {
    // Couldn't read prefs; fall open and send. See comment above.
  }

  try {
    const siteUrl =
      process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
    const unsubscribeUrl = `${siteUrl}/unsubscribe?uid=${encodeURIComponent(
      input.userId
    )}&token=${signUnsubscribeToken(input.userId)}`;
    const bodyText = input.body
      ? `${input.title}\n\n${input.body}`
      : input.title;
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: process.env.RESEND_FROM || "Hearth <onboarding@resend.dev>",
        to: input.email,
        subject: input.title,
        text: `${bodyText}\n${emailFooter(unsubscribeUrl)}`,
      }),
    });
    if (!response.ok) {
      // NEVER log the raw provider body: Resend echoes the recipient email
      // address back inside 403 sandbox and validation error messages, and
      // Vercel logs are third-party retention. Parse out only the machine
      // error name and log that plus the HTTP status - enough to debug, no
      // recipient PII. `name` is a fixed enum string (e.g. "validation_error",
      // "invalid_from_address"); the free-text `message` is dropped on purpose.
      let code = "unknown";
      try {
        const parsed = (await response.json()) as { name?: unknown };
        if (typeof parsed?.name === "string") code = parsed.name;
      } catch {
        // Body unreadable or not JSON; status alone still tells us something.
      }
      console.error(
        `sendEmail: Resend API rejected the request (status ${response.status}, code ${code})`
      );
    }
  } catch {
    // A provider hiccup must never break the caller - the in-app
    // notification is the source of truth.
  }
}

// SMS via the Twilio REST API. Dormant until the TWILIO_* env vars are set -
// and, separately, until the recipient has opted in (TCPA gate: see the note
// atop this file). Both gates must pass; either alone is not enough.
async function sendSms(input: NotificationInput): Promise<void> {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM_NUMBER;
  if (!sid || !token || !from || !input.phone) return;
  if (input.smsConsent !== true) return;

  // TCPA quiet hours: no marketing/informational texts before 8am or after
  // 9pm in the recipient's local time. Crons can fire at any hour, so gate it
  // here rather than trusting each caller. Single-metro launch, so the metro's
  // timezone (America/Los_Angeles) is hardcoded on purpose - do NOT build a
  // per-user-timezone deferred-send queue for this. When we launch a second
  // metro, this needs to become per-recipient. The in-app notification row is
  // already written by sendNotification regardless (the product's
  // authoritative channel), so a suppressed text loses no information.
  const laHour = Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Los_Angeles",
      hour: "numeric",
      hourCycle: "h23",
    }).format(new Date())
  );
  if (Number.isNaN(laHour) || laHour < 8 || laHour >= 21) {
    // Silent best-effort non-send, same shape as the unconfigured-Twilio and
    // no-consent gates above; callers see no difference.
    return;
  }

  try {
    const body = input.body ? `${input.title} ${input.body}` : input.title;
    const response = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString(
            "base64"
          )}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          To: input.phone,
          From: from,
          // "Reply STOP to opt out." is appended to every SMS (never the
          // email body) so each text carries its own opt-out instruction,
          // independent of whatever the inbound STOP webhook also does.
          Body: `${body} Reply STOP to opt out.`,
        }),
      }
    );
    if (!response.ok) {
      // NEVER log the raw provider body: Twilio echoes the destination phone
      // number back inside its most common failures (21211 invalid 'To',
      // 21610 unsubscribed recipient, 21614 not a mobile number), and Vercel
      // logs are third-party retention. Parse out only the numeric error
      // `code` and log that plus the HTTP status - enough to debug against
      // Twilio's error reference, no recipient PII. The free-text `message`
      // (which is what carries the number) is dropped on purpose.
      let code: string | number = "unknown";
      try {
        const parsed = (await response.json()) as { code?: unknown };
        if (typeof parsed?.code === "number" || typeof parsed?.code === "string")
          code = parsed.code;
      } catch {
        // Body unreadable or not JSON; status alone still tells us something.
      }
      console.error(
        `sendSms: Twilio API rejected the request (status ${response.status}, code ${code})`
      );
    }
  } catch {
    // Same as email: never let a provider error break the caller.
  }
}
