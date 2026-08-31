// Home Wins feature - remove this file to remove the feature's tests.
import { describe, it, expect } from "vitest";
import {
  selectHomeWins,
  isGreatShape,
  isOwnerAssessed,
  isValidWinsCode,
  homeWinsCaption,
  type HomeWinsInput,
} from "./homeWins";
import type { HomeSystem } from "@/lib/database.types";

const THIS_YEAR = new Date().getFullYear();
// A fixed "now" for deterministic year math, independent of the real clock.
const NOW = new Date("2026-06-15T00:00:00Z");

function system(over: Partial<HomeSystem> = {}): HomeSystem {
  return {
    id: "s1",
    property_id: "p1",
    system_type: "roof", // DEFAULT_LIFESPANS.roof = 22
    material_or_model: null,
    model_number: null,
    capacity: null,
    install_year: null,
    last_serviced: null,
    condition_rating: null,
    expected_lifespan_years: null,
    notes: null,
    created_at: new Date().toISOString(),
    confirmed_at: null,
    ...over,
  } as HomeSystem;
}

// A fixed owner-confirmation timestamp. Any non-null confirmed_at marks a
// system as owner-assessed; the exact instant never matters to the logic.
const CONFIRMED = "2026-01-02T00:00:00Z";

// An owner-assessed system: same fixture as system() but confirmed, the way
// the walkthrough confirm flow (migration 0056) leaves a real row. Most
// framing tests use this because a bare install_year no longer counts - the
// onboarding seed writes an ESTIMATED install_year on every starter row, so
// install_year alone is indistinguishable from a placeholder.
function assessedSystem(over: Partial<HomeSystem> = {}): HomeSystem {
  return system({ confirmed_at: CONFIRMED, ...over });
}

function input(over: Partial<HomeWinsInput> = {}): HomeWinsInput {
  return {
    firstName: "Dana",
    createdAt: null,
    systems: [],
    tasksDoneCount: 0,
    now: NOW,
    ...over,
  };
}

describe("isGreatShape", () => {
  it("counts a young system", () => {
    expect(isGreatShape(system({ install_year: THIS_YEAR - 1 }))).toBe(true);
  });
  it("does NOT count a system the owner marked failing or worn", () => {
    expect(
      isGreatShape(system({ install_year: THIS_YEAR - 1, condition_rating: 1 }))
    ).toBe(false);
    expect(
      isGreatShape(system({ install_year: THIS_YEAR - 1, condition_rating: 2 }))
    ).toBe(false);
  });
  it("does NOT count a system past its life (due stage)", () => {
    // roof lifespan 22y; installed 30y ago => stage "due".
    expect(isGreatShape(system({ install_year: THIS_YEAR - 30 }))).toBe(false);
  });
  it("counts a system with no install year (undated, not a red flag)", () => {
    // Per-system semantics only: "nothing is a red flag". selectHomeWins
    // additionally requires isOwnerAssessed before this can reach the card.
    expect(isGreatShape(system())).toBe(true);
  });
});

describe("isOwnerAssessed (the placeholder gate)", () => {
  it("rejects a seeded onboarding row, even one with an estimated install year", () => {
    // This is exactly what onboarding/actions.ts seeds: install_year guessed
    // from the build year, expected lifespan set, and NO owner input
    // (confirmed_at null, condition_rating null, last_serviced null).
    expect(
      isOwnerAssessed(
        system({ install_year: THIS_YEAR - 5, expected_lifespan_years: 22 })
      )
    ).toBe(false);
    expect(isOwnerAssessed(system())).toBe(false);
  });
  it("accepts any of the three owner-only signals", () => {
    expect(isOwnerAssessed(system({ confirmed_at: CONFIRMED }))).toBe(true);
    expect(isOwnerAssessed(system({ condition_rating: 4 }))).toBe(true);
    expect(isOwnerAssessed(system({ last_serviced: "2026-03-01" }))).toBe(true);
  });
});

describe("selectHomeWins - starter variant (never a bad number)", () => {
  it("returns an encouraging starter for a brand-new empty home", () => {
    const w = selectHomeWins(input());
    expect(w.variant).toBe("starter");
    expect(w.hasRealWin).toBe(false);
    expect(w.wins).toHaveLength(1);
    expect(w.wins[0].key).toBe("starter");
    // Positive, never negative.
    expect(w.wins[0].text.toLowerCase()).not.toContain("no ");
  });

  it("never returns an empty wins list", () => {
    const w = selectHomeWins(input());
    expect(w.wins.length).toBeGreaterThan(0);
  });
});

