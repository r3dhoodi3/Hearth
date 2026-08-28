// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { LAUNCH_CITIES } from "./launchCities";
import LaunchCityCheckboxes from "./LaunchCityCheckboxes";

// Globals are off in vitest.config.ts, so Testing Library's automatic
// unmount never registers; without this every test would see the forms the
// earlier ones rendered.
afterEach(cleanup);

// What the form actually posts, read the way saveCompanyAction and the wizard
// read it: every `service_cities` value in the form, hidden inputs included.
function postedCities(form: HTMLFormElement): string[] {
  return new FormData(form).getAll("service_cities").map(String);
}

function renderInForm(props: Parameters<typeof LaunchCityCheckboxes>[0] = {}) {
  const utils = render(
    <form data-testid="form">
      <LaunchCityCheckboxes {...props} />
    </form>
  );
  return { ...utils, form: screen.getByTestId("form") as HTMLFormElement };
}

describe("LaunchCityCheckboxes", () => {
  it("starts a new pro on All of Orange County and posts every city", () => {
    const { form } = renderInForm();
    expect(screen.getByLabelText("All of Orange County")).toBeChecked();
    expect(postedCities(form)).toEqual([...LAUNCH_CITIES]);
    // The marker that tells saveCompanyAction the question was asked.
    expect(new FormData(form).get("service_cities_present")).toBe("1");
    // Collapsed: no city boxes on screen, just the disclosure.
    expect(screen.queryByLabelText("Irvine")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Pick specific cities instead" })
    ).toBeInTheDocument();
  });

  it("treats a stored pick of every city as All", () => {
    const { form } = renderInForm({ defaultCities: [...LAUNCH_CITIES] });
    expect(screen.getByLabelText("All of Orange County")).toBeChecked();
    expect(postedCities(form)).toEqual([...LAUNCH_CITIES]);
    expect(screen.queryByLabelText("Irvine")).toBeNull();
  });

  it("opens the list and posts only the checked cities once narrowed", () => {
    const { form } = renderInForm();
    fireEvent.click(
      screen.getByRole("button", { name: "Pick specific cities instead" })
    );
    expect(screen.getByLabelText("All of Orange County")).not.toBeChecked();
    // Nothing checked yet, so nothing posts, and every box is required.
    expect(postedCities(form)).toEqual([]);
    expect(screen.getByLabelText("Irvine")).toBeRequired();

    fireEvent.click(screen.getByLabelText("Irvine"));
    fireEvent.click(screen.getByLabelText("Anaheim"));
    expect(postedCities(form).sort()).toEqual(["Anaheim", "Irvine"]);
    expect(screen.getByLabelText("Tustin")).not.toBeRequired();
  });

  it("round-trips a narrowed pick with All unchecked and the list open", () => {
    const { form } = renderInForm({
      defaultCities: ["Huntington Beach", "fountain valley "],
    });
    expect(screen.getByLabelText("All of Orange County")).not.toBeChecked();
    expect(screen.getByLabelText("Huntington Beach")).toBeChecked();
    expect(screen.getByLabelText("Fountain Valley")).toBeChecked();
    expect(screen.getByLabelText("Irvine")).not.toBeChecked();
    expect(postedCities(form).sort()).toEqual([
      "Fountain Valley",
      "Huntington Beach",
    ]);
  });

  it("ignores a stored value that is not a launch city", () => {
    const { form } = renderInForm({ defaultCities: ["Long Beach"] });
    // Nothing valid stored reads as nothing stored: All, collapsed.
    expect(screen.getByLabelText("All of Orange County")).toBeChecked();
    expect(postedCities(form)).toEqual([...LAUNCH_CITIES]);
  });

  it("re-checking All collapses the list and posts every city again", () => {
    const { form } = renderInForm({ defaultCities: ["Irvine"] });
    fireEvent.click(screen.getByLabelText("All of Orange County"));
    expect(screen.queryByLabelText("Irvine")).toBeNull();
    expect(postedCities(form)).toEqual([...LAUNCH_CITIES]);
    // And unchecking it brings the earlier pick back rather than a blank list.
    fireEvent.click(screen.getByLabelText("All of Orange County"));
    expect(screen.getByLabelText("Irvine")).toBeChecked();
    expect(postedCities(form)).toEqual(["Irvine"]);
  });

  it("switching to specific starts every box unchecked when every city was previously stored", () => {
    // Mirrors an onboarding draft resumed after a pro left "All" checked:
    // the draft re-posts every launch city, so defaultCities arrives full
    // rather than empty. Opening the disclosure must still start from zero,
    // not from all 36 pre-checked (the bug testers hit on phone).
    const { form } = renderInForm({ defaultCities: [...LAUNCH_CITIES] });
    fireEvent.click(
      screen.getByRole("button", { name: "Pick specific cities instead" })
    );
    expect(screen.getByLabelText("All of Orange County")).not.toBeChecked();
    expect(screen.getByLabelText("Irvine")).not.toBeChecked();
    expect(screen.getByLabelText("Huntington Beach")).not.toBeChecked();
    expect(postedCities(form)).toEqual([]);
    expect(screen.getByLabelText("Irvine")).toBeRequired();
  });

  it("shows every launch city under one of the four regions when open", () => {
    renderInForm({ defaultCities: ["Irvine"] });
    for (const label of ["North", "Central", "Coastal", "South"]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    for (const city of LAUNCH_CITIES) {
      expect(screen.getByLabelText(city)).toBeInTheDocument();
    }
  });

  it("drops required while the wizard has the step off screen", () => {
    renderInForm({ defaultCities: [], requireOne: false });
    fireEvent.click(
      screen.getByRole("button", { name: "Pick specific cities instead" })
    );
    expect(screen.getByLabelText("Irvine")).not.toBeRequired();
  });
});
