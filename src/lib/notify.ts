// Build-time guard: this module reads the Resend/Twilio secrets and pulls in
// the service-role client, so importing it from a Client Component must fail
// the build, not ship any of that.
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import { createAdminClient } from "@/lib/supabase/admin";
import { signUnsubscribeToken } from "@/lib/unsubscribeToken";
import { isMissingSchemaError } from "@/lib/dbErrors";
import {
  isPlusGatedKind,
  isTransactionalKind,
  marketingBudgetAllows,
  MARKETING_BUDGET_WINDOW_MS,
  shouldSendOutboundChannels,
  TRANSACTIONAL_NOTIFICATION_KINDS,
} from "@/lib/notifyGating";
import {
  allowOutboundSend,
  outboundDisabled,
  stripControlChars,
  toUsE164,
} from "@/lib/outboundGuards";
import { sendPush } from "@/lib/push";

// Single entry point for notifying a homeowner. Always writes the in-app
// notification row (what the bell in the nav shows), then tries the push,
// email and SMS channels - all three stay dormant until their env vars exist,
// so wiring one up later is just adding keys, no code changes.
//
// One caller does NOT come through the front door: the job-post fan-out in
// src/lib/proAlerts.ts writes its in-app rows in a single bulk insert (one
// query for up to MAX_ALERTS pros instead of one per pro, inside a server
// action the homeowner is waiting on) and then calls sendOutboundChannels
// below for the email/SMS half. That is the ONLY thing it reimplements - the
// insert - so the Plus gate, the email opt-out, and the TCPA/quiet-hours rules
// still live here and here only. Anything added to sendNotification after the
// insert must go inside sendOutboundChannels, or the fan-out will not get it.
// The marketing budget check below is the one exception that is safe to leave
// out of sendOutboundChannels: the fan-out only ever sends "new_lead", which
// is on the TRANSACTIONAL_NOTIFICATION_KINDS allowlist and would pass the
// check unconditionally anyway. A future fan-out kind that is NOT
// transactional would need the check added to sendOutboundChannels too.
//
// Hearth Plus gate: for the proactive homeowner alert/reminder kinds listed in
// src/lib/notifyGating.ts, the email and SMS channels are a paid perk. The
// in-app row is still written for everyone, and so is the web push (free to
// send, so nothing to gate); only email and SMS are withheld. See
// sendNotification below - the check lives there so no cron can skip it.
//
// Marketing frequency cap: BEFORE any of that, and before the in-app row is
// even written, sendNotification checks withinMarketingBudget for every kind
// not on the TRANSACTIONAL_NOTIFICATION_KINDS allowlist in
// src/lib/notifyGating.ts. At most MARKETING_BUDGET_MAX_PER_WINDOW
// non-transactional notifications reach one person per rolling
// MARKETING_BUDGET_WINDOW_DAYS, counted across every campaign kind together.
// See docs/NOTIFICATIONS.md for the full kind list and how to add a
// campaign.
//
// To activate push: generate a VAPID key pair and set
//   NEXT_PUBLIC_VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT
// See src/lib/push.ts and docs/GO-LIVE-WIRING.md.
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
  // The marketing/campaign frequency cap, checked FIRST: a person already at
  // budget for the week gets neither the bell row nor the outbound channels
  // for a non-transactional kind. Transactional kinds (see
  // TRANSACTIONAL_NOTIFICATION_KINDS in src/lib/notifyGating.ts) return
  // immediately with no database read, so the ordinary path - a reply, a
  // quote, a job status change - pays nothing extra here.
  if (!(await withinMarketingBudget(input.userId, input.kind))) {
    console.warn(
      `sendNotification: marketing budget exceeded for user ${input.userId}, kind ${input.kind} - skipped`
    );
    return false;
  }

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

  await sendOutboundChannels(input);
  return true;
}

