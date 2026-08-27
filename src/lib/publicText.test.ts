import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  isAcceptablePublicText,
  ABOUT_REJECTED,
  COMPANY_NAME_REJECTED,
} from "@/lib/publicText";

// contractors.name and contractors.about are unreviewed free text printed
// verbatim on the public /p/<slug> page, the browse cards and every share
// image. The custom-service box got a moderation gate when it shipped; these
// two never had one, which made the business name - the first thing a
// homeowner reads - the largest unmoderated surface on the site.

const CYR_C = String.fromCharCode(0x0441);
const ZWSP = String.fromCharCode(0x200b);

describe("isAcceptablePublicText", () => {
  it("accepts an ordinary business name", () => {
    expect(isAcceptablePublicText("Ramirez Plumbing")).toBe(true);
    expect(isAcceptablePublicText("A-1 Heating & Air, Inc.")).toBe(true);
    expect(isAcceptablePublicText("Costa Mesa Roof Co.")).toBe(true);
  });

  it("accepts an ordinary about section", () => {
    expect(
      isAcceptablePublicText(
        "Family run since 1998. We do repipes, water heaters and slab leaks, and we show up when we say we will."
      )
    ).toBe(true);
  });

  it("accepts an empty value - the caller decides whether a field is required", () => {
    expect(isAcceptablePublicText("")).toBe(true);
    expect(isAcceptablePublicText("   ")).toBe(true);
  });

  it("rejects a name censor() flags", () => {
    expect(isAcceptablePublicText("Best Fucking Plumber")).toBe(false);
    expect(isAcceptablePublicText("Retard Removal Services")).toBe(false);
  });

  it("rejects the same words spelled to dodge the filter", () => {
    expect(isAcceptablePublicText(`Best Fu${CYR_C}king Plumber`)).toBe(false);
    expect(isAcceptablePublicText(`Sh${ZWSP}it Removal Co`)).toBe(false);
  });

  it("rejects an off-platform contact route in the name", () => {
    expect(isAcceptablePublicText("Joe's Plumbing 714-555-0100")).toBe(false);
    expect(isAcceptablePublicText("Joe's Plumbing - joe@example.com")).toBe(
      false
    );
    expect(isAcceptablePublicText("Call 7145550100 for fast service")).toBe(
      false
    );
  });

  it("rejects a contact route buried in the about section", () => {
    expect(
      isAcceptablePublicText(
        "We cover all of Orange County. Skip the app and text us direct at (714) 555-0100 for a faster quote."
      )
    ).toBe(false);
  });

  it("rejects a non-string", () => {
    expect(isAcceptablePublicText(null)).toBe(false);
    expect(isAcceptablePublicText(undefined)).toBe(false);
    expect(isAcceptablePublicText(42)).toBe(false);
  });

  // Every one of these is a real, ordinary business name that the first draft
  // of this gate REFUSED, because censor()'s block lists match a surname as
  // readily as a slur and its suffix expansion invents more ("spic" + "er").
  // A rejected business name blocks the entire profile save and has no appeal
  // path, so these are the cases that decide whether the gate is shippable.
  it("accepts surnames that collide with the block lists", () => {
    expect(isAcceptablePublicText("Dick's Plumbing")).toBe(true);
    expect(isAcceptablePublicText("Van Dyke Drainage")).toBe(true);
    expect(isAcceptablePublicText("Spicer Roofing")).toBe(true);
    expect(isAcceptablePublicText("Coons Heating")).toBe(true);
    // And the same names in a sentence, which is where `about` puts them.
    expect(
      isAcceptablePublicText(
        "Dick Spicer founded Spicer Roofing in 1998. Coons Heating joined us in 2015."
      )
    ).toBe(true);
  });

  it("accepts a garden hoe, which on a home-services site is a tool", () => {
    expect(isAcceptablePublicText("Hoe & Rake Landscaping")).toBe(true);
  });

  // The other false-positive family: digits that are not a phone number. The
  // first draft used redactContact(), whose rule is "any run carrying seven or
  // more digits" - right for masking a stranger's message, wrong here.
  it("accepts digits that are not a phone number", () => {
    expect(isAcceptablePublicText("CSLB #1023456")).toBe(true);
    expect(isAcceptablePublicText("Family owned 2005-2025")).toBe(true);
    expect(
      isAcceptablePublicText("Serving OC since 1998. 250 five-star reviews.")
    ).toBe(true);
    expect(isAcceptablePublicText("Ramirez Plumbing Lic 987654")).toBe(true);
    expect(isAcceptablePublicText("We cover 92646, 92647 and 92648")).toBe(true);
  });

  it("still refuses a real phone number in among those digits", () => {
    // The loosening above must not have opened the door it was guarding.
    expect(isAcceptablePublicText("CSLB #1023456 - call 714-555-0100")).toBe(
      false
    );
    expect(isAcceptablePublicText("Since 1998. Text 7145550100.")).toBe(false);
  });

  it("still refuses the slurs the allowlist was not for", () => {
    // Allowlisting "coons" must not allowlist the bare singular, and no
    // surname exception touches the rest of the list.
    expect(isAcceptablePublicText("Coon Cleaning")).toBe(false);
    expect(isAcceptablePublicText("Retard Removal Services")).toBe(false);
  });
});

describe("the two actions actually call the gate", () => {
  const read = (rel: string) =>
    readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

  it("saveCompanyAction refuses a flagged business name", () => {
    const src = read("../app/pro/actions.ts");
    expect(src).toContain("isAcceptablePublicText");
    expect(src).toContain("COMPANY_NAME_REJECTED");
    expect(src).toMatch(
      /if \(nameChanged && !isAcceptablePublicText\(fields\.name\)\)/
    );
  });

  it("only checks the name when the name actually changed", () => {
    // The check is fatal to the WHOLE save, and this action saves every field
    // on the profile form. Unconditional, it would mean a pro whose stored
    // name the filter dislikes could never save anything again - including the
    // rename that would fix it.
    const src = read("../app/pro/actions.ts");
    expect(src).toContain("const nameChanged = fields.name !== (existing?.name ?? null);");
  });

  it("savePublicPageAction refuses a flagged about section", () => {
    const src = read("../app/pro/profile/actions.ts");
    expect(src).toContain("isAcceptablePublicText");
    expect(src).toContain("ABOUT_REJECTED");
    expect(src).toMatch(
      /if \(aboutChanged && !isAcceptablePublicText\(about\)\)/
    );
    // setFlash writes through Next's async cookie store and every call here is
    // followed by a redirect() that throws immediately, so an un-awaited one
    // races the unwind and the message lands only sometimes.
    expect(src).toContain("await setFlash(ABOUT_REJECTED, \"error\");");
  });

  it("only checks about when about actually changed", () => {
    const src = read("../app/pro/profile/actions.ts");
    expect(src).toContain("const aboutChanged = about !==");
  });

  it("the two messages are distinct and say what to do", () => {
    expect(COMPANY_NAME_REJECTED).not.toBe(ABOUT_REJECTED);
    for (const m of [COMPANY_NAME_REJECTED, ABOUT_REJECTED]) {
      expect(m.length).toBeGreaterThan(20);
      expect(m).toMatch(/public page/);
    }
  });
});
