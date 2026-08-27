import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { OC_INCORPORATED_CITIES } from "./ocCities";
import {
  isLaunchZip,
  isOrangeCountyZip,
  launchCityForZip,
  LAUNCH_AREA_LABEL,
  LAUNCH_CITY_BY_ZIP,
  LAUNCH_CITY_NAMES,
  LAUNCH_COMMUNITIES,
  LAUNCH_ONLY_MESSAGE,
  ORANGE_COUNTY_ZIPS,
  OUT_OF_AREA_POST_MESSAGE,
} from "./serviceArea";

// The homeowner-side launch gate. Since 0129 the launch area is all of Orange
// County, so this is no longer a narrower twin of isOrangeCountyZip: every
// Orange County ZIP must map to a city, and nothing outside the county may.
// The same mapping lives in SQL as public.launch_city_for_zip() (migration
// 0129, which widened 0126's nine-city map), and the SQL file is read below
// so the two cannot drift silently.
describe("LAUNCH_CITY_NAMES", () => {
  it("is every incorporated city plus the two communities with their own ZIP, 36 names, no repeats", () => {
    expect(LAUNCH_CITY_NAMES).toEqual([
      ...OC_INCORPORATED_CITIES,
      ...LAUNCH_COMMUNITIES,
    ]);
    expect(LAUNCH_COMMUNITIES).toEqual(["Ladera Ranch", "Midway City"]);
    expect(LAUNCH_CITY_NAMES).toHaveLength(36);
    expect(new Set(LAUNCH_CITY_NAMES).size).toBe(36);
  });

  it("does not offer a community that shares its ZIP with a city", () => {
    // A pro who checked only one of these would see no jobs, ever.
    for (const name of ["North Tustin", "Rossmoor", "Coto de Caza"]) {
      expect(LAUNCH_CITY_NAMES).not.toContain(name);
    }
  });
});

