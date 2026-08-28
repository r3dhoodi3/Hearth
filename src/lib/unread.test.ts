import { describe, expect, it } from "vitest";
import { isAfter, isUnreadSince } from "@/lib/unread";

// isAfter/isUnreadSince replace a raw string `<`/`>` comparison between a
// JS-built "seen" timestamp (Date.toISOString(): always 3 fractional digits
// + "Z") and a Postgres-returned created_at (PostgREST: 0-6 trimmed
// fractional digits + "+00:00"). Both formats are exercised here in every
// combination - different seconds, matching seconds with differing
// fractional digit counts, and a whole-second Postgres value with no
// fractional part at all - to pin down the epoch-millis comparison as
// correct across the real shapes these two sources actually produce.
describe("isAfter / isUnreadSince across Postgres vs JS timestamp formats", () => {
  it("orders a later Postgres-format timestamp after an earlier JS-format one", () => {
    const seenAt = "2026-08-27T12:00:00.123Z";
    const messageCreatedAt = "2026-08-27T12:00:05.000001+00:00"; // 5s later
    expect(isAfter(messageCreatedAt, seenAt)).toBe(true);
    expect(isUnreadSince(seenAt, messageCreatedAt)).toBe(true);
  });

  it("orders an earlier Postgres-format timestamp before a later JS-format one", () => {
    const seenAt = "2026-08-27T12:00:05.000Z";
    const messageCreatedAt = "2026-08-27T12:00:00.999999+00:00"; // 4s earlier
    expect(isAfter(messageCreatedAt, seenAt)).toBe(false);
    expect(isUnreadSince(seenAt, messageCreatedAt)).toBe(false);
  });

  it("handles a Postgres value with trimmed trailing zeros (fewer than 3 fractional digits)", () => {
    const seenAt = "2026-08-27T12:00:00.100Z";
    // Postgres trims trailing zeros: exactly .200000s renders as ".2".
    const messageCreatedAt = "2026-08-27T12:00:00.2+00:00"; // genuinely 100ms later
    expect(isUnreadSince(seenAt, messageCreatedAt)).toBe(true);
  });

  it("handles a Postgres value with no fractional part at all (exact whole second)", () => {
    const seenAt = "2026-08-27T11:59:59.900Z";
    const messageCreatedAt = "2026-08-27T12:00:00+00:00"; // 100ms later, on the second
    expect(isUnreadSince(seenAt, messageCreatedAt)).toBe(true);
  });

  it("is not unread when the message is not strictly newer than the seen mark", () => {
    const seenAt = "2026-08-27T12:00:00.500Z";
    const messageCreatedAt = "2026-08-27T12:00:00.100000+00:00"; // older
    expect(isUnreadSince(seenAt, messageCreatedAt)).toBe(false);
  });

  it("is unread when the thread has never been seen", () => {
    const messageCreatedAt = "2026-08-27T12:00:00.000000+00:00";
    expect(isUnreadSince(null, messageCreatedAt)).toBe(true);
    expect(isUnreadSince(undefined, messageCreatedAt)).toBe(true);
    expect(isUnreadSince("", messageCreatedAt)).toBe(true);
  });
});
