import { describe, it, expect } from "vitest";
import {
  buildStarterSystems,
  STARTER_SYSTEM_TYPES,
  type StarterSystemHomeInput,
} from "./starterSystems";
import { DEFAULT_LIFESPANS } from "./health";

// Mirrors buildStarterSystems' own estimateInstallYear exactly, so these
// tests catch a regression in the FORMULA (not just in "did a row appear"),
// the same way the codebase's other pure-logic tests duplicate the math they
// are checking rather than importing it.
function expectedInstallYear(yearBuilt: number, lifespan: number): number {
  const currentYear = new Date().getFullYear();
  const age = currentYear - yearBuilt;
  if (age <= 0) return yearBuilt;
  const yearsIntoCycle = age % lifespan || lifespan;
  return currentYear - yearsIntoCycle;
}

function baseInput(over: Partial<StarterSystemHomeInput> = {}): StarterSystemHomeInput {
  return {
    yearBuilt: null,
    sqft: null,
    propertyType: null,
    lotSizeSqft: null,
    materials: null,
    facts: null,
    ...over,
  };
}

function row(rows: ReturnType<typeof buildStarterSystems>, type: string) {
  return rows.find((r) => r.system_type === type);
}

describe("STARTER_SYSTEM_TYPES / DEFAULT_LIFESPANS", () => {
  it("gives every starter system a real lifespan (not the bare 20 fallback)", () => {
    // A missing entry here doesn't break anything at runtime (seedRow falls
    // back to 20), but it does mean the row is seeded with a guessed
    // lifespan no one chose on purpose - this is the guard against silently
    // forgetting one when a new starter type is added.
    const missing = STARTER_SYSTEM_TYPES.filter((t) => !(t in DEFAULT_LIFESPANS));
    expect(missing).toEqual([]);
  });
});

describe("buildStarterSystems: 1965 single-family with a pool and a garage", () => {
  const input = baseInput({
    yearBuilt: 1965,
    sqft: 1800,
    propertyType: "single_family",
    lotSizeSqft: 6000,
    materials: {
      foundation: "Slab",
      roof: "Composition shingle",
      hvac: "Forced air heat, Central A/C",
    },
    facts: {
      exteriorType: "Stucco",
      pool: true,
      garage: true,
      garageSpaces: 2,
      fireplace: false,
    },
  });
  const rows = buildStarterSystems(input);

  it("seeds the core 7 with their real materials, no notes", () => {
    expect(row(rows, "foundation")).toMatchObject({
      material_or_model: "Slab",
      expected_lifespan_years: DEFAULT_LIFESPANS.foundation,
      install_year: expectedInstallYear(1965, DEFAULT_LIFESPANS.foundation),
      notes: null,
    });
    expect(row(rows, "roof")).toMatchObject({
      material_or_model: "Composition shingle",
      install_year: expectedInstallYear(1965, DEFAULT_LIFESPANS.roof),
    });
    expect(row(rows, "hvac")).toMatchObject({
      material_or_model: "Forced air heat, Central A/C",
      install_year: expectedInstallYear(1965, DEFAULT_LIFESPANS.hvac),
    });
    for (const t of ["plumbing", "electrical_panel", "water_heater", "windows"]) {
      expect(row(rows, t)).toMatchObject({ material_or_model: null, notes: null });
    }
  });

  it("always adds the household systems, siding carrying the exterior type", () => {
    expect(row(rows, "siding")).toMatchObject({ material_or_model: "Stucco" });
    for (const t of [
      "gutters",
      "smoke_co_detector",
      "dishwasher",
      "range",
      "refrigerator",
      "washer_dryer",
      "garbage_disposal",
    ]) {
      expect(row(rows, t), t).toBeTruthy();
    }
  });

  it("adds the garage door with a spaces-aware note, since garage=true", () => {
    expect(row(rows, "garage_door")).toMatchObject({
      notes: "2-car garage, from the property record.",
    });
  });

  it("adds pool equipment, since pool=true", () => {
    expect(row(rows, "pool")).toMatchObject({
      notes: "Pool on the property record.",
    });
  });

  it("does not add a fireplace row, since fireplace=false", () => {
    expect(row(rows, "fireplace")).toBeUndefined();
  });

  it("adds irrigation: single-family with a 6,000 sqft lot reads as a yard", () => {
    expect(row(rows, "irrigation")).toMatchObject({
      notes: "Lot size suggests a yard to water.",
    });
  });

  it("never adds a water softener: no fact to gate it on", () => {
    expect(row(rows, "water_softener")).toBeUndefined();
  });

  it("seeds exactly the core 7 + 8 household + garage door + pool + irrigation", () => {
    expect(rows).toHaveLength(7 + 8 + 3);
  });
});