describe("launchCityForZip", () => {
  it("maps every Orange County ZIP to a launch city", () => {
    expect(ORANGE_COUNTY_ZIPS.size).toBeGreaterThan(0);
    for (const zip of ORANGE_COUNTY_ZIPS) {
      expect(launchCityForZip(zip), zip).not.toBeNull();
    }
  });

  it("maps nothing that is not an Orange County ZIP", () => {
    // The two sets are the same set: a mapped ZIP the county list lacks would
    // let a homeowner in whom isOrangeCountyZip still turns away.
    expect(Object.keys(LAUNCH_CITY_BY_ZIP).sort()).toEqual(
      [...ORANGE_COUNTY_ZIPS].sort()
    );
  });

  it("maps every ZIP to a name on the canonical city list", () => {
    for (const city of Object.values(LAUNCH_CITY_BY_ZIP)) {
      expect(LAUNCH_CITY_NAMES).toContain(city);
    }
  });

  it("gives every launch city at least one ZIP", () => {
    // A city on the checkbox list with no ZIP behind it would let a pro claim
    // a city no job can ever match, and a narrowed pick of only that city
    // would be a silently empty board.
    const mapped = new Set(Object.values(LAUNCH_CITY_BY_ZIP));
    for (const city of LAUNCH_CITY_NAMES) {
      expect(mapped.has(city), city).toBe(true);
    }
    expect([...mapped].sort()).toEqual([...LAUNCH_CITY_NAMES].sort());
  });

  it("keeps the 29 mappings 0126 made", () => {
    const from0126: Record<string, string> = {
      "92646": "Huntington Beach",
      "92647": "Huntington Beach",
      "92648": "Huntington Beach",
      "92649": "Huntington Beach",
      "90742": "Huntington Beach",
      "92708": "Fountain Valley",
      "90740": "Seal Beach",
      "90743": "Seal Beach",
      "92683": "Westminster",
      "92655": "Midway City",
      "92840": "Garden Grove",
      "92841": "Garden Grove",
      "92843": "Garden Grove",
      "92844": "Garden Grove",
      "92845": "Garden Grove",
      "92701": "Santa Ana",
      "92703": "Santa Ana",
      "92704": "Santa Ana",
      "92705": "Santa Ana",
      "92706": "Santa Ana",
      "92707": "Santa Ana",
      "92626": "Costa Mesa",
      "92627": "Costa Mesa",
      "92625": "Newport Beach",
      "92657": "Newport Beach",
      "92660": "Newport Beach",
      "92661": "Newport Beach",
      "92662": "Newport Beach",
      "92663": "Newport Beach",
    };
    for (const [zip, city] of Object.entries(from0126)) {
      expect(launchCityForZip(zip), zip).toBe(city);
    }
  });

  it("sends the border and annexed ZIPs to the city that serves them", () => {
    expect(launchCityForZip("92624")).toBe("Dana Point"); // Capistrano Beach
    expect(launchCityForZip("92625")).toBe("Newport Beach"); // Corona del Mar
    expect(launchCityForZip("92610")).toBe("Lake Forest"); // Foothill Ranch
    expect(launchCityForZip("92679")).toBe("Rancho Santa Margarita"); // Coto de Caza / Dove Canyon
    expect(launchCityForZip("92694")).toBe("Ladera Ranch");
    expect(launchCityForZip("92705")).toBe("Santa Ana"); // North Tustin shares it
    expect(launchCityForZip("90742")).toBe("Huntington Beach"); // Sunset Beach
    expect(launchCityForZip("90743")).toBe("Seal Beach"); // Surfside
    expect(launchCityForZip("90720")).toBe("Los Alamitos"); // Rossmoor shares it
    expect(launchCityForZip("92676")).toBe("Orange"); // Silverado, via Santiago Canyon Rd
    expect(launchCityForZip("92678")).toBe("Rancho Santa Margarita"); // Trabuco Canyon
    expect(launchCityForZip("92807")).toBe("Anaheim"); // Anaheim Hills
    expect(launchCityForZip("92832")).toBe("Fullerton");
  });

  it("maps one representative ZIP for each of the cities 0129 added", () => {
    expect(launchCityForZip("92656")).toBe("Aliso Viejo");
    expect(launchCityForZip("92805")).toBe("Anaheim");
    expect(launchCityForZip("92821")).toBe("Brea");
    expect(launchCityForZip("90620")).toBe("Buena Park");
    expect(launchCityForZip("90630")).toBe("Cypress");
    expect(launchCityForZip("92629")).toBe("Dana Point");
    expect(launchCityForZip("92831")).toBe("Fullerton");
    expect(launchCityForZip("92618")).toBe("Irvine");
    expect(launchCityForZip("90631")).toBe("La Habra");
    expect(launchCityForZip("90623")).toBe("La Palma");
    expect(launchCityForZip("92651")).toBe("Laguna Beach");
    expect(launchCityForZip("92653")).toBe("Laguna Hills");
    expect(launchCityForZip("92677")).toBe("Laguna Niguel");
    expect(launchCityForZip("92637")).toBe("Laguna Woods");
    expect(launchCityForZip("92630")).toBe("Lake Forest");
    expect(launchCityForZip("92691")).toBe("Mission Viejo");
    expect(launchCityForZip("92866")).toBe("Orange");
    expect(launchCityForZip("92870")).toBe("Placentia");
    expect(launchCityForZip("92688")).toBe("Rancho Santa Margarita");
    expect(launchCityForZip("92672")).toBe("San Clemente");
    expect(launchCityForZip("92675")).toBe("San Juan Capistrano");
    expect(launchCityForZip("90680")).toBe("Stanton");
    expect(launchCityForZip("92780")).toBe("Tustin");
    expect(launchCityForZip("92861")).toBe("Villa Park");
    expect(launchCityForZip("92886")).toBe("Yorba Linda");
  });

  it("normalizes a ZIP+4 down to its first five digits", () => {
    expect(launchCityForZip("92646-1234")).toBe("Huntington Beach");
    expect(launchCityForZip("92708-0001")).toBe("Fountain Valley");
  });

  it("tolerates surrounding whitespace", () => {
    expect(launchCityForZip("  92647 ")).toBe("Huntington Beach");
    expect(launchCityForZip("\t92708\n")).toBe("Fountain Valley");
  });

  it("returns null for a ZIP outside Orange County", () => {
    // Long Beach, Beverly Hills, Corona, Riverside: neighbors, not the county.
    for (const zip of ["90803", "90210", "92880", "92501"]) {
      expect(isOrangeCountyZip(zip)).toBe(false);
      expect(launchCityForZip(zip)).toBeNull();
    }
  });

  it("returns null for garbage and for empty input", () => {
    for (const junk of ["", "   ", "abcde", "9264", "0", "not a zip"]) {
      expect(launchCityForZip(junk)).toBeNull();
    }
  });

  it("does not let a prototype key masquerade as a launch city", () => {
    // The lookup is a plain object, so a crafted "ZIP" must not resolve to an
    // inherited property.
    expect(launchCityForZip("constructor")).toBeNull();
    expect(launchCityForZip("__proto__")).toBeNull();
  });
});

