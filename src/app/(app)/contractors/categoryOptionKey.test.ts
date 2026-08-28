import { describe, expect, it } from "vitest";
import { REMODEL_PROJECTS, SERVICE_CATEGORIES } from "@/lib/constants";
import {
  categoryForKey,
  projectKey,
  projectOptions,
} from "./categoryOptionKey";

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

describe("projectOptions", () => {
  // The reported bug: "Garage door" and "Landscaping" each appeared twice in
  // the post-a-job dropdown, once under Services and once under Popular
  // projects, with nothing distinguishing them.
  it("renders every label in the picker exactly once", () => {
    const labels = [
      ...SERVICE_CATEGORIES.map((c) => c.label),
      ...projectOptions().map((p) => p.label),
      "Other (describe it)",
    ].map((l) => l.toLowerCase());
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("drops the project entries that repeat a Services label", () => {
    const projectLabels = projectOptions().map((p) => p.label);
    expect(projectLabels).not.toContain("Garage door");
    expect(projectLabels).not.toContain("Landscaping");
    // Proof this test is testing something: those labels really are in the
    // source list, so the dedupe is what removed them.
    const sourceLabels = REMODEL_PROJECTS.map((p) => p.label);
    expect(sourceLabels).toContain("Garage door");
    expect(sourceLabels).toContain("Landscaping");
  });

  it("keeps projects that merely share a category with a service", () => {
    const projectLabels = projectOptions().map((p) => p.label);
    // Same category as the plain "Plumbing" / "Remodeling" service options,
    // different words - these carry real extra meaning and must survive.
    expect(projectLabels).toContain("Water heater");
    expect(projectLabels).toContain("Kitchen remodel");
    expect(projectLabels).toContain("Bathroom remodel");
  });

  it("keeps every option key unique and still resolvable to its category", () => {
    const options = projectOptions();
    expect(new Set(options.map((o) => o.key)).size).toBe(options.length);
    for (const option of options) {
      const index = Number(option.key.slice("project:".length));
      expect(REMODEL_PROJECTS[index].label).toBe(option.label);
      expect(categoryForKey(option.key)).toBe(REMODEL_PROJECTS[index].category);
    }
  });
});
