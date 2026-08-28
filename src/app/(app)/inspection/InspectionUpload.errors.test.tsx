import { describe, expect, it } from "vitest";
import { knownApiError } from "./InspectionUpload";

// knownApiError is the allowlist gate between /api/ingest-inspection's raw
// `error` field and what gets printed to a homeowner: only a message Hearth
// itself wrote is ever shown, so a future exception (a stack trace, an
// internal code) can't slip through verbatim. See ALLOWED_API_ERRORS in
// InspectionUpload.tsx.
describe("knownApiError", () => {
  it("passes through a known server message unchanged", () => {
    const msg = "Add a photo or PDF of the report, or paste its text.";
    expect(knownApiError(msg)).toBe(msg);
  });

  it("matches a known message even with surrounding whitespace", () => {
    const msg = "  One of those images is too large.  ";
    expect(knownApiError(msg)).toBe("One of those images is too large.");
  });

  it("falls back to null for a message not on the allowlist, so the caller uses its own copy", () => {
    expect(knownApiError("Internal server error: stack trace at line 42")).toBeNull();
  });

  it("returns null for a non-string value", () => {
    expect(knownApiError(undefined)).toBeNull();
    expect(knownApiError(null)).toBeNull();
    expect(knownApiError(42)).toBeNull();
  });
});
