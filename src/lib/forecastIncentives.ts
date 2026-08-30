// Rebates and credits shown next to the replacements on the cost forecast.
//
// THE ONE PLACE TO UPDATE. Every amount, caveat, link and expiry for this
// feature lives in this file. Nothing anywhere else hardcodes a rebate number.
// When any row changes, bump INCENTIVES_AS_OF in the same edit: the page prints
// that date, so a table nobody has touched in a year says so out loud.
//
// THE RULE THIS TABLE FOLLOWS: an amount only appears when it comes from a
// statute or a published program cap we can point at. Where the real number
// depends on the territory, the measure, the household income, or how much
// funding is left this quarter, the row carries `maxAmount: null` and the page
// shows the program name and a link with NO dollar figure. A made-up "up to
// $X" is worse than no number at all, because the homeowner budgets around it.
//
// WHAT CHANGED FOR 2026, AND WHY MOST FEDERAL ROWS SAY "ended":
// The One Big Beautiful Bill Act (Public Law 119-21, July 2025) terminated both
// residential energy tax credits early:
//   - Section 25C, the Energy Efficient Home Improvement Credit, does not apply
//     to property placed in service after December 31, 2025.
//   - Section 25D, the Residential Clean Energy Credit, does not apply to
//     expenditures made after December 31, 2025.
// Both had been scheduled to run to 2032/2034 before that. A homeowner planning
// a 2029 heat pump around "the 30% federal credit" is planning around something
// that no longer exists, so the expired rows stay in the table on purpose: the
// page names them as ended rather than quietly dropping them, which is the
// difference between an honest table and a silently wrong one.
//
// The rebate programs funded by the Inflation Reduction Act (the Home
// Electrification and Appliance Rebates, "HEAR") are grants to states, not tax
// credits, and were not terminated by that act. They are administered state by
// state, they are income-qualified, and any given state's program can be
// paused, waitlisted, or out of money. So their statutory per-measure caps are
// listed as "up to" with both caveats attached, never as a promise.

export const INCENTIVES_AS_OF = "2026-08";

// Shown under every incentive line on the page. One sentence, because the
// caveat has to be read, and a paragraph of fine print does not get read.
export const INCENTIVE_CAVEAT =
  "Eligibility, funding and amounts vary by household and utility. Check the program before you count on it.";

export type IncentiveLevel = "federal" | "state" | "utility";

// "check" means the program is believed to be running and worth checking.
// "ended" means it existed and is gone, and the page says so rather than
// leaving a homeowner to plan around it.
export type IncentiveStatus = "check" | "ended";

export interface IncentiveProgram {
  name: string;
  level: IncentiveLevel;
  status: IncentiveStatus;
  // The cap we are confident enough to print, in whole dollars. Null when the
  // real number depends on territory, measure, income or remaining funding: the
  // page then renders the name and link with no amount.
  maxAmount: number | null;
  // One plain line: what it covers and what the catch is.
  note: string;
  url: string;
}

export interface ForecastIncentive {
  // Stable id. Also the only thing the analytics event carries, so the payload
  // stays ids and enums (docs/ANALYTICS.md).
  key: string;
  label: string;
  // Which forecast system types this shows under. A system may appear in more
  // than one entry; the page renders each one as its own line.
  systemTypes: string[];
  programs: IncentiveProgram[];
}

