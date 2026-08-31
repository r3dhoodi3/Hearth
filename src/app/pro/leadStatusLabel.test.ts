import { describe, expect, it } from "vitest";
import {
  STATUS_LABEL,
  TERMINAL_LEAD_STATUSES,
  isTerminalLeadStatus,
  leadStatusLabel,
} from "./leadStatusLabel";

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

// The Active / Closed split both Messages inboxes filter on. It lives next to
// STATUS_LABEL so the vocabulary and its classification cannot drift: if a
// status is ever added to or removed from the JobStatusSelect vocabulary,
// these assertions force whoever does it to decide which tab it belongs to.
describe("isTerminalLeadStatus", () => {
  it("only classifies statuses that exist in the shared vocabulary", () => {
    for (const status of TERMINAL_LEAD_STATUSES) {
      expect(Object.keys(STATUS_LABEL)).toContain(status);
    }
  });

  it("splits the full vocabulary the way the pro pipeline does", () => {
    // closed ("Won") and lost are over; new and accepted are still going.
    // Same pair as pro/page.tsx's activeCount and pro/leads/page.tsx's isDone.
    const split = Object.fromEntries(
      Object.keys(STATUS_LABEL).map((s) => [s, isTerminalLeadStatus(s)])
    );
    expect(split).toEqual({
      new: false,
      accepted: false,
      closed: true,
      lost: true,
    });
  });

  it("treats anything unknown as active, because hiding a chat is worse", () => {
    expect(isTerminalLeadStatus("something_new")).toBe(false);
    expect(isTerminalLeadStatus(null)).toBe(false);
    expect(isTerminalLeadStatus(undefined)).toBe(false);
  });
});
