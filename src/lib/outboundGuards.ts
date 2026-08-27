// The four guards that stand in front of every outgoing email and SMS.
//
// They live in their own dependency-free module (no server-only, no Supabase,
// no next/*) for the same reason src/lib/notifyGating.ts and
// src/lib/proAlertBatch.ts do: the rules that decide what leaves the building
// are exactly the part worth unit testing, and importing src/lib/notify.ts
// from a test would drag in the Resend/Twilio secrets and the "server-only"
// guard.
//
// All four are applied in src/lib/notify.ts, at the single send boundary every
// notification goes through (sendOutboundChannels -> sendEmail / sendSms).
// Nothing else in the app talks to Resend or Twilio directly.

// ---------------------------------------------------------------------------
// 1. SMS destination validation
// ---------------------------------------------------------------------------

// Formatting characters a human might type around a phone number. Anything
// outside this set - a letter, a comma, a newline, a control byte - means the
// value is not a phone number and is refused rather than cleaned up.
const PHONE_SHAPE = /^\+?[\d\s().-]+$/;

// The longest string worth even looking at. "+1 (555) 123-4567" is 17.
const PHONE_MAX_INPUT = 24;

// Normalise a US phone number to E.164 (+1XXXXXXXXXX), or null if it is not
// one.
//
// Accepts exactly two digit shapes, after formatting characters are dropped:
//   - 10 digits            -> +1 and the ten digits
//   - 11 digits starting 1 -> + and the eleven digits
// Everything else is null: too short, too long, an international number we
// cannot text from a US long code anyway, or something that was never a phone
// number at all.
//
// WHY THIS IS A HARD GATE AND NOT A TIDY-UP. contractors.contact_phone is a
// column `authenticated` holds a direct UPDATE on (migration 0085), so the
// destination of a pro alert is a value the recipient's own account can write
// to freely, without passing through any server action that validates it. That
// makes "whatever is in the column" an untrusted string being handed to a paid
// send API. Refusing to text anything that is not a plain US number keeps that
// column from being usable to aim Hearth's Twilio account at an arbitrary
// destination (a premium-rate number, an international one), and keeps CR/LF
// or field-separator characters out of the form-encoded request body.
export function toUsE164(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > PHONE_MAX_INPUT) return null;
  if (!PHONE_SHAPE.test(trimmed)) return null;
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

// ---------------------------------------------------------------------------
// 2. Control characters in user-controlled text
// ---------------------------------------------------------------------------

// Strip CR, LF, tab and every other C0 control character from a string that is
// about to be interpolated into an email subject or an SMS body.
//
// The strings that reach those places are not ours: a pro's business name, a
// homeowner's job title, a custom category. A bare CR/LF inside an email
// subject is header injection in the classic sense (the provider is asked to
// send one header and sends two), and even where a provider rejects it, a
// notification whose subject contains a newline renders as a truncated or
// forged-looking message. Nothing legitimate in any of these fields needs a
// control character, so they are removed rather than escaped.
//
// Collapses the resulting run of whitespace so a name pasted out of a
// spreadsheet does not arrive with a gap where its newline used to be.
export function stripControlChars(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\r\n\t\x00-\x1f\x7f]+/g, " ").replace(/ {2,}/g, " ").trim();
}

// ---------------------------------------------------------------------------
// 3. The kill switch
// ---------------------------------------------------------------------------

// OUTBOUND_DISABLED=1 (or "true") stops every email and SMS at the door.
//
// This is the lever to pull at 3am when a cron is looping, a fan-out is
// misfiring, or a staging deploy turns out to be pointed at the live Resend
// key. It needs no code change and no redeploy of anything but the env var,
// and it is read on every call on purpose: flipping it takes effect on the
// next send, not on the next cold start. The in-app notification row is
// written before this runs and is unaffected, so nothing is lost, only
// delayed.
export function outboundDisabled(): boolean {
  const raw = (process.env.OUTBOUND_DISABLED ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true";
}

// ---------------------------------------------------------------------------
// 4. The per-process rate cap
// ---------------------------------------------------------------------------

// A ceiling on how many outbound notifications one server process may send per
// minute. The kill switch is a human pulling a lever; this is the brake that
// works while nobody is watching.
//
// 600 a minute is far above anything real: the largest single fan-out is a job
// post to ~200 pros, and those arrive minutes apart. A runaway loop, on the
// other hand, reaches it in seconds. Per PROCESS, not global, because it needs
// no database round trip in the hot path - a serverless deployment will run
// several of these in parallel, so this is a blast-radius limiter, not an
// exact quota. The database-backed limits upstream (post:, post-day:) are what
// bound the total.
export const OUTBOUND_PER_MINUTE = 600;

const OUTBOUND_WINDOW_MS = 60_000;

let windowStart = 0;
let sentInWindow = 0;
let droppedInWindow = 0;

// Register one outbound send against the current minute. Returns false when
// the cap is already spent, in which case the caller must drop the send.
//
// Logs once when the cap first trips in a window, and once more with the total
// when that window rolls over: a message per dropped send would turn a flood
// of texts into a flood of log lines.
export function allowOutboundSend(now: number = Date.now()): boolean {
  if (now - windowStart >= OUTBOUND_WINDOW_MS) {
    if (droppedInWindow > 0) {
      console.error(
        `[ALERT] outbound cap dropped ${droppedInWindow} sends in the last minute (cap ${OUTBOUND_PER_MINUTE})`
      );
    }
    windowStart = now;
    sentInWindow = 0;
    droppedInWindow = 0;
  }
  if (sentInWindow >= OUTBOUND_PER_MINUTE) {
    if (droppedInWindow === 0) {
      console.error(
        `[ALERT] outbound per-process cap tripped (${OUTBOUND_PER_MINUTE}/minute) - dropping sends`
      );
    }
    droppedInWindow += 1;
    return false;
  }
  sentInWindow += 1;
  return true;
}

// Test-only reset of the window counters. Exported rather than reached into,
// so the module keeps its state private.
export function resetOutboundWindow(): void {
  windowStart = 0;
  sentInWindow = 0;
  droppedInWindow = 0;
}
