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

// document.readyState is "complete" by default in jsdom, which would make
// pageLoaded flip true on mount and mask the exact bug this component was
// fixed for (a permanently-stuck skeleton when window's "load" event never
// fires). Force it back to "loading" for every test and restore afterward,
// so `loading && !pageLoaded` behaves the way it does on a real cold
// navigation unless a test explicitly fires "load" itself.
function setReadyState(value: DocumentReadyState) {
  Object.defineProperty(document, "readyState", {
    value,
    configurable: true,
  });
}

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
  setReadyState("loading");
  fetchHomeAlerts.mockReset();
});

afterEach(() => {
  cleanup();
  setReadyState("complete");
  vi.useRealTimers();
});

describe("WeatherStrip", () => {
  it("shows a skeleton while both the page and the fetch are still pending", () => {
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

  // The bug: on a cold navigation, window's "load" event can be delayed or
  // never fire (a slow/hung resource elsewhere on the page), which alone
  // would leave `loading && !pageLoaded` true forever regardless of how
  // fast the fetch itself resolves. The hard client deadline must end the
  // skeleton on its own even when "load" never comes and the fetch never
  // settles either.
  it("clears the skeleton on its own after the hard deadline even if load never fires and the fetch hangs", () => {
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

  it("skips the skeleton once the page has already finished loading, even before the fetch resolves", () => {
    setReadyState("complete");
    fetchHomeAlerts.mockReturnValue(new Promise(() => {}));
    const { container } = render(<WeatherStrip propertyId="p1" />);
    expect(container).toBeEmptyDOMElement();
  });
});
