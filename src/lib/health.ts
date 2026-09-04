import type { HomeSystem, Issue } from "@/lib/database.types";
import {
  labelFor,
  SYSTEM_TYPES,
  ISSUE_CATEGORIES,
  categoryForSystem,
} from "@/lib/constants";

// Fallback lifespans (years) used when system_lifespans isn't loaded or a
// system has no stored expected_lifespan_years. Mirrors the seed in 0003.
export const DEFAULT_LIFESPANS: Record<string, number> = {
  roof: 22,
  hvac: 18,
  water_heater: 11,
  electrical_panel: 35,
  plumbing: 50,
  windows: 25,
  foundation: 75,
  appliance: 12,
  gutters: 25,
  siding: 30,
  garage_door: 20,
  deck: 20,
  driveway: 30,
  sump_pump: 10,
  sewer_line: 50,
  fence: 18,
};

// Rough national replacement cost RANGES (USD) plus a plain explanation of what
// drives the price. Ballpark planning figures, not quotes.
export interface ReplacementInfo {
  low: number;
  high: number;
  why: string;
}

export const REPLACEMENT_INFO: Record<string, ReplacementInfo> = {
  roof: {
    low: 8000,
    high: 18000,
    why: "Mostly the size and pitch of the roof, the material (asphalt shingles are cheapest; metal, tile, and slate cost much more), tearing off the old roof, and repairing any rotted decking underneath.",
  },
  hvac: {
    low: 5000,
    high: 10000,
    why: "The unit size your home needs, its efficiency rating, whether the ductwork needs work, and the labor to install it and charge the refrigerant.",
  },
  water_heater: {
    low: 1200,
    high: 3500,
    why: "Tank vs tankless (tankless costs more upfront), gas vs electric, the capacity, and any venting or plumbing changes.",
  },
  electrical_panel: {
    low: 1500,
    high: 4000,
    why: "The amperage (200A costs more than 100A), whether the meter or wiring also needs upgrading, permits, and an electrician's labor.",
  },
  plumbing: {
    low: 4000,
    high: 15000,
    why: "A whole-home repipe scales with the home's size, number of bathrooms, pipe material (copper costs more than PEX), and how much wall access is needed.",
  },
  windows: {
    low: 5000,
    high: 15000,
    why: "The number of windows, frame material, glass type (double vs triple pane), and any frame or trim repairs.",
  },
  foundation: {
    low: 3000,
    high: 12000,
    why: "The type and extent of the damage, how accessible it is, and whether it's minor crack sealing or major structural work like piers.",
  },
  appliance: {
    low: 600,
    high: 3000,
    why: "The appliance type and brand, its capacity and features, and installation or haul-away of the old unit.",
  },
  gutters: {
    low: 1000,
    high: 3000,
    why: "The linear footage, material (aluminum vs copper), seamless vs sectional, and the number of downspouts.",
  },
  siding: {
    low: 8000,
    high: 20000,
    why: "The home's square footage, material (vinyl is cheapest; fiber cement and wood cost more), removing the old siding, and any house wrap or insulation.",
  },
  garage_door: {
    low: 800,
    high: 2500,
    why: "Single vs double, the material and insulation, and whether the opener and springs are replaced too.",
  },
  deck: {
    low: 4000,
    high: 12000,
    why: "The size, material (pressure-treated wood vs composite), railings, and any footings or permits.",
  },
  driveway: {
    low: 3000,
    high: 8000,
    why: "The square footage, material (concrete vs asphalt vs pavers), demolition of the old surface, and grading.",
  },
  sump_pump: {
    low: 400,
    high: 1200,
    why: "The pump type, whether a battery backup is added, and any work on the pit or discharge line.",
  },
  sewer_line: {
    low: 3000,
    high: 8000,
    why: "The length and depth of the line, the method (traditional dig vs trenchless), and whether it runs under landscaping or the driveway.",
  },
  fence: {
    low: 2000,
    high: 7000,
    why: "The linear footage, material (wood, vinyl, metal), height, and how hard the terrain is to set posts in.",
  },
};

export function replacementInfoFor(systemType: string): ReplacementInfo | null {
  return REPLACEMENT_INFO[systemType] ?? null;
}

// Maps a job/service category to the home system OakTend keeps a national
// replacement range for. Same shape as quoteAnalysis.ts's own baseline map:
// categories with no clean system match (structural, remodeling, landscaping,
// cleaning, painting, home_inspection, pest, handyman, other) are left out on
// purpose, so a job in one of those keeps the neutral budget default.
const CATEGORY_TO_SYSTEM: Record<string, string> = {
  roof: "roof",
  hvac: "hvac",
  plumbing: "plumbing",
  windows: "windows",
  electrical: "electrical_panel",
  garage_door: "garage_door",
};