// Is this person still within their non-transactional notification budget for
// the week? See TRANSACTIONAL_NOTIFICATION_KINDS in src/lib/notifyGating.ts
// for the exemption list and the reasoning, and marketingBudgetAllows there
// for the pure window math this wraps.
//
// FAILS CLOSED on a broken count, the opposite direction from the email
// opt-out check further down in this file. That check protects against
// spamming someone, so the safest failure is still to deliver a message with
// an unsubscribe link in it; this one exists to protect against exactly that
// kind of over-messaging, so a broken count must not let a runaway campaign
// send unmetered for as long as the outage lasts. Nothing is lost either way:
// a withheld marketing notification is, by definition, one nobody was
// waiting on.
export async function withinMarketingBudget(
  userId: string,
  kind: string
): Promise<boolean> {
  // Transactional kinds are exempt outright and never reach the database -
  // this also means a bug that calls withinMarketingBudget for a kind it was
  // never meant to gate (a future rename, a copy-paste) fails OPEN rather
  // than blocking a message someone is waiting on.
  if (isTransactionalKind(kind)) return true;

  try {
    const admin = createAdminClient();
    const since = new Date(Date.now() - MARKETING_BUDGET_WINDOW_MS).toISOString();
    // Every kind NOT on the transactional allowlist shares one budget, so the
    // count spans every campaign kind at once rather than giving each its own
    // ceiling. Same unquoted parenthesized-list style the renewal-reminders
    // cron uses for its own .not(..., "in", ...) filter; every value here is
    // one of our own snake_case kind literals, never user input.
    const excluded = Array.from(TRANSACTIONAL_NOTIFICATION_KINDS).join(",");
    const { count, error } = await admin
      .from("notifications")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .gte("created_at", since)
      .not("kind", "in", `(${excluded})`);
    if (error || typeof count !== "number") {
      console.error(
        "withinMarketingBudget: count read failed, failing closed:",
        error?.message ?? error
      );
      return false;
    }
    return marketingBudgetAllows(count);
  } catch (e) {
    console.error("withinMarketingBudget: threw, failing closed:", e);
    return false;
  }
}

// Overrides for callers that already hold the recipient data sendOutboundChannels
// would otherwise fetch one user at a time.
export type OutboundChannelOverrides = {
  // The recipient's users.notification_prefs.email_opt_out. Pass it when the
  // caller has already read that row (a batched fan-out reads every recipient
  // in one .in() query), and sendEmail skips its own per-user lookup.
  //   true       - opted out, no email.
  //   false      - opted in, send without re-reading.
  //   undefined  - unknown, sendEmail does the lookup itself, as always.
  // `null` is treated as unknown too, so a caller that maps a missing row to
  // null gets the safe fall-open behavior rather than an accidental send
  // decision made on no data.
  emailOptOut?: boolean | null;
};

