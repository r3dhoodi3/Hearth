import { describe, expect, it } from "vitest";
import { isAcceptableCustomCategory } from "@/lib/customCategory";

// The "Other" service box on CategoryPicker is the only free text that reaches
// a public contractor page unreviewed, so both halves of this gate matter: it
// has to keep real trades (the reason the box exists) and refuse the four
// abuses it was added for - off-platform contact details, junk, profanity, and
// a restated canonical category.
describe("isAcceptableCustomCategory", () => {
  it("accepts a plain trade that isn't on the canonical list", () => {
    expect(isAcceptableCustomCategory("Solar panel cleaning")).toBe(true);
    expect(isAcceptableCustomCategory("Pool and spa service")).toBe(true);
    expect(isAcceptableCustomCategory("Crape myrtle trimming")).toBe(true);
  });

  it("rejects a URL", () => {
    expect(isAcceptableCustomCategory("https://cheapfix.example")).toBe(false);
    expect(isAcceptableCustomCategory("Roofing - www.myroof.com")).toBe(false);
    expect(isAcceptableCustomCategory("Visit joesplumbing.net today")).toBe(
      false
    );
  });

  it("rejects an email address", () => {
    expect(isAcceptableCustomCategory("Email joe@joesplumbing.com")).toBe(false);
    expect(isAcceptableCustomCategory("joe (at) joesplumbing.com")).toBe(false);
  });

  it("rejects a phone number", () => {
    expect(isAcceptableCustomCategory("Drywall - call 714-555-0100")).toBe(
      false
    );
    expect(isAcceptableCustomCategory("Fencing (714) 555 0100")).toBe(false);
    expect(isAcceptableCustomCategory("Text me 7145550100")).toBe(false);
    expect(isAcceptableCustomCategory("Fencing +1 714 555 0100")).toBe(false);
    expect(isAcceptableCustomCategory("Roofing 1-714-555-0100")).toBe(false);
    expect(isAcceptableCustomCategory("Tile work (714)555-0100")).toBe(false);
    expect(isAcceptableCustomCategory("Painting 714.555.0100")).toBe(false);
  });

  // The phone rule used to be "seven or more digits with punctuation between
  // them," which is a description of a license number, a pair of ZIP codes and
  // a ZIP+4 as much as of a phone number. Each of these was a rejection an
  // honest pro had no appeal from.
  it("accepts numbers that are not phone numbers", () => {
    expect(isAcceptableCustomCategory("Solar install lic 1234567")).toBe(true);
    expect(isAcceptableCustomCategory("Masonry - license #987654")).toBe(true);
    expect(isAcceptableCustomCategory("Fence repair 92646 92647")).toBe(true);
    expect(isAcceptableCustomCategory("Hauling in 92646-1234")).toBe(true);
    expect(isAcceptableCustomCategory("Restoring homes 1900 to 1975")).toBe(
      true
    );
    // A digits-only run longer than a phone number is an ID, not a number to
    // call, and must not be read as a phone number hiding inside it.
    expect(isAcceptableCustomCategory("Permit 1234567890123 filing")).toBe(
      true
    );
  });

  it("rejects strings with fewer than three letters", () => {
    expect(isAcceptableCustomCategory("!!!")).toBe(false);
    expect(isAcceptableCustomCategory("AC")).toBe(false);
    expect(isAcceptableCustomCategory("$$$ 24 7")).toBe(false);
  });

  it("rejects blank, non-string, and over-cap input", () => {
    expect(isAcceptableCustomCategory("")).toBe(false);
    expect(isAcceptableCustomCategory("   ")).toBe(false);
    expect(isAcceptableCustomCategory(null)).toBe(false);
    expect(isAcceptableCustomCategory(42)).toBe(false);
    expect(isAcceptableCustomCategory("a".repeat(101))).toBe(false);
  });

  it("rejects profanity and slurs", () => {
    expect(isAcceptableCustomCategory("Best fucking plumber")).toBe(false);
    expect(isAcceptableCustomCategory("Escort service")).toBe(false);
  });

  it("catches leetspeak and spaced-out evasion", () => {
    expect(isAcceptableCustomCategory("Sh1t hauling")).toBe(false);
    expect(isAcceptableCustomCategory("f u c k it repairs")).toBe(false);
    expect(isAcceptableCustomCategory("p0rn setup")).toBe(false);
    expect(isAcceptableCustomCategory("e5c0rt service")).toBe(false);
    expect(isAcceptableCustomCategory("Adult w-h-o-r-e house calls")).toBe(
      false
    );
    // Suffixes still apply to a stem long enough to earn them.
    expect(isAcceptableCustomCategory("Escorts, discreet")).toBe(false);
    expect(isAcceptableCustomCategory("Stripper pole installs")).toBe(false);
  });

  // The suffix expansion is what turned this filter on real trades: "chink"
  // plus "ing" is chinking, the job of sealing the gaps between logs on a log
  // home, and "retard" plus "er" is a concrete set retarder. Both are things a
  // mason or a log-home specialist types into the one free-text box they have.
  it("keeps real trade words that collide with the block list", () => {
    expect(isAcceptableCustomCategory("Log home chinking")).toBe(true);
    expect(isAcceptableCustomCategory("Concrete retarder application")).toBe(
      true
    );
    expect(isAcceptableCustomCategory("Dyke and levee maintenance")).toBe(true);
    expect(isAcceptableCustomCategory("Cocker spaniel grooming")).toBe(true);
    expect(isAcceptableCustomCategory("Cockroach and termite work")).toBe(true);
    expect(isAcceptableCustomCategory("Shingles and flashing repair")).toBe(
      true
    );
    expect(isAcceptableCustomCategory("Sheetrock patching")).toBe(true);
    expect(isAcceptableCustomCategory("Asphalt driveway sealing")).toBe(true);
    expect(isAcceptableCustomCategory("Scunthorpe removals")).toBe(true);
  });

  // An allowlisted word buys nothing for the rest of the sentence.
  it("still reads the rest of a string around an allowlisted word", () => {
    expect(isAcceptableCustomCategory("Asphalt - call 714-555-0100")).toBe(
      false
    );
    expect(isAcceptableCustomCategory("Shingles at joesroofing.com")).toBe(
      false
    );
    expect(isAcceptableCustomCategory("Sheetrock and escort service")).toBe(
      false
    );
  });

  // The boundary rule is what keeps the block list from eating real trades:
  // "spicy", "cockroach", "analysis", and "unisex" all contain a blocked term
  // as a substring and all have to survive.
  it("does not match a blocked term inside a legitimate word", () => {
    expect(isAcceptableCustomCategory("Cockroach and termite work")).toBe(true);
    expect(isAcceptableCustomCategory("Soil analysis for planting")).toBe(true);
    expect(isAcceptableCustomCategory("Unisex salon buildouts")).toBe(true);
    expect(isAcceptableCustomCategory("Vacuum system installs")).toBe(true);
  });

  it("rejects a restated canonical category, by value or by label", () => {
    expect(isAcceptableCustomCategory("plumbing")).toBe(false);
    expect(isAcceptableCustomCategory("Plumbing")).toBe(false);
    expect(isAcceptableCustomCategory("garage_door")).toBe(false);
    expect(isAcceptableCustomCategory("Garage door")).toBe(false);
    expect(isAcceptableCustomCategory("Pest & termite control")).toBe(false);
    expect(isAcceptableCustomCategory("Home inspection")).toBe(false);
    // A canonical word plus a real qualifier is still a distinct service.
    expect(isAcceptableCustomCategory("Commercial plumbing")).toBe(true);
  });
});
