// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import PaywallReasonBanner from "./PaywallReasonBanner";

function clearCookies() {
  document.cookie.split(";").forEach((c) => {
    const name = c.split("=")[0].trim();
    if (name) document.cookie = `${name}=; max-age=0; path=/`;
  });
}

beforeEach(() => {
  window.sessionStorage.clear();
  clearCookies();
});

afterEach(() => {
  cleanup();
});

describe("PaywallReasonBanner", () => {
  it("renders its children on the first hit of a reason", () => {
    render(
      <PaywallReasonBanner reason="forecast">
        <p>Forecast pitch</p>
      </PaywallReasonBanner>
    );
    expect(screen.getByText("Forecast pitch")).toBeInTheDocument();
  });

  it("sets the hearth_last_reason cookie to this reason", () => {
    render(
      <PaywallReasonBanner reason="quote">
        <p>Quote pitch</p>
      </PaywallReasonBanner>
    );
    expect(document.cookie).toContain("hearth_last_reason=quote");
  });

  it("keeps showing the first three distinct reasons in a session", () => {
    render(
      <PaywallReasonBanner reason="job_limit">
        <p>1</p>
      </PaywallReasonBanner>
    );
    cleanup();
    render(
      <PaywallReasonBanner reason="forecast">
        <p>2</p>
      </PaywallReasonBanner>
    );
    cleanup();
    render(
      <PaywallReasonBanner reason="quote">
        <p>3</p>
      </PaywallReasonBanner>
    );
    expect(screen.getByText("3")).toBeInTheDocument();
  });

  it("stands down from the 4th distinct reason of a session, without touching the lock underneath", () => {
    for (const reason of ["job_limit", "forecast", "quote"]) {
      render(
        <PaywallReasonBanner reason={reason}>
          <p>pitch</p>
        </PaywallReasonBanner>
      );
      cleanup();
    }
    render(
      <PaywallReasonBanner reason="ask">
        <p>4th pitch</p>
      </PaywallReasonBanner>
    );
    expect(screen.queryByText("4th pitch")).not.toBeInTheDocument();
    // The cookie is still written even when the banner itself stands down -
    // the dashboard tile order and the session cap are two different rules.
    expect(document.cookie).toContain("hearth_last_reason=ask");
  });

  it("still shows a reason already seen this session, even past the cap", () => {
    for (const reason of ["job_limit", "forecast", "quote", "ask"]) {
      render(
        <PaywallReasonBanner reason={reason}>
          <p>pitch-{reason}</p>
        </PaywallReasonBanner>
      );
      cleanup();
    }
    // job_limit was the 1st of the three counted slots, so revisiting it
    // still renders even after a 4th distinct reason has already stood down.
    render(
      <PaywallReasonBanner reason="job_limit">
        <p>revisit</p>
      </PaywallReasonBanner>
    );
    expect(screen.getByText("revisit")).toBeInTheDocument();
  });
});