describe("selectHomeWins - framing", () => {
  // These framing fixtures use assessedSystem (confirmed_at set): they used
  // to pass with a bare install_year, but that relied on the placeholder bug
  // where an unassessed seed row counted as "great shape".
  it("frames all-healthy systems as 'All N in great shape'", () => {
    const w = selectHomeWins(
      input({
        systems: [
          assessedSystem({ install_year: THIS_YEAR - 1 }),
          assessedSystem({ install_year: THIS_YEAR - 2 }),
        ],
      })
    );
    expect(w.variant).toBe("active");
    expect(w.wins.some((x) => x.text === "All 2 systems in great shape")).toBe(
      true
    );
  });

  it("frames a mix as 'X of Y in great shape' over ASSESSED systems only", () => {
    const w = selectHomeWins(
      input({
        systems: [
          assessedSystem({ install_year: THIS_YEAR - 1 }), // great
          assessedSystem({ install_year: THIS_YEAR - 2 }), // great
          assessedSystem({ install_year: THIS_YEAR - 30 }), // due, not great
        ],
      })
    );
    expect(w.wins.some((x) => x.text === "2 of 3 systems in great shape")).toBe(
      true
    );
  });

  it("uses singular wording for one great system", () => {
    const w = selectHomeWins(
      input({ systems: [assessedSystem({ install_year: THIS_YEAR - 1 })] })
    );
    expect(w.wins.some((x) => x.text === "1 system in great shape")).toBe(true);
  });

  it("gives an all-placeholder home the Tracking line, never a great line", () => {
    // A freshly claimed home: onboarding seeded every row with an estimated
    // install_year and zero owner input. Before the placeholder gate this
    // produced "All 7 systems in great shape" on a home Hearth knows nothing
    // real about; now the honest "Tracking 7 home systems" carries the card.
    const seeds = Array.from({ length: 7 }, (_, i) =>
      system({ id: `seed-${i}`, install_year: THIS_YEAR - 5 })
    );
    const w = selectHomeWins(input({ systems: seeds }));
    expect(w.wins.some((x) => x.key === "great")).toBe(false);
    expect(w.wins.some((x) => x.text === "Tracking 7 home systems")).toBe(true);
  });

  it("counts only assessed systems in both halves of the fraction (mixed seeds + real)", () => {
    const w = selectHomeWins(
      input({
        systems: [
          // Two owner-assessed systems: one great, one the owner marked worn.
          assessedSystem({ id: "a", install_year: THIS_YEAR - 1 }),
          assessedSystem({ id: "b", condition_rating: 2 }),
          // Three untouched onboarding seeds, which must not inflate either
          // the numerator or the denominator.
          system({ id: "c", install_year: THIS_YEAR - 3 }),
          system({ id: "d", install_year: THIS_YEAR - 4 }),
          system({ id: "e" }),
        ],
      })
    );
    expect(w.wins.some((x) => x.text === "1 of 2 systems in great shape")).toBe(
      true
    );
  });

  it("uses a bare count when every assessed system is great but seeds remain", () => {
    // "All" would overstate (5 systems exist, only 2 are assessed) and
    // "2 of 2" reads oddly, so the line is the plain honest count.
    const w = selectHomeWins(
      input({
        systems: [
          assessedSystem({ id: "a", install_year: THIS_YEAR - 1 }),
          assessedSystem({ id: "b", condition_rating: 5 }),
          system({ id: "c" }),
          system({ id: "d" }),
          system({ id: "e" }),
        ],
      })
    );
    expect(w.wins.some((x) => x.text === "2 systems in great shape")).toBe(
      true
    );
    expect(w.wins.every((x) => !x.text.includes("All"))).toBe(true);
  });

  it("counts whole years on Hearth from createdAt", () => {
    const w = selectHomeWins(
      input({ createdAt: "2024-01-01T00:00:00Z" }) // NOW is 2026-06 => 2 years
    );
    expect(w.wins.some((x) => x.text === "2 years on Hearth")).toBe(true);
  });

  it("does not claim a year for a home under 12 months old", () => {
    const w = selectHomeWins(
      input({ createdAt: "2026-01-01T00:00:00Z" }) // ~5 months at NOW
    );
    expect(w.wins.every((x) => !x.text.includes("year"))).toBe(true);
  });

  it("reports maintenance tasks handled, pluralized", () => {
    expect(
      selectHomeWins(input({ tasksDoneCount: 1 })).wins.some(
        (x) => x.text === "1 maintenance task handled"
      )
    ).toBe(true);
    expect(
      selectHomeWins(input({ tasksDoneCount: 5 })).wins.some(
        (x) => x.text === "5 maintenance tasks handled"
      )
    ).toBe(true);
  });

  it("falls back to 'Tracking N systems' only when no great-shape line exists", () => {
    // Every assessed system past life => no great-shape line, so the plain
    // tracking line carries the systems story instead (never both). These are
    // assessed (confirmed) so the missing great line is about being due, not
    // about the placeholder gate.
    const w = selectHomeWins(
      input({
        systems: [
          assessedSystem({ install_year: THIS_YEAR - 30 }),
          assessedSystem({ install_year: THIS_YEAR - 31 }),
        ],
      })
    );
    expect(w.wins.some((x) => x.text === "Tracking 2 home systems")).toBe(true);
    expect(w.wins.some((x) => x.key === "great")).toBe(false);
  });

  it("never mentions systems twice (great-shape line suppresses the fallback)", () => {
    const w = selectHomeWins(
      input({ systems: [assessedSystem({ install_year: THIS_YEAR - 1 })] })
    );
    expect(w.wins.filter((x) => x.text.includes("system")).length).toBe(1);
  });

  it("caps the card at three wins, best-first", () => {
    const w = selectHomeWins(
      input({
        createdAt: "2020-01-01T00:00:00Z",
        tasksDoneCount: 9,
        systems: [assessedSystem({ install_year: THIS_YEAR - 1 })],
      })
    );
    expect(w.wins.length).toBeLessThanOrEqual(3);
    // Great-shape systems lead.
    expect(w.wins[0].key).toBe("great");
  });

  it("carries a stat/statLabel split for the card's hero number", () => {
    const w = selectHomeWins(
      input({
        createdAt: "2020-01-01T00:00:00Z",
        systems: [assessedSystem({ install_year: THIS_YEAR - 1 })],
      })
    );
    // Every non-starter win exposes the number and the words separately so
    // the share card can render the number at poster scale.
    for (const win of w.wins) {
      expect(win.stat).toBeTruthy();
      expect(win.statLabel).toBeTruthy();
      expect(win.stat).toMatch(/^\d+$/);
    }
  });

  it("never emits a dollar figure (product decision: omitted)", () => {
    const w = selectHomeWins(
      input({
        createdAt: "2020-01-01T00:00:00Z",
        tasksDoneCount: 9,
        systems: [assessedSystem({ install_year: THIS_YEAR - 1 })],
      })
    );
    for (const win of w.wins) expect(win.text).not.toContain("$");
    expect(homeWinsCaption(w)).not.toContain("$");
  });
});

