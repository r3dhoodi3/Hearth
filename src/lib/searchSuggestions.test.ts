import { describe, expect, it } from "vitest";
import {
  DESTINATIONS,
  matchDestinations,
  matchFaq,
  matchesQuery,
} from "./searchSuggestions";
import { FAQ_INDEX } from "./faqIndex";

describe("matchesQuery", () => {
  it("matches on a bare prefix from the first keystrokes", () => {
    expect(matchesQuery("dep", "Deposits and billing", [])).toBe(true);
    expect(matchesQuery("d", "Deposits and billing", [])).toBe(true);
  });

  it("matches keywords, not just the visible label", () => {
    expect(matchesQuery("wallet", "Deposits and billing", ["wallet", "balance"])).toBe(true);
  });

  it("requires every typed token to match something (AND, not OR)", () => {
    expect(matchesQuery("post job", "Post a job", ["quote"])).toBe(true);
    expect(matchesQuery("post zebra", "Post a job", ["quote"])).toBe(false);
  });

  it("matches longer tokens inside compound words", () => {
    expect(matchesQuery("heater", "waterheater manual", [])).toBe(true);
  });

  it("matches a plural query against a singular keyword", () => {
    expect(matchesQuery("leads", "How much does a lead cost?", ["lead", "fee"])).toBe(true);
  });

  it("never matches an empty or whitespace query", () => {
    expect(matchesQuery("", "Anything", [])).toBe(false);
    expect(matchesQuery("   ", "Anything", [])).toBe(false);
  });
});

describe("matchDestinations", () => {
  it("finds the homeowner Post a job destination", () => {
    const hits = matchDestinations("post", "homeowner");
    expect(hits.map((h) => h.label)).toContain("Post a job");
  });

  it("filters by side: pro-only rows never leak into homeowner results", () => {
    const homeowner = matchDestinations("leads", "homeowner");
    expect(homeowner.map((h) => h.href)).not.toContain("/pro/leads");
    const pro = matchDestinations("leads", "pro");
    expect(pro.map((h) => h.href)).toContain("/pro/leads");
  });

  it("caps results at the limit", () => {
    // "a" prefix-matches broadly; whatever it returns must respect the cap.
    expect(matchDestinations("a", "homeowner", 3).length).toBeLessThanOrEqual(3);
  });

  it("finds pro deposits by keyword", () => {
    const hits = matchDestinations("deposit", "pro");
    expect(hits.map((h) => h.href)).toContain("/pro/billing");
  });
});

describe("matchFaq", () => {
  it("finds the trial entry on the homeowner side", () => {
    const hits = matchFaq("trial", "homeowner");
    expect(hits.map((h) => h.question)).toContain("How does the Hearth Plus trial work?");
  });

  it("finds ghost protection on the pro side only", () => {
    const pro = matchFaq("ghost", "pro");
    expect(pro.map((h) => h.question)).toContain("What if the homeowner never responds?");
    expect(matchFaq("ghost", "homeowner")).toHaveLength(0);
  });

  it("surfaces both-sided entries on either side", () => {
    const q = "switch business";
    expect(matchFaq(q, "homeowner").map((h) => h.question)).toContain(
      "How do I switch between my home and my business?"
    );
    expect(matchFaq(q, "pro").map((h) => h.question)).toContain(
      "How do I switch between my home and my business?"
    );
  });

  it("returns nothing for an empty query", () => {
    expect(matchFaq("", "homeowner")).toHaveLength(0);
  });
});

describe("registry and FAQ index sanity", () => {
  it("keeps the FAQ index small enough to ship in the bundle", () => {
    expect(FAQ_INDEX.length).toBeGreaterThanOrEqual(15);
    expect(FAQ_INDEX.length).toBeLessThanOrEqual(25);
  });

  it("gives every FAQ entry a real question, answer, and valid side", () => {
    for (const f of FAQ_INDEX) {
      expect(f.question.trim().length).toBeGreaterThan(0);
      expect(f.answer.trim().length).toBeGreaterThan(0);
      expect(["homeowner", "pro", "both"]).toContain(f.side);
    }
  });

  it("keeps pro hrefs under /pro and homeowner hrefs out of it", () => {
    for (const d of DESTINATIONS) {
      if (d.side === "pro") expect(d.href.startsWith("/pro")).toBe(true);
      if (d.side === "homeowner") expect(d.href.startsWith("/pro")).toBe(false);
    }
    for (const f of FAQ_INDEX) {
      if (!f.href) continue;
      if (f.side === "pro") expect(f.href.startsWith("/pro")).toBe(true);
      if (f.side === "homeowner") expect(f.href.startsWith("/pro")).toBe(false);
    }
  });

  it("bans em dashes from every question and answer (house rule)", () => {
    for (const f of FAQ_INDEX) {
      expect(f.question).not.toContain("—");
      expect(f.answer).not.toContain("—");
    }
  });
});
