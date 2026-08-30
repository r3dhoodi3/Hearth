// "Push it out" maintenance steps for the 10-year cost forecast.
//
// WHY THIS EXISTS: the forecast used to be a list of amounts and dates. A
// homeowner reading "roof, 2031, $8,000 - $18,000" has been told what is coming
// and nothing about what to do between now and then, which is the part a paid
// feature actually owes them. This table answers "what one thing delays this
// bill, and by how long".
//
// EVERY NUMBER HERE IS A TYPICAL RANGE, NEVER A QUOTE. The page must render
// these as ranges with the word "typically", because the honest version of this
// advice is "a flush usually runs $100 to $200 and usually buys 2 to 3 years",
// not "$150 buys 2.4 years". A single number would be fake precision on a table
// that is national ballpark data, and the forecast page is already careful
// about that distinction everywhere else (see the "Ballpark from statewide
// price trends" line in forecast/page.tsx).
//
// SOURCE OF THE YEARS: manufacturer maintenance schedules and trade rules of
// thumb (anode rod and flush intervals for tanks, annual HVAC service, roof
// flashing and sealant, gutter/drainage effect on foundations). These are the
// same conventional-wisdom bands the lifespan table in src/lib/health.ts rests
// on, so a step's claimed gain never exceeds a plausible fraction of that
// system's own lifespan.
//
// ONE PLACE TO UPDATE: this file. Bump ACTIONS_AS_OF when any row changes.

import { ALWAYS_SCHEDULE, SYSTEM_SCHEDULE } from "@/lib/maintenancePlan";

// When these rows were last reviewed. Rendered on the page so the advice is
// never undated, and asserted on by the test so a stale table is visible.
export const ACTIONS_AS_OF = "2026-08";

export interface ForecastAction {
  // The one step, phrased as the homeowner would say it out loud.
  step: string;
  // Typical national cost of doing that step once, in today's dollars.
  costLow: number;
  costHigh: number;
  // Typical extra life the step buys, in years, as a range.
  yearsGainedLow: number;
  yearsGainedHigh: number;
  // One line on why it works. Plain, no jargon, no sales voice.
  why: string;
  // The maintenance_tasks title the "Add to my plan" button inserts.
  //
  // When src/lib/maintenancePlan.ts already schedules a task for this system,
  // this is that EXACT title, so adding it here dedupes against a plan the
  // owner already built (generateMaintenancePlanAction skips titles already
  // open, and the add action below does the same check in reverse). A new
  // title is only invented for systems the plan generator has no entry for.
  taskTitle: string;
  // How far out the added reminder lands. Matches the plan generator's own
  // spacing convention: quick checks inside a couple of weeks, bigger jobs a
  // month or two out.
  dueInDays: number;
}

