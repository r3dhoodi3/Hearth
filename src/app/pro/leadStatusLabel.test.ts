import { describe, expect, it } from "vitest";
import { STATUS_LABEL, leadStatusLabel } from "./leadStatusLabel";

// LOW-3: this is the one map both LeadsBoard.tsx's status badge and
// actions.ts's status-change toast read from now, so they can never say two
// different things about the same status.
describe("leadStatusLabel", () => {
  it("matches the exact wording LeadsBoard.tsx's badge shows", () => {
    expect(STATUS_LABEL).toEqual({
      new: "New lead",
      accepted: "Active",
      closed: "Won",
      lost: "Lost",
    });
  });

  it("looks up a known status", () => {
    expect(leadStatusLabel("closed")).toBe("Won");
    expect(leadStatusLabel("lost")).toBe("Lost");
    expect(leadStatusLabel("accepted")).toBe("Active");
    expect(leadStatusLabel("new")).toBe("New lead");
  });

  it("falls back to the raw value for an unknown status rather than throwing", () => {
    expect(leadStatusLabel("something_new")).toBe("something_new");
  });
});
