// Shared server-side readers for FormData fields.
//
// A server action accepts ANY FormData, regardless of what the page rendered:
// an <input maxLength>, a <select>, and an <input type="number"> are all
// client-side hints, not guards. So every field a server action reads needs a
// trim and a ceiling (free text), a finite-and-in-range check (numbers), or an
// allow-list (enums) before it reaches the database.
//
// This is the str(key, max) shape the public contact form
// (src/app/contact/actions.ts) already used, lifted out so every other action
// caps its input the same way instead of re-deriving it per file.

// Ceilings shared by the fields that mean the same thing everywhere. A field
// with a genuinely local meaning (a job description, a support message) keeps
// its own number at the call site rather than being forced in here.
export const FIELD_MAX = {
  name: 200,
  email: 254,
  phone: 40,
  title: 200,
  message: 5000,
} as const;

// The honeypot field name, shared by the three forms that write to
// support_messages and the three actions behind them. It lives here, not in
// the component, so a server action can read it without importing JSX; see
// src/components/Honeypot.tsx for the markup and why it is not display:none.
export const HONEYPOT_FIELD = "company_website";

// True when a bot filled the invisible field. The caller's job is then to
// PRETEND THE SEND WORKED - same redirect, same flash, nothing stored - so the
// script gets no signal that it was caught.
export function honeypotTripped(formData: FormData): boolean {
  const v = formData.get(HONEYPOT_FIELD);
  return typeof v === "string" && v.trim().length > 0;
}

// Trim, then slice. Quietly truncates rather than erroring: a paste-happy
// person should never lose the rest of their form over one long field. Always
// returns a string, so a missing field reads as "" the way `(get() as string)
// || ""` already did at most call sites.
export function cappedField(
  formData: FormData,
  key: string,
  max: number
): string {
  const v = formData.get(key);
  return (typeof v === "string" ? v.trim() : "").slice(0, max);
}

// Same, but empty becomes null, for a nullable column where "" and "not
// answered" are the same thing.
export function cappedFieldOrNull(
  formData: FormData,
  key: string,
  max: number
): string | null {
  return cappedField(formData, key, max) || null;
}

// A number that is really a number and really in range, or null.
//
// Number.isFinite is the part that matters: Number("abc") is NaN, and NaN
// slips straight through both a `??` fallback (it isn't nullish) and a naive
// `v ? Number(v) : null` guard, so without this an unparseable value reaches
// the database as NaN instead of being ignored. Out-of-range returns null
// rather than pinning to the bound - same choice confirmSystemAction
// (src/app/(app)/walkthrough/actions.ts) already makes, since a wildly wrong
// number is bad data, not a value worth half-keeping.
export function boundedNumber(
  raw: FormDataEntryValue | string | null | undefined,
  min: number,
  max: number
): number | null {
  if (raw === null || raw === undefined) return null;
  const s = typeof raw === "string" ? raw.trim() : String(raw).trim();
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n < min || n > max) return null;
  return n;
}

// boundedNumber for a column that stores whole numbers (a year, a rating, a
// bedroom count). Truncates toward zero after the range check, so "1998.5"
// lands as 1998 rather than being rejected outright.
export function boundedInt(
  raw: FormDataEntryValue | string | null | undefined,
  min: number,
  max: number
): number | null {
  const n = boundedNumber(raw, min, max);
  return n === null ? null : Math.trunc(n);
}

// Whether a value is one of the options a shared list in src/lib/constants.ts
// actually offers. The lists are the same ones the forms render from, so this
// is the server-side half of a <select>: a forged value picks a fee tier, an
// icon, and a label the rest of the app has no entry for, so it never gets
// written.
export function isAllowedValue(
  list: readonly { value: string }[],
  value: string | null | undefined
): boolean {
  if (typeof value !== "string" || !value) return false;
  return list.some((o) => o.value === value);
}
