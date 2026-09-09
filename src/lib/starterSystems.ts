// Pure, unit-testable starter-inventory logic for a freshly claimed home.
// claimPropertyAction (src/app/onboarding/actions.ts) calls buildStarterSystems
// right after a new `properties` row is inserted, then stamps property_id onto
// every row this returns and inserts them all into home_systems in one call.
//
// Kept as a pure function (no Supabase client, no formData, no network) on
// purpose: the "which systems does this home get, and what year were they
// probably installed" decisions are exactly the kind of thing that should be
// checked with a plain input -> output test (starterSystems.test.ts), not only
// exercised by driving the whole onboarding flow end to end.
//
// Every row this produces is meant to be inserted with confirmed_at left at
// its column default (null): these are estimates from the build year and
// RentCast's property record, never owner-verified facts. The dashboard and
// Home Profile already treat a null confirmed_at as "this is a guess" - this
// module doesn't touch that contract, it only decides which rows to guess at.
//
// v1 seeded exactly 7 systems ("virtually every home has these"): foundation,
// plumbing, electrical panel, roof, HVAC, water heater, windows. Landen's
// 2026-09-07 feedback was that this stops short of the product's own premise -
// "no roof automatically added, no foundation, everything else" was meant
// literally, and RentCast was already returning exteriorType/pool/garage/
// fireplace facts that the seed threw away. This module is the fix: the same
// 7 core systems, plus everyday household systems every owned home has
// (gutters, siding, smoke/CO detectors, the big kitchen and laundry
// appliances), plus a few extras ONLY when RentCast's record actually flags
// them (a garage door opener only if there's a garage, pool equipment only if
// there's a pool, a fireplace/chimney row only if there's a fireplace,
// irrigation only when the lot size suggests a private yard to water).

import { DEFAULT_LIFESPANS } from "@/lib/health";

// The flag/spec facts this module reads, mirroring HomeSeedFeatures
// (src/lib/parcel.ts) field for field. A separate type rather than importing
// parcel.ts's directly: parcel.ts is "server-only" (it touches the admin
// Supabase client and RENTCAST_API_KEY), and this module needs to stay
// importable from a plain vitest file with no server context at all. Every
// field optional/nullable: a sparse or missing RentCast record still seeds
// every core and household system, just with material_or_model null and every
// flagged extra skipped.
export interface StarterSystemFacts {
  exteriorType?: string | null;
  pool?: boolean | null;
  garage?: boolean | null;
  garageSpaces?: number | null;
  fireplace?: boolean | null;
}

// Pre-derived material/spec text, one entry per system_type RentCast's
// property record can describe in words today (roof, foundation, hvac - see
// deriveSystemFacts in src/lib/parcel.ts). Typed loosely (not
// Record<string, string>) because the values ultimately come from a
// third-party JSON body by the time they reach here; materialText below
// coerces defensively rather than trusting an annotation, the same reasoning
// draft.ts's own systemFacts() parser already uses for the same data.
export type StarterSystemMaterials = Record<string, unknown>;

export interface StarterSystemHomeInput {
  yearBuilt: number | null;
  // Accepted for interface completeness (a home's facts are yearBuilt, sqft,
  // propertyType, lotSizeSqft, and its records-source facts - matching what
  // claimPropertyAction already validates and stores on the properties row)
  // and so a future rule can key off it (e.g. a very large home getting a
  // second HVAC-zone row) without changing this function's signature. Not
  // read by any rule yet.
  sqft: number | null;
  propertyType: string | null;
  lotSizeSqft: number | null;
  materials: StarterSystemMaterials | null;
  facts: StarterSystemFacts | null;
}

export interface StarterSystemSeed {
  system_type: string;
  install_year: number | null;
  expected_lifespan_years: number;
  material_or_model: string | null;
  notes: string | null;
}

// Core 7 - the original starter set: systems virtually every home has,
// seeded unconditionally regardless of what RentCast knows about this
// specific address.
const CORE_SYSTEMS = [
  "foundation",
  "plumbing",
  "electrical_panel",
  "roof",
  "hvac",
  "water_heater",
  "windows",
] as const;

// Household systems: not sourced from a records API (RentCast has no
// plumbing-fixture or appliance-model data), but true of an owned home often
// enough that a blank row an owner can fill in beats no row at all - exactly
// the same reasoning the original 7 already used for plumbing, electrical,
// and windows, none of which RentCast can describe either. Always seeded.
const HOUSEHOLD_SYSTEMS = [
  "gutters",
  "siding",
  "smoke_co_detector",
  "dishwasher",
  "range",
  "refrigerator",
  "washer_dryer",
  "garbage_disposal",
] as const;

// Every system_type buildStarterSystems can produce, core + household +
// flagged. Exported so a caller (or a test) can assert against the full list
// without hand-copying it.
export const STARTER_SYSTEM_TYPES = [
  ...CORE_SYSTEMS,
  ...HOUSEHOLD_SYSTEMS,
  "garage_door",
  "pool",
  "fireplace",
  "irrigation",
] as const;

// Coerces a possibly-untrusted value into a short plain string or null.
// Never trusts a type annotation over a runtime check: by the time a value
// reaches here it started life inside a third-party JSON body, so a number,
// an object, or a page-long string can arrive exactly as that annotation
// promised nothing against. Same 120-char ceiling home_systems.material_or_model
// has always used.
function materialText(value: unknown): string | null {
  return typeof value === "string" && value.trim()
    ? value.trim().slice(0, 120)
    : null;
}

