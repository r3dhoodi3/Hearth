// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, act } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// fetchHomeAlerts is mocked per test so we control exactly what the route
// would have returned, including the hasLocation flag this fix adds.
const fetchHomeAlerts = vi.fn();
vi.mock("@/lib/homeAlertsClient", () => ({
  fetchHomeAlerts: (...args: unknown[]) => fetchHomeAlerts(...args),
}));

import WeatherStrip from "./WeatherStrip";

const realWeather = {
  tempF: 72,
  code: 1,
  isDay: true,
  highF: 80,
  lowF: 60,
  city: "Huntington Beach",
  daily: [],
};

beforeEach(() => {
  fetchHomeAlerts.mockReset();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("WeatherStrip", () => {
  it("shows a skeleton while the fetch is still pending", () => {
    fetchHomeAlerts.mockReturnValue(new Promise(() => {})); // never resolves
    const { container } = render(<WeatherStrip propertyId="p1" />);
    // The skeleton row is the only aria-hidden wrapper rendered up front.
    expect(container.querySelector('[aria-hidden="true"]')).toBeTruthy();
    expect(container.querySelector(".motion-safe\\:animate-pulse")).toBeTruthy();
  });

  it("renders real weather once the fetch resolves", async () => {
    fetchHomeAlerts.mockResolvedValue({
      weather: [],
      recalls: [],
      current: realWeather,
      hasLocation: true,
    });
    render(<WeatherStrip propertyId="p1" />);
    expect(await screen.findByText("Huntington Beach")).toBeInTheDocument();
    expect(screen.getByText("72° Sunny")).toBeInTheDocument();
  });

  // Hypothesis (a): a claimed home with no city/state (a quick test claim,
  // or one made before the zip fallback existed) resolves with current:
  // null and hasLocation: false. The strip must render nothing - not a
  // fallback message, and not a stuck skeleton.
  it("renders nothing when the property has no resolvable location", async () => {
    fetchHomeAlerts.mockResolvedValue({
      weather: [],
      recalls: [],
      current: null,
      hasLocation: false,
    });
    const { container } = render(<WeatherStrip propertyId="p1" />);
    await waitFor(() =>
      expect(container.querySelector(".motion-safe\\:animate-pulse")).toBeNull()
    );
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText("Weather unavailable")).toBeNull();
  });

  // A property WITH a location whose lookup nonetheless failed (upstream
  // Open-Meteo error, etc.) gets a quiet one-line fallback instead of
  // looking broken or silently vanishing.
  it("shows a one-word fallback when the lookup fails for a home that has a location", async () => {
    fetchHomeAlerts.mockResolvedValue({
      weather: [],
      recalls: [],
      current: null,
      hasLocation: true,
    });
    render(<WeatherStrip propertyId="p1" />);
    expect(await screen.findByText("Weather unavailable")).toBeInTheDocument();
  });

  // The fetch itself can hang (a stuck upstream call, a dropped connection).
  // The hard client deadline must end the skeleton on its own even when the
  // fetch never settles, so the strip doesn't get stuck loading forever.
  it("clears the skeleton on its own after the hard deadline even if the fetch hangs", () => {
    vi.useFakeTimers();
    fetchHomeAlerts.mockReturnValue(new Promise(() => {})); // hangs forever
    const { container } = render(<WeatherStrip propertyId="p1" />);
    expect(container.querySelector(".motion-safe\\:animate-pulse")).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(7_999);
    });
    expect(container.querySelector(".motion-safe\\:animate-pulse")).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(2); // crosses the 8s deadline
    });
    expect(container.querySelector(".motion-safe\\:animate-pulse")).toBeNull();
    // No payload ever arrived, so hasLocation stays at its safe default
    // (false): render nothing rather than guess at a fallback message.
    expect(container).toBeEmptyDOMElement();
  });

  // The bug this fixes: the skeleton used to also require
  // document.readyState/window's "load" to not have fired yet, a per-
  // document signal that is already permanently true for the rest of an SPA
  // session after the very first hard load. That made every later
  // client-side navigation back to /dashboard - including the redirect from
  // the profile menu's side switcher - skip the skeleton entirely and render
  // nothing for as long as the fetch took, which on a slow request read as
  // "the weather strip is missing". The skeleton must show regardless of
  // whether the document has already finished loading, for exactly as long
  // as the fetch is genuinely still pending.
  it("still shows the skeleton on a soft navigation, where the document already finished loading before this mount", () => {
    Object.defineProperty(document, "readyState", {
      value: "complete",
      configurable: true,
    });
    fetchHomeAlerts.mockReturnValue(new Promise(() => {})); // never resolves
    const { container } = render(<WeatherStrip propertyId="p1" />);
    expect(container.querySelector(".motion-safe\\:animate-pulse")).toBeTruthy();
  });
});