// The rough budget band (a BUDGET_RANGES value from constants.ts) that best
// fits the middle of a category's national replacement range, or null when we
// have no range for that category. Used to pre-fill the post-a-job budget
// dropdown when the job arrives tied to a known system, so the owner starts
// from a sane bracket instead of "Prefer not to say". A starting point they
// can freely change, never a fixed number: real repairs cost less than a full
// replacement. The returned strings MUST stay in sync with BUDGET_RANGES.
export function budgetBracketForCategory(
  category: string | null | undefined
): string | null {
  if (!category) return null;
  const systemType = CATEGORY_TO_SYSTEM[category];
  const info = systemType ? REPLACEMENT_INFO[systemType] : null;
  if (!info) return null;
  const mid = (info.low + info.high) / 2;
  if (mid < 500) return "under-500";
  if (mid < 1500) return "500-1500";
  if (mid < 5000) return "1500-5000";
  if (mid < 15000) return "5000-15000";
  if (mid < 25000) return "15000-25000";
  if (mid < 50000) return "25000-50000";
  return "50000-plus";
}

export type LifeStage = "healthy" | "aging" | "due" | "unknown";

export interface SystemHealth {
  system: HomeSystem;
  age: number | null;
  lifespan: number;
  remaining: number | null; // years left; negative = past expected life
  stage: LifeStage;
  message: string;
}

// Computed per call, not cached at module scope: a long-running server that
// crosses New Year would otherwise age every system a year late and disagree
// with forecast math evaluated at request time.
function currentYear(): number {
  return new Date().getFullYear();
}

export function assessSystem(system: HomeSystem): SystemHealth {
  const lifespan =
    system.expected_lifespan_years ??
    DEFAULT_LIFESPANS[system.system_type] ??
    20;

  if (!system.install_year) {
    return {
      system,
      age: null,
      lifespan,
      remaining: null,
      stage: "unknown",
      message: "Add an install year to get a lifespan estimate.",
    };
  }

  const age = currentYear() - system.install_year;
  const remaining = lifespan - age;
  let stage: LifeStage;
  let message: string;

  if (remaining <= 0) {
    stage = "due";
    message = `This system is ${age} years old. It is past the typical ${lifespan} year lifespan, so plan a replacement.`;
  } else if (remaining <= 3) {
    stage = "due";
    message = `This system is ${age} years old. The typical lifespan is ${lifespan} years, so budget for a replacement soon.`;
  } else if (remaining <= lifespan * 0.4) {
    stage = "aging";
    message = `This system is ${age} years old. It has roughly ${remaining} years of typical life left.`;
  } else {
    stage = "healthy";
    message = `This system is ${age} years old and in good shape. The typical lifespan is ${lifespan} years.`;
  }

  return { system, age, lifespan, remaining, stage, message };
}

// Years until likely replacement, ADJUSTED for the owner-reported condition.
// Age alone isn't enough - a system rated failing (1) or worn (2) needs action
// much sooner than its typical lifespan implies, so we cap the years left.
export function effectiveYearsLeft(system: HomeSystem): number | null {
  const ageBased = assessSystem(system).remaining;
  const c = system.condition_rating;
  let cap: number | null = null;
  if (c === 1) cap = 0; // failing - now
  else if (c === 2) cap = 2; // worn - within ~2 years
  else if (c === 3) cap = 5; // fair - within ~5 years
  if (cap == null) return ageBased; // good / unknown: no adjustment
  if (ageBased == null) return cap; // no install year: condition drives it
  return Math.min(ageBased, cap);
}

// Sort weight for the systems list - higher = more urgent. Combines the
// owner-reported condition (1 = failing) with the age-based stage, so failing /
// past-lifespan systems float to the top and healthy ones sink to the bottom.
export function systemPriority(system: HomeSystem): number {
  const h = assessSystem(system);
  let r = 0;
  const c = system.condition_rating ?? 0;
  if (c === 1) r += 100; // failing
  else if (c === 2) r += 40; // worn
  else if (c === 3) r += 10; // fair
  if (h.stage === "due") r += 50;
  else if (h.stage === "aging") r += 20;
  return r;
}

// Matches a system to its most relevant open issue: an issue linked directly
// by system_id wins, falling back to the first open issue in the same
// category (for issues filed without a specific system picked). This is the
// single place that decides which open issue "belongs" to a system - Home,
// Cost Forecast, and anything else that needs the answer should call this
// instead of re-deriving it, so they never pick different issues for the
// same system.
export function openIssueFor(
  system: Pick<HomeSystem, "id" | "system_type">,
  openIssues: Pick<
    Issue,
    "id" | "system_id" | "category" | "severity" | "description"
  >[]
): Pick<
  Issue,
  "id" | "system_id" | "category" | "severity" | "description"
