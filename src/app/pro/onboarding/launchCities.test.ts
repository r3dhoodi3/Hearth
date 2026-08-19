import { describe, expect, it } from "vitest";
import { LAUNCH_CITIES, selectLaunchCities } from "./launchCities";

// The signup service-area seam: two checkboxes in, two stored fields out.
// serves_orange_county is a gate the job board and apply_to_lead both read, so
// the cases that matter most here are the ones that must NOT flip it on.
describe("selectLaunchCities", () => {
  it("offers exactly the two launch cities", () => {
    expect(LAUNCH_CITIES).toEqual(["Huntington Beach", "Fountain Valley"]);
  });

  it("joins both cities in canonical order", () => {
    expect(selectLaunchCities(["Huntington Beach", "Fountain Valley"])).toEqual({
      cities: ["Huntington Beach", "Fountain Valley"],
      serviceArea: "Huntington Beach, Fountain Valley",
      servesOrangeCounty: true,
    });
  });

  it("uses canonical order, not the order the boxes were posted in", () => {
    expect(
      selectLaunchCities(["Fountain Valley", "Huntington Beach"]).serviceArea
    ).toBe("Huntington Beach, Fountain Valley");
  });

  it("accepts Huntington Beach alone", () => {
    expect(selectLaunchCities(["Huntington Beach"])).toEqual({
      cities: ["Huntington Beach"],
      serviceArea: "Huntington Beach",
      servesOrangeCounty: true,
    });
  });

  it("accepts Fountain Valley alone", () => {
    expect(selectLaunchCities(["Fountain Valley"])).toEqual({
      cities: ["Fountain Valley"],
      serviceArea: "Fountain Valley",
      servesOrangeCounty: true,
    });
  });

  it("stores nothing and never attests when no box is checked", () => {
    expect(selectLaunchCities([])).toEqual({
      cities: [],
      serviceArea: null,
      servesOrangeCounty: false,
    });
  });

  it("tolerates whitespace and casing from the form post", () => {
    expect(
      selectLaunchCities(["  fountain valley ", "HUNTINGTON BEACH"]).serviceArea
    ).toBe("Huntington Beach, Fountain Valley");
  });

  it("collapses a duplicated value instead of repeating the city", () => {
    expect(
      selectLaunchCities(["Fountain Valley", "Fountain Valley"])
    ).toEqual({
      cities: ["Fountain Valley"],
      serviceArea: "Fountain Valley",
      servesOrangeCounty: true,
    });
  });

  it("drops a city Hearth does not serve rather than storing it", () => {
    expect(selectLaunchCities(["Irvine", "Huntington Beach"])).toEqual({
      cities: ["Huntington Beach"],
      serviceArea: "Huntington Beach",
      servesOrangeCounty: true,
    });
  });

  it("does not let a crafted post turn junk into an Orange County attestation", () => {
    for (const junk of [["Irvine"], ["All of Orange County"], [""], ["   "]]) {
      const result = selectLaunchCities(junk);
      expect(result.servesOrangeCounty).toBe(false);
      expect(result.serviceArea).toBeNull();
      expect(result.cities).toEqual([]);
    }
  });
});
