// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import RememberedDetails from "./RememberedDetails";

// Vitest globals are off in this repo, so testing-library's auto cleanup never
// wires itself up.
afterEach(() => cleanup());

beforeEach(() => {
  window.localStorage.clear();
});

const KEY = "hearth_details_closed_this-month-user-1";

function renderIt(props: { forceOpen?: boolean } = {}) {
  return render(
    <RememberedDetails
      storageKey="this-month-user-1"
      testId="remembered"
      {...props}
    >
      <summary>See this month&apos;s tasks</summary>
      <p>Task list</p>
    </RememberedDetails>
  );
}

function details(): HTMLDetailsElement {
  return screen.getByTestId("remembered") as HTMLDetailsElement;
}

describe("RememberedDetails", () => {
  it("is open on a first visit, with nothing in storage", () => {
    renderIt();
    expect(details().open).toBe(true);
  });

  it("remembers a close and applies it on the next visit", () => {
    renderIt();
    // Closing it is the user's own act, which is the only thing that may make
    // it start closed later.
    const el = details();
    el.open = false;
    fireEvent(el, new Event("toggle", { bubbles: false }));
    expect(window.localStorage.getItem(KEY)).toBe("1");

    cleanup();
    renderIt();
    expect(details().open).toBe(false);
  });

  it("forgets the close as soon as the user opens it again", () => {
    window.localStorage.setItem(KEY, "1");
    renderIt();
    const el = details();
    expect(el.open).toBe(false);

    el.open = true;
    fireEvent(el, new Event("toggle", { bubbles: false }));
    expect(window.localStorage.getItem(KEY)).toBeNull();

    cleanup();
    renderIt();
    expect(details().open).toBe(true);
  });

  it("forceOpen wins over a remembered close and clears it", () => {
    window.localStorage.setItem(KEY, "1");
    renderIt({ forceOpen: true });
    expect(details().open).toBe(true);
    // ?plan=open is an explicit "show me": leaving the flag would snap it shut
    // again on the very next visit, which reads as the link not working.
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });

  it("keys the flag by the storageKey, so one user's close is not another's", () => {
    window.localStorage.setItem("hearth_details_closed_this-month-user-2", "1");
    renderIt();
    expect(details().open).toBe(true);
  });
});
