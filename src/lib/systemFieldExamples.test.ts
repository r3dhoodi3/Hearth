import { describe, expect, it } from "vitest";
import {
  SYSTEM_FIELD_EXAMPLES,
  SYSTEM_TYPES,
  systemFieldExample,
} from "./constants";

// The walkthrough's manual-entry step showed the same water-heater example on
// every system's Brand and Model boxes, so an owner standing at their roof was
// told to type "Rheem" and "XE50T10H45U0". These tests are the guard against
// that coming back: every system type needs its OWN example, or none at all.

describe("SYSTEM_FIELD_EXAMPLES", () => {
  it("covers every system type the app can show a card for", () => {
    const missing = SYSTEM_TYPES.filter(
      (t) => !(t.value in SYSTEM_FIELD_EXAMPLES)
    ).map((t) => t.value);
    expect(missing).toEqual([]);
  });

  it("never reuses the water heater's example on another system", () => {
    const wrong = Object.entries(SYSTEM_FIELD_EXAMPLES)
      .filter(
        ([type, ex]) =>
          type !== "water_heater" &&
          (ex.brand === "Rheem" || ex.model === "XE50T10H45U0")
      )
      .map(([type]) => type);
    expect(wrong).toEqual([]);
  });

  it("gives each system that has a model number a distinct one", () => {
    const models = Object.values(SYSTEM_FIELD_EXAMPLES)
      .map((e) => e.model)
      .filter(Boolean);
    expect(new Set(models).size).toBe(models.length);
  });

  it("leaves both fields blank for a system with no brand or model", () => {
    // A foundation has no plate to read and no manufacturer to name; the card
    // renders "Not applicable" off this rather than inventing an example.
    expect(systemFieldExample("foundation")).toEqual({ brand: "", model: "" });
  });

  it("falls back to no example at all for an unknown type", () => {
    // Never to another system's example: that IS the bug.
    expect(systemFieldExample("something_new")).toEqual({
      brand: "",
      model: "",
    });
    expect(systemFieldExample(null)).toEqual({ brand: "", model: "" });
    expect(systemFieldExample(undefined)).toEqual({ brand: "", model: "" });
  });

  it("keeps the examples the walkthrough is written around", () => {
    expect(systemFieldExample("hvac")).toEqual({
      brand: "Carrier",
      model: "24ACC636",
    });
    expect(systemFieldExample("roof")).toEqual({
      brand: "Owens Corning",
      model: "Duration",
    });
    expect(systemFieldExample("electrical_panel").brand).toBe("Square D");
    expect(systemFieldExample("garage_door").brand).toBe("LiftMaster");
    expect(systemFieldExample("appliance").model).toBe("SHPM65Z55N");
  });
});
