import { describe, expect, it } from "vitest";
import { SYSTEM_TYPES } from "@/lib/constants";
import { SYSTEM_SCHEDULE } from "@/lib/maintenancePlan";
import {
  FORECAST_ACTIONS,
  ACTIONS_AS_OF,
  forecastActionFor,
  forecastActionTitles,
  planSchedulesTitle,
  topRiskItems,
  riskScore,
  lifeUsedFraction,
  HIGH_CONSEQUENCE_SYSTEMS,
  EMERGENCY_PREMIUM_COPY,
  type RiskCandidate,
} from "@/lib/forecastActions";

// The whole point of this table is that it is curated, so the things worth
// testing are the ones a careless edit breaks silently: a missing system, a
// single number where a range belongs, a step that quietly stops matching the
// maintenance plan's own title (which would let the same reminder be added
// twice), and a stray em dash.
describe("FORECAST_ACTIONS shape", () => {
  it("covers every system type the forecast can list", () => {
    for (const { value } of SYSTEM_TYPES) {
      expect(
        FORECAST_ACTIONS[value],
        `no push-it-out step for system type "${value}"`
      ).toBeDefined();
    }
  });

  it("has no entries for system types that do not exist", () => {
    const known = new Set(SYSTEM_TYPES.map((s) => s.value as string));
    for (const key of Object.keys(FORECAST_ACTIONS)) {
      expect(known.has(key), `"${key}" is not a SYSTEM_TYPES value`).toBe(true);
    }
  });

  it("gives every step a real cost range and a real years-gained range", () => {
    for (const [key, a] of Object.entries(FORECAST_ACTIONS)) {
      expect(a.costLow, key).toBeGreaterThan(0);
      // A range, not a single number dressed up as one. The page prints
      // "typically $X to $Y" and a collapsed range would be fake precision.
      expect(a.costHigh, key).toBeGreaterThan(a.costLow);
      expect(a.yearsGainedLow, key).toBeGreaterThan(0);
      expect(a.yearsGainedHigh, key).toBeGreaterThan(a.yearsGainedLow);
      // Nothing may claim to buy a decade. These are maintenance steps, not
      // replacements, and an unbelievable number discredits the honest ones.
      expect(a.yearsGainedHigh, key).toBeLessThanOrEqual(10);
    }
  });

  it("gives every step plain prose, a title and a due window", () => {
    for (const [key, a] of Object.entries(FORECAST_ACTIONS)) {
      expect(a.step.length, key).toBeGreaterThan(10);
      expect(a.why.length, key).toBeGreaterThan(20);
      expect(a.taskTitle.length, key).toBeGreaterThan(5);
      expect(a.dueInDays, key).toBeGreaterThan(0);
      expect(a.dueInDays, key).toBeLessThanOrEqual(120);
    }
  });

  it("reuses the maintenance plan's own title wherever the plan has one", () => {
    // Why this matters: addForecastStepAction dedupes on title against open
    // maintenance_tasks, and so does generateMaintenancePlanAction. A
    // near-duplicate title ("Flush water heater" vs "Flush the water heater")
    // would let both features schedule the same job twice.
    for (const systemType of Object.keys(SYSTEM_SCHEDULE)) {
      const action = FORECAST_ACTIONS[systemType];
      if (!action) continue;
      expect(
        planSchedulesTitle(action.taskTitle),
        `${systemType} uses "${action.taskTitle}", which the plan generator does not schedule`
      ).toBe(true);
    }
  });

  it("carries no em dashes or en dashes anywhere in its prose", () => {
    for (const [key, a] of Object.entries(FORECAST_ACTIONS)) {
      for (const text of [a.step, a.why, a.taskTitle]) {
        expect(/[–—]/.test(text), `${key}: "${text}"`).toBe(false);
      }
    }
    expect(/[–—]/.test(EMERGENCY_PREMIUM_COPY)).toBe(false);
  });

  it("is dated, so a stale table says so on the page", () => {
    expect(ACTIONS_AS_OF).toMatch(/^\d{4}-\d{2}$/);
  });

  it("returns null rather than a wrong step for an unknown system", () => {
    expect(forecastActionFor("teleporter")).toBeNull();
    expect(forecastActionFor(null)).toBeNull();
    expect(forecastActionFor(undefined)).toBeNull();
    expect(forecastActionFor("water_heater")?.taskTitle).toBe(
      "Flush the water heater"
    );
  });

  it("exposes every title it can insert", () => {
    const titles = forecastActionTitles();
    expect(titles.size).toBe(Object.keys(FORECAST_ACTIONS).length);
    expect(titles.has("Flush the water heater")).toBe(true);
  });
});

