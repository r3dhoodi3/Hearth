// The soft-vs-hard paywall experiment (owner ask, 2026-08-30): some accounts
// are offered the 3-day free trial on every paywall ("soft"), the rest see the
// same paywalls with no trial mentioned anywhere and a checkout that charges
// from day one ("hard"), so the two conversion rates can be compared.
//
// ASSIGNMENT IS DETERMINISTIC AND PER ACCOUNT. The variant is a pure hash of
// the user id plus a literal salt, so the same account lands on the same
// variant on every render, every device, and every deploy, with no database
// column and no cookie to drift. There is deliberately no per-render
// randomness: a paywall that flips between "3 days free" and "charged today"
// on reload would be both useless data and a ROSCA problem, since the
// disclosure the buyer consents to must match what checkout does.
//
// THE VARIANT NEVER WIDENS ELIGIBILITY. "hard" is only ever one more reason a
// trial does not apply, ANDed in next to the existing checks
// (isPlusTrialEligible / isProTrialEligible and the risk decision), which stay
// exactly as they are. An account with any subscription history was never
// trial-eligible on either variant, so existing trialing and paid members are
// unaffected either way.
//
// ENDING THE EXPERIMENT. Set the PAYWALL_EXPERIMENT env var and redeploy:
//   PAYWALL_EXPERIMENT=soft   every account sees the trial offer (today's
//                             behavior before the experiment)
//   PAYWALL_EXPERIMENT=hard   no account sees a trial offer
//   PAYWALL_EXPERIMENT=split  the 50/50 hash split (also the default when the
//                             var is unset or carries any other value)
// The override is read on every call, so no code change is needed to end the
// test - pick the winner, set the var, redeploy.

export type PaywallVariant = "soft" | "hard";

// A literal experiment salt, never reused for anything else. Changing it would
// silently reshuffle every account between the two arms mid-experiment and
// corrupt the comparison, so it stays fixed for the life of this test.
const EXPERIMENT_SALT = "hearth-paywall-trial-ab-2026-08-30";

// FNV-1a, 32-bit. Small, dependency-free, and stable across runtimes, which is
// all a 50/50 split needs. Not cryptographic, and does not need to be: the
// input is an opaque UUID nobody can choose, and the worst a guessed variant
// buys is knowing which copy you will see.
function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  // Force the sign bit off so the modulo below is over a non-negative number.
  return hash >>> 0;
}

// The one entry point: which paywall arm this account is in, stable forever.
// A missing id (a signed-out viewer, a surface rendered before auth resolves)
// answers "soft", which is the behavior every surface had before the
// experiment; checkout itself always runs with a verified user id, so nobody
// can reach a trial the hash would deny them by arriving without one.
export function variantForUser(
  userId: string | null | undefined
): PaywallVariant {
  const mode = process.env.PAYWALL_EXPERIMENT;
  if (mode === "soft" || mode === "hard") return mode;
  if (!userId) return "soft";
  return fnv1a(`${userId}:${EXPERIMENT_SALT}`) % 2 === 0 ? "soft" : "hard";
}
