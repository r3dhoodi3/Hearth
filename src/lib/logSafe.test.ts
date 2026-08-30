import { describe, expect, it } from "vitest";
import { redact } from "./logSafe";

describe("redact", () => {
  it("drops the keys that must never reach a log line", () => {
    const out = redact({
      access_token: "ey.real.token",
      refresh_token: "r-1",
      password: "hunter2",
      authorization: "Bearer abc",
      cookie: "sb-x-auth-token=...",
      stripeSecretKey: "sk_live_1",
      cardLast4: "4242",
      email: "someone@example.com",
      phone: "+15551234567",
      otp: "123456",
      code_verifier: "v",
      userId: "u-1",
      count: 3,
    }) as Record<string, unknown>;

    for (const key of [
      "access_token",
      "refresh_token",
      "password",
      "authorization",
      "cookie",
      "stripeSecretKey",
      "cardLast4",
      "email",
      "phone",
      "otp",
      "code_verifier",
    ]) {
      expect(out[key]).toBe("[redacted]");
    }
    // What is left is what we actually wanted in the log.
    expect(out.userId).toBe("u-1");
    expect(out.count).toBe(3);
  });

  it("matches key names case-insensitively and as a substring", () => {
    const out = redact({
      AuthToken: "x",
      user_email_address: "a@b.c",
      CVV: "123",
    }) as Record<string, unknown>;
    expect(out.AuthToken).toBe("[redacted]");
    expect(out.user_email_address).toBe("[redacted]");
    expect(out.CVV).toBe("[redacted]");
  });

  it("reaches nested objects and arrays", () => {
    const out = redact({
      user: { id: "u-1", email: "a@b.c" },
      events: [{ password: "p" }, { ok: true }],
    }) as any;
    expect(out.user.id).toBe("u-1");
    expect(out.user.email).toBe("[redacted]");
    expect(out.events[0].password).toBe("[redacted]");
    expect(out.events[1].ok).toBe(true);
  });

  it("truncates a long string instead of copying it whole", () => {
    const out = redact("x".repeat(500)) as string;
    expect(out.length).toBeLessThan(300);
    expect(out).toContain("[500 chars]");
  });

  it("keeps an Error readable but leaves the stack out", () => {
    const out = redact(new TypeError("bad thing")) as Record<string, unknown>;
    expect(out).toEqual({ name: "TypeError", message: "bad thing" });
  });

  it("stops at a bounded depth so one payload cannot become a megabyte", () => {
    const deep = { a: { b: { c: { d: { e: "deep value" } } } } };
    expect(JSON.stringify(redact(deep))).toContain("[deep]");
  });

  it("bounds how many keys and array entries it copies", () => {
    const wide: Record<string, number> = {};
    for (let i = 0; i < 100; i += 1) wide[`k${i}`] = i;
    expect(JSON.stringify(redact(wide))).toContain("[truncated]");

    const long = Array.from({ length: 100 }, (_, i) => i);
    expect(JSON.stringify(redact(long))).toContain("more]");
  });

  it("passes through the primitives a log line is normally made of", () => {
    expect(redact(null)).toBeNull();
    expect(redact(undefined)).toBeUndefined();
    expect(redact(7)).toBe(7);
    expect(redact(false)).toBe(false);
    expect(redact("short")).toBe("short");
  });
});