function candidate(over: Partial<RiskCandidate> = {}): RiskCandidate {
  return {
    system_type: "windows",
    age: 5,
    lifespan: 25,
    yearsLeft: 20,
    timingEstimated: false,
    ...over,
  };
}

describe("risk ranking", () => {
  it("measures how far through its life a system is", () => {
    expect(lifeUsedFraction(candidate({ age: 10, lifespan: 20 }))).toBeCloseTo(0.5);
    // No install year: fall back to the yearsLeft the forecast already placed.
    expect(
      lifeUsedFraction(candidate({ age: null, lifespan: 20, yearsLeft: 5 }))
    ).toBeCloseTo(0.75);
  });

  it("bumps the systems whose failure does damage while you wait", () => {
    const plain = candidate({ system_type: "windows", age: 10, lifespan: 20 });
    const nasty = candidate({ system_type: "water_heater", age: 10, lifespan: 20 });
    expect(riskScore(nasty)).toBeGreaterThan(riskScore(plain));
    for (const t of ["water_heater", "sewer_line", "roof"]) {
      expect(HIGH_CONSEQUENCE_SYSTEMS.has(t)).toBe(true);
    }
  });

  it("picks the two worst, worst first", () => {
    const items = [
      candidate({ system_type: "fence", age: 2, lifespan: 18, yearsLeft: 16 }),
      candidate({ system_type: "roof", age: 20, lifespan: 22, yearsLeft: 2 }),
      candidate({ system_type: "hvac", age: 16, lifespan: 18, yearsLeft: 2 }),
    ];
    const top = topRiskItems(items);
    expect(top.map((i) => i.system_type)).toEqual(["roof", "hvac"]);
  });

  it("lets a cheap high-consequence system outrank an older harmless one", () => {
    const items = [
      // 60% through life, but a failure floods the room it is in.
      candidate({ system_type: "water_heater", age: 7, lifespan: 11, yearsLeft: 4 }),
      // 80% through life, and a failure is an inconvenience.
      candidate({ system_type: "fence", age: 15, lifespan: 18, yearsLeft: 3 }),
    ];
    expect(topRiskItems(items, 1).map((i) => i.system_type)).toEqual([
      "water_heater",
    ]);
  });

  it("never tells anybody to act on guessed timing", () => {
    const items = [
      candidate({
        system_type: "roof",
        age: null,
        lifespan: 22,
        yearsLeft: 11,
        timingEstimated: true,
      }),
    ];
    expect(topRiskItems(items)).toEqual([]);
  });

  it("skips systems that are simply not urgent yet", () => {
    const items = [
      candidate({ system_type: "deck", age: 1, lifespan: 20, yearsLeft: 19 }),
    ];
    expect(topRiskItems(items)).toEqual([]);
  });

  it("breaks ties on how soon the system is due, so the order is stable", () => {
    const a = candidate({ system_type: "siding", age: 15, lifespan: 30, yearsLeft: 15 });
    const b = candidate({ system_type: "driveway", age: 15, lifespan: 30, yearsLeft: 4 });
    expect(topRiskItems([a, b]).map((i) => i.system_type)).toEqual([
      "driveway",
      "siding",
    ]);
    expect(topRiskItems([b, a]).map((i) => i.system_type)).toEqual([
      "driveway",
      "siding",
    ]);
  });
});