// The outbound (email + SMS) half of sendNotification, split out so the
// batched fan-out in src/lib/proAlerts.ts can write its in-app rows in one bulk
// insert and still reach these channels through the SAME code - rather than
// keeping a second copy of the Plus gate and the opt-out rules that drifts.
// sendNotification's own behavior is unchanged: it calls this with no
// overrides, which is exactly what it used to run inline.
export async function sendOutboundChannels(
  input: NotificationInput,
  overrides?: OutboundChannelOverrides
): Promise<void> {
  // THE KILL SWITCH. OUTBOUND_DISABLED=1 stops every email, SMS and PUSH here,
  // at the one door all of them go through, without touching the in-app rows
  // (already written by the time this runs) or any caller. See
  // docs/GO-LIVE-WIRING.md.
  //
  // Push is included even though it costs nothing per message: the lever exists
  // for the 3am "a cron is looping" moment, and a looping cron buzzing every
  // phone we have is exactly the blast radius it is meant to contain.
  if (outboundDisabled()) {
    console.warn(
      `sendOutboundChannels: OUTBOUND_DISABLED is set, skipping email/SMS/push for kind ${input.kind}`
    );
    return;
  }

  // PUSH, started before the email/SMS gates below and deliberately ahead of
  // the "no contact details" return: push needs no email address and no phone
  // number, so a caller that has neither (most crons, and the job fan-out in
  // proAlerts.ts) still reaches a phone. It is also NOT behind the Hearth Plus
  // gate - see the note in src/lib/notifyGating.ts - and it has its own
  // allowlist of kinds, its own opt-out, and its own quiet-hours rule, all of
  // which sendPush applies itself.
  const pushing = sendPush(input.userId, {
    title: input.title,
    body: input.body,
    url: input.url,
    // Group by kind AND destination, so five replies in one chat thread replace
    // each other on the lock screen while a message and a new quote stay two
    // separate notifications.
    tag: `${input.kind}:${input.url ?? ""}`,
    kind: input.kind,
  });

  // Nothing left to send when the caller passed no outbound contact at all -
  // sendEmail/sendSms would both no-op. Returning here also spares the Plus
  // lookup below from running once per recipient on crons that only write
  // in-app rows. Push has already been started above.
  if (!input.email && !input.phone) {
    await pushing;
    return;
  }

  // THE BRAKE. A per-process ceiling on outbound sends per minute, so a
  // looping cron or a misfiring fan-out costs a few hundred messages rather
  // than a few hundred thousand. Counted per recipient-notification, before
  // the Plus lookup below so a runaway does not also hammer the database.
  //
  // Push is deliberately NOT counted against it: this brake exists to bound a
  // BILL, and push has none. The kill switch above still stops push, and the
  // number of devices a person has is its own natural ceiling.
  if (!allowOutboundSend()) {
    await pushing;
    return;
  }

  // Hearth Plus gate on the OUTBOUND channels only (see src/lib/notifyGating.ts
  // for the kind list and the reasoning). Enforced here, at the one door every
  // sender goes through, rather than in each cron: a gate a caller has to
  // remember is a gate the next cron forgets. The in-app row is already
  // written by the time this runs and is never affected.
  if (isPlusGatedKind(input.kind)) {
    const status = await lookupPlusStatus(input.userId);
    if (!shouldSendOutboundChannels(input.kind, status)) {
      // Push is free and ungated, so it goes out even when the paid channels
      // are withheld from a non-member.
      await pushing;
      return;
    }
  }

  await Promise.all([
    pushing,
    sendEmail(input, overrides?.emailOptOut),
    sendSms(input),
  ]);
}

// Does this recipient have Hearth Plus benefits, as far as the service role
// can tell? Mirrors hasPlus() from src/lib/subscription.ts, which is
// session-bound and therefore useless to a cron: the recipient counts as a
// member if they hold a live homeowner subscription row themselves, or if
// they are an active household member of a home whose OWNER holds one (Plus
// carries with the home). Uses the same admin-client pattern sendEmail
// already uses for the opt-out lookup.
//
// Returns "unknown" on any read failure so the caller can fail CLOSED - see
// shouldSendOutboundChannels for why this one gate goes the opposite way from
// the email opt-out check below.
async function lookupPlusStatus(
  userId: string
): Promise<"plus" | "free" | "unknown"> {
  try {
    const admin = createAdminClient();

    // Homeowner side only: a contractor's pro_ plan is not Hearth Plus.
    const { data: own, error: ownError } = await admin
      .from("subscriptions")
      .select("plan, status, current_period_end")
      .eq("user_id", userId);
    if (ownError) {
      console.error(
        "lookupPlusStatus: subscriptions read failed:",
        ownError.message ?? ownError
      );
      return "unknown";
    }
    if ((own ?? []).some(isLiveHomeownerRow)) return "plus";

    // Household leg: homes shared WITH this user, by an owner who pays.
    const { data: memberships, error: memberError } = await admin
      .from("household_members")
      .select("property_id")
      .eq("member_user_id", userId)
      .eq("status", "active");
    if (memberError) {
      // A database that has not run migration 0051 yet has no household
      // sharing at all, so "no memberships" is the correct answer there, not
      // an unknown. Any other error really is unknown.
      if (!isMissingSchemaError(memberError)) {
        console.error(
          "lookupPlusStatus: household_members read failed:",
          memberError.message ?? memberError
        );
        return "unknown";
      }
      return "free";
    }
    const propertyIds = (memberships ?? []).map((m) => m.property_id);
    if (propertyIds.length === 0) return "free";

    const { data: homes, error: homesError } = await admin
      .from("properties")
      .select("user_id")
      .in("id", propertyIds);
    if (homesError) {
      console.error(
        "lookupPlusStatus: properties read failed:",
        homesError.message ?? homesError
      );
      return "unknown";
    }
    const ownerIds = Array.from(
      new Set((homes ?? []).map((h) => h.user_id).filter(Boolean))
    );
    if (ownerIds.length === 0) return "free";

    const { data: ownerSubs, error: ownerSubsError } = await admin
      .from("subscriptions")
      .select("plan, status, current_period_end")
      .in("user_id", ownerIds);
    if (ownerSubsError) {
      console.error(
        "lookupPlusStatus: owner subscriptions read failed:",
        ownerSubsError.message ?? ownerSubsError
      );
      return "unknown";
    }
    return (ownerSubs ?? []).some(isLiveHomeownerRow) ? "plus" : "free";
  } catch (e) {
    console.error("lookupPlusStatus: threw:", e);
    return "unknown";
  }
}

