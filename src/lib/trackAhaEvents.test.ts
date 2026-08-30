import { describe, expect, it } from "vitest";
import { AHA_FIRST_LEAD, AHA_HOME_SCORE, ahaReportedKey } from "@/lib/trackAhaEvents";

describe("ahaReportedKey", () => {
  it("gives each aha event its own storage key", () => {
    expect(ahaReportedKey(AHA_HOME_SCORE)).toBe(
      "hearth_aha_reported:aha_home_score"
    );
    expect(ahaReportedKey(AHA_FIRST_LEAD)).toBe(
      "hearth_aha_reported:aha_first_lead"
    );
    expect(ahaReportedKey(AHA_HOME_SCORE)).not.toBe(
      ahaReportedKey(AHA_FIRST_LEAD)
    );
  });
});
