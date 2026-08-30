import { describe, expect, it, vi } from "vitest";
import {
  ACTIVITY_COOKIE,
  IDLE_LIMIT_MS,
  activityCookieOptions,
  isIdleExpired,
  readStamp,
  shouldStampActivity,
} from "./sessionActivity";

const NOW = 1_760_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

describe("readStamp", () => {
  it("reads a plain millisecond timestamp", () => {
    expect(readStamp(String(NOW))).toBe(NOW);
  });

  it("rejects anything that is not a positive integer", () => {
    // A hand-typed or truncated cookie must read as "no stamp", never as a
    // number that happens to parse.
    for (const bad of [
      undefined,
      null,
      "",
      "0",
      "-1",
      "abc",
      "1.5",
      " 123",
      "123 ",
      "1e12",
      "99999999999999999999",
    ]) {
      expect(readStamp(bad)).toBeNull();
    }
  });
});

describe("isIdleExpired", () => {
  it("is false for a session used inside the window", () => {
    expect(isIdleExpired(String(NOW - 29 * DAY), NOW)).toBe(false);
    expect(isIdleExpired(String(NOW), NOW)).toBe(false);
  });

  it("is true once the window has passed", () => {
    expect(isIdleExpired(String(NOW - 31 * DAY), NOW)).toBe(true);
  });

  it("is exactly 30 days", () => {
    expect(IDLE_LIMIT_MS).toBe(30 * DAY);
    expect(isIdleExpired(String(NOW - IDLE_LIMIT_MS), NOW)).toBe(false);
    expect(isIdleExpired(String(NOW - IDLE_LIMIT_MS - 1), NOW)).toBe(true);
  });

  it("does NOT expire a browser that has no stamp yet", () => {
    // This is the deploy-day case: every already-signed-in browser arrives
    // with no cookie. Reading that as "idle for 30 days" would sign out the
    // whole user base at once, and it would not even be true.
    expect(isIdleExpired(undefined, NOW)).toBe(false);
    expect(isIdleExpired(null, NOW)).toBe(false);
    expect(isIdleExpired("garbage", NOW)).toBe(false);
  });

  it("does not expire on a future-dated stamp", () => {
    // Clock skew between a phone and the server is normal. The cookie is
    // httpOnly, so a page script cannot write one to buy itself time.
    expect(isIdleExpired(String(NOW + DAY), NOW)).toBe(false);
  });
});

describe("shouldStampActivity", () => {
  it("stamps when there is nothing stored", () => {
    expect(shouldStampActivity(undefined, NOW)).toBe(true);
    expect(shouldStampActivity("nonsense", NOW)).toBe(true);
  });

  it("does not rewrite the cookie on every navigation", () => {
    expect(shouldStampActivity(String(NOW - 5 * 60 * 1000), NOW)).toBe(false);
  });

  it("rewrites it once an hour", () => {
    expect(shouldStampActivity(String(NOW - HOUR), NOW)).toBe(true);
    expect(shouldStampActivity(String(NOW - HOUR + 1), NOW)).toBe(false);
  });
});

describe("the activity cookie itself", () => {
  it("has the name the middleware and the sign-out route agree on", () => {
    expect(ACTIVITY_COOKIE).toBe("hearth_seen");
  });

  it("cannot be read or rewritten by page script", () => {
    expect(activityCookieOptions().httpOnly).toBe(true);
  });

  it("outlives the window it measures, so a stale stamp is still visible", () => {
    // If Max-Age equalled the 30-day window the cookie would simply disappear
    // and the timeout could never fire.
    expect(activityCookieOptions().maxAge * 1000).toBeGreaterThan(IDLE_LIMIT_MS);
  });

  it("survives a normal top-level navigation", () => {
    expect(activityCookieOptions().sameSite).toBe("lax");
    expect(activityCookieOptions().path).toBe("/");
  });

  it("is Secure in production and not in development", () => {
    try {
      vi.stubEnv("NODE_ENV", "production");
      expect(activityCookieOptions().secure).toBe(true);
      // A Secure cookie is dropped on http://localhost.
      vi.stubEnv("NODE_ENV", "development");
      expect(activityCookieOptions().secure).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
