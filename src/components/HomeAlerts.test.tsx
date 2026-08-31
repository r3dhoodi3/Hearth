// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, act, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// fetchHomeAlerts is mocked per test so we control exactly what the route
// would have returned.
const fetchHomeAlerts = vi.fn();
vi.mock("@/lib/homeAlertsClient", () => ({
  fetchHomeAlerts: (...args: unknown[]) => fetchHomeAlerts(...args),
}));

import HomeAlerts from "./HomeAlerts";

const freezeAlert = {
  kind: "freeze" as const,
  title: "Freeze warning",
  detail: "Temperatures below 32°F expected tonight.",
  url: "https://example.com/notice",
};

beforeEach(() => {
  fetchHomeAlerts.mockReset();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("HomeAlerts", () => {
  it("shows a skeleton while the fetch is still pending", () => {
    fetchHomeAlerts.mockReturnValue(new Promise(() => {})); // never resolves
    const { container } = render(<HomeAlerts propertyId="p1" />);
    expect(container.querySelector('[aria-hidden="true"]')).toBeTruthy();
    expect(container.querySelector(".motion-safe\\:animate-pulse")).toBeTruthy();
  });

  it("renders real alerts once the fetch resolves", async () => {
    fetchHomeAlerts.mockResolvedValue({
      weather: [freezeAlert],
      recalls: [],
      current: null,
      hasLocation: true,
    });
    render(<HomeAlerts propertyId="p1" />);
    expect(await screen.findByText("Freeze warning")).toBeInTheDocument();
  });

  it("renders nothing once loading finishes with zero alerts", async () => {
    fetchHomeAlerts.mockResolvedValue({
      weather: [],
      recalls: [],
      current: null,
      hasLocation: true,
    });
    const { container } = render(<HomeAlerts propertyId="p1" />);
    await waitFor(() =>
      expect(container.querySelector(".motion-safe\\:animate-pulse")).toBeNull()
    );
    expect(container).toBeEmptyDOMElement();
  });

  // The bug this fixes: the skeleton used to also require
  // document.readyState/window's "load" to not have fired yet, a per-
  // document signal that is already permanently true for the rest of an SPA
  // session after the very first hard load. That made every later
  // client-side navigation back to /dashboard (including the redirect from
  // the profile menu's side switcher) skip the skeleton entirely, so a
  // component that mounted with `loading` still true rendered nothing
  // (loading && !pageLoaded was false) for as long as the fetch took -
  // silently dropping freeze/heat/recall alerts until the fetch resolved.
  // The skeleton must show regardless of whether the document has already
  // finished loading, for exactly as long as the fetch is genuinely still
  // pending. Mirrors WeatherStrip.test.tsx's identical regression test.
  it("still shows the skeleton on a soft navigation, where the document already finished loading before this mount", () => {
    Object.defineProperty(document, "readyState", {
      value: "complete",
      configurable: true,
    });
    fetchHomeAlerts.mockReturnValue(new Promise(() => {})); // never resolves
    const { container } = render(<HomeAlerts propertyId="p1" />);
    expect(container.querySelector(".motion-safe\\:animate-pulse")).toBeTruthy();
  });

  // The fetch itself can hang (a stuck upstream call, a dropped connection).
  // The hard client deadline must end the skeleton on its own even when the
  // fetch never settles, so the widget doesn't get stuck loading forever.
  it("clears the skeleton on its own after the hard deadline even if the fetch hangs", () => {
    vi.useFakeTimers();
    fetchHomeAlerts.mockReturnValue(new Promise(() => {})); // hangs forever
    const { container } = render(<HomeAlerts propertyId="p1" />);
    expect(container.querySelector(".motion-safe\\:animate-pulse")).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(7_999);
    });
    expect(container.querySelector(".motion-safe\\:animate-pulse")).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(2); // crosses the 8s deadline
    });
    expect(container.querySelector(".motion-safe\\:animate-pulse")).toBeNull();
    expect(container).toBeEmptyDOMElement();
  });

  it("has a mobile tap target on the notice link, matching the show-more toggle", async () => {
    fetchHomeAlerts.mockResolvedValue({
      weather: [freezeAlert],
      recalls: [],
      current: null,
      hasLocation: true,
    });
    render(<HomeAlerts propertyId="p1" />);
    const link = await screen.findByRole("link", { name: /view the official notice/i });
    expect(link.className).toContain("max-sm:min-h-11");
  });

  it("expands to show the rest of the alerts past the first three", async () => {
    const alerts = Array.from({ length: 5 }, (_, i) => ({
      kind: "recall" as const,
      title: `Recall ${i}`,
      detail: "detail",
    }));
    fetchHomeAlerts.mockResolvedValue({
      weather: [],
      recalls: alerts,
      current: null,
      hasLocation: true,
    });
    render(<HomeAlerts propertyId="p1" />);
    await screen.findByText("Recall 0");
    expect(screen.queryByText("Recall 4")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /show 2 more/i }));
    expect(screen.getByText("Recall 4")).toBeInTheDocument();
  });

  // The same control must close what it opened: the button used to disappear
  // once expanded, leaving no way back to the compact three-alert view.
  it("collapses again when the same button is clicked a second time", async () => {
    const alerts = Array.from({ length: 5 }, (_, i) => ({
      kind: "recall" as const,
      title: `Recall ${i}`,
      detail: "detail",
    }));
    fetchHomeAlerts.mockResolvedValue({
      weather: [],
      recalls: alerts,
      current: null,
      hasLocation: true,
    });
    render(<HomeAlerts propertyId="p1" />);
    await screen.findByText("Recall 0");

    const button = screen.getByRole("button", { name: /show 2 more/i });
    expect(button).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(button);
    expect(screen.getByText("Recall 4")).toBeInTheDocument();
    // Still the same element, now reading "Show fewer" and marked expanded.
    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(button).toHaveTextContent("Show fewer");

    fireEvent.click(button);
    expect(screen.queryByText("Recall 4")).toBeNull();
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(button).toHaveTextContent("Show 2 more");
  });
});
