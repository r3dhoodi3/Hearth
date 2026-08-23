import type { PublicParcelFacts } from "@/lib/parcel";

// A half-finished home claim has to survive a reload.
//
// Onboarding is one screen with two phases (editable address, then the same
// screen expanded into confirm-and-claim) with no URL of its own per phase,
// so before this file existed ANY reload, back navigation, or second visit to
// /onboarding dropped the visitor on a blank address entry with everything
// they had typed gone - including the address lookup they had already spent
// a billed parcel call on. On a phone that is the normal case, not the edge
// case: a tab gets evicted, a password manager bounces them out to another
// app, they tap back to check the sign-in email.
//
// localStorage rather than sessionStorage (the pro wizard's choice in
// src/app/pro/onboarding/OnboardingCompanyForm.tsx): a homeowner interrupted
// here often comes back in a NEW tab, or the next morning, which is exactly
// the case a session-scoped draft loses. The 7-day floor below is what keeps
// that from turning into a stale draft haunting the form months later.
//
// What goes in it: the address and ZIP they typed, their name, and the parcel
// facts the lookup returned - the same public-record values already on screen
// in the form fields. It stays on the device that typed it, it is cleared the
// moment the claim is submitted, and it expires on its own after a week.
export const HOME_ONBOARDING_DRAFT_KEY = "hearth.home-onboarding.v1";

// Older than this and the draft is thrown away rather than restored. Someone
// coming back a week later is starting over, not resuming, and silently
// re-filling a form with a stale address is worse than an empty one.
export const HOME_ONBOARDING_DRAFT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// Only the two phases worth resuming. The out_of_area panel is an end state,
// not a half-filled form, so a draft never restores into it - a reload there
// puts the visitor back on the editable address fields with their ZIP still
// typed, which is the one thing they might want to change.
export type HomeOnboardingDraftStep = "address" | "ready";

export type HomeOnboardingDraft = {
  step: HomeOnboardingDraftStep;
  // The address fields, as typed. `unit` is the optional condo/townhome
  // designator (migration 0127), empty for a single-family home. It counts as
  // "something typed" like the rest of them: a draft that has lost the one
  // detail separating unit 4B from the building is not worth restoring.
  street: string;
  unit: string;
  zip: string;
  // The expanded section's editable fields.
  fullName: string;
  addressLine1: string;
  // The lookup result behind the expanded section. Null means the draft can
  // only restore the editable address fields: without facts there is nothing
  // to expand, and re-running the lookup would spend another billed parcel
  // call.
  facts: PublicParcelFacts | null;
  savedAt: number;
};

function str(value: unknown, max: number): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nullableStr(value: unknown, max: number): string | null {
  return typeof value === "string" ? value.slice(0, max) : null;
}

// Tax history and system facts are the two loose blobs in the parcel payload.
// Both are re-derived rather than trusted: they get posted straight back to
// claimPropertyAction as hidden JSON fields, which caps and re-validates them
// server-side, but there is no reason to hand it junk from here.
function taxHistory(value: unknown): { year: number; amount: number }[] | null {
  if (!Array.isArray(value)) return null;
  const rows = value
    .filter((row): row is Record<string, unknown> => !!row && typeof row === "object")
    .map((row) => ({ year: num(row.year), amount: num(row.amount) }))
    .filter((row): row is { year: number; amount: number } =>
      row.year !== null && row.amount !== null
    );
  return rows.length ? rows.slice(0, 50) : null;
}

function systemFacts(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const out: Record<string, string> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "string") out[key.slice(0, 60)] = v.slice(0, 200);
  }
  return Object.keys(out).length ? out : null;
}