describe("isLaunchZip", () => {
  it("is true for every launch ZIP", () => {
    for (const zip of Object.keys(LAUNCH_CITY_BY_ZIP)) {
      expect(isLaunchZip(zip)).toBe(true);
    }
  });

  it("agrees with isOrangeCountyZip now that the launch area is the county", () => {
    for (const zip of ORANGE_COUNTY_ZIPS) {
      expect(isLaunchZip(zip)).toBe(true);
    }
    expect(isLaunchZip("90803")).toBe(false);
  });

  it("normalizes the same way launchCityForZip does", () => {
    expect(isLaunchZip("92646-1234")).toBe(true);
    expect(isLaunchZip("  92708  ")).toBe(true);
  });

  it("is false for garbage and for empty input", () => {
    for (const junk of ["", "   ", "abcde", "90210", "12345"]) {
      expect(isLaunchZip(junk)).toBe(false);
    }
  });
});

describe("launch-area copy", () => {
  it("reads as one sentence with the county label", () => {
    expect(LAUNCH_AREA_LABEL).toBe("all of Orange County");
    expect(LAUNCH_ONLY_MESSAGE).toBe(
      "Hearth serves all of Orange County right now. We added you to the " +
        "waitlist and will email you the moment we expand to your area."
    );
    expect(OUT_OF_AREA_POST_MESSAGE).toBe(
      "Hearth pros serve all of Orange County right now, and this home is " +
        "outside that area. We'll email you the moment we expand."
    );
  });
});

// The SQL twin. Migration 0129 carries the same city list (in the CHECK
// constraint and the backfill) and the same ZIP map (in launch_city_for_zip)
// as this module, kept in sync by hand. Reading the file here is what turns
// "by hand" into "and the build fails if you forget".
describe("migration 0129 matches the TypeScript map", () => {
  const sql = readFileSync(
    join(__dirname, "..", "..", "supabase", "migrations", "0129_all_orange_county.sql"),
    "utf8"
  );

  // Every quoted name inside one `array[ ... ]::text[]` block. The migration
  // has three such blocks: the constraint, the backfill's SET, and the
  // backfill's guard; the SET has no ::text[] cast, so it is matched on the
  // `set launch_cities = array[` prefix instead.
  function quotedNames(block: string): string[] {
    return [...block.matchAll(/'((?:[^']|'')+)'/g)].map((m) =>
      m[1].replace(/''/g, "'")
    );
  }

  it("lists exactly the launch cities in the CHECK constraint", () => {
    const m = sql.match(
      /add constraint contractors_launch_cities_subset\s+check \(launch_cities <@ array\[([\s\S]*?)\]::text\[\]\)/
    );
    expect(m).not.toBeNull();
    expect(quotedNames(m![1]).sort()).toEqual([...LAUNCH_CITY_NAMES].sort());
  });

  it("backfills exactly the launch cities, and guards on the same list", () => {
    const set = sql.match(/set launch_cities = array\[([\s\S]*?)\]\s+where/);
    const guard = sql.match(/and not \(launch_cities @> array\[([\s\S]*?)\]::text\[\]\)/);
    expect(set).not.toBeNull();
    expect(guard).not.toBeNull();
    expect(quotedNames(set![1]).sort()).toEqual([...LAUNCH_CITY_NAMES].sort());
    expect(quotedNames(guard![1]).sort()).toEqual([...LAUNCH_CITY_NAMES].sort());
  });

  it("maps every ZIP to the same city launch_city_for_zip does, and no others", () => {
    const fn = sql.match(
      /create or replace function public\.launch_city_for_zip[\s\S]*?\$\$([\s\S]*?)\$\$;/
    );
    expect(fn).not.toBeNull();
    const pairs = [...fn![1].matchAll(/when '(\d{5})' then '((?:[^']|'')+)'/g)];
    const sqlMap: Record<string, string> = {};
    for (const [, zip, city] of pairs) {
      expect(sqlMap[zip], `duplicate ZIP ${zip}`).toBeUndefined();
      sqlMap[zip] = city.replace(/''/g, "'");
    }
    expect(sqlMap).toEqual(LAUNCH_CITY_BY_ZIP);
  });
});
