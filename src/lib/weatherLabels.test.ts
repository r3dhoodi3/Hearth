import { describe, expect, it } from "vitest";
import { conditionFor, dayLabel, weekdayShort } from "./weatherLabels";

describe("conditionFor", () => {
  it("says Sunny with a sun only in daylight", () => {
    for (const code of [0, 1]) {
      expect(conditionFor(code, true)).toEqual({ key: "sun", word: "Sunny" });
    }
  });

  // The bug this module exists for: WMO 0/1 is "clear sky", which the strip
  // used to render as a sun and the word "Sunny" at midnight.
  it("says Clear with a moon at night", () => {
    for (const code of [0, 1]) {
      expect(conditionFor(code, false)).toEqual({ key: "moon", word: "Clear" });
    }
  });

  it("keeps the partly-cloudy wording at night but swaps sun for moon", () => {
    expect(conditionFor(2, true)).toEqual({
      key: "cloudSun",
      word: "Partly cloudy",
    });
    expect(conditionFor(2, false)).toEqual({
      key: "cloudMoon",
      word: "Partly cloudy",
    });
  });

  it("ignores day/night for everything overcast or worse", () => {
    for (const code of [3, 45, 48, 55, 63, 73, 81, 86, 95, 99]) {
      expect(conditionFor(code, false)).toEqual(conditionFor(code, true));
    }
  });

  it("maps the remaining buckets", () => {
    expect(conditionFor(3, true)).toEqual({ key: "cloud", word: "Cloudy" });
    expect(conditionFor(45, true)).toEqual({ key: "fog", word: "Foggy" });
    expect(conditionFor(53, true)).toEqual({ key: "drizzle", word: "Drizzle" });
    expect(conditionFor(65, true)).toEqual({ key: "rain", word: "Rain" });
    expect(conditionFor(73, true)).toEqual({ key: "snow", word: "Snow" });
    expect(conditionFor(81, true)).toEqual({ key: "rain", word: "Showers" });
    expect(conditionFor(86, true)).toEqual({ key: "snow", word: "Snow" });
    expect(conditionFor(95, true)).toEqual({ key: "storm", word: "Storms" });
  });

  it("falls back to cloudy on an unknown code", () => {
    expect(conditionFor(7, true)).toEqual({ key: "cloud", word: "Cloudy" });
    expect(conditionFor(-1, true)).toEqual({ key: "cloud", word: "Cloudy" });
  });
});

describe("weekdayShort", () => {
  it("reads the date string as a plain calendar date, not an instant", () => {
    // 2026-08-23 is a Sunday. Parsed as an instant it would be UTC midnight,
    // which is Saturday evening anywhere west of UTC - the shift this guards.
    expect(weekdayShort("2026-08-23")).toBe("Sun");
    expect(weekdayShort("2026-08-21")).toBe("Fri");
    expect(weekdayShort("2026-01-01")).toBe("Thu");
    expect(weekdayShort("2026-12-31")).toBe("Thu");
  });

  it("returns an empty string on a malformed date", () => {
    expect(weekdayShort("")).toBe("");
    expect(weekdayShort("8/23/2026")).toBe("");
    expect(weekdayShort("2026-08-23T00:00")).toBe("");
  });
});

describe("dayLabel", () => {
  const WEEK = [
    "2026-08-21",
    "2026-08-22",
    "2026-08-23",
    "2026-08-24",
    "2026-08-25",
    "2026-08-26",
    "2026-08-27",
  ];

  it("names Today and Tomorrow by DATE, not by row position", () => {
    expect(dayLabel("2026-08-21", "2026-08-21")).toBe("Today");
    expect(dayLabel("2026-08-22", "2026-08-21")).toBe("Tomorrow");
    expect(dayLabel("2026-08-23", "2026-08-21")).toBe("Sun");
  });

  it("labels a full week against the home's own today", () => {
    expect(WEEK.map((d) => dayLabel(d, "2026-08-21"))).toEqual([
      "Today",
      "Tomorrow",
      "Sun",
      "Mon",
      "Tue",
      "Wed",
      "Thu",
    ]);
  });

  // The bug this signature exists for: the panel used to call row 0 "Today"
  // no matter what date it held. A payload cached across midnight, or a
  // dropped row, shifted every row up and the strip then announced tomorrow's
  // forecast as today's.
  it("does not call row 0 Today when row 0 is yesterday's date", () => {
    expect(dayLabel("2026-08-21", "2026-08-22")).toBe("Fri");
    expect(WEEK.map((d) => dayLabel(d, "2026-08-22"))).toEqual([
      "Fri",
      "Today",
      "Tomorrow",
      "Mon",
      "Tue",
      "Wed",
      "Thu",
    ]);
  });

  it("crosses a month and a year boundary", () => {
    expect(dayLabel("2026-09-01", "2026-08-31")).toBe("Tomorrow");
    expect(dayLabel("2027-01-01", "2026-12-31")).toBe("Tomorrow");
  });

  // A payload cached before `today` existed carries no date to compare
  // against. A real weekday is always true; a guessed "Today" is not.
  it("falls back to weekday names with no today given", () => {
    expect(dayLabel("2026-08-21")).toBe("Fri");
    expect(dayLabel("2026-08-21", null)).toBe("Fri");
    expect(dayLabel("2026-08-21", "")).toBe("Fri");
    expect(dayLabel("2026-08-21", "not-a-date")).toBe("Fri");
  });
});
