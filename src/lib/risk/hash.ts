import { createHash } from "crypto";

// Salted, one-way hashing for every identifier the trial-abuse score looks at.
//
// The rule this module exists to enforce: a raw IP address, device id, card
// fingerprint, phone number, parcel id or email address NEVER reaches
// public.account_signals. The only question the scorer ever asks is "do two
// accounts share this value", and equality over a salted hash answers that
// exactly as well as the raw value would, while leaving the table useless to
// anybody who gets a copy of it without also having the salt.
//
// The salt is a secret, not a formality. Without one, the hash of an IPv4
// address or a US phone number is trivially reversible: the whole input space
// fits in a few billion entries and a laptop enumerates it in an afternoon.
// With a secret salt in front of it, that attack needs the salt first.
//
// THERE IS NO FALLBACK SALT. An earlier version of this file derived one from
// the first 32 characters of SUPABASE_SERVICE_ROLE_KEY when RISK_HASH_SALT was
// missing, which was a quiet trap on two counts: rotating that key (a routine
// security response) would have silently changed every hash and reset every
// repeat offender to "brand new" with nothing in the logs, and a deploy that
// simply forgot the env var would have looked like it was working. Now a
// missing salt means riskHash returns null, recordSignal writes nothing, and
// the decision fails open exactly as it does when the migration has not run.
// Loud, visible, and never silently weaker. RISK_HASH_SALT is a go-live blocker
// (docs/GO-LIVE-WIRING.md).

// The signal kinds the score understands. Kept here rather than in signals.ts
// because the kind is part of the hash preimage (see riskHash), so the two can
// never drift apart, and it mirrors the check constraint on
// public.account_signals.kind in migration 0130.
export type SignalKind =
  | "device"
  | "fingerprint"
  | "ip"
  | "card"
  | "email_norm"
  | "email_domain"
  | "phone"
  | "parcel"
  | "company_name";

// Which salt generation produced a stored hash. Written to
// account_signals.salt_version on every row and mixed into the preimage, so a
// future salt rotation is a migration (re-hash what can be re-derived, expire
// the rest) rather than silent amnesia: rows at the old version are visibly at
// the old version instead of just quietly failing to match.
export const SALT_VERSION = 1;

// Logged at most once per process, so a misconfigured deploy shows up in the
// logs without a line per request.
let warnedNoSalt = false;

// The configured salt, or null. Null is a real answer, not an error case to be
// papered over: see the no-fallback note above.
function riskSalt(): string | null {
  const configured = process.env.RISK_HASH_SALT;
  if (configured && configured.length >= 16) return configured;

  if (!warnedNoSalt) {
    warnedNoSalt = true;
    console.error(
      "RISK_HASH_SALT is missing or too short (needs 16+ characters). " +
        "Trial-abuse signals are NOT being recorded and the risk score will " +
        "read as clean for every account. See docs/GO-LIVE-WIRING.md."
    );
  }
  return null;
}

// Whether a real, configured salt is in use. Called at module load in
// src/lib/risk/facts.ts so "we are running unsalted" is observable in
// production rather than a silent degradation.
export function riskSaltIsConfigured(): boolean {
  const configured = process.env.RISK_HASH_SALT;
  return Boolean(configured && configured.length >= 16);
}

// The stored value for one signal:
// sha256(salt : saltVersion : kind : normalized value), hex. Null when no salt
// is configured, which every caller treats as "record nothing".
//
// The KIND is part of the preimage on purpose. Two different kinds of signal
// that happen to carry the same text (a company literally named after a parcel
// number, say) must not collide into a false link, and including the kind also
// means an attacker who somehow learns one plaintext/hash pair learns nothing
// about the same value under a different kind.
//
// Normalization is deliberately minimal here - trim and lowercase, nothing
// clever. Kind-specific normalization (stripping gmail dots, reducing a phone
// number to digits, flattening a company name) belongs to the caller, because
// it is a product decision about what counts as "the same", not a hashing
// detail. See src/lib/risk/emailNorm.ts and normalizeSignalValue in
// src/lib/risk/signals.ts.
export function riskHash(kind: SignalKind, value: string): string | null {
  const salt = riskSalt();
  if (!salt) return null;
  const normalized = value.trim().toLowerCase();
  return createHash("sha256")
    .update(`${salt}:${SALT_VERSION}:${kind}:${normalized}`)
    .digest("hex");
}
