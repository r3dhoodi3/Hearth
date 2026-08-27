import { describe, expect, it } from "vitest";
import { LAUNCH_CITY_NAMES } from "@/lib/serviceArea";
import {
  LAUNCH_CITIES,
  LAUNCH_CITY_GROUPS,
  selectLaunchCities,
} from "./launchCities";

// The signup service-area seam: checkboxes in, three stored fields out.
// serves_orange_county is a gate the job board and apply_to_lead both read, so
// the cases that matter most here are the ones that must NOT flip it on.
describe("LAUNCH_CITIES", () => {
  it("is the canonical list from serviceArea, all 36 names", () => {
    expect(LAUNCH_CITIES).toBe(LAUNCH_CITY_NAMES);
    expect(LAUNCH_CITIES).toHaveLength(36);
    // The two original cities and the seven 0126 added are still here.
    for (const city of [
      "Huntington Beach",
      "Fountain Valley",
      "Seal Beach",
      "Westminster",
      "Midway City",
      "Garden Grove",
      "Santa Ana",
      "Costa Mesa",
      "Newport Beach",
    ]) {
      expect(LAUNCH_CITIES).toContain(city);
    }
  });
});

describe("LAUNCH_CITY_GROUPS", () => {
  it("places every launch city in exactly one group, and nothing else", () => {
    const grouped = LAUNCH_CITY_GROUPS.flatMap((g) => [...g.cities]);
    expect(grouped).toHaveLength(LAUNCH_CITIES.length);
    expect(new Set(grouped).size).toBe(grouped.length);
    expect([...grouped].sort()).toEqual([...LAUNCH_CITIES].sort());
  });

  it("has the four regions, each with a label", () => {
    expect(LAUNCH_CITY_GROUPS.map((g) => g.label)).toEqual([
      "North",
      "Central",
      "Coastal",
      "South",
    ]);
  });
});

describe("selectLaunchCities", () => {
  it("joins the two original cities in canonical order", () => {
    expect(selectLaunchCities(["Huntington Beach", "Fountain Valley"])).toEqual({
      cities: ["Fountain Valley", "Huntington Beach"],
      serviceArea: "Fountain Valley, Huntington Beach",
      servesOrangeCounty: true,
    });
  });

  it("uses canonical order, not the order the boxes were posted in", () => {
    expect(
      selectLaunchCities(["Huntington Beach", "Fountain Valley"]).serviceArea
    ).toBe("Fountain Valley, Huntington Beach");
    // Same rule across the whole list: the communities come after every
    // incorporated city no matter when they were clicked.
    expect(
      selectLaunchCities(["Ladera Ranch", "Newport Beach", "Anaheim"]).serviceArea
    ).toBe("Anaheim, Newport Beach, Ladera Ranch");
  });

  it("accepts a single city", () => {
    expect(selectLaunchCities(["Huntington Beach"])).toEqual({
      cities: ["Huntington Beach"],
      serviceArea: "Huntington Beach",
      servesOrangeCounty: true,
    });
  });

  it("accepts any single city on the list as a truthful Orange County attestation", () => {
    // Every launch city is inside Orange County, so checking any one of them
    // on its own is still a truthful serves_orange_county attestation.
    for (const city of LAUNCH_CITIES) {
      expect(selectLaunchCities([city])).toEqual({
        cities: [city],
        serviceArea: city,
        servesOrangeCounty: true,
      });
    }
  });

  it("stores every city when all 36 are checked, which is what the All box posts", () => {
    const result = selectLaunchCities([...LAUNCH_CITIES]);
    expect(result.cities).toEqual([...LAUNCH_CITIES]);
    expect(result.serviceArea).toBe(LAUNCH_CITIES.join(", "));
    expect(result.servesOrangeCounty).toBe(true);
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
    ).toBe("Fountain Valley, Huntington Beach");
    expect(selectLaunchCities([" midway CITY "]).serviceArea).toBe(
      "Midway City"
    );
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

  it("drops a place Hearth does not list rather than storing it", () => {
    // Corona del Mar is inside Newport Beach; Long Beach is another county;
    // North Tustin, Rossmoor and Coto de Caza share a ZIP with a city and are
    // deliberately not pickable (see LAUNCH_COMMUNITIES in serviceArea.ts).
    expect(
      selectLaunchCities([
        "Corona del Mar",
        "Long Beach",
        "North Tustin",
        "Rossmoor",
        "Coto de Caza",
        "Huntington Beach",
      ])
    ).toEqual({
      cities: ["Huntington Beach"],
      serviceArea: "Huntington Beach",
      servesOrangeCounty: true,
    });
  });

  it("does not let a crafted post turn junk into an Orange County attestation", () => {
    // "All of Orange County" is the label on the shortcut checkbox, never a
    // posted value: the component expands it into every city client-side.
    for (const junk of [
      ["Long Beach"],
      ["All of Orange County"],
      ["Orange County"],
      [""],
      ["   "],
    ]) {
      const result = selectLaunchCities(junk);
      expect(result.servesOrangeCounty).toBe(false);
      expect(result.serviceArea).toBeNull();
      expect(result.cities).toEqual([]);
    }
  });
});
