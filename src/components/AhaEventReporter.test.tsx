// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

// docs/ANALYTICS.md: the aha events fire client-side through
// src/lib/analytics.ts's track() (a sendBeacon call). Mocked so these tests
// can assert on the event name without a real navigator.sendBeacon.
const trackCalls: string[] = [];
vi.mock("@/lib/analytics", () => ({
  track: (event: string) => {
    trackCalls.push(event);
  },
}));

import AhaEventReporter from "./AhaEventReporter";
import { AHA_HOME_SCORE, ahaReportedKey } from "@/lib/trackAhaEvents";

beforeEach(() => {
  window.localStorage.clear();
  trackCalls.length = 0;
});

afterEach(() => cleanup());

describe("AhaEventReporter", () => {
  it("renders nothing and reports once eligible", () => {
    const { container } = render(
      <AhaEventReporter event={AHA_HOME_SCORE} eligible />
    );
    expect(container.innerHTML).toBe("");
    expect(trackCalls).toEqual([AHA_HOME_SCORE]);
    expect(
      window.localStorage.getItem(ahaReportedKey(AHA_HOME_SCORE))
    ).toBe("1");
  });

  it("does not report while not eligible", () => {
    render(<AhaEventReporter event={AHA_HOME_SCORE} eligible={false} />);
    expect(trackCalls).toEqual([]);
    expect(window.localStorage.getItem(ahaReportedKey(AHA_HOME_SCORE))).toBeNull();
  });

  it("reports once per account, not once per render", () => {
    render(<AhaEventReporter event={AHA_HOME_SCORE} eligible />);
    cleanup();
    // A second dashboard visit, score still there. A moment that fires every
    // time is a pulse, not a moment.
    render(<AhaEventReporter event={AHA_HOME_SCORE} eligible />);
    expect(trackCalls).toEqual([AHA_HOME_SCORE]);
  });

  it("still reports when localStorage is unavailable", () => {
    const spy = vi
      .spyOn(window.localStorage.__proto__, "getItem")
      .mockImplementation(() => {
        throw new Error("storage disabled");
      });

    render(<AhaEventReporter event={AHA_HOME_SCORE} eligible />);
    // A duplicate report is harmless; a missed one loses the whole signal.
    expect(trackCalls).toEqual([AHA_HOME_SCORE]);

    spy.mockRestore();
  });
});
