import { describe, expect, it } from "vitest";
import { PREVIEW_MAX_CHARS, plainPreview } from "./previewText";

describe("plainPreview strips machine-readable blocks", () => {
  it("removes an OPTIONS block, payload and all", () => {
    expect(
      plainPreview(
        'Here is what I would do. [[OPTIONS]]{"options":["Call a pro","Do it myself"]}[[/OPTIONS]]'
      )
    ).toBe("Here is what I would do.");
  });

  it("removes POSTJOB, LOGISSUE and REMINDER blocks", () => {
    expect(
      plainPreview(
        'Sounds like a plumber. [[POSTJOB]]{"category":"plumbing","timing":"asap","summary":"Leak"}[[/POSTJOB]]'
      )
    ).toBe("Sounds like a plumber.");
    expect(
      plainPreview('Logged it. [[LOGISSUE]]{"title":"Leak"}[[/LOGISSUE]]')
    ).toBe("Logged it.");
    expect(
      plainPreview('Set for May. [[REMINDER]]{"when":"2026-05-01"}[[/REMINDER]]')
    ).toBe("Set for May.");
  });

  it("removes an unterminated opener from a reply cut off mid-tag", () => {
    expect(plainPreview("Check the filter first. [[OPTI")).toBe(
      "Check the filter first."
    );
  });

  it("removes a stray marker with no payload", () => {
    expect(plainPreview("All set. [[/OPTIONS]]")).toBe("All set.");
  });

  it("returns an empty string when the block was the whole message", () => {
    expect(plainPreview('[[OPTIONS]]{"options":["Yes","No"]}[[/OPTIONS]]')).toBe("");
  });
});

describe("plainPreview strips basic markdown", () => {
  it("drops emphasis markers but keeps the words", () => {
    expect(plainPreview("**Here's what I'd do:** check the *shutoff* valve")).toBe(
      "Here's what I'd do: check the shutoff valve"
    );
  });

  it("drops an unclosed emphasis marker from a streaming reply", () => {
    expect(plainPreview("**Start here")).toBe("Start here");
  });

  it("drops backticks, headings, quotes and list markers", () => {
    expect(plainPreview("Run `npm test` first")).toBe("Run npm test first");
    expect(plainPreview("## Your options\n- Call a pro\n- Wait")).toBe(
      "Your options Call a pro Wait"
    );
    expect(plainPreview("1. Shut the water off\n2. Call a pro")).toBe(
      "Shut the water off Call a pro"
    );
    expect(plainPreview("> Quoted line")).toBe("Quoted line");
  });

  it("keeps a link's label and drops its target", () => {
    expect(plainPreview("See [the guide](/learn/water) for more")).toBe(
      "See the guide for more"
    );
  });

  it("keeps a hyphen inside a sentence", () => {
    expect(plainPreview("It is a well-known fix")).toBe("It is a well-known fix");
  });
});

describe("plainPreview collapses and truncates", () => {
  it("collapses newlines and runs of whitespace to single spaces", () => {
    expect(plainPreview("Line one\n\n  Line   two")).toBe("Line one Line two");
  });

  it("truncates past the limit and marks it", () => {
    const long = "word ".repeat(80).trim();
    const out = plainPreview(long);
    expect(out.length).toBeLessThanOrEqual(PREVIEW_MAX_CHARS + 1);
    expect(out.endsWith("…")).toBe(true);
  });

  it("honours a caller's own limit", () => {
    const out = plainPreview("one two three four five six seven", 12);
    expect(out).toBe("one two thre…");
    expect(plainPreview("alpha beta gamma delta", 14)).toBe("alpha beta…");
  });

  it("leaves a short message untouched and unmarked", () => {
    expect(plainPreview("Thanks, see you Tuesday")).toBe("Thanks, see you Tuesday");
  });

  it("returns an empty string for nothing at all", () => {
    expect(plainPreview("")).toBe("");
    expect(plainPreview(null)).toBe("");
    expect(plainPreview(undefined)).toBe("");
  });
});
