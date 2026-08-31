import { complianceStatus } from "@/lib/proCompliance";
import { isMajorCategory } from "@/lib/constants";

// Big-job insurance gate (migration 0153). Before a pro can take a
// major-tier (big-ticket) job, they must have current proof of insurance on
// file: contractors.insurance_expires (set by the compliance card on
// /pro/business, migration 0051) must hold a date that has not passed.
//
// Pure on purpose, same discipline as src/lib/proCompliance.ts: this one
// module is what the apply action, the unlock action, the leads board, the
// direct-request card and the setup checklist all read, so "what counts as
// insured" can never drift between the button a pro sees and the refusal the
// server actually enforces. The database is the real gate (apply_to_lead and
// unlock_direct_request re-check in SQL, migration 0153, because both RPCs
// keep EXECUTE for `authenticated` and are callable without going through
// the server actions at all); everything here exists so a pro is told about
// the requirement BEFORE any money or any form submit is in flight.

// Where a pro adds their certificate of insurance: the compliance card in
// the Account panel on the Business tab. Same destination proHome's expiry
// chips already link to.
export const INSURANCE_UPLOAD_HREF = "/pro/business";

// The one friendly refusal, shown by the client-side gate and by the server
// action's flash alike. Owner-approved copy; keep the three surfaces
// identical.
export const INSURANCE_REQUIRED_MESSAGE =
  "Big jobs need proof of insurance on file first. Add yours in Business > Compliance, it takes two minutes.";

// The exact text apply_to_lead / unlock_direct_request raise in SQL
// (migration 0153). The actions match on it to translate the database's
// backstop refusal into INSURANCE_REQUIRED_MESSAGE instead of the generic
// "couldn't apply" copy.
export const INSURANCE_GATE_SQL_ERROR = "Insurance required for big jobs";

// Whether the stored insurance record counts as current. Built on the same
// classification the compliance card shows the pro (proCompliance.ts):
// "ok" and "expiring" are both on file and unexpired, so both pass; "none"
// (nothing stored) and "expired" both fail. Mirrors the SQL predicate in
// 0153 (insurance_expires is not null and insurance_expires >= current_date).
export function hasCurrentInsurance(
  insuranceExpires: string | null | undefined
): boolean {
  const { status } = complianceStatus(insuranceExpires);
  return status === "ok" || status === "expiring";
}

// The gate itself: the refusal message for a major-tier lead without current
// insurance, or null when this lead needs no gate (light/skilled tier) or
// the pro is covered. Callers treat null as "let it through".
export function majorLeadInsuranceGate(
  category: string | null | undefined,
  insuranceExpires: string | null | undefined
): string | null {
  if (!isMajorCategory(category ?? "")) return null;
  return hasCurrentInsurance(insuranceExpires)
    ? null
    : INSURANCE_REQUIRED_MESSAGE;
}

// Is this RPC failure the 0153 insurance gate raising? Matched on the
// stable substring rather than equality so a wrapped Postgres message
// ("ERROR: Insurance required for big jobs") still maps.
export function isInsuranceGateSqlError(
  message: string | null | undefined
): boolean {
  return Boolean(message && message.includes(INSURANCE_GATE_SQL_ERROR));
}
