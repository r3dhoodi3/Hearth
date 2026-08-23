import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { reasonToClientPayload } from "./aiReason";

// The whole point of this module: four counter reasons, three honest answers,
// and never the wrong one. Before it, ten of the eleven tool routes flattened
// every refusal into "rate_limited", so a five-second burst window and a
// tripped owner-wide breaker both told the person they had used up their day.
describe("reasonToClientPayload", () => {
  it("only the daily cap is the person's own allowance", () => {
    const payload = reasonToClientPayload("user_daily");
    expect(payload.reason).toBe("rate_limited");
    expect(payload.error).toMatch(/today/i);
    expect(payload.error).toMatch(/resets/i);
  });

  it("a burst window says how long, not that they are out", () => {
    const payload = reasonToClientPayload("user_burst");
    expect(payload.reason).toBe("busy");
    // The window is minutes wide, so the copy has to say minutes.
    expect(payload.error).toMatch(/minute/i);
    // And it must NOT read as an allowance they spent: that is the sentence
    // that sent people to the billing page over a double tap.
    expect(payload.error).not.toMatch(/limit|out of|used/i);
  });

  it("an owner-wide ceiling is Hearth being busy, never the person's fault", () => {
    const payload = reasonToClientPayload("global");
    expect(payload.reason).toBe("busy");
    expect(payload.error).toMatch(/busy/i);
    expect(payload.error).not.toMatch(/your|you've|you have/i);
  });

  it("a counter we could not read is unavailable, not a limit", () => {
    const payload = reasonToClientPayload("counter_unavailable");
    expect(payload.reason).toBe("unavailable");
    expect(payload.error).not.toMatch(/limit/i);
  });

  it("a missing reason fails to the honest answer, not to a limit", () => {
    // countAiUsage always sends a reason alongside overLimit, so null here
    // means something changed. Claiming a limit would be a guess, and the
    // wrong one costs a customer.
    expect(reasonToClientPayload(null).reason).toBe("unavailable");
  });

  it("never sends an empty message", () => {
    for (const reason of [
      "user_daily",
      "user_burst",
      "global",
      "counter_unavailable",
      null,
    ] as const) {
      expect(reasonToClientPayload(reason).error.length).toBeGreaterThan(10);
    }
  });

  it("never uses an em dash", () => {
    for (const reason of [
      "user_daily",
      "user_burst",
      "global",
      "counter_unavailable",
    ] as const) {
      expect(reasonToClientPayload(reason).error).not.toMatch(/[—–]/);
    }
  });
});

// The mapper only helps if the routes actually use it. This is the same
// route-table-as-fixture trick guardedSegments.test.ts uses: read the
// directory, so a NEW AI tool route that hand-rolls its own refusal wording
// fails the test rather than quietly drifting back to the old behaviour.
const API_DIR = fileURLToPath(new URL("../app/api", import.meta.url));

function routeSource(name: string): string {
  return readFileSync(`${API_DIR}/${name}/route.ts`, "utf8");
}

function toolRoutes(): string[] {
  return readdirSync(API_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    // The two CHAT routes count in their own buckets and speak in full
    // sentences inside the chat bubble, so they keep their own copy.
    .filter((name) => name !== "ask" && name !== "pro-ask")
    .filter((name) => {
      try {
        return routeSource(name).includes("countAiUsage(");
      } catch {
        return false;
      }
    });
}

describe("the AI tool routes", () => {
  it("all eleven map their refusals through one place", () => {
    const routes = toolRoutes();
    expect(routes.length).toBe(11);
    for (const name of routes) {
      expect(routeSource(name)).toContain("reasonToClientPayload");
    }
  });

  it("no longer hand-rolls the counter_unavailable branch", () => {
    // Four routes carried their own copy of this ternary, and the other seven
    // had no branch at all. One mapper replaced both halves of that split.
    for (const name of toolRoutes()) {
      expect(routeSource(name)).not.toContain('reason === "counter_unavailable"');
    }
  });
});
