// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearReviewMoment,
  isNativePlatform,
  readReviewMoment,
  reportReviewMoment,
  requestPlatformReview,
  REVIEW_MOMENT_EVENT,
} from "@/lib/nativeReview";

type CapacitorWindow = Window & {
  Capacitor?: { isNativePlatform?: () => boolean };
};

function pretendNative(on: boolean) {
  const w = window as CapacitorWindow;
  if (on) w.Capacitor = { isNativePlatform: () => true };
  else delete w.Capacitor;
}

beforeEach(() => {
  window.sessionStorage.clear();
  pretendNative(false);
});

afterEach(() => {
  pretendNative(false);
  vi.restoreAllMocks();
});

describe("isNativePlatform", () => {
  it("is false in a plain browser, with no Capacitor global and no dependency", () => {
    expect(isNativePlatform()).toBe(false);
  });

  it("is true only when the Capacitor global says so", () => {
    pretendNative(true);
    expect(isNativePlatform()).toBe(true);
  });

  it("is false for a half-present global rather than throwing", () => {
    (window as CapacitorWindow).Capacitor = {};
    expect(isNativePlatform()).toBe(false);
  });
});

describe("requestPlatformReview", () => {
  it("resolves and does nothing on the web", async () => {
    await expect(requestPlatformReview()).resolves.toBeUndefined();
  });
});

describe("reportReviewMoment", () => {
  it("records the moment and announces it", () => {
    const heard: string[] = [];
    const listener = (e: Event) => {
      heard.push(String((e as CustomEvent).detail));
    };
    window.addEventListener(REVIEW_MOMENT_EVENT, listener);
    reportReviewMoment("job_hired");
    window.removeEventListener(REVIEW_MOMENT_EVENT, listener);

    expect(heard).toEqual(["job_hired"]);
    expect(readReviewMoment()).toBe("job_hired");
  });

  it("survives the redirect that follows a hire", () => {
    // sessionStorage, not React state: the rehire flow lands straight in a new
    // chat thread, so anything held in a component is gone by the time the ask
    // would be considered.
    reportReviewMoment("job_hired");
    expect(window.sessionStorage.getItem("hearth_review_moment")).toBe(
      "job_hired"
    );
  });

  it("reads back nothing for junk, and clears cleanly", () => {
    window.sessionStorage.setItem("hearth_review_moment", "something_else");
    expect(readReviewMoment()).toBeNull();

    reportReviewMoment("plan_built");
    expect(readReviewMoment()).toBe("plan_built");
    clearReviewMoment();
    expect(readReviewMoment()).toBeNull();
  });
});
