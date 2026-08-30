import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

// Source-pattern tests, the same shape src/lib/risk/wiring.test.ts uses and for
// the same reason: these two server actions pull in "server-only" through the
// service-role client, so they cannot be imported and driven here. The logic
// they delegate to IS driven for real, in src/lib/checkoutReservation.test.ts
// and src/lib/checkoutIdempotency.test.ts; what these tests pin is the wiring
// between them, which is exactly what went wrong live.
//
// THE BUG. "Start my free 3 day trial" failed for every buyer who had opened
// Stripe Checkout once and backed out: their own unspent promo_claims
// reservation made the second click lose claim_promo, which changed the request
// body (no trial) while the idempotency key stayed the same, and Stripe refuses
// a replayed key with a different body.

function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

const plusAction = src("./actions.ts");
const proAction = src("../../pro/plus/actions.ts");
const webhook = src("../../api/stripe/webhook/route.ts");

const cases: Array<[string, string]> = [
  ["homeowner Plus", plusAction],
  ["Hearth Pro", proAction],
];

describe("the idempotency key covers everything that can vary", () => {
  it.each(cases)("%s builds the key from the shared helper", (_l, source) => {
    expect(source).toContain("checkoutIdempotencyKey({");
    expect(source).toContain("checkoutIdempotencyBucket()");
  });

  it.each(cases)("%s no longer keys on the bucket alone", (_l, source) => {
    // The exact shape that broke: prefix, user, plan, bucket, nothing else.
    expect(source).not.toMatch(
      /`(plus|pro)-checkout:\$\{user\.id\}:\$\{plan\}:\$\{idempotencyBucket\}`/
    );
  });

  it.each(cases)("%s puts the trial in the key", (_l, source) => {
    const key = source.slice(source.indexOf("checkoutIdempotencyKey({"));
    expect(key).toMatch(/varying:\s*\{[\s\S]*freeTrial,/);
    // And the rest of the body that can move between two clicks.
    for (const field of ["customer:", "price:", "consentTerms,", "consentAt,"]) {
      expect(key.slice(0, 600)).toContain(field);
    }
  });

  it("keeps the coupon in the key on the Pro side", () => {
    // The Pro intro coupon is dormant, not deleted. When it is switched back
    // on, two clicks can differ on the discount alone.
    const key = proAction.slice(proAction.indexOf("checkoutIdempotencyKey({"));
    expect(key.slice(0, 600)).toContain("coupon:");
  });
});

describe("a lost promo claim asks who is holding it", () => {
  it.each(cases)("%s reclaims instead of silently dropping the offer", (_l, source) => {
    expect(source).toContain("reclaimCheckoutReservation(admin, {");
    expect(source).toContain('outcome.kind === "resume"');
    expect(source).toContain('outcome.kind === "reclaimed"');
  });

  it.each(cases)("%s redirects to the resumed session OUTSIDE the try", (_l, source) => {
    // redirect() works by throwing; inside the try that wraps the claim, the
    // catch would swallow it and the buyer would land on a second checkout.
    expect(source).toMatch(/\}\s*\n\s*\/\/[^\n]*\n(\s*\/\/[^\n]*\n)*\s*if \(resumeUrl\) redirect\(resumeUrl\);/);
  });

  it.each(cases)("%s records the session that holds the reservation", (_l, source) => {
    const createAt = source.indexOf("stripe.checkout.sessions.create");
    const markAt = source.indexOf("markReservationSession(");
    expect(createAt).toBeGreaterThan(-1);
    // The id only exists after the session does.
    expect(markAt).toBeGreaterThan(createAt);
    expect(source).toContain("sessionId: session.id");
  });

  it.each(cases)("%s still releases the reservation when Stripe fails", (_l, source) => {
    const afterCreate = source.slice(
      source.indexOf("stripe.checkout.sessions.create")
    );
    expect(afterCreate).toContain('.from("promo_claims")');
    expect(afterCreate).toContain(".delete()");
  });
});

describe("checkout_started fires before Stripe, not before it might refuse", () => {
  // docs/ANALYTICS.md: checkout_started has to sit after every earlier guard
  // in startPlusCheckoutAction (double-checkout, risk block, etc.) so a
  // refused attempt is never counted as a started checkout, and before the
  // redirect to Stripe so a real one always is.
  it("fires after the session is created and before the redirect", () => {
    const trackAt = plusAction.indexOf('trackServerEvent(user.id, "checkout_started"');
    const createAt = plusAction.indexOf("stripe.checkout.sessions.create");
    const redirectAt = plusAction.indexOf("if (session.url) redirect(session.url);");
    expect(trackAt).toBeGreaterThan(-1);
    expect(trackAt).toBeGreaterThan(createAt);
    expect(trackAt).toBeLessThan(redirectAt);
  });

  it("imports the shared tracker rather than a local copy", () => {
    expect(plusAction).toContain(
      'import { trackServerEvent } from "@/lib/trackServer";'
    );
  });
});

describe("the webhook marks a claim spent when it converts", () => {
  it("stamps both sides on checkout.session.completed", () => {
    // Without this, a converted claim and an abandoned one read identically in
    // the ledger, and the reclaim above could hand out a second trial.
    expect(webhook).toContain('markPromoConverted(\n        admin,\n        meta.user_id,\n        "plus_trial",');
    expect(webhook).toContain('markPromoConverted(\n        admin,\n        meta.user_id,\n        "pro_intro_monthly",');
    expect(webhook).toContain("convertedRef(subscriptionId)");
  });

  it("only releases the refs the event it is handling owns", () => {
    // A redelivered expiry for a long-dead session must not wipe a reservation
    // a later attempt has taken over.
    expect(webhook).toContain('.in("ref", refs)');
    expect(webhook).toContain("reservedSessionRef(PLUS_RESERVATION_REF, String(session.id))");
    expect(webhook).toContain("reservedSessionRef(PRO_RESERVATION_REF, String(session.id))");
  });
});
