// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  waitFor,
  cleanup,
  act,
  fireEvent,
} from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import {
  convertTemp,
  formatTemp,
  TEMP_UNIT_STORAGE_KEY,
} from "@/lib/weatherUnits";

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

// A home with a real week attached, for the unit tests below. 72F/80F/60F map
// to 22C/27C/16C, and the daily row carries a null low so the "--" hole keeps
// working once the numbers go through the converter.
const weatherWithWeek = {
  ...realWeather,
  today: "2026-01-05",
  daily: [
    { date: "2026-01-06", code: 0, highF: 68, lowF: null, rainPct: 4 },
  ],
};

beforeEach(() => {
  fetchHomeAlerts.mockReset();
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  // The localStorage-throws test installs a Storage.prototype spy; restoring
  // here keeps a failed assertion from leaking it into the next test.
  vi.restoreAllMocks();
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

describe("temperature conversion", () => {
  it("rounds Fahrenheit through unchanged and converts to whole Celsius", () => {
    expect(convertTemp(72, "F")).toBe(72);
    expect(convertTemp(72.4, "F")).toBe(72);
    expect(convertTemp(32, "C")).toBe(0);
    expect(convertTemp(212, "C")).toBe(100);
    expect(convertTemp(72, "C")).toBe(22);
    expect(convertTemp(-40, "C")).toBe(-40);
  });

  it("renders a missing temperature as a hole in both units", () => {
    expect(formatTemp(null, "F")).toBe("--");
    expect(formatTemp(null, "C")).toBe("--");
    expect(formatTemp(68, "F")).toBe("68°");
    expect(formatTemp(68, "C")).toBe("20°");
  });
});

describe("WeatherStrip units", () => {
  it("defaults to Fahrenheit when nothing has been stored", async () => {
    fetchHomeAlerts.mockResolvedValue({
      weather: [],
      recalls: [],
      current: realWeather,
      hasLocation: true,
    });
    render(<WeatherStrip propertyId="p1" />);
    expect(await screen.findByText("72° Sunny")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Show temperatures in Fahrenheit" })
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("converts the row and the week, and remembers the choice", async () => {
    fetchHomeAlerts.mockResolvedValue({
      weather: [],
      recalls: [],
      current: weatherWithWeek,
      hasLocation: true,
    });
    render(<WeatherStrip propertyId="p1" />);

    // Open the week first, so both the summary row and a daily row are on
    // screen when the unit flips.
    fireEvent.click(await screen.findByRole("button", { name: /forecast/i }));
    const dayRow = screen.getByRole("listitem");
    expect(dayRow).toHaveTextContent("68°");
    expect(dayRow).toHaveTextContent("--");

    fireEvent.click(
      screen.getByRole("button", { name: "Show temperatures in Celsius" })
    );

    expect(screen.getByText("22° Sunny")).toBeInTheDocument();
    expect(screen.getByText(/H 27° L 16°/)).toBeInTheDocument();
    // 68F -> 20C on the daily row, and the null low is still a hole.
    expect(dayRow).toHaveTextContent("20°");
    expect(dayRow).toHaveTextContent("--");
    expect(window.localStorage.getItem(TEMP_UNIT_STORAGE_KEY)).toBe("C");
  });

  it("starts in Celsius when that is what the device remembers", async () => {
    window.localStorage.setItem(TEMP_UNIT_STORAGE_KEY, "C");
    fetchHomeAlerts.mockResolvedValue({
      weather: [],
      recalls: [],
      current: realWeather,
      hasLocation: true,
    });
    render(<WeatherStrip propertyId="p1" />);
    expect(await screen.findByText("22° Sunny")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Show temperatures in Celsius" })
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("falls back to Fahrenheit when localStorage throws", async () => {
    const spy = vi
      .spyOn(Storage.prototype, "getItem")
      .mockImplementation(() => {
        throw new Error("site data blocked");
      });
    fetchHomeAlerts.mockResolvedValue({
      weather: [],
      recalls: [],
      current: realWeather,
      hasLocation: true,
    });
    render(<WeatherStrip propertyId="p1" />);
    expect(await screen.findByText("72° Sunny")).toBeInTheDocument();
    spy.mockRestore();
  });
});
