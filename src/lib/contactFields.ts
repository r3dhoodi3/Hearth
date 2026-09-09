// Server-side shape checks for the two ways a pro can reach a homeowner off a
// posted job: contractor_leads.homeowner_email and .homeowner_phone.
//
// Why this exists. B1 (2026-09-07 tester wave) made "email OR phone" mandatory
// when posting a job, but the first cut only checked that at least one of the
// two strings was non-blank. A pro pays real money to apply to a lead, so
// "asdf" in the email box passed the gate and sold them a lead with no way in.
// Both columns are plain `text` with no length limit in the database
// (migration 0005), so an unbounded string also went straight to storage.
//
// Deliberately conservative on the phone side: this is a US-only marketplace
// today (Orange County launch cities), PhoneInput formats every typed number
// to "(000) 000-0000", and a partially typed number is exactly the case a pro
// should never be charged for. A number that does not carry a full 10 digits
// is refused rather than silently stored.

export const MAX_CONTACT_EMAIL_LEN = 254; // RFC 5321 practical ceiling
export const MAX_CONTACT_PHONE_LEN = 25;

// One "@", something before it, and a dotted domain after it. Not RFC-complete
// on purpose: this rejects the typos and the junk, and an address that is
// well-formed but wrong is not something any regex can catch.
const EMAIL_SHAPE = /^[^\s@]{1,64}@[^\s@.]+(?:\.[^\s@.]+)+$/;

// Only the characters a person actually types into a phone field. A letter or
// an angle bracket here means the value is not a phone number.
const PHONE_CHARS = /^[0-9+()\-.\s]+$/;

/**
 * The trimmed email address when it looks like one, otherwise null.
 * Null means "do not store this", never "the field was blank" - callers that
 * need to tell those apart check the raw value themselves.
 */
export function normalizeContactEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (!value || value.length > MAX_CONTACT_EMAIL_LEN) return null;
  return EMAIL_SHAPE.test(value) ? value : null;
}

/**
 * The trimmed phone number when it carries a full, plausible number,
 * otherwise null. 10 digits (US) up to 15 (E.164's own ceiling, so a pro
 * abroad or a country code is not refused), and nothing but phone characters.
 */
export function normalizeContactPhone(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (!value || value.length > MAX_CONTACT_PHONE_LEN) return null;
  if (!PHONE_CHARS.test(value)) return null;
  const digits = value.replace(/\D/g, "").length;
  return digits >= 10 && digits <= 15 ? value : null;
}
