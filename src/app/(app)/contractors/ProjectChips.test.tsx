// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, render } from "@testing-library/react";
import { REMODEL_PROJECTS } from "@/lib/constants";
import ProjectChips from "./ProjectChips";

// Vitest globals are off in this repo, so testing-library's auto-cleanup never
// wires itself up (see dashboardShape.test.tsx for the same note).
afterEach(() => cleanup());

// The chip row used to be inline JSX on the dashboard only. It is shared now:
// the dashboard renders it above sm, /contractors renders it below sm. If the
// two ever drift the phone shortcut silently stops matching the desktop list,
// which is exactly what pulling it into one component is meant to prevent.
describe("ProjectChips", () => {
  it("renders one chip per remodel project plus Other", () => {
    const { container } = render(<ProjectChips />);
    const links = Array.from(container.querySelectorAll("a"));
    expect(links).toHaveLength(REMODEL_PROJECTS.length + 1);
    expect(links.at(-1)).toHaveTextContent("Other");
  });

  it("points every chip at the Post a job form with its category prefilled", () => {
    const { container } = render(<ProjectChips />);
    const links = Array.from(container.querySelectorAll("a"));
    for (const a of links) {
      expect(a.getAttribute("href")).toMatch(/^\/contractors\?category=/);
      // Phone tap target: 44px minimum, same rule as every other chip row.
      expect(a.className).toContain("max-sm:min-h-11");
    }
    expect(container.querySelector("a")?.getAttribute("href")).toBe(
      `/contractors?category=${REMODEL_PROJECTS[0].category}`
    );
  });
});
