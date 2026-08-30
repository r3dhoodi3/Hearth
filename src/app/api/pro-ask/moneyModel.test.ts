import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

// Source-pattern test, same reasoning as gate.test.ts: this route imports the
// service-role client, Stripe and Claude, so it cannot be imported and driven
// here. This pins the one sentence the copilot's system prompt uses to state
// the money model, so it can never drift from PRO_LEAD_DISCOUNT_PCT (10%,
// migration 0149) or start quoting a member a wrong fee.

function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

const route = src("./route.ts");

describe("pro-ask system prompt: the money model states the Pro member discount", () => {
  it("imports PRO_LEAD_DISCOUNT_PCT from constants", () => {
    expect(route).toContain(
      'import {\n  LEAD_TIER_FEES,\n  MAJOR_INTRO_FEE,\n  PRO_LEAD_DISCOUNT_PCT,'
    );
  });

  it("states the discount and the never-stacks rule in the same sentence as the base tiers", () => {
    expect(route).toContain(
      "Hearth Pro members get ${PRO_LEAD_DISCOUNT_PCT}% off every one of those fees, but it NEVER stacks with the aging markdown"
    );
    expect(route).toContain("never both added together");
  });

  it("tells the model to never quote a discounted price to a non-member", () => {
    expect(route).toContain(
      "Never tell a NON-member their per-lead price is anything but the plain base tier number."
    );
  });

  it("keeps the intro price a fixed floor, never further discounted", () => {
    expect(route).toContain(
      "is a FIXED price, and is never discounted further by membership or the aging markdown"
    );
  });
});