> | null {
  const bySystemId = openIssues.find((i) => i.system_id === system.id);
  if (bySystemId) return bySystemId;
  const cat = categoryForSystem(system.system_type);
  return openIssues.find((i) => i.category === cat) ?? null;
}

// A system the owner must deal with: reported failing, or well past its life.
//
// Day-one honesty (same exemption as SystemRow's "Check soon (estimated)"
// badge): a "due" verdict resting ONLY on an install year estimated from the
// home's age at onboarding (confirmed_at null, no owner-entered condition,
// no open issue) is a guess, not a confirmed problem, so it is NOT a must-do.
// HomeSystem itself carries no issue linkage; callers that have joined open
// issues to systems (by category, like the dashboard does) should pass the
// system's open issue so a reported problem overrides the exemption.
export function isMustDo(
  system: HomeSystem,
  openIssue: { severity?: string | null } | null = null
): boolean {
  if (system.condition_rating === 1) return true;
  if (assessSystem(system).stage !== "due") return false;
  const pureAgeEstimate =
    !system.confirmed_at && system.condition_rating == null && !openIssue;
  return !pureAgeEstimate;
}

// ---------------------------------------------------------------------------
// One system's plain-language status, shared by the interactive card on screen
// (src/app/(app)/profile/SystemRow.tsx) and the printed home report
// (src/app/(app)/home-report/page.tsx).
//
// Pulled out of SystemRow deliberately: the printed report is the paid
// artifact, so it has to say the SAME thing about a system as the screen does.
// Two copies of this branching would drift the first time either side was
// touched, and the version a homeowner hands to a buyer is the worst possible
// place for that drift to land. Pure and dependency-free, so it is unit
// tested (health.test.ts) rather than only exercised through a React tree.
export type SystemStatus = {
  // "Must do" | "Check soon (estimated)" | "Healthy" | "Plan ahead" |
  // "Needs maintenance" | "Add details"
  label: string;
  mustDo: boolean;
  // A "due" verdict that rests ONLY on an install year estimated at
  // onboarding: never confirmed, no owner-entered condition, no reported
  // issue. Shown as an explicit estimate rather than a red alarm.
  estimatedDue: boolean;
  stage: LifeStage;
  // Why the system carries this status, in the owner's own terms: any issue
  // they reported, any condition they set, then the age-based assessment.
  why: string;
};

const STAGE_LABEL: Record<string, string> = {
  healthy: "Healthy",
  aging: "Plan ahead",
  due: "Needs maintenance",
  unknown: "Add details",
};

export function systemStatus(
  system: HomeSystem,
  openIssue: {
    category?: string | null;
    description?: string | null;
    severity?: string | null;
  } | null = null
): SystemStatus {
  const health = assessSystem(system);
  const issueSeverity = openIssue?.severity ?? null;
  const mustDo = system.condition_rating === 1 || issueSeverity === "urgent";
  const isPureAgeEstimate =
    !system.confirmed_at && system.condition_rating == null && !openIssue;
  const estimatedDue =
    health.stage === "due" && !mustDo && isPureAgeEstimate;

  const whyParts: string[] = [];
  if (openIssue?.category) {
    whyParts.push(
      `You reported a ${labelFor(ISSUE_CATEGORIES, openIssue.category)} issue${
        openIssue.description ? `: ${openIssue.description}` : ""
      }.`
    );
  }
  if (system.condition_rating === 1) {
    whyParts.push("You marked its condition as failing.");
  } else if (system.condition_rating === 2) {
    whyParts.push("You marked its condition as worn.");
  }
  whyParts.push(health.message);

  return {
    label: mustDo
      ? "Must do"
      : estimatedDue
        ? "Check soon (estimated)"
        : (STAGE_LABEL[health.stage] ?? health.stage),
    mustDo,
    estimatedDue,
    stage: health.stage,
    why: whyParts.join(" "),
  };
}

// Condition-adjusted life left, as the one sentence both the card and the
// printed report show. Shares systemStatus's reason for existing: the screen
// and the paid artifact must not word this differently.
export function lifeLeftText(system: HomeSystem): string {
  const eff = effectiveYearsLeft(system);
  if (eff == null) return "Add an install year to estimate";
  if (eff <= 0) {
    return system.condition_rating === 1
      ? "Failing. Replace now."
      : "Past due. Replace now.";
  }
  if (eff < 1) return "Less than a year";
  const years = Math.round(eff);
  return `about ${years} more year${years === 1 ? "" : "s"}`;
}

