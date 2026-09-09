import { createHmac, timingSafeEqual } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { LEGAL } from "@/lib/legal";

// Twilio's inbound-SMS webhook: fires whenever someone texts our Twilio
// number back. This is the OTHER half of the TCPA consent gate in
// src/lib/notify.ts - a STOP here must always be able to turn sendSms back
// off, regardless of what the /account checkbox says, or the "Reply STOP to
// opt out." line on every text we send would be a lie.
//
// PUBLIC route: Twilio calls this with no OakTend session, so it must be
// reachable with no auth. The middleware allowlist entry for
// /api/twilio/inbound is added elsewhere (not this file).
//
// SIGNATURE VERIFICATION: every request must carry a valid X-Twilio-Signature
// before From/Body are trusted or sms_consent is touched, same shape as
// src/lib/checkr.ts's verifyWebhookSignature - HMAC over (full URL + sorted
// POST param key+value pairs), keyed by TWILIO_AUTH_TOKEN, constant-time
// compared. FAIL CLOSED: a missing TWILIO_AUTH_TOKEN, a missing header, or a
// mismatch all return 403 without processing STOP/START. Twilio is dormant
// until TWILIO_AUTH_TOKEN/TWILIO_ACCOUNT_SID/TWILIO_FROM_NUMBER are set (see
// src/lib/notify.ts), so there is no legitimate inbound traffic to lose by
// refusing everything until then.
//
// runtime = "nodejs": needs the real node:crypto HMAC, same requirement as
// the Checkr webhook (src/app/api/checkr/webhook/route.ts).
export const runtime = "nodejs";
// dynamic = force-dynamic: this must never be cached, matching the other
// webhook routes (checkr, stripe).
export const dynamic = "force-dynamic";

const STOP_WORDS = new Set([
  "STOP",
  "STOPALL",
  "UNSUBSCRIBE",
  "CANCEL",
  "END",
  "QUIT",
  // FCC's April 2025 standardized opt-out keyword list adds these two. "OPT
  // OUT" carries a space, so Body is whitespace-collapsed before this lookup
  // (see the normalize step in POST below) - "opt   out" still matches.
  "REVOKE",
  "OPT OUT",
]);
const START_WORDS = new Set(["START", "YES", "UNSTOP"]);
// Carriers require a HELP/INFO auto-reply for 10DLC approval, and the SMS
// consent copy (src/app/(app)/account/ProfileInfoForm.tsx) promises "HELP for
// help" - so both keywords must actually answer. HELP never touches consent.
const HELP_WORDS = new Set(["HELP", "INFO"]);

const TWIML_EMPTY_RESPONSE = "<Response></Response>";

// Canonical site origin for the support link in the HELP reply. Same env var
// and fallback the rest of the app uses (src/app/layout.tsx etc.).
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

// XML-escape values dropped into TwiML. The HELP body contains "&" (in
// "Msg&data"), which is not valid raw in XML, so at minimum & < > must be
// encoded or Twilio rejects the TwiML.
function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// One compliant HELP/INFO auto-reply, returned as TwiML so Twilio sends it
// back to the texter (the same reply channel this route already speaks - no
// separate REST call needed). Identifies the sender, points to support, and
// restates the rate + opt-out disclosure carriers look for.
function helpTwiml(): string {
  const message = `${LEGAL.brand}: home maintenance help. Support: ${SITE_URL}/contact Msg&data rates may apply. Reply STOP to opt out.`;
  return `<Response><Message>${escapeXml(message)}</Message></Response>`;
}

// The STOP-family confirmation (09-sms-terms.md section 5). Carriers require
// this to be the SINGLE, FINAL message a texter gets after a STOP-family
// keyword - no HELP text, no second message, nothing else riding along with
// it - so this is returned alone, in its own TwiML response, and nothing
// else in this route ever appends to it.
function stopTwiml(): string {
  const message = `You have opted out of ${LEGAL.brand} text messages. No further messages will be sent. Reply START to opt back in. For help, reply HELP.`;
  return `<Response><Message>${escapeXml(message)}</Message></Response>`;
}