// Estimated install year from the build year and a system's typical
// lifespan: assumes each system was replaced around the end of its typical
// life, so a home age that's an exact multiple of the lifespan reads as "due
// now", not "brand new" - a 75-year-old home does not get a brand-new
// 75-year foundation. Null when the build year itself isn't known.
function estimateInstallYear(
  yearBuilt: number | null,
  lifespan: number
): number | null {
  if (!yearBuilt) return null;
  const currentYear = new Date().getFullYear();
  const age = currentYear - yearBuilt;
  if (age <= 0) return yearBuilt;
  const yearsIntoCycle = age % lifespan || lifespan;
  return currentYear - yearsIntoCycle;
}

function seedRow(
  system_type: string,
  yearBuilt: number | null,
  material: unknown,
  notes: string | null = null
): StarterSystemSeed {
  const lifespan = DEFAULT_LIFESPANS[system_type] ?? 20;
  return {
    system_type,
    install_year: estimateInstallYear(yearBuilt, lifespan),
    expected_lifespan_years: lifespan,
    material_or_model: materialText(material),
    notes,
  };
}

// A condo or a unit in a multi-family building doesn't get a private yard to
// irrigate even on a large parcel - the lot belongs to the building, not to
// any one owner, and the irrigation system (if any) is common-area equipment
// an HOA maintains, not this home's. Everything else counts a lot large
// enough to plausibly carry a lawn or planters worth watering; 1,500 sqft is
// a deliberately low floor (a small Orange County lot minus the house
// footprint) so this only skips homes that are genuinely lot-line-to-lot-line,
// not merely small.
function hasYard(propertyType: string | null, lotSizeSqft: number | null): boolean {
  if (propertyType === "condo" || propertyType === "multi_family") return false;
  return typeof lotSizeSqft === "number" && lotSizeSqft >= 1500;
}

// Builds the full starter inventory for a freshly claimed home: the core 7,
// the always-added household systems, and whichever flagged extras the
// records-source facts actually support. Every row comes back with
// install_year estimated from yearBuilt and its typical lifespan,
// expected_lifespan_years from DEFAULT_LIFESPANS, a material_or_model when
// the facts had one, and a short plain note ONLY where the note explains why
// the row exists at all (a flagged extra) - the core and household rows stay
// note-less, same as v1, since the "these are estimates" notice already lives
// at the top of the Home Profile page rather than repeated on every row.
export function buildStarterSystems(
  input: StarterSystemHomeInput
): StarterSystemSeed[] {
  const { yearBuilt, propertyType, lotSizeSqft } = input;
  const materials = input.materials ?? {};
  const facts = input.facts ?? {};
  const rows: StarterSystemSeed[] = [];

  // --- core 7 -------------------------------------------------------------
  rows.push(seedRow("foundation", yearBuilt, materials.foundation));
  rows.push(seedRow("plumbing", yearBuilt, null));
  rows.push(seedRow("electrical_panel", yearBuilt, null));
  rows.push(seedRow("roof", yearBuilt, materials.roof));
  rows.push(seedRow("hvac", yearBuilt, materials.hvac));
  rows.push(seedRow("water_heater", yearBuilt, null));
  rows.push(seedRow("windows", yearBuilt, null));

  // --- always-added household systems --------------------------------------
  rows.push(seedRow("gutters", yearBuilt, null));
  rows.push(seedRow("siding", yearBuilt, facts.exteriorType));
  rows.push(seedRow("smoke_co_detector", yearBuilt, null));
  rows.push(seedRow("dishwasher", yearBuilt, null));
  rows.push(seedRow("range", yearBuilt, null));
  rows.push(seedRow("refrigerator", yearBuilt, null));
  rows.push(seedRow("washer_dryer", yearBuilt, null));
  rows.push(seedRow("garbage_disposal", yearBuilt, null));

  // --- flagged extras: only when the records source says this home has one -
  if (facts.garage) {
    const note =
      typeof facts.garageSpaces === "number" && facts.garageSpaces > 0
        ? `${facts.garageSpaces}-car garage, from the property record.`
        : "Garage on the property record.";
    rows.push(seedRow("garage_door", yearBuilt, null, note));
  }
  if (facts.pool) {
    rows.push(seedRow("pool", yearBuilt, null, "Pool on the property record."));
  }
  if (facts.fireplace) {
    rows.push(
      seedRow("fireplace", yearBuilt, null, "Fireplace on the property record.")
    );
  }
  if (hasYard(propertyType, lotSizeSqft)) {
    rows.push(
      seedRow(
        "irrigation",
        yearBuilt,
        null,
        "Lot size suggests a yard to water."
      )
    );
  }

  // Water softener is deliberately NOT seeded: RentCast's property-record
  // features have no such flag today (confirmed against the live response
  // shape and RentCast's own docs, 2026-09-07), so there is no fact to gate
  // it on - seeding it unconditionally would make it indistinguishable from
  // the always-added household systems above, which IS meant to say "most
  // homes have one", not "we found one here". water_softener stays a real
  // SYSTEM_TYPES option (src/lib/constants.ts) an owner can add by hand; see
  // the API proposal in reports/seed-expand.md for what a future data source
  // could unlock here.

  return rows;
}
