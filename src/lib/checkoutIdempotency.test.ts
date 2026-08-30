import { describe, it, expect } from "vitest";
import {
  checkoutIdempotencyBucket,
  checkoutIdempotencyKey,
  IDEMPOTENCY_BUCKET_MS,
} from "./checkoutIdempotency";

// The live bug these guard: the key used to be user + plan + time bucket only,
// so two clicks inside one 5-minute window could send DIFFERENT bodies (trial
// vs no trial) under the SAME key. Stripe answers that with
// StripeIdempotencyError and no session, which is what broke "Start my free
// 3 day trial" for every buyer who had backed out of checkout once.

const base = {
  prefix: "plus-checkout",
  userId: "user_1",
  plan: "weekly",
  bucket: 12345,
  varying: {
    freeTrial: true,
    customer: "new",
    price: "price_1",
    consentTerms: "Free for 3 days, then $2.99 a week.",
    consentAt: "2026-08-29T00:00:00.000Z",
  },
};

describe("checkoutIdempotencyKey", () => {
  it("is stable for identical inputs, so a double-click replays one session", () => {
    expect(checkoutIdempotencyKey(base)).toBe(checkoutIdempotencyKey(base));
  });

  it("changes when the trial flips", () => {
    const noTrial = {
      ...base,
      varying: { ...base.varying, freeTrial: false },
    };
    expect(checkoutIdempotencyKey(noTrial)).not.toBe(
      checkoutIdempotencyKey(base)
    );
  });

  it("changes when any other varying input changes", () => {
    const fields: Array<[string, string]> = [
      ["customer", "cus_9"],
      ["price", "inline"],
      ["consentTerms", "Billed today."],
      ["consentAt", "2026-08-29T00:05:00.000Z"],
    ];
    for (const [field, value] of fields) {
      const changed = {
        ...base,
        varying: { ...base.varying, [field]: value },
      };
      expect(checkoutIdempotencyKey(changed)).not.toBe(
        checkoutIdempotencyKey(base)
      );
    }
  });

  it("does not depend on the order the varying inputs are written in", () => {
    const reordered = {
      ...base,
      varying: {
        consentAt: base.varying.consentAt,
        price: base.varying.price,
        freeTrial: base.varying.freeTrial,
        consentTerms: base.varying.consentTerms,
        customer: base.varying.customer,
      },
    };
    expect(checkoutIdempotencyKey(reordered)).toBe(
      checkoutIdempotencyKey(base)
    );
  });

  it("keeps the readable prefix, and stays well under Stripe's 255 characters", () => {
    const key = checkoutIdempotencyKey(base);
    expect(key.startsWith("plus-checkout:user_1:weekly:12345:")).toBe(true);
    expect(key.length).toBeLessThan(255);
    // The disclosure text is long; hashing is what keeps it out of the key.
    const long = {
      ...base,
      varying: { ...base.varying, consentTerms: "x".repeat(500) },
    };
    expect(checkoutIdempotencyKey(long).length).toBe(key.length);
  });

  it("separates the two sides even for one user on one bucket", () => {
    const pro = { ...base, prefix: "pro-checkout", plan: "pro_monthly" };
    expect(checkoutIdempotencyKey(pro)).not.toBe(checkoutIdempotencyKey(base));
  });
});

describe("checkoutIdempotencyBucket", () => {
  it("holds still inside a 5-minute window and moves after it", () => {
    const start = 1_000 * IDEMPOTENCY_BUCKET_MS;
    expect(checkoutIdempotencyBucket(start)).toBe(
      checkoutIdempotencyBucket(start + IDEMPOTENCY_BUCKET_MS - 1)
    );
    expect(checkoutIdempotencyBucket(start + IDEMPOTENCY_BUCKET_MS)).toBe(
      checkoutIdempotencyBucket(start) + 1
    );
  });
});
