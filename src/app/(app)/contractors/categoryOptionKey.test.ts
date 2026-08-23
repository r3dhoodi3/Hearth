import { describe, expect, it } from "vitest";
import { REMODEL_PROJECTS } from "@/lib/constants";
import { categoryForKey, projectKey } from "./categoryOptionKey";

describe("categoryOptionKey", () => {
  it("recovers the canonical category from a project key", () => {
    const waterHeaterIndex = REMODEL_PROJECTS.findIndex(
      (p) => p.label === "Water heater"
    );
    expect(waterHeaterIndex).toBeGreaterThanOrEqual(0);
    expect(categoryForKey(projectKey(waterHeaterIndex))).toBe("plumbing");
  });

  it("gives every project option a unique key even when categories repeat", () => {
    const keys = REMODEL_PROJECTS.map((_, i) => projectKey(i));
    expect(new Set(keys).size).toBe(REMODEL_PROJECTS.length);

    // Sanity check the bug this exists to prevent: at least two projects
    // really do share a category (e.g. "Water heater" and the plain
    // "Plumbing" service option both resolve to "plumbing"), yet their keys
    // still differ.
    const categories = REMODEL_PROJECTS.map((p) => p.category);
    expect(new Set(categories).size).toBeLessThan(REMODEL_PROJECTS.length);
  });

  it("passes a plain category value straight through", () => {
    expect(categoryForKey("plumbing")).toBe("plumbing");
    expect(categoryForKey("other")).toBe("other");
    expect(categoryForKey("")).toBe("");
  });

  it("falls back to empty string for an out-of-range project index", () => {
    expect(categoryForKey(projectKey(9999))).toBe("");
  });
});