export const FORECAST_INCENTIVES: ForecastIncentive[] = [
  {
    key: "heat_pump_hvac",
    label: "Heat pump instead of a like-for-like furnace or AC",
    systemTypes: ["hvac"],
    programs: [
      {
        name: "Federal 25C credit",
        level: "federal",
        status: "ended",
        maxAmount: null,
        note: "Was 30% of cost, up to $2,000 a year for a heat pump. Ended for work placed in service after December 31, 2025.",
        url: "https://www.irs.gov/credits-deductions/energy-efficient-home-improvement-credit",
      },
      {
        name: "Home Electrification and Appliance Rebates",
        level: "state",
        status: "check",
        // IRA section 50122 statutory cap for a heat pump for space heating
        // and cooling. Income-qualified and state-administered, both said out
        // loud in the note.
        maxAmount: 8000,
        note: "Federally funded, run by California. Income-qualified, and states pause or waitlist it when funding runs low.",
        url: "https://www.energy.ca.gov/programs-and-topics/programs/home-electrification-and-appliance-rebates-program",
      },
      {
        name: "TECH Clean California",
        level: "state",
        status: "check",
        maxAmount: null,
        note: "Heat pump incentives that change by contractor, territory and equipment, so check the current amount rather than a number quoted here.",
        url: "https://techcleanca.com/",
      },
      {
        name: "Your utility (SCE, SoCalGas)",
        level: "utility",
        status: "check",
        maxAmount: null,
        note: "Southern California Edison and SoCalGas run their own equipment rebates on their own schedules.",
        url: "https://www.energystar.gov/rebate-finder",
      },
    ],
  },
  {
    key: "heat_pump_water_heater",
    label: "Heat pump water heater instead of a standard tank",
    systemTypes: ["water_heater"],
    programs: [
      {
        name: "Federal 25C credit",
        level: "federal",
        status: "ended",
        maxAmount: null,
        note: "Was 30% of cost, inside the same $2,000 a year heat pump cap. Ended for work placed in service after December 31, 2025.",
        url: "https://www.irs.gov/credits-deductions/energy-efficient-home-improvement-credit",
      },
      {
        name: "Home Electrification and Appliance Rebates",
        level: "state",
        status: "check",
        // IRA section 50122 statutory cap for a heat pump water heater.
        maxAmount: 1750,
        note: "Federally funded, run by California. Income-qualified, and states pause or waitlist it when funding runs low.",
        url: "https://www.energy.ca.gov/programs-and-topics/programs/home-electrification-and-appliance-rebates-program",
      },
      {
        name: "TECH Clean California",
        level: "state",
        status: "check",
        maxAmount: null,
        note: "Water heater incentives vary by contractor and territory, so check the current amount rather than a number quoted here.",
        url: "https://techcleanca.com/",
      },
    ],
  },
  {
    key: "electrical_panel_upgrade",
    label: "Panel upgrade, often needed before anything else gets electrified",
    systemTypes: ["electrical_panel"],
    programs: [
      {
        name: "Federal 25C credit",
        level: "federal",
        status: "ended",
        maxAmount: null,
        note: "Was 30% of cost, up to $600, and only when the panel was upgraded to support another qualifying improvement. Ended after December 31, 2025.",
        url: "https://www.irs.gov/credits-deductions/energy-efficient-home-improvement-credit",
      },
      {
        name: "Home Electrification and Appliance Rebates",
        level: "state",
        status: "check",
        // IRA section 50122 statutory cap for an electric load service center.
        maxAmount: 4000,
        note: "Federally funded, run by California. Income-qualified, and usually has to be paired with an electrification project.",
        url: "https://www.energy.ca.gov/programs-and-topics/programs/home-electrification-and-appliance-rebates-program",
      },
    ],
  },
  {
    key: "insulation_air_sealing",
    label: "Insulation and air sealing while the walls are open",
    // Under siding: the one time insulation and air sealing are cheap is when
    // the exterior is already off, so this belongs next to that replacement.
    systemTypes: ["siding"],
    programs: [
      {
        name: "Federal 25C credit",
        level: "federal",
        status: "ended",
        maxAmount: null,
        note: "Was 30% of cost, inside a $1,200 a year cap for envelope work. Ended for work placed in service after December 31, 2025.",
        url: "https://www.irs.gov/credits-deductions/energy-efficient-home-improvement-credit",
      },
      {
        name: "Home Electrification and Appliance Rebates",
        level: "state",
        status: "check",
        // IRA section 50122 statutory cap for insulation, air sealing and
        // ventilation taken together.
        maxAmount: 1600,
        note: "Federally funded, run by California, covering insulation, air sealing and ventilation together. Income-qualified.",
        url: "https://www.energy.ca.gov/programs-and-topics/programs/home-electrification-and-appliance-rebates-program",
      },
      {
        name: "Your utility (SCE, SoCalGas)",
        level: "utility",
        status: "check",
        maxAmount: null,
        note: "Envelope rebates come and go by territory and season. The rebate finder lists what is live at your address today.",
        url: "https://www.energystar.gov/rebate-finder",
      },
    ],
  },
  {
    key: "windows_doors",
    label: "Efficient windows and exterior doors",
    systemTypes: ["windows"],
    programs: [
      {
        name: "Federal 25C credit",
        level: "federal",
        status: "ended",
        maxAmount: null,
        note: "Was 30% of cost, up to $600 a year for windows and $500 for doors. Ended for work placed in service after December 31, 2025.",
        url: "https://www.irs.gov/credits-deductions/energy-efficient-home-improvement-credit",
      },
      {
        name: "State and utility programs",
        level: "state",
        status: "check",
        maxAmount: null,
        note: "Window rebates are local and change often. DSIRE lists every program running at your address.",
        url: "https://www.dsireusa.org/",
      },
    ],
  },
  {
    key: "solar_and_storage",
    label: "Solar or battery storage, if you are already reroofing",
    // Under roof on purpose: a reroof is the cheapest moment in a decade to
    // add or re-mount solar, and it is the one time the decision is in front of
    // the homeowner anyway.
    systemTypes: ["roof"],
    programs: [
      {
        name: "Federal 25D credit",
        level: "federal",
        status: "ended",
        maxAmount: null,
        note: "Was 30% of cost with no cap, for solar, batteries and geothermal. Ended for spending after December 31, 2025.",
        url: "https://www.irs.gov/credits-deductions/residential-clean-energy-credit",
      },
      {
        name: "Self-Generation Incentive Program",
        level: "state",
        status: "check",
        maxAmount: null,
        note: "California battery storage incentives, paid per kilowatt-hour and tiered by household and location, so there is no single number to quote.",
        url: "https://www.selfgenca.com/",
      },
      {
        name: "State and utility programs",
        level: "state",
        status: "check",
        maxAmount: null,
        note: "DSIRE lists every solar and storage program running at your address.",
        url: "https://www.dsireusa.org/",
      },
    ],
  },
];

// Every incentive entry that should render under one forecast system.
export function incentivesForSystem(
  systemType: string | null | undefined
): ForecastIncentive[] {
  if (!systemType) return [];
  return FORECAST_INCENTIVES.filter((i) => i.systemTypes.includes(systemType));
}

// The largest amount we are confident enough to print for this entry, or null
// when every live program under it is one whose real amount depends on things
// we cannot know from here. Ended programs never contribute: their old cap is
// history, not money anyone can still get.
export function bestIncentiveAmount(incentive: ForecastIncentive): number | null {
  const amounts = incentive.programs
    .filter((p) => p.status === "check" && p.maxAmount != null)
    .map((p) => p.maxAmount as number);
  return amounts.length > 0 ? Math.max(...amounts) : null;
}

// True when this entry has at least one program worth sending someone to.
export function hasLiveProgram(incentive: ForecastIncentive): boolean {
  return incentive.programs.some((p) => p.status === "check");
}