// The START/YES/UNSTOP opt-in confirmation (09-sms-terms.md section 7),
// restating the same rate/frequency/opt-out disclosure the Account checkbox
// promises, so a text-triggered opt-in reads exactly like a checkbox one.
function startTwiml(): string {
  const message = `You have opted in to ${LEGAL.brand} text messages for account and job-related alerts. Msg&data rates may apply. Message frequency varies. Reply STOP to opt out, HELP for help.`;
  return `<Response><Message>${escapeXml(message)}</Message></Response>`;
}

// Best-effort US phone match: strip everything but digits and compare the
// last 10 (the national number), so it doesn't matter whether one side has a
// leading "+1" and the other doesn't.
function normalizePhone(raw: string): string {
  return raw.replace(/\D/g, "").slice(-10);
}

// Reconstructs the exact public URL Twilio signed. Behind a proxy (Vercel,
// etc.) req.url's host/proto can be rewritten before this handler ever sees
// it, so prefer an explicit override, then the standard forwarded headers,
// then fall back to whatever req.nextUrl reports.
//
// TODO(config): TWILIO_WEBHOOK_URL must exactly match the URL entered as
// this number's "A message comes in" webhook in the Twilio console
// (scheme + host + path, no query string) - if they ever drift apart, every
// genuine Twilio request starts failing signature verification (403) too.
// Set that env var explicitly if the forwarded-header fallback below ever
// proves unreliable for this deployment's proxy.
function inboundWebhookUrl(req: NextRequest): string {
  const configured = process.env.TWILIO_WEBHOOK_URL;
  if (configured) return configured;

  const proto =
    req.headers.get("x-forwarded-proto") ??
    req.nextUrl.protocol.replace(":", "");
  const host =
    req.headers.get("x-forwarded-host") ??
    req.headers.get("host") ??
    req.nextUrl.host;
  return `${proto}://${host}${req.nextUrl.pathname}`;
}

// Twilio's request-validation scheme: base64(HMAC-SHA1(authToken, url +
// sorted-by-key concatenation of every POST param's "key"+"value")). See
// https://www.twilio.com/docs/usage/security#validating-requests - no query
// string for a form POST like this one.
function computeTwilioSignature(
  url: string,
  params: URLSearchParams,
  authToken: string
): string {
  const sorted = Array.from(params.entries()).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0
  );
  let data = url;
  for (const [key, value] of sorted) data += key + value;
  return createHmac("sha1", authToken).update(data, "utf8").digest("base64");
}

// Verifies X-Twilio-Signature against the reconstructed URL + form params.
// Never throws: returns false (reject) on any missing config, missing
// header, or mismatch - mirrors src/lib/checkr.ts's
// verifyWebhookSignature, including the constant-time compare via
// timingSafeEqual (only run once both buffers are confirmed equal length).
function verifyTwilioSignature(
  url: string,
  params: URLSearchParams,
  signatureHeader: string | null
): boolean {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!authToken || !signatureHeader) return false;

  let expected: string;
  try {
    expected = computeTwilioSignature(url, params, authToken);
  } catch {
    return false;
  }

  const provided = Buffer.from(signatureHeader, "utf8");
  const expectedBuf = Buffer.from(expected, "utf8");
  if (provided.length !== expectedBuf.length || provided.length === 0) {
    return false;
  }
  try {
    return timingSafeEqual(provided, expectedBuf);
  } catch {
    return false;
  }
}

