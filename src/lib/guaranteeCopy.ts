import { GHOST_PROTECTION_DAYS } from "@/lib/constants";

// The two credit-back promises, as one canonical sentence each. They are two
// DIFFERENT credits and must never blur into one guarantee: ghost protection
// is unlimited and repeats every time, the first-application guarantee is a
// one-time credit gated on a license.
//
// These live here rather than on any one page because the same promise is
// made in five places (the /pros marketing page, the /pro board, the "not
// selected" list, the billing ledger, and the apply confirm). Wording that
// drifts between those places is a legal problem, not a copy problem, so
// every surface renders these strings verbatim.
//
// Source of truth for the rules: migration 0044
// (supabase/migrations/0044_first_apply_guarantee.sql). The
// first-application credit is once per contractor ever, on their first paid
// application only, and only when a license number is on file whose
// verification has not failed. Change 0044 and this file together.

export const GHOST_PROTECTION_GUARANTEE = `If the homeowner never responds within ${GHOST_PROTECTION_DAYS} days, you always get the fee back as credit, every time, no limit.`;

export const FIRST_APPLICATION_GUARANTEE =
  "If they do respond but pick someone else, you get that one back as credit too, but only on your very first paid application and only if you have a license number on file that has not failed our check. After that, a lost bid is a lost fee.";

export const CREDIT_NOT_CASH_LINE =
  "Either way it is Hearth credit in your wallet, not money back to your card.";

// Shown to a pro who has no license number saved yet: the same rule, said as
// the thing they can do about it.
export const FIRST_APPLICATION_NEEDS_LICENSE =
  "Adding your license number unlocks the first-application guarantee.";
