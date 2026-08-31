// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// GlobalSearch only uses router.push; the rest of next/navigation is
// irrelevant here.
const { push } = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

import GlobalSearch from "./GlobalSearch";

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  push.mockClear();
});

// Focus the box and type. The suggestion list is debounced (~180ms), so
// assertions below use findBy*/waitFor instead of immediate getBy*.
function type(value: string) {
  const input = screen.getByRole("searchbox", { name: "Search" });
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value } });
  return input;
}

describe("GlobalSearch suggestions", () => {
  it("shows a destination and an FAQ hit while typing, and expands the FAQ answer on selection", async () => {
    render(<GlobalSearch />);
    type("trial");

    // The FAQ entry seeded from the pricing page surfaces as a suggestion.
    const faqRow = await screen.findByText("How does the Hearth Plus trial work?");
    // Selecting it expands the answer inline rather than navigating.
    fireEvent.click(faqRow);
    expect(
      screen.getByText(/the first \d+ days cost nothing/)
    ).toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();
  });

  it("navigates to a destination with arrow keys and enter", async () => {
    render(<GlobalSearch />);
    const input = type("post a job");

    await screen.findByText("Post a job");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(push).toHaveBeenCalledWith("/contractors");
  });

  it("closes the dropdown on escape", async () => {
    render(<GlobalSearch />);
    const input = type("post a job");

    await screen.findByText("Post a job");
    fireEvent.keyDown(input, { key: "Escape" });
    // The panel plays a 120ms exit animation before unmounting.
    await waitFor(() => {
      expect(screen.queryByText("Post a job")).toBeNull();
    });
  });

  it("filters by side: the pro box suggests pro destinations and submits to /pro/search", async () => {
    const { container } = render(<GlobalSearch side="pro" />);
    type("leads");

    await screen.findByText("Browse leads");
    // The homeowner-only destinations never leak into the pro box.
    expect(screen.queryByText("Post a job")).toBeNull();

    // Enter with nothing highlighted submits the form to the pro search page.
    const form = container.querySelector("form");
    expect(form).not.toBeNull();
    fireEvent.submit(form as HTMLFormElement);
    expect(push).toHaveBeenCalledWith("/pro/search?q=leads");
  });

  it("offers Ask Hearth when nothing matches", async () => {
    render(<GlobalSearch />);
    type("zzzz qqqq");

    await screen.findByText(/No matches/);
    const ask = screen.getByText(/Ask Hearth: /);
    fireEvent.click(ask);
    expect(push).toHaveBeenCalledWith(
      `/chats?lead=ask-hearth&q=${encodeURIComponent("zzzz qqqq")}`
    );
  });
});
