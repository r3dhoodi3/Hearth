// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

import ReviewMomentReporter from "./ReviewMomentReporter";
import { readReviewMoment, REVIEW_MOMENT_EVENT } from "@/lib/nativeReview";

afterEach(() => cleanup());

beforeEach(() => {
  window.sessionStorage.clear();
});

describe("ReviewMomentReporter", () => {
  it("reports the moment on mount and renders nothing", () => {
    const heard: string[] = [];
    const onMoment = (e: Event) =>
      heard.push(String((e as CustomEvent).detail));
    window.addEventListener(REVIEW_MOMENT_EVENT, onMoment);

    const { container } = render(<ReviewMomentReporter moment="plan_built" />);

    expect(container.innerHTML).toBe("");
    expect(readReviewMoment()).toBe("plan_built");
    expect(heard).toEqual(["plan_built"]);

    window.removeEventListener(REVIEW_MOMENT_EVENT, onMoment);
  });

  it("reports once per session, not once per dashboard visit", () => {
    const heard: string[] = [];
    const onMoment = () => heard.push("x");
    window.addEventListener(REVIEW_MOMENT_EVENT, onMoment);

    render(<ReviewMomentReporter moment="plan_built" />);
    cleanup();
    // A second visit to the dashboard, plan still there. A moment that fires
    // on every render is a pulse, not a moment.
    render(<ReviewMomentReporter moment="plan_built" />);

    expect(heard).toHaveLength(1);
    window.removeEventListener(REVIEW_MOMENT_EVENT, onMoment);
  });

  it("still reports when sessionStorage is unavailable", () => {
    const heard: string[] = [];
    const onMoment = () => heard.push("x");
    window.addEventListener(REVIEW_MOMENT_EVENT, onMoment);

    const spy = vi
      .spyOn(window.sessionStorage.__proto__, "getItem")
      .mockImplementation(() => {
        throw new Error("storage disabled");
      });

    render(<ReviewMomentReporter moment="plan_built" />);
    // A duplicate moment is harmless; a missed one is a lost ask.
    expect(heard).toHaveLength(1);

    spy.mockRestore();
    window.removeEventListener(REVIEW_MOMENT_EVENT, onMoment);
  });
});
