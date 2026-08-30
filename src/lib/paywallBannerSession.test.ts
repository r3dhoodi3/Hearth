import { describe, it, expect } from "vitest";
import {
  PAYWALL_BANNER_SESSION_CAP,
  recordPaywallBannerSeen,
  shouldShowPaywallBanner,
} from "@/lib/paywallBannerSession";

describe("shouldShowPaywallBanner", () => {
  it("shows the first three distinct reasons in a session", () => {
    let seen: string[] = [];
    expect(shouldShowPaywallBanner(seen, "job_limit")).toBe(true);
    seen = recordPaywallBannerSeen(seen, "job_limit");

    expect(shouldShowPaywallBanner(seen, "forecast")).toBe(true);
    seen = recordPaywallBannerSeen(seen, "forecast");

    expect(shouldShowPaywallBanner(seen, "quote")).toBe(true);
    seen = recordPaywallBannerSeen(seen, "quote");

    expect(seen).toHaveLength(PAYWALL_BANNER_SESSION_CAP);
  });

  it("stands down from the 4th distinct reason on", () => {
    const seen = ["job_limit", "forecast", "quote"];
    expect(shouldShowPaywallBanner(seen, "ask")).toBe(false);
    expect(shouldShowPaywallBanner(seen, "documents")).toBe(false);
  });

  it("keeps showing a reason already seen, even past the cap", () => {
    const seen = ["job_limit", "forecast", "quote"];
    // Revisiting the first one hit does not cost a slot: it is not a NEW
    // distinct reason, so the banner still renders.
    expect(shouldShowPaywallBanner(seen, "job_limit")).toBe(true);
  });

  it("never grows the seen list past what was actually distinct", () => {
    let seen: string[] = ["job_limit"];
    seen = recordPaywallBannerSeen(seen, "job_limit");
    expect(seen).toEqual(["job_limit"]);

    seen = recordPaywallBannerSeen(seen, "forecast");
    expect(seen).toEqual(["job_limit", "forecast"]);
  });

  it("starts empty and allows the very first reason", () => {
    expect(shouldShowPaywallBanner([], "value")).toBe(true);
  });
});
