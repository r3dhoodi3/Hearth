// Home Wins feature - remove this file to remove the feature's tests.
import { describe, it, expect } from "vitest";
import {
  selectHomeWins,
  isGreatShape,
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
    expect(isGreatShape(system())).toBe(true);
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
  it("frames all-healthy systems as 'All N in great shape'", () => {
    const w = selectHomeWins(
      input({
        systems: [
          system({ install_year: THIS_YEAR - 1 }),
          system({ install_year: THIS_YEAR - 2 }),
        ],
      })
    );
    expect(w.variant).toBe("active");
    expect(w.wins.some((x) => x.text === "All 2 systems in great shape")).toBe(
      true
    );
  });

  it("frames a mix as 'X of Y in great shape'", () => {
    const w = selectHomeWins(
      input({
        systems: [
          system({ install_year: THIS_YEAR - 1 }), // great
          system({ install_year: THIS_YEAR - 2 }), // great
          system({ install_year: THIS_YEAR - 30 }), // due, not great
        ],
      })
    );
    expect(w.wins.some((x) => x.text === "2 of 3 systems in great shape")).toBe(
      true
    );
  });

  it("uses singular wording for one great system", () => {
    const w = selectHomeWins(
      input({ systems: [system({ install_year: THIS_YEAR - 1 })] })
    );
    expect(w.wins.some((x) => x.text === "1 system in great shape")).toBe(true);
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
    // Every system past life => no great-shape line, so the plain tracking line
    // carries the systems story instead (never both).
    const w = selectHomeWins(
      input({
        systems: [
          system({ install_year: THIS_YEAR - 30 }),
          system({ install_year: THIS_YEAR - 31 }),
        ],
      })
    );
    expect(w.wins.some((x) => x.text === "Tracking 2 home systems")).toBe(true);
    expect(w.wins.some((x) => x.key === "great")).toBe(false);
  });

  it("never mentions systems twice (great-shape line suppresses the fallback)", () => {
    const w = selectHomeWins(
      input({ systems: [system({ install_year: THIS_YEAR - 1 })] })
    );
    expect(w.wins.filter((x) => x.text.includes("system")).length).toBe(1);
  });

  it("caps the card at three wins, best-first", () => {
    const w = selectHomeWins(
      input({
        createdAt: "2020-01-01T00:00:00Z",
        tasksDoneCount: 9,
        systems: [system({ install_year: THIS_YEAR - 1 })],
      })
    );
    expect(w.wins.length).toBeLessThanOrEqual(3);
    // Great-shape systems lead.
    expect(w.wins[0].key).toBe("great");
  });

  it("never emits a dollar figure (product decision: omitted)", () => {
    const w = selectHomeWins(
      input({
        createdAt: "2020-01-01T00:00:00Z",
        tasksDoneCount: 9,
        systems: [system({ install_year: THIS_YEAR - 1 })],
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
      input({ systems: [system({ install_year: THIS_YEAR - 1 })] })
    );
    expect(homeWinsCaption(w)).toContain("1 system in great shape");
  });
  it("uses no em dashes", () => {
    const w = selectHomeWins(
      input({ systems: [system({ install_year: THIS_YEAR - 1 })] })
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