export async function POST(req: NextRequest) {
  // Declared outside the try block so the final return (after the try/catch)
  // can still see which keyword family fired even if the DB update inside
  // the try threw partway through - the confirmation reply is owed to the
  // texter independent of whether the matching users row was found or
  // updated cleanly.
  let consent: boolean | null = null;
  try {
    // Read the raw body once (form-encoded, not multipart) so the exact same
    // bytes back both the signature check and the From/Body values below -
    // req.formData() would consume the body without giving us the raw param
    // pairs the signature needs.
    const rawBody = await req.text();
    const params = new URLSearchParams(rawBody);

    const signatureHeader = req.headers.get("x-twilio-signature");
    const url = inboundWebhookUrl(req);

    if (!verifyTwilioSignature(url, params, signatureHeader)) {
      // FAIL CLOSED: do not touch STOP/START or any user's sms_consent on an
      // unverified request.
      console.error("twilio inbound: signature verification failed");
      return new NextResponse("Forbidden", { status: 403 });
    }

    // Whitespace-collapsed so multi-token keywords like "OPT OUT" match no
    // matter how many spaces the texter typed.
    const body = (params.get("Body") ?? "")
      .trim()
      .toUpperCase()
      .replace(/\s+/g, " ");
    const from = params.get("From") ?? "";

    // HELP/INFO get an informational auto-reply and never change consent, so
    // answer and return before the STOP/START handling below.
    if (HELP_WORDS.has(body)) {
      return new NextResponse(helpTwiml(), {
        status: 200,
        headers: { "Content-Type": "text/xml" },
      });
    }

    if (STOP_WORDS.has(body)) consent = false;
    else if (START_WORDS.has(body)) consent = true;

    const fromDigits = normalizePhone(from);
    if (consent !== null && fromDigits) {
      const admin = createAdminClient();

      // Stored phone numbers come from PhoneInput (see
      // src/components/PhoneInput.tsx), which writes the US display format
      // "(555) 123-4567" - not the E.164 format Twilio sends in `From`
      // ("+15551234567"). There's no column suited to an indexed lookup in
      // that format, so this pulls every user with a phone on file and
      // compares normalized digits in memory.
      // TODO(perf): this still full-scans every user with a phone on every
      // request. Signature verification above already closes the
      // abusive-volume angle (a forged/unsigned flood is rejected with 403
      // before it ever reaches this query), but a legitimate high-volume
      // deployment should still add a normalized, indexed `phone_digits`
      // column (needs a migration) and look up by equality instead of
      // scanning + comparing in memory.
      // TODO: if phone storage ever changes format (or goes non-US/+1), this
      // matching logic needs to change with it.
      const { data: users, error } = await (admin as any)
        .from("users")
        .select("id, phone")
        .not("phone", "is", null);

      if (error) {
        console.error("twilio inbound: users lookup failed:", error.message);
      } else {
        // EVERY matching row, not the first one found. users.phone is
        // unverified and has no unique constraint, so two accounts can carry
        // the same number; a STOP from that number must switch off consent on
        // all of them, or the confirmation "No further messages will be sent"
        // is false for whichever row lost the sort (red team, 2026-09-03).
        const matchIds = (users ?? [])
          .filter(
            (u: { id: string; phone: string | null }) =>
              u.phone && normalizePhone(u.phone) === fromDigits
          )
          .map((u: { id: string }) => u.id);

        if (matchIds.length > 0) {
          // sms_consent_at only advances on a fresh grant (START). A STOP
          // flips consent off but deliberately leaves sms_consent_at alone,
          // same rule as saveAccountAction in
          // src/app/(app)/account/actions.ts - it should keep recording when
          // consent was originally given, not when it was revoked.
          const updatePayload =
            consent === true
              ? { sms_consent: true, sms_consent_at: new Date().toISOString() }
              : { sms_consent: false };

          const { error: updateError } = await admin
            .from("users")
            .update(updatePayload)
            .in("id", matchIds);
          if (updateError) {
            console.error(
              "twilio inbound: consent update failed:",
              updateError.message
            );
          }
        }
      }
    }
  } catch (err) {
    // Twilio retries on a non-2xx response - always 200 below regardless of
    // what went wrong here, so a parsing hiccup doesn't turn into a retry
    // storm. `consent` may already be set (the keyword parse happens before
    // the DB work that can throw), so the confirmation still goes out even
    // if the users-table update failed.
    console.error("twilio inbound:", err instanceof Error ? err.message : err);
  }

  // Carriers require the STOP-family confirmation to be the single, final
  // message a texter gets - never bundled with anything else - so it (and
  // the START confirmation) are returned alone here, after every DB write
  // attempt above has already run. A keyword outside STOP/HELP/START gets the
  // same empty ack every unrecognized inbound text always got.
  const twiml =
    consent === false ? stopTwiml() : consent === true ? startTwiml() : TWIML_EMPTY_RESPONSE;
  return new NextResponse(twiml, {
    status: 200,
    headers: { "Content-Type": "text/xml" },
  });
}