describe("buildStarterSystems: 2019 condo with none of the flagged extras", () => {
  const input = baseInput({
    yearBuilt: 2019,
    sqft: 950,
    propertyType: "condo",
    // Condos often carry a building-level lot size, not a private one - set
    // deliberately large to prove the condo gate wins over a large number.
    lotSizeSqft: 40000,
    materials: {},
    facts: { exteriorType: null, pool: false, garage: false, fireplace: false },
  });
  const rows = buildStarterSystems(input);

  it("still seeds the core 7 and the household systems", () => {
    expect(rows).toHaveLength(7 + 8);
  });

  it("skips garage door, pool, and fireplace: every flag is false", () => {
    expect(row(rows, "garage_door")).toBeUndefined();
    expect(row(rows, "pool")).toBeUndefined();
    expect(row(rows, "fireplace")).toBeUndefined();
  });

  it("skips irrigation even with a large lot size, because it's a condo", () => {
    expect(row(rows, "irrigation")).toBeUndefined();
  });

  it("estimates a recent build's systems as installed at construction", () => {
    // 2019 is recent enough that most lifespans haven't completed a full
    // cycle yet, so install_year should equal yearBuilt for the short-lived
    // household systems.
    expect(row(rows, "dishwasher")?.install_year).toBe(
      expectedInstallYear(2019, DEFAULT_LIFESPANS.dishwasher)
    );
  });
});

describe("buildStarterSystems: missing facts entirely", () => {
  const rows = buildStarterSystems(baseInput());

  it("still seeds the core 7 and household systems, nothing flagged", () => {
    expect(rows).toHaveLength(7 + 8);
  });

  it("every install_year is null when yearBuilt is unknown", () => {
    expect(rows.every((r) => r.install_year === null)).toBe(true);
  });

  it("every material_or_model is null with no materials/facts to draw on", () => {
    expect(rows.every((r) => r.material_or_model === null)).toBe(true);
  });

  it("still carries the right expected_lifespan_years per type", () => {
    expect(row(rows, "roof")?.expected_lifespan_years).toBe(DEFAULT_LIFESPANS.roof);
    expect(row(rows, "dishwasher")?.expected_lifespan_years).toBe(
      DEFAULT_LIFESPANS.dishwasher
    );
  });
});

describe("buildStarterSystems: untrusted material values", () => {
  it("coerces a non-string material to null instead of trusting the type annotation", () => {
    const rows = buildStarterSystems(
      baseInput({
        yearBuilt: 1990,
        materials: { roof: 12345 as unknown as string, foundation: { bad: true } as unknown as string },
      })
    );
    expect(row(rows, "roof")?.material_or_model).toBeNull();
    expect(row(rows, "foundation")?.material_or_model).toBeNull();
  });

  it("truncates an overlong material to 120 characters", () => {
    const long = "x".repeat(500);
    const rows = buildStarterSystems(baseInput({ materials: { roof: long } }));
    expect(row(rows, "roof")?.material_or_model).toHaveLength(120);
  });
});

describe("buildStarterSystems: garage without a known space count", () => {
  it("still adds the garage door, with a generic note", () => {
    const rows = buildStarterSystems(
      baseInput({ facts: { garage: true, garageSpaces: null } })
    );
    expect(row(rows, "garage_door")).toMatchObject({
      notes: "Garage on the property record.",
    });
  });
});
