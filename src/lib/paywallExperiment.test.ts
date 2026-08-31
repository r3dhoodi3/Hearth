import { afterEach, describe, expect, it, vi } from "vitest";
import { variantForUser, type PaywallVariant } from "./paywallExperiment";

// The soft-vs-hard paywall experiment's assignment function. Everything the
// experiment's data quality rests on is pinned here: the assignment is a pure
// function of the account id (no per-render randomness, no storage), both arms
// actually occur, and the env escape hatch can end the experiment without a
// code change.

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("variantForUser is deterministic per account", () => {
  it("answers the same variant for the same id, every time", () => {
    const first = variantForUser("11111111-2222-3333-4444-555555555555");
    for (let i = 0; i < 50; i++) {
      expect(variantForUser("11111111-2222-3333-4444-555555555555")).toBe(
        first
      );
    }
  });

  it("only ever answers soft or hard", () => {
    for (let i = 0; i < 100; i++) {
      expect(["soft", "hard"]).toContain(variantForUser(`user-${i}`));
    }
  });

  it("splits a population into BOTH arms, roughly in half", () => {
    const counts: Record<PaywallVariant, number> = { soft: 0, hard: 0 };
    const total = 500;
    for (let i = 0; i < total; i++) {
      // UUID-ish ids, so the distribution check runs over inputs shaped like
      // the real ones rather than over sequential integers alone.
      counts[variantForUser(`0000${i}-abcd-${i}ef-user-${i * 7}`)]++;
    }
    expect(counts.soft + counts.hard).toBe(total);
    // A 50/50 hash over 500 ids landing outside 35-65 percent would mean the
    // hash is broken, not unlucky.
    expect(counts.soft).toBeGreaterThan(total * 0.35);
    expect(counts.soft).toBeLessThan(total * 0.65);
  });

  it("a missing id falls back to soft, the pre-experiment behavior", () => {
    expect(variantForUser(null)).toBe("soft");
    expect(variantForUser(undefined)).toBe("soft");
    expect(variantForUser("")).toBe("soft");
  });
});

describe("the PAYWALL_EXPERIMENT env escape hatch", () => {
  // An id from each arm under the default split, so the override tests prove
  // the env var really overrides rather than agreeing by coincidence.
  function idsFromBothArms(): { softId: string; hardId: string } {
    let softId = "";
    let hardId = "";
    for (let i = 0; !softId || !hardId; i++) {
      const id = `probe-${i}`;
      if (variantForUser(id) === "soft") softId = softId || id;
      else hardId = hardId || id;
    }
    return { softId, hardId };
  }

  it("PAYWALL_EXPERIMENT=soft puts every account on soft", () => {
    const { hardId } = idsFromBothArms();
    vi.stubEnv("PAYWALL_EXPERIMENT", "soft");
    expect(variantForUser(hardId)).toBe("soft");
    expect(variantForUser(null)).toBe("soft");
  });

  it("PAYWALL_EXPERIMENT=hard puts every account on hard", () => {
    const { softId } = idsFromBothArms();
    vi.stubEnv("PAYWALL_EXPERIMENT", "hard");
    expect(variantForUser(softId)).toBe("hard");
    // Even a missing id: the env var is the owner saying the experiment is
    // over, so nothing may keep advertising the trial.
    expect(variantForUser(null)).toBe("hard");
  });

  it("PAYWALL_EXPERIMENT=split (and any junk value) keeps the hash split", () => {
    const { softId, hardId } = idsFromBothArms();
    for (const mode of ["split", "on", "true", "SOFT"]) {
      vi.stubEnv("PAYWALL_EXPERIMENT", mode);
      expect(variantForUser(softId)).toBe("soft");
      expect(variantForUser(hardId)).toBe("hard");
    }
  });
});
