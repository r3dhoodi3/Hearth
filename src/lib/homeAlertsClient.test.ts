import { describe, expect, it } from "vitest";
import type { CurrentWeather } from "./homeAlertsClient";

// homeAlertsClient's types are consumed straight off the /api/home-alerts
// JSON response, so there's no runtime logic here to exercise directly.
// These are compile-time shape checks: if CurrentWeather ever drops or
// mistypes a field (in particular `timezone`, which WeatherStrip reads to
// resolve the home's real clock), this file fails `tsc --noEmit` even
// though nothing here throws at runtime.
describe("CurrentWeather shape", () => {
  it("accepts a real geocoded timezone alongside the rest of the payload", () => {
    const weather: CurrentWeather = {
      tempF: 72,
      code: 1,
      isDay: true,
      highF: 80,
      lowF: 60,
      city: "Huntington Beach",
      today: "2026-01-05",
      timezone: "America/Los_Angeles",
      daily: [],
    };
    expect(weather.timezone).toBe("America/Los_Angeles");
  });

  it("accepts a null timezone for a payload where Open-Meteo didn't return one", () => {
    const weather: CurrentWeather = {
      tempF: 72,
      code: 1,
      isDay: true,
      highF: 80,
      lowF: 60,
      city: "Huntington Beach",
      timezone: null,
      daily: [],
    };
    expect(weather.timezone).toBeNull();
  });
});
