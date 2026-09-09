import { describe, it, expect } from "vitest";
import { parseOtherService, withOtherService } from "./otherService";

describe("parseOtherService", () => {
  it("splits a prefixed description", () => {
    expect(
      parseOtherService("Service needed: Chimney sweep. Soot everywhere.")
    ).toEqual({ name: "Chimney sweep", rest: "Soot everywhere." });
  });

  it("handles a prefix with no description after it", () => {
    expect(parseOtherService("Service needed: Chimney sweep")).toEqual({
      name: "Chimney sweep",
      rest: "",
    });
    expect(parseOtherService("Service needed: Chimney sweep.")).toEqual({
      name: "Chimney sweep",
      rest: "",
    });
  });

  it("leaves an unprefixed description alone", () => {
    expect(parseOtherService("The gate is off its hinges")).toEqual({
      name: "",
      rest: "The gate is off its hinges",
    });
    expect(parseOtherService(null)).toEqual({ name: "", rest: "" });
  });

  it("refuses to eat a description whose 'name' is implausible", () => {
    const text = `Service needed: ${"x".repeat(200)}. tail`;
    expect(parseOtherService(text)).toEqual({ name: "", rest: text });
  });
});

describe("withOtherService", () => {
  it("prefixes a description", () => {
    expect(withOtherService("Chimney sweep", "Soot everywhere.")).toBe(
      "Service needed: Chimney sweep. Soot everywhere."
    );
  });

  it("never stacks the prefix across repeated edits", () => {
    const once = withOtherService("Chimney sweep", "Soot everywhere.");
    const twice = withOtherService("Chimney sweep", once);
    const thrice = withOtherService("Chimney sweep", twice);
    expect(thrice).toBe("Service needed: Chimney sweep. Soot everywhere.");
  });

  it("replaces a renamed service instead of appending it", () => {
    const once = withOtherService("Chimney sweep", "Soot everywhere.");
    expect(withOtherService("Fireplace inspection", once)).toBe(
      "Service needed: Fireplace inspection. Soot everywhere."
    );
  });

  it("caps the name at 80 characters", () => {
    const out = withOtherService("y".repeat(200), "tail");
    expect(out).toBe(`Service needed: ${"y".repeat(80)}. tail`);
  });

  it("gives back just the description when there is no name", () => {
    expect(withOtherService("", "Soot everywhere.")).toBe("Soot everywhere.");
    expect(withOtherService(null, "")).toBeNull();
  });
});
