import { describe, expect, it } from "vitest";
import {
  APP_GUIDE_EXCLUDED_PATHS,
  appGuideSeenKey,
  appGuideSnoozeKey,
  isAppGuideExcludedPath,
  isEligibleForAppGuide,
} from "./appGuide";

const BASE = {
  pathname: "/dashboard",
  onboardingComplete: true,
  seenOnServer: false,
  seenInThisBrowser: false,
};

describe("isAppGuideExcludedPath", () => {
  it("excludes every listed route exactly", () => {
    for (const p of APP_GUIDE_EXCLUDED_PATHS) {
      expect(isAppGuideExcludedPath(p)).toBe(true);
    }
  });

  it("excludes child routes of a listed route", () => {
    expect(isAppGuideExcludedPath("/onboarding/systems")).toBe(true);
    expect(isAppGuideExcludedPath("/pro/onboarding/business")).toBe(true);
    expect(isAppGuideExcludedPath("/emergency/water")).toBe(true);
  });

  it("ignores a query string or hash", () => {
    expect(isAppGuideExcludedPath("/plus?reason=ask")).toBe(true);
    expect(isAppGuideExcludedPath("/dashboard?tab=plan")).toBe(false);
  });

  it("does not exclude a route that merely starts with the same letters", () => {
    expect(isAppGuideExcludedPath("/plusters")).toBe(false);
    expect(isAppGuideExcludedPath("/onboardings")).toBe(false);
  });

  it("allows the ordinary signed-in pages", () => {
    expect(isAppGuideExcludedPath("/dashboard")).toBe(false);
    expect(isAppGuideExcludedPath("/pro")).toBe(false);
    expect(isAppGuideExcludedPath("/account/help")).toBe(false);
  });

  it("fails toward not showing when there is no route yet", () => {
    expect(isAppGuideExcludedPath(null)).toBe(true);
  });
});

describe("isEligibleForAppGuide", () => {
  it("shows for a set-up account that has never seen it, on an ordinary page", () => {
    expect(isEligibleForAppGuide(BASE)).toBe(true);
  });

  it("never shows before onboarding is finished", () => {
    expect(
      isEligibleForAppGuide({ ...BASE, onboardingComplete: false })
    ).toBe(false);
  });

  it("never shows again once the account has been stamped", () => {
    expect(isEligibleForAppGuide({ ...BASE, seenOnServer: true })).toBe(false);
  });

  it("never shows again once this browser has been through it", () => {
    // The localStorage mirror alone is enough, so a stamp that has not landed
    // yet (slow write, migration not applied) cannot show it twice in one
    // session.
    expect(isEligibleForAppGuide({ ...BASE, seenInThisBrowser: true })).toBe(
      false
    );
  });

  it("stays shut for the rest of a session that waved it away", () => {
    // Navigating past the sheet is a "not now", not a "seen": the account is
    // still un-stamped, so a later visit offers it again.
    expect(
      isEligibleForAppGuide({ ...BASE, snoozedInThisSession: true })
    ).toBe(false);
  });

  it("treats a caller that does not track the snooze as not snoozed", () => {
    expect(
      isEligibleForAppGuide({ ...BASE, snoozedInThisSession: undefined })
    ).toBe(true);
  });

  it("never takes over onboarding, a payment screen, or an emergency page", () => {
    for (const pathname of [
      "/onboarding",
      "/pro/onboarding",
      "/plus",
      "/pro/plus",
      "/checkout",
      "/emergency",
      "/emergency-help",
    ]) {
      expect(isEligibleForAppGuide({ ...BASE, pathname })).toBe(false);
    }
  });
});

describe("appGuideSeenKey", () => {
  it("keeps the two sides apart", () => {
    // One account can hold both sides; finishing one guide must not eat the
    // other.
    expect(appGuideSeenKey("homeowner")).toBe("hearth_app_guide_seen");
    expect(appGuideSeenKey("pro")).toBe("hearth_pro_guide_seen");
    expect(appGuideSeenKey("homeowner")).not.toBe(appGuideSeenKey("pro"));
  });
});

describe("appGuideSnoozeKey", () => {
  it("keeps the two sides apart, and never collides with the seen key", () => {
    expect(appGuideSnoozeKey("homeowner")).toBe("hearth_app_guide_snoozed");
    expect(appGuideSnoozeKey("pro")).toBe("hearth_pro_guide_snoozed");
    expect(appGuideSnoozeKey("homeowner")).not.toBe(appGuideSnoozeKey("pro"));
    // A snooze lives in sessionStorage and a seen stamp in localStorage, but
    // the names must not be confusable either: one is temporary, one is not.
    expect(appGuideSnoozeKey("homeowner")).not.toBe(appGuideSeenKey("homeowner"));
    expect(appGuideSnoozeKey("pro")).not.toBe(appGuideSeenKey("pro"));
  });
});
