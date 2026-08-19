import { describe, expect, it } from "vitest";
import { LOOKAHEAD, initialMountCount, nextMountCount } from "./heroPhotoWindow";

// The landing hero ships twelve photos. Guarding the arithmetic here is
// cheaper than eyeballing the network tab: the whole point of the window is
// that the hero does NOT request all twelve on load, and that the photo about
// to be shown is always already mounted.
const TOTAL = 12;

describe("initialMountCount", () => {
  it("mounts only the first photo plus its lookahead", () => {
    expect(initialMountCount(TOTAL)).toBe(LOOKAHEAD + 1);
    expect(initialMountCount(TOTAL)).toBeLessThan(TOTAL);
  });

  it("never asks for more photos than exist", () => {
    expect(initialMountCount(1)).toBe(1);
    expect(initialMountCount(0)).toBe(0);
  });
});

describe("nextMountCount", () => {
  it("keeps the photo the crossfade is about to reach mounted", () => {
    for (let active = 0; active < TOTAL; active++) {
      const count = nextMountCount(initialMountCount(TOTAL), active, TOTAL);
      const nextIndex = (active + 1) % TOTAL;
      expect(nextIndex).toBeLessThan(count);
    }
  });

  it("grows one step per beat and never shrinks", () => {
    let count = initialMountCount(TOTAL);
    const seen: number[] = [count];
    for (let active = 1; active < TOTAL; active++) {
      const next = nextMountCount(count, active, TOTAL);
      expect(next).toBeGreaterThanOrEqual(count);
      count = next;
      seen.push(count);
    }
    expect(seen).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 12, 12]);
  });

  it("stays put when the cycle wraps back to the start", () => {
    const full = nextMountCount(initialMountCount(TOTAL), TOTAL - 1, TOTAL);
    expect(full).toBe(TOTAL);
    expect(nextMountCount(full, 0, TOTAL)).toBe(TOTAL);
  });

  it("is idempotent, so a repeated call cannot double-advance", () => {
    const once = nextMountCount(3, 4, TOTAL);
    expect(nextMountCount(once, 4, TOTAL)).toBe(once);
  });

  it("never exceeds the number of photos", () => {
    expect(nextMountCount(1, 0, 1)).toBe(1);
    expect(nextMountCount(0, 5, 2)).toBe(2);
  });
});
