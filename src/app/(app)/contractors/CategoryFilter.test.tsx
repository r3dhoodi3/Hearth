// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import CategoryFilter from "./CategoryFilter";
import { DraftJobProvider } from "./DraftJobContext";

// Vitest globals are off in this repo, so testing-library's auto-cleanup never
// wires itself up (see dashboardShape.test.tsx for the same note).
afterEach(() => cleanup());

// Regression test: a project chip on /contractors sets ?category=x on the
// SAME route. That re-renders the server page with a new `category` prop,
// but a searchParams-only navigation does not remount this component or its
// DraftJobProvider - React reuses both. Before this fix the URL updated and
// the chip highlighted itself while the select underneath silently kept
// showing "Choose what you need".
describe("CategoryFilter", () => {
  it("fills the select when the category prop changes without a remount (DraftJobProvider)", () => {
    const { rerender } = render(
      <DraftJobProvider initialCategory="">
        <CategoryFilter category="" id="job-category" />
      </DraftJobProvider>
    );
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    expect(select.value).toBe("");

    // Simulate the chip's navigation: the parent server component re-renders
    // with the new `category` search param, same component instance.
    rerender(
      <DraftJobProvider initialCategory="plumbing">
        <CategoryFilter category="plumbing" id="job-category" />
      </DraftJobProvider>
    );

    expect(select.value).toBe("plumbing");
    // The hidden field postJobAction actually reads.
    expect(
      (document.querySelector('input[name="category"]') as HTMLInputElement)
        .value
    ).toBe("plumbing");
  });

  it("never overwrites a category the owner already picked themselves", () => {
    const { rerender } = render(
      <DraftJobProvider initialCategory="">
        <CategoryFilter category="" id="job-category" />
      </DraftJobProvider>
    );
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "electrical" } });
    expect(select.value).toBe("electrical");

    // A chip navigation landing after the owner has already chosen something
    // themselves must not stomp on their pick.
    rerender(
      <DraftJobProvider initialCategory="plumbing">
        <CategoryFilter category="plumbing" id="job-category" />
      </DraftJobProvider>
    );

    expect(select.value).toBe("electrical");
  });

  it("fills the select without a DraftJobProvider too (standalone use, e.g. EditJobForm)", () => {
    const { rerender } = render(
      <CategoryFilter category="" id="job-category" />
    );
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    expect(select.value).toBe("");

    rerender(<CategoryFilter category="roof" id="job-category" />);
    expect(select.value).toBe("roof");
  });
});
