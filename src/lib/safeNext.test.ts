import { describe, expect, it } from "vitest";
import { safeNextPath } from "@/lib/safeNext";

describe("safeNextPath", () => {
  it("keeps ordinary relative paths", () => {
    expect(safeNextPath("/dashboard")).toBe("/dashboard");
    expect(safeNextPath("/jobs/123?tab=quotes")).toBe("/jobs/123?tab=quotes");
    expect(safeNextPath("/")).toBe("/");
  });

  it("rejects absolute and protocol-relative URLs", () => {
    expect(safeNextPath("https://evil.com")).toBeNull();
    expect(safeNextPath("//evil.com")).toBeNull();
    expect(safeNextPath("javascript:alert(1)")).toBeNull();
  });

  it("rejects backslash and control-character smuggling", () => {
    // Browsers normalize "/\evil.com" to "//evil.com".
    expect(safeNextPath("/\\evil.com")).toBeNull();
    expect(safeNextPath("/foo\\bar")).toBeNull();
    // The WHATWG URL parser strips C0 controls, so "/\tevil.com" would
    // resolve absolute once handed to new URL().
    expect(safeNextPath("/\t/evil.com")).toBeNull();
    expect(safeNextPath("/\n//evil.com")).toBeNull();
  });

  it("rejects empty and missing values", () => {
    expect(safeNextPath("")).toBeNull();
    expect(safeNextPath(null)).toBeNull();
    expect(safeNextPath(undefined)).toBeNull();
    expect(safeNextPath("dashboard")).toBeNull();
  });
});
