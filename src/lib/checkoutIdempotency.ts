import { createHash } from "node:crypto";

// The Stripe idempotency key for a checkout session create.
//
// THE BUG THIS EXISTS FOR. The key used to be
// `plus-checkout:<user>:<plan>:<5-minute bucket>` and nothing else, on the
// theory that only a double-click could land twice inside one bucket, with the
// same body both times. That stopped being true once the free trial became a
// promo_claims reservation: a buyer who opened Stripe Checkout and backed out
// came back inside the same bucket, lost the claim_promo race against their own
// abandoned reservation, and so built a DIFFERENT body (no trial_period_days,
// trial_reserved "false", different consent text) under the SAME key. Stripe
// answers that with StripeIdempotencyError, and every click on "Start my free
// 3 day trial" failed with "We couldn't start checkout."
//
// So the key now covers every input that can vary between two clicks. Same
// inputs, same bucket, same key: a genuine double-click still replays the one
// session instead of minting two. Any input different: a different key, and
// Stripe is asked for a new session rather than told to replay one that no
// longer matches.
//
// The values are hashed rather than concatenated because two of them (the
// consent disclosure, the price id) are long and Stripe caps a key at 255
// characters. 16 hex characters is 64 bits, which is far more than enough to
// separate a handful of clicks by one user inside one 5-minute window.
export const IDEMPOTENCY_BUCKET_MS = 5 * 60 * 1000;

export function checkoutIdempotencyBucket(now: number = Date.now()): number {
  return Math.floor(now / IDEMPOTENCY_BUCKET_MS);
}

export function checkoutIdempotencyKey(input: {
  prefix: string;
  userId: string;
  plan: string;
  bucket: number;
  // Everything about the request body that is not already in the four fields
  // above. Key order does not matter: the entries are sorted before hashing, so
  // the same values always produce the same key.
  varying: Record<string, string | number | boolean | null>;
}): string {
  const entries = Object.keys(input.varying)
    .sort()
    .map((key) => [key, input.varying[key]] as const);
  const hash = createHash("sha256")
    .update(JSON.stringify(entries))
    .digest("hex")
    .slice(0, 16);
  return `${input.prefix}:${input.userId}:${input.plan}:${input.bucket}:${hash}`;
}
