// Home Wins feature - remove this file to remove the feature.
//
// POSITIVE-ONLY, shareable "home wins" for a property. Deliberately NOT the
// 0-100 Home Health Score (src/lib/health.ts): a score shames a home with a low
// number, and the point of this card is to make a homeowner feel good and pass
// Hearth along to a neighbor. So everything here is framed as something the
// owner has ALREADY done well, and there is always an encouraging "just getting
// started" fallback so the card is never a bad number.
//
// Pure and dependency-light on purpose (only assessSystem, itself pure), so the
// selection/framing logic is unit tested in homeWins.test.ts rather than only
// exercised through a React tree or an image route.
//
// ON THE DOLLAR FIGURE (an explicit product decision): the brief allowed an
// OPTIONAL banded "$X-$Y caught early" line IF a clean, defensible source
// exists, and said to OMIT it if the methodology is murky. It is murky, so it
// is omitted. Hearth stores no ledger of money saved by acting early: the
// reserve math (forecastReserve.ts) is a FUTURE savings target, not realized
// savings; REPLACEMENT_INFO bands are the cost to REPLACE a system, not money a
// healthy system saved; and maintenance_tasks carry no cost. Any figure built
// from those would be invented, so this card shows counts and streaks of good
// behavior only - never a dollar amount.

import type { HomeSystem } from "@/lib/database.types";
import { assessSystem } from "@/lib/health";

// A system counts as "in great shape" when nothing about it is a red flag: the
// owner did not mark it worn (2) or failing (1), and its age-based stage is not
// "due" (past / near end of life). Healthy, aging-but-fine, and not-yet-dated
// systems all count - this is a flattering read on purpose, but a failing or
// past-life system is never counted, so the number stays honest.
// assessSystem reads the real current year internally (no injectable clock),
// exactly as it does everywhere else in the app - tests drive it with an
// install_year relative to the real year, the same way health.test.ts does.
export function isGreatShape(system: HomeSystem): boolean {
  if (system.condition_rating === 1 || system.condition_rating === 2) {
    return false;
  }
  return assessSystem(system).stage !== "due";
}

export interface HomeWinsInput {
  // First name only, or null. Never a last name, never anything else - this is
  // the one piece of PII that can reach the public card.
  firstName: string | null;
  // properties.created_at (ISO string) - drives "years on Hearth".
  createdAt: string | null;
  systems: HomeSystem[];
  // Count of maintenance_tasks with status "done" for this property.
  tasksDoneCount: number;
  // Injectable clock so the tests are deterministic. Defaults to now.
  now?: Date;
}

export interface HomeWin {
  key: "great" | "years" | "tasks" | "systems" | "starter";
  // A self-contained, pronoun-free phrase that reads correctly in both the
  // first-person in-app caption and the third-person share card.
  text: string;
}

export interface HomeWins {
  // "active" when there is at least one genuine win; "starter" for a brand-new
  // or low-activity home, which gets a single encouraging line instead.
  variant: "active" | "starter";
  firstName: string | null;
  // Ordered best-first, capped at 3 for the card. Always at least one item.
  wins: HomeWin[];
  // True only when a genuine (non-starter) win is present.
  hasRealWin: boolean;
}

// Whole years between two dates, floored. Uses 365.25 days so a leap year does
// not tip a just-under-a-year home into claiming a full year.
function fullYearsBetween(fromIso: string | null, now: Date): number {
  if (!fromIso) return 0;
  const from = new Date(fromIso);
  const ms = now.getTime() - from.getTime();
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.floor(ms / (365.25 * 24 * 60 * 60 * 1000));
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

// THE PURE WIN-SELECTION / FRAMING FUNCTION. Given the raw facts, decide which
// positive wins to show and how to word them. Never returns an empty list and
// never a negative or shaming line.
export function selectHomeWins(input: HomeWinsInput): HomeWins {
  const now = input.now ?? new Date();
  const systems = input.systems ?? [];
  const systemsCount = systems.length;
  const greatCount = systems.filter((s) => isGreatShape(s)).length;
  const tasksDone = Math.max(0, Math.floor(input.tasksDoneCount || 0));
  const years = fullYearsBetween(input.createdAt, now);

  // Build candidate wins best-first. A home that has kept many systems in
  // great shape leads; then loyalty (years); then work done; then a plain
  // "tracking N systems" only when the great-shape line did not already speak
  // to the systems (so the card never says "systems" twice).
  const candidates: HomeWin[] = [];

  const greatLine =
    systemsCount >= 1 && greatCount >= 1
      ? greatCount === systemsCount
        ? systemsCount === 1
          ? "1 system in great shape"
          : `All ${systemsCount} systems in great shape`
        : `${greatCount} of ${systemsCount} systems in great shape`
      : null;
  if (greatLine) candidates.push({ key: "great", text: greatLine });

  if (years >= 1) {
    candidates.push({ key: "years", text: `${plural(years, "year")} on Hearth` });
  }

  if (tasksDone >= 1) {
    candidates.push({
      key: "tasks",
      text: `${plural(tasksDone, "maintenance task")} handled`,
    });
  }

  // Fallback systems line only when there was no great-shape line to carry the
  // systems story (e.g. every system is still an undated onboarding guess).
  if (!greatLine && systemsCount >= 1) {
    candidates.push({
      key: "systems",
      text: `Tracking ${plural(systemsCount, "home system")}`,
    });
  }

  if (candidates.length === 0) {
    // Brand-new or empty home: never a bad number, just a warm start.
    return {
      variant: "starter",
      firstName: input.firstName,
      wins: [{ key: "starter", text: "Home set up on Hearth" }],
      hasRealWin: false,
    };
  }

  return {
    variant: "active",
    firstName: input.firstName,
    wins: candidates.slice(0, 3),
    hasRealWin: true,
  };
}

// Shared code-shape guard for the public wins-card route
// (src/app/api/wins-card/[code]/route.tsx). A referral_code is 8 chars from an
// uppercase-letters-and-digits alphabet (referralCode.ts); this accepts that
// shape (4-16 to tolerate a future length change) and rejects everything else -
// lowercase, whitespace, injection characters, an empty string - BEFORE the
// route spends any admin query on it. Kept here, pure and exported, so the
// route's first line of defense is unit tested rather than an inline regex.
export function isValidWinsCode(code: string): boolean {
  return /^[A-Z0-9]{4,16}$/.test(code);
}

// The share caption the homeowner posts, in the first person (they are sharing
// their OWN home). Kept here so the copy is covered by the same test as the
// selection it describes. The caller appends the invite URL, so this never
// contains a link and never promises a reward.
export function homeWinsCaption(wins: HomeWins): string {
  if (wins.variant === "starter") {
    return "Just set up my home on Hearth to stay on top of maintenance. Handy for keeping a house in shape:";
  }
  const top = wins.wins[0]?.text ?? "";
  const topSentence = top ? ` ${top.charAt(0).toUpperCase()}${top.slice(1)}.` : "";
  return `I've been staying on top of my home with Hearth.${topSentence} Worth a look for yours:`;
}