// A system whose details are still the onboarding guess: never confirmed by
// the owner (confirmed_at null, migration 0056) and no owner-entered
// condition. Its age-based verdict rests on an estimated install year, so its
// deductions count at half weight until the owner confirms it.
function isUnconfirmedEstimate(system: HomeSystem): boolean {
  return !system.confirmed_at && system.condition_rating == null;
}

// True when more than half the systems are unconfirmed estimates, so the
// dashboard can honestly label the number "Estimated score".
export function scoreIsMostlyEstimated(systems: HomeSystem[]): boolean {
  if (systems.length === 0) return false;
  return systems.filter(isUnconfirmedEstimate).length > systems.length / 2;
}

// 0-100 Home Health Score. Starts at 100, then deducts for aging/overdue
// systems, open issues (weighted by severity), and missing system data.
// Unconfirmed onboarding estimates deduct at half weight (see
// isUnconfirmedEstimate); confirmed systems deduct in full.
export function homeHealthScore(
  systems: HomeSystem[],
  openIssues: Issue[]
): number {
  let score = 100;

  for (const s of systems) {
    const h = assessSystem(s);
    const est = isUnconfirmedEstimate(s);
    if (h.stage === "due") score -= est ? 5 : 10;
    else if (h.stage === "aging") score -= est ? 2 : 4;
    if (s.condition_rating && s.condition_rating <= 2) score -= 5;
  }

  for (const issue of openIssues) {
    if (issue.severity === "urgent") score -= 12;
    else if (issue.severity === "medium") score -= 5;
    else score -= 2;
  }

  return Math.max(0, Math.min(100, Math.round(score)));
}

// Same math as homeHealthScore, but returns the itemized deductions so the UI
// can explain *why* the score is what it is.
export interface ScoreLine {
  label: string;
  points: number;
}

export function scoreBreakdown(
  systems: HomeSystem[],
  openIssues: Issue[]
): { score: number; lines: ScoreLine[] } {
  const lines: ScoreLine[] = [];

  for (const s of systems) {
    const name = labelFor(SYSTEM_TYPES, s.system_type);
    const h = assessSystem(s);
    // Half-weight deductions for unconfirmed estimates, mirroring
    // homeHealthScore, with the label saying so plainly.
    const est = isUnconfirmedEstimate(s);
    const suffix = est ? " (estimated, confirm it)" : "";
    if (h.stage === "due")
      lines.push({
        label: `${name} past/near end of life${suffix}`,
        points: est ? -5 : -10,
      });
    else if (h.stage === "aging")
      lines.push({ label: `${name} is aging${suffix}`, points: est ? -2 : -4 });
    if (s.condition_rating && s.condition_rating <= 2)
      lines.push({ label: `${name} in poor condition`, points: -5 });
  }

  for (const issue of openIssues) {
    const name = labelFor(ISSUE_CATEGORIES, issue.category);
    const points = issue.severity === "urgent" ? -12 : issue.severity === "medium" ? -5 : -2;
    lines.push({ label: `${issue.severity} ${name} issue`, points });
  }

  const total = lines.reduce((sum, l) => sum + l.points, 0);
  const score = Math.max(0, Math.min(100, Math.round(100 + total)));
  return { score, lines };
}

export function scoreBand(score: number): { label: string; tone: string } {
  if (score >= 85) return { label: "Great shape", tone: "text-green-700 bg-green-50 border-green-200 dark:text-green-300 dark:bg-green-500/15 dark:border-green-500/30" };
  if (score >= 65) return { label: "Generally healthy", tone: "text-bark-700 bg-bark-50 border-bark-100 dark:text-stone-300 dark:bg-bark-700/40 dark:border-bark-700" };
  if (score >= 45) return { label: "Needs attention", tone: "text-amber-700 bg-amber-50 border-amber-200 dark:text-amber-300 dark:bg-amber-500/15 dark:border-amber-500/30" };
  return { label: "Several items overdue", tone: "text-red-700 bg-red-50 border-red-200 dark:text-red-300 dark:bg-red-500/15 dark:border-red-500/30" };
}

// Derive upcoming maintenance prompts from system ages (read-only, computed -
// not persisted). Screen 3 surfaces these alongside any saved maintenance_tasks.
export interface MaintenancePrompt {
  systemId: string;
  systemType: string;
  title: string;
  urgency: LifeStage;
}

export function derivedMaintenance(systems: HomeSystem[]): MaintenancePrompt[] {
  return systems
    .map(assessSystem)
    .filter((h) => h.stage === "due" || h.stage === "aging")
    .sort((a, b) => (a.remaining ?? 0) - (b.remaining ?? 0))
    .map((h) => ({
      systemId: h.system.id,
      systemType: h.system.system_type,
      title: h.message,
      urgency: h.stage,
    }));
}