function parseFacts(value: unknown): PublicParcelFacts | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const f = value as Record<string, unknown>;
  // No address line means nothing worth showing on the confirm screen.
  if (typeof f.address_line1 !== "string" || !f.address_line1.trim()) return null;
  return {
    parcel_id: nullableStr(f.parcel_id, 120),
    address_line1: str(f.address_line1, 200),
    city: nullableStr(f.city, 120),
    state: nullableStr(f.state, 60),
    zip: nullableStr(f.zip, 10),
    year_built: num(f.year_built),
    sqft: num(f.sqft),
    beds: num(f.beds),
    baths: num(f.baths),
    lot_size_sqft: num(f.lot_size_sqft),
    property_type: nullableStr(f.property_type, 60),
    purchase_date: nullableStr(f.purchase_date, 20),
    purchase_price: num(f.purchase_price),
    assessed_value: num(f.assessed_value),
    assessed_year: num(f.assessed_year),
    property_tax_history: taxHistory(f.property_tax_history),
    latitude: num(f.latitude),
    longitude: num(f.longitude),
    hoa_fee: num(f.hoa_fee),
    county: nullableStr(f.county, 120),
    market_value: num(f.market_value),
    market_value_low: num(f.market_value_low),
    market_value_high: num(f.market_value_high),
    system_facts: systemFacts(f.system_facts),
    source: f.source === "rentcast" ? "rentcast" : "none",
  };
}

// Turns whatever is in storage into a draft this form can actually use, or
// null. Everything in there is a previous version of our own write, a
// hand-edited value, or junk, so every field is re-derived and a parse failure
// just means "no draft". Pure and time-injected so the expiry is testable.
export function parseHomeOnboardingDraft(
  raw: string | null,
  now: number
): HomeOnboardingDraft | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const d = parsed as Record<string, unknown>;

  const savedAt = num(d.savedAt);
  if (savedAt === null) return null;
  // Too old, or stamped in the future by a clock change: either way this is
  // not a draft anyone is in the middle of.
  if (now - savedAt > HOME_ONBOARDING_DRAFT_MAX_AGE_MS) return null;
  if (savedAt - now > HOME_ONBOARDING_DRAFT_MAX_AGE_MS) return null;

  const facts = parseFacts(d.facts);
  const draft: HomeOnboardingDraft = {
    // Without facts there is no expanded section to restore, so fall back to
    // the editable address fields rather than rendering a half-empty claim
    // form.
    step: d.step === "ready" && facts ? "ready" : "address",
    street: str(d.street, 200),
    // Same 20-character ceiling the server puts on it (MAX_UNIT in
    // ./actions.ts), so a hand-edited storage value can't seed the form with
    // something the claim would only truncate anyway.
    unit: str(d.unit, 20),
    zip: str(d.zip, 10),
    fullName: str(d.fullName, 200),
    addressLine1: str(d.addressLine1, 200),
    facts,
    savedAt,
  };

  // Nothing typed and nothing looked up: an empty draft is the same as none,
  // and restoring it would only churn state on mount.
  if (
    draft.step === "address" &&
    !draft.street.trim() &&
    !draft.unit.trim() &&
    !draft.zip.trim() &&
    !draft.fullName.trim()
  ) {
    return null;
  }
  return draft;
}

// Storage is a convenience here, never a requirement: private mode, a full
// quota, or a browser with site data blocked all just mean the draft doesn't
// happen. None of it may ever cost a keystroke or a claim.
export function readHomeOnboardingDraft(now: number): HomeOnboardingDraft | null {
  try {
    return parseHomeOnboardingDraft(
      localStorage.getItem(HOME_ONBOARDING_DRAFT_KEY),
      now
    );
  } catch {
    return null;
  }
}

export function writeHomeOnboardingDraft(
  draft: Omit<HomeOnboardingDraft, "savedAt">,
  now: number
) {
  try {
    localStorage.setItem(
      HOME_ONBOARDING_DRAFT_KEY,
      JSON.stringify({ ...draft, savedAt: now })
    );
  } catch {
    // Storage full or blocked.
  }
}

export function clearHomeOnboardingDraft() {
  try {
    localStorage.removeItem(HOME_ONBOARDING_DRAFT_KEY);
  } catch {
    // Nothing to do: there was no draft to lose.
  }
}
