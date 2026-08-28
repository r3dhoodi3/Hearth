import { describe, expect, it } from "vitest";
import { formatLocalTime, timeZoneForProperty } from "./localTime";

describe("timeZoneForProperty", () => {
  it("defaults to the launch area's zone when nothing is known", () => {
    expect(timeZoneForProperty({})).toBe("America/Los_Angeles");
  });

  it("prefers a real timezone from the weather payload or property over the state guess", () => {
    expect(
      timeZoneForProperty({ state: "NY", tz: "America/Denver" })
    ).toBe("America/Denver");
  });

  it("falls back to the state map when no timezone is given", () => {
    expect(timeZoneForProperty({ state: "NY" })).toBe("America/New_York");
    expect(timeZoneForProperty({ state: "TX" })).toBe("America/Chicago");
    expect(timeZoneForProperty({ state: "AZ" })).toBe("America/Phoenix");
    expect(timeZoneForProperty({ state: "AK" })).toBe("America/Anchorage");
    expect(timeZoneForProperty({ state: "HI" })).toBe("Pacific/Honolulu");
  });

  it("accepts a lowercase or padded state code", () => {
    expect(timeZoneForProperty({ state: " ny " })).toBe("America/New_York");
  });

  it("falls back to the default zone for an unrecognized state", () => {
    expect(timeZoneForProperty({ state: "ZZ" })).toBe("America/Los_Angeles");
  });

  it("ignores a malformed tz and falls back to the state guess", () => {
    expect(
      timeZoneForProperty({ state: "IL", tz: "Not/AZone" })
    ).toBe("America/Chicago");
  });

  it("ignores a malformed tz with no state to fall back to", () => {
    expect(timeZoneForProperty({ tz: "garbage" })).toBe("America/Los_Angeles");
  });

  it("accepts zip on the input shape without using it to resolve a zone", () => {
    // zip-to-zone isn't wired up here (see the comment on PropertyLocation);
    // this just documents that passing it is harmless and doesn't override
    // a real tz or a state match.
    expect(
      timeZoneForProperty({ zip: "92602", state: "CA" })
    ).toBe("America/Los_Angeles");
  });
});

describe("formatLocalTime", () => {
  it("formats a morning time with no leading zero on the hour", () => {
    // 2026-01-05T15:05:00Z is 7:05 AM in Los Angeles (PST, UTC-8).
    const date = new Date("2026-01-05T15:05:00Z");
    expect(formatLocalTime(date, "America/Los_Angeles")).toBe("7:05 AM");
  });

  it("formats an afternoon time with a two-digit minute", () => {
    // 2026-01-05T23:42:00Z is 3:42 PM in Los Angeles (PST, UTC-8).
    const date = new Date("2026-01-05T23:42:00Z");
    expect(formatLocalTime(date, "America/Los_Angeles")).toBe("3:42 PM");
  });

  it("formats the same instant differently in a different zone", () => {
    // Same instant as above, but 6:42 PM in New York (EST, UTC-5).
    const date = new Date("2026-01-05T23:42:00Z");
    expect(formatLocalTime(date, "America/New_York")).toBe("6:42 PM");
  });

  it("falls back to the default zone when given an invalid zone rather than throwing", () => {
    const date = new Date("2026-01-05T23:42:00Z");
    expect(() => formatLocalTime(date, "Not/AZone")).not.toThrow();
    expect(formatLocalTime(date, "Not/AZone")).toBe(
      formatLocalTime(date, "America/Los_Angeles")
    );
  });

  it("never leaves a narrow no-break space before the meridiem", () => {
    const date = new Date("2026-01-05T23:42:00Z");
    const out = formatLocalTime(date, "America/Los_Angeles");
    expect(out).not.toMatch(/[  ]/);
    expect(out).toBe("3:42 PM");
  });
});