// A live homeowner-side Plus row: same predicate isLive()/ownsPlus() apply in
// src/lib/subscription.ts, restated here against a bare row because that
// module's version is wrapped in session-bound getters.
function isLiveHomeownerRow(row: {
  plan?: string | null;
  status?: string | null;
  current_period_end?: string | null;
}): boolean {
  if (typeof row.plan === "string" && row.plan.startsWith("pro_")) return false;
  if (row.status !== "active" && row.status !== "trialing") return false;
  if (row.current_period_end && new Date(row.current_period_end) <= new Date())
    return false;
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
async function sendEmail(
  input: NotificationInput,
  knownOptOut?: boolean | null
): Promise<void> {
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
  //
  // knownOptOut lets a caller that already read this recipient's row hand the
  // answer over instead of paying for a second query (see
  // OutboundChannelOverrides). Only an explicit true/false counts; undefined
  // and null both mean "unknown", which runs the lookup exactly as before.
  if (knownOptOut === true) return;
  if (knownOptOut !== false) {
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
  }

  try {
    const siteUrl =
      process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
    const unsubscribeUrl = `${siteUrl}/unsubscribe?uid=${encodeURIComponent(
      input.userId
    )}&token=${signUnsubscribeToken(input.userId)}`;
    // The title becomes the SUBJECT, and the pieces it is built from are not
    // ours: a pro's business name, a homeowner's job title, a custom category.
    // A CR/LF in a subject line is header injection, so control characters are
    // stripped at the boundary rather than trusted upstream (see
    // stripControlChars in src/lib/outboundGuards.ts). The body is a plain-text
    // field and keeps its newlines - that is what makes it readable.
    const subject = stripControlChars(input.title);
    const bodyText = input.body ? `${subject}\n\n${input.body}` : subject;
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: process.env.RESEND_FROM || "Hearth <onboarding@resend.dev>",
        to: input.email,
        subject,
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

  // DESTINATION VALIDATION, ENFORCED HERE BECAUSE THIS IS THE ONE DOOR.
  //
  // The number a pro alert is aimed at comes from contractors.contact_phone,
  // and `authenticated` holds a direct column UPDATE on that table (migration
  // 0085) - so the destination is a string the recipient's own account can
  // write to freely, with no server action in between to validate it. Every
  // other Twilio path in the app is this function, so validating the "To"
  // field here validates all of them: a value that is not a plain US number
  // (an international one, a premium-rate one, or something with a field
  // separator in it) never reaches Twilio at all.
  //
  // Skipped, not failed: an unusable number is the same non-event as an
  // unconfigured Twilio account, and the in-app notification row is already
  // written either way.
  const to = toUsE164(input.phone);
  if (!to) return;

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
    // Same reasoning as the email subject: the title and body are assembled
    // from names and titles other people typed, and a control character in a
    // one-line message body is never anything but noise or an attempt at one.
    const body = stripControlChars(
      input.body ? `${input.title} ${input.body}` : input.title
    );
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
          To: to,
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
