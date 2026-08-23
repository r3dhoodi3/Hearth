// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { parseAssistant } from "./AskHearth";

// What the homeowner must never see is raw [[...]] machinery. The assistant
// appends action blocks to the END of a reply, so every failure mode here is
// about a block that is malformed, half-written, or cut off mid-tag.

describe("parseAssistant", () => {
  it("pulls a well-formed block out of the visible text", () => {
    const { text, options } = parseAssistant(
      'Sure, here are some choices.\n[[OPTIONS]]{"options":["Yes","No"]}[[/OPTIONS]]'
    );
    expect(text).toBe("Sure, here are some choices.");
    expect(options).toEqual(["Yes", "No"]);
  });

  it("reads a job block and leaves no markers behind", () => {
    const { text, job } = parseAssistant(
      'I can get you quotes.\n[[POSTJOB]]{"category":"roof","timing":"asap","summary":"Leak"}[[/POSTJOB]]'
    );
    expect(text).toBe("I can get you quotes.");
    expect(job?.category).toBe("roof");
    expect(text).not.toContain("[[");
  });

  // A reply cut off mid-tag (max_tokens, a dropped stream) used to leave the
  // raw fragment sitting in the bubble: every strip rule needed a closing
  // "]]" to match, and there was not one.
  it("strips a trailing unterminated [[ fragment", () => {
    expect(parseAssistant("Change the filter soon.\n[[OPTI").text).toBe(
      "Change the filter soon."
    );
    expect(parseAssistant("Change the filter soon.\n[[").text).toBe(
      "Change the filter soon."
    );
    expect(parseAssistant("Change the filter soon. [[OPTIONS]").text).toBe(
      "Change the filter soon."
    );
    expect(
      parseAssistant('Try that first.\n[[REMINDER]]{"title":"Flush it"').text
    ).toBe("Try that first.");
  });

  it("leaves ordinary text with brackets alone", () => {
    // One bracket is not a marker, and neither is a closed pair of them.
    expect(parseAssistant("Look for a [model] number on the plate.").text).toBe(
      "Look for a [model] number on the plate."
    );
    expect(parseAssistant("Arrays start at index [0] here.").text).toBe(
      "Arrays start at index [0] here."
    );
  });

  it("does not eat a well-formed block's own text as a fragment", () => {
    const { text, options } = parseAssistant(
      'Pick one.\n[[OPTIONS]]{"options":["A"]}[[/OPTIONS]]'
    );
    expect(text).toBe("Pick one.");
    expect(options).toEqual(["A"]);
  });

  it("survives a block with a typo'd closing tag", () => {
    const { text, issue } = parseAssistant(
      'Noted.\n[[LOGISSUE]]{"category":"plumbing","severity":"low","description":"Drip"}[[/LOGISSGUE]]'
    );
    expect(text).toBe("Noted.");
    expect(issue?.category).toBe("plumbing");
    expect(text).not.toContain("[[");
  });

  it("returns plain text untouched", () => {
    expect(parseAssistant("Your water heater is about 12 years old.").text).toBe(
      "Your water heater is about 12 years old."
    );
  });
});
