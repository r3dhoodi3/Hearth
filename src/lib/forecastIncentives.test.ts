import { describe, expect, it } from "vitest";
import { SYSTEM_TYPES } from "@/lib/constants";
import {
  FORECAST_INCENTIVES,
  INCENTIVES_AS_OF,
  INCENTIVE_CAVEAT,
  incentivesForSystem,
  bestIncentiveAmount,
  hasLiveProgram,
} from "@/lib/forecastIncentives";

// This table is the one place in the app that prints a dollar figure somebody
// might not get. The tests exist to hold the two rules that keep it honest: an
// amount only ever appears on a program we believe is still running, and an
// ended program never contributes a number to the "up to $X back" headline.
describe("FORECAST_INCENTIVES shape", () => {
  it("has a stable key, a label and at least one program per entry", () => {
    const keys = new Set<string>();
    for (const inc of FORECAST_INCENTIVES) {
      expect(inc.key).toMatch(/^[a-z0-9_]+$/);
      expect(keys.has(inc.key), `duplicate key "${inc.key}"`).toBe(false);
      keys.add(inc.key);
      expect(inc.label.length).toBeGreaterThan(5);
      expect(inc.programs.length).toBeGreaterThan(0);
    }
  });

  it("only points at system types that actually exist", () => {
    const known = new Set(SYSTEM_TYPES.map((s) => s.value as string));
    for (const inc of FORECAST_INCENTIVES) {
      expect(inc.systemTypes.length).toBeGreaterThan(0);
      for (const t of inc.systemTypes) {
        expect(known.has(t), `${inc.key} points at unknown system "${t}"`).toBe(
          true
        );
      }
    }
  });

  it("gives every program a name, a note and a real https link", () => {
    for (const inc of FORECAST_INCENTIVES) {
      for (const p of inc.programs) {
        expect(p.name.length, inc.key).toBeGreaterThan(3);
        expect(p.note.length, `${inc.key}/${p.name}`).toBeGreaterThan(20);
        expect(p.url, `${inc.key}/${p.name}`).toMatch(/^https:\/\//);
      }
    }
  });

  it("never attaches an amount to a program that has ended", () => {
    // An ended credit's old cap is history, not money anyone can still get.
    // Printing it as "up to $X" would have somebody budget around a credit
    // that no longer exists, which is the exact failure this table is built to
    // avoid.
    for (const inc of FORECAST_INCENTIVES) {
      for (const p of inc.programs) {
        if (p.status === "ended") {
          expect(p.maxAmount, `${inc.key}/${p.name}`).toBeNull();
        }
      }
    }
  });

  it("says when a federal credit ended rather than dropping it silently", () => {
    const ended = FORECAST_INCENTIVES.flatMap((i) =>
      i.programs.filter((p) => p.status === "ended")
    );
    expect(ended.length).toBeGreaterThan(0);
    for (const p of ended) {
      // The note has to name the cutoff, or "ended" is an unanswerable claim.
      expect(p.note, p.name).toMatch(/2025/);
    }
  });

  it("keeps every printed amount a plausible whole-dollar cap", () => {
    for (const inc of FORECAST_INCENTIVES) {
      for (const p of inc.programs) {
        if (p.maxAmount == null) continue;
        expect(Number.isInteger(p.maxAmount), `${inc.key}/${p.name}`).toBe(true);
        expect(p.maxAmount, `${inc.key}/${p.name}`).toBeGreaterThan(0);
        expect(p.maxAmount, `${inc.key}/${p.name}`).toBeLessThanOrEqual(50000);
      }
    }
  });

  it("carries an as-of date and the eligibility caveat", () => {
    expect(INCENTIVES_AS_OF).toMatch(/^\d{4}-\d{2}$/);
    expect(INCENTIVE_CAVEAT.length).toBeGreaterThan(40);
    expect(/vary/i.test(INCENTIVE_CAVEAT)).toBe(true);
  });

  it("carries no em dashes or en dashes anywhere in its prose", () => {
    for (const inc of FORECAST_INCENTIVES) {
      expect(/[–—]/.test(inc.label), inc.key).toBe(false);
      for (const p of inc.programs) {
        expect(/[–—]/.test(p.name), `${inc.key}/${p.name}`).toBe(false);
        expect(/[–—]/.test(p.note), `${inc.key}/${p.name}`).toBe(false);
      }
    }
    expect(/[–—]/.test(INCENTIVE_CAVEAT)).toBe(false);
  });
});

describe("incentive lookups", () => {
  it("finds the entries for a system and nothing for one with none", () => {
    expect(incentivesForSystem("hvac").map((i) => i.key)).toContain(
      "heat_pump_hvac"
    );
    expect(incentivesForSystem("water_heater").map((i) => i.key)).toContain(
      "heat_pump_water_heater"
    );
    expect(incentivesForSystem("fence")).toEqual([]);
    expect(incentivesForSystem(null)).toEqual([]);
    expect(incentivesForSystem(undefined)).toEqual([]);
  });

  it("takes the best live amount and ignores ended programs", () => {
    const hvac = incentivesForSystem("hvac")[0];
    expect(bestIncentiveAmount(hvac)).toBe(8000);
    expect(hasLiveProgram(hvac)).toBe(true);
  });

  it("returns null rather than guessing when no live program has an amount", () => {
    const windows = incentivesForSystem("windows")[0];
    expect(bestIncentiveAmount(windows)).toBeNull();
    // Still worth showing: the page renders the program name and link with no
    // dollar figure instead of inventing one.
    expect(hasLiveProgram(windows)).toBe(true);
  });
});
