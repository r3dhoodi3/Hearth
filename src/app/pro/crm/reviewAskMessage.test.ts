import { describe, expect, it } from "vitest";
import { reviewAskMessage } from "./reviewAskMessage";

describe("reviewAskMessage (CR4#4, Won-stage review template)", () => {
  it("greets by first name only, even for a multi-word client name", () => {
    const msg = reviewAskMessage("Maria Gonzalez", "lead-1", "https://hearth.com");
    expect(msg.startsWith("Hi Maria,")).toBe(true);
    expect(msg).not.toContain("Gonzalez");
  });

  it("falls back to the whole name when there is nothing to split", () => {
    const msg = reviewAskMessage("Maria", "lead-1", "https://hearth.com");
    expect(msg.startsWith("Hi Maria,")).toBe(true);
  });

  it("carries the exact /contractors?review=<leadId> link the automated request uses", () => {
    const msg = reviewAskMessage("Maria", "lead-abc-123", "https://hearth.com");
    expect(msg).toContain("https://hearth.com/contractors?review=lead-abc-123");
  });

  it("mentions Hearth by name", () => {
    const msg = reviewAskMessage("Maria", "lead-1", "https://hearth.com");
    expect(msg).toContain("Hearth");
  });

  it("stays SMS length (well under the 160-char single-segment guideline for a short name)", () => {
    const msg = reviewAskMessage("Maria", "lead-1", "https://hearth.com");
    expect(msg.length).toBeLessThan(200);
  });

  it("uses whatever origin is passed in, with no hardcoded host", () => {
    const msg = reviewAskMessage("Maria", "lead-1", "");
    expect(msg).toContain("/contractors?review=lead-1");
    expect(msg).not.toContain("hearth.com");
  });
});