describe("homeWinsCaption", () => {
  it("has a first-person, no-reward starter caption", () => {
    const cap = homeWinsCaption(selectHomeWins(input()));
    expect(cap.toLowerCase()).toContain("hearth");
    expect(cap.toLowerCase()).not.toContain("reward");
  });
  it("leads an active caption with the top win", () => {
    const w = selectHomeWins(
      input({ systems: [assessedSystem({ install_year: THIS_YEAR - 1 })] })
    );
    expect(homeWinsCaption(w)).toContain("1 system in great shape");
  });
  it("uses no em dashes", () => {
    const w = selectHomeWins(
      input({ systems: [assessedSystem({ install_year: THIS_YEAR - 1 })] })
    );
    expect(homeWinsCaption(w)).not.toContain("—");
  });
});

describe("isValidWinsCode (public route guard)", () => {
  it("accepts a referral-code-shaped value", () => {
    // referralCode.ts alphabet is uppercase letters + digits 2-9, length 8.
    expect(isValidWinsCode("ABCD2345")).toBe(true);
    expect(isValidWinsCode("PQRSTUVW")).toBe(true);
  });
  it("rejects lowercase, whitespace, injection, and out-of-range lengths", () => {
    expect(isValidWinsCode("")).toBe(false);
    expect(isValidWinsCode("abc")).toBe(false);
    expect(isValidWinsCode("abcd2345")).toBe(false);
    expect(isValidWinsCode("ABC")).toBe(false); // too short
    expect(isValidWinsCode("A".repeat(17))).toBe(false); // too long
    expect(isValidWinsCode("ABCD 2345")).toBe(false);
    expect(isValidWinsCode("'; DROP TABLE users;--")).toBe(false);
    expect(isValidWinsCode("../../etc")).toBe(false);
  });
});
