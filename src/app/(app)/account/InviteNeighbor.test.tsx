// @vitest-environment jsdom
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import InviteNeighbor from "./InviteNeighbor";

const MOMENT_SEEN_KEY = "hearth_invite_neighbor_moment_seen";

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
});

describe("InviteNeighbor: standing /account card (no moment prop)", () => {
  it("renders unconditionally, with no dismiss button", () => {
    render(<InviteNeighbor code="ABCD1234" />);
    expect(screen.getByText("Invite a neighbor")).toBeInTheDocument();
    expect(
      screen.getByText("Hearth grows street by street. If it's been useful, pass it along.")
    ).toBeInTheDocument();
    expect(screen.queryByText("Not now")).toBeNull();
  });

  it("ignores the moment-seen flag entirely", () => {
    window.localStorage.setItem(MOMENT_SEEN_KEY, "1");
    render(<InviteNeighbor code="ABCD1234" />);
    expect(screen.getByText("Invite a neighbor")).toBeInTheDocument();
  });
});

describe("InviteNeighbor: moment mode", () => {
  it("shows moment-specific copy and a dismiss button the first time", async () => {
    render(<InviteNeighbor code="ABCD1234" moment="plan" />);
    await waitFor(() =>
      expect(screen.getByText(/Your maintenance plan is ready/)).toBeInTheDocument()
    );
    expect(screen.getByText("Not now")).toBeInTheDocument();
  });

  it("renders nothing when the moment was already seen", async () => {
    window.localStorage.setItem(MOMENT_SEEN_KEY, "1");
    const { container } = render(<InviteNeighbor code="ABCD1234" moment="value" />);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it("dismissing marks it seen so a later mount stays hidden", async () => {
    const first = render(<InviteNeighbor code="ABCD1234" moment="plan" />);
    await waitFor(() => expect(screen.getByText("Not now")).toBeInTheDocument());
    fireEvent.click(screen.getByText("Not now"));
    expect(window.localStorage.getItem(MOMENT_SEEN_KEY)).toBe("1");
    first.unmount();

    const second = render(<InviteNeighbor code="ABCD1234" moment="plan" />);
    await waitFor(() => expect(second.container).toBeEmptyDOMElement());
  });

  it("a share also marks it seen, even without native share support", async () => {
    // jsdom has no navigator.share; the component falls back to clipboard.
    Object.defineProperty(window.navigator, "clipboard", {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      configurable: true,
    });
    render(<InviteNeighbor code="ABCD1234" moment="value" />);
    await waitFor(() => expect(screen.getByText("Copy link")).toBeInTheDocument());
    fireEvent.click(screen.getByText("Copy link"));
    await waitFor(() =>
      expect(window.localStorage.getItem(MOMENT_SEEN_KEY)).toBe("1")
    );
  });

  it("uses the plan vs value copy correctly", async () => {
    const valueRender = render(<InviteNeighbor code="X" moment="value" />);
    await waitFor(() =>
      expect(screen.getByText(/Good news on your home's value/)).toBeInTheDocument()
    );
    valueRender.unmount();

    // A fresh "plan" mount still needs its own moment-seen check to resolve
    // before asserting - the previous "value" render never dismissed or
    // shared, so the flag is still unset and this one renders too.
    render(<InviteNeighbor code="X" moment="plan" />);
    await waitFor(() =>
      expect(screen.getByText(/Your maintenance plan is ready/)).toBeInTheDocument()
    );
  });
});