// Keyed by SYSTEM_TYPES values (src/lib/constants.ts). Every one of them has an
// entry: a system the forecast can list is a system this page owes an action
// for, and the test fails if a new system type ever lands without one.
//
// Two notes on the owner's original list:
//   "exterior paint" lives under `siding` - Hearth has no separate paint
//   system, and repainting/resealing IS the step that keeps siding alive.
//   "water softener" has no system type at all, so there is nothing to key it
//   to. If one is ever added to SYSTEM_TYPES, this table must grow a row or
//   the test below will say so.
export const FORECAST_ACTIONS: Record<string, ForecastAction> = {
  water_heater: {
    step: "Flush the tank and have the anode rod checked",
    costLow: 100,
    costHigh: 200,
    yearsGainedLow: 2,
    yearsGainedHigh: 3,
    why: "Sediment on the bottom of the tank makes the burner work harder, and a spent anode rod lets the tank itself start rusting.",
    taskTitle: "Flush the water heater",
    dueInDays: 75,
  },
  hvac: {
    step: "Book a yearly tune-up and keep the filter fresh",
    costLow: 100,
    costHigh: 250,
    yearsGainedLow: 3,
    yearsGainedHigh: 5,
    why: "A dirty coil or low refrigerant makes the compressor run hot, and the compressor is the expensive part that decides when the whole unit is done.",
    taskTitle: "Schedule an HVAC tune-up",
    dueInDays: 60,
  },
  roof: {
    step: "Have the flashing and sealant checked and touched up",
    costLow: 300,
    costHigh: 800,
    yearsGainedLow: 3,
    yearsGainedHigh: 5,
    why: "Most roofs do not fail all over at once. They fail at the edges, valleys and pipe boots first, and those are cheap to fix while they are still small.",
    taskTitle: "Inspect roof and flashing",
    dueInDays: 50,
  },
  plumbing: {
    step: "Have a plumber check the water pressure and fix small leaks",
    costLow: 150,
    costHigh: 400,
    yearsGainedLow: 3,
    yearsGainedHigh: 5,
    why: "High incoming pressure quietly wears out every joint and fixture in the house, and a failed pressure regulator is far cheaper than a repipe.",
    taskTitle: "Check under sinks and around toilets for leaks",
    dueInDays: 20,
  },
  electrical_panel: {
    step: "Have an electrician inspect and re-torque the panel connections",
    costLow: 150,
    costHigh: 350,
    yearsGainedLow: 3,
    yearsGainedHigh: 5,
    why: "Loose lugs and breakers heat up, and heat is what damages the bus bar, which is the part that turns a repair into a full panel replacement.",
    taskTitle: "Test GFCI outlets and breakers",
    dueInDays: 30,
  },
  windows: {
    step: "Re-caulk the exterior and replace worn weatherstripping",
    costLow: 200,
    costHigh: 600,
    yearsGainedLow: 3,
    yearsGainedHigh: 5,
    why: "Water getting past a failed bead of caulk rots the frame and the wall behind it, which is what usually forces the replacement, not the glass.",
    taskTitle: "Check window caulk and weatherstripping",
    dueInDays: 55,
  },
  foundation: {
    step: "Fix the grading and run the downspouts away from the house",
    costLow: 300,
    costHigh: 1200,
    yearsGainedLow: 5,
    yearsGainedHigh: 10,
    why: "Most slab and footing movement is a water problem: soil that swells and shrinks right against the house. Moving the water is the cheap half of the fix.",
    taskTitle: "Walk the foundation and grading for cracks or pooling",
    dueInDays: 65,
  },
  appliance: {
    step: "Clean the dryer vent and the refrigerator coils",
    costLow: 100,
    costHigh: 250,
    yearsGainedLow: 1,
    yearsGainedHigh: 3,
    why: "Both appliances fail early for the same reason: a blocked airflow path makes the motor or compressor run hot for years.",
    taskTitle: "Clean the dryer vent and refrigerator coils",
    dueInDays: 40,
  },
  gutters: {
    step: "Clean and re-seal the gutters twice a year",
    costLow: 150,
    costHigh: 350,
    yearsGainedLow: 5,
    yearsGainedHigh: 10,
    why: "Standing water and debris rot the fascia and pull the hangers loose, which is what ends a gutter run long before the metal wears out.",
    taskTitle: "Clean gutters and downspouts",
    dueInDays: 45,
  },
  siding: {
    step: "Caulk the seams and repaint the trim and sun-facing walls",
    costLow: 400,
    costHigh: 1200,
    yearsGainedLow: 3,
    yearsGainedHigh: 5,
    why: "Paint is the siding's raincoat. Once it cracks at a seam, water gets behind the board and the repair stops being cosmetic.",
    taskTitle: "Caulk siding seams and touch up exterior paint",
    dueInDays: 70,
  },
  garage_door: {
    step: "Have the springs, rollers and opener serviced",
    costLow: 125,
    costHigh: 300,
    yearsGainedLow: 2,
    yearsGainedHigh: 4,
    why: "A door that is out of balance makes the opener carry weight it was never meant to, and the opener burns out years early.",
    taskTitle: "Service the garage door springs and rollers",
    dueInDays: 35,
  },
  deck: {
    step: "Clean and re-seal the boards and check the ledger",
    costLow: 400,
    costHigh: 1000,
    yearsGainedLow: 3,
    yearsGainedHigh: 5,
    why: "Unsealed wood soaks up water, and the joint where the deck meets the house is the first thing to rot and the most dangerous thing to lose.",
    taskTitle: "Clean and reseal the deck",
    dueInDays: 60,
  },
  driveway: {
    step: "Fill the cracks and seal the surface",
    costLow: 250,
    costHigh: 700,
    yearsGainedLow: 3,
    yearsGainedHigh: 5,
    why: "Water in an open crack freezes, spreads, and undermines the base underneath. Once the base is gone the slab has to be replaced, not patched.",
    taskTitle: "Seal driveway cracks",
    dueInDays: 75,
  },
  sump_pump: {
    step: "Test the pump and add or replace the battery backup",
    costLow: 150,
    costHigh: 400,
    yearsGainedLow: 2,
    yearsGainedHigh: 3,
    why: "A sump pump that has not run in months is the one that seizes during the storm, and the flood costs many times the pump.",
    taskTitle: "Test the sump pump and its backup",
    dueInDays: 25,
  },
  sewer_line: {
    step: "Run a camera scope and clear any roots",
    costLow: 250,
    costHigh: 800,
    yearsGainedLow: 3,
    yearsGainedHigh: 5,
    why: "Roots get in at a joint and grow for years. Cutting them early keeps a scheduled cleaning from turning into an emergency dig.",
    taskTitle: "Watch for slow drains, consider a sewer scope",
    dueInDays: 70,
  },
  fence: {
    step: "Reset loose posts and re-seal the wood",
    costLow: 200,
    costHigh: 600,
    yearsGainedLow: 3,
    yearsGainedHigh: 5,
    why: "A fence dies at the ground line where the post meets wet soil. Everything above it is usually still fine.",
    taskTitle: "Reset loose fence posts and reseal the wood",
    dueInDays: 80,
  },
};

// The curated step for one system type, or null when there is no entry (a
// system type added to the database ahead of this table). Null means the page
// simply omits the line, never invents one.
export function forecastActionFor(
  systemType: string | null | undefined
): ForecastAction | null {
  return FORECAST_ACTIONS[systemType ?? ""] ?? null;
}

// Every task title this table can insert, so the reserve/plan code and the
// tests can tell a forecast-added reminder apart from a manual one.
export function forecastActionTitles(): Set<string> {
  return new Set(Object.values(FORECAST_ACTIONS).map((a) => a.taskTitle));
}

// True when the step's taskTitle is one the maintenance plan generator already
// schedules. Used only by the test, which asserts that any system with a plan
// entry reuses one of ITS titles rather than inventing a near-duplicate the
// dedupe check would miss.
export function planSchedulesTitle(title: string): boolean {
  if (ALWAYS_SCHEDULE.some((t) => t.title === title)) return true;
  return Object.values(SYSTEM_SCHEDULE).some((list) =>
    list.some((t) => t.title === title)
  );
}

// ---------------------------------------------------------------------------
// Risk ranking: which systems get the "line up quotes early" card.
// ---------------------------------------------------------------------------

// Systems where waiting does not just cost more, it causes damage while you
// wait: a burst water heater floods a floor, a failed sewer line backs up into
// the house, and a leaking roof ruins everything under it. These get a
// consequence bump so a $2,000 water heater can outrank a $12,000 roof that is
// still years out.
export const HIGH_CONSEQUENCE_SYSTEMS = new Set([
  "water_heater",
  "sewer_line",
  "roof",
]);

// The minimum a system's risk score has to reach before the page offers the
// early-quotes card. Below this the item is simply not urgent enough to be
// worth interrupting the timeline for.
const RISK_FLOOR = 0.5;

// Emergency-replacement premium, as a plain range. Used in the card's copy.
// Contractors charge more for after-hours, same-day, and no-time-to-shop work;
// 20-40% is the conventional band, quoted as a range for that reason.
export const EMERGENCY_PREMIUM_COPY =
  "Emergency replacements typically cost 20-40% more.";

// Anything the ranking needs off a ForecastItem. Kept structural rather than
// importing the Forecast type so this stays testable with plain objects and
// carries no dependency on the forecast math.
export interface RiskCandidate {
  system_type: string;
  age: number | null;
  lifespan: number;
  yearsLeft: number;
  timingEstimated: boolean;
}

// How far through its typical life a system is, 0 to just over 1. Systems with
// no install year fall back to yearsLeft against the lifespan, which is the
// same midpoint placement the forecast already made for them.
export function lifeUsedFraction(item: RiskCandidate): number {
  const lifespan = item.lifespan > 0 ? item.lifespan : 1;
  if (item.age != null) return item.age / lifespan;
  return (lifespan - item.yearsLeft) / lifespan;
}

// Risk score for the early-quotes card: how far through its life the system is,
// plus a fixed bump for the systems whose failure does collateral damage.
// Deliberately simple and readable, because the page has to justify the pick in
// one sentence, and a score nobody can explain is worse than a rough one.
export function riskScore(item: RiskCandidate): number {
  const base = lifeUsedFraction(item);
  return base + (HIGH_CONSEQUENCE_SYSTEMS.has(item.system_type) ? 0.35 : 0);
}

// The two highest-risk systems, worst first.
//
// Guessed timing is excluded for the same reason buildForecast excludes it from
// "start here": telling somebody to go get quotes has to rest on a real install
// year or a real condition signal, not a midpoint placeholder. Ties break on
// yearsLeft (sooner first) so the order is stable rather than dependent on the
// input array.
export function topRiskItems<T extends RiskCandidate>(
  items: T[],
  limit = 2
): T[] {
  return items
    .filter((i) => !i.timingEstimated && riskScore(i) >= RISK_FLOOR)
    .sort((a, b) => {
      const diff = riskScore(b) - riskScore(a);
      if (Math.abs(diff) > 1e-9) return diff;
      return a.yearsLeft - b.yearsLeft;
    })
    .slice(0, limit);
}
