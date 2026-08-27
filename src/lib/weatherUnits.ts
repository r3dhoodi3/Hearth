// Fahrenheit / Celsius preference for the dashboard weather strip.
//
// The API hands us Fahrenheit and only Fahrenheit (tempF, highF, lowF, and the
// per-day highF/lowF), so the unit choice is a pure display concern: nothing
// refetches when it flips. Keeping the conversion and the storage handling in
// one pure module means both can be tested without mounting the strip.
//
// Pattern note: Google's weather card puts a small "°F | °C" pair right on the
// card and remembers the choice; iOS Weather keeps its switcher on the
// forecast list view; AccuWeather buries it in a settings sheet. The card-level
// control is the one that works on a phone without a settings trip, so that is
// what the strip uses. US default is Fahrenheit in all three.

export type TempUnit = "F" | "C";

// Per device, not per account: a unit choice is a property of the phone you
// are holding, and there is no server round trip to justify for it.
export const TEMP_UNIT_STORAGE_KEY = "hearth.weatherUnit";

// Hearth launches in US cities, so Fahrenheit is the honest default rather
// than something derived from the browser locale.
export const DEFAULT_TEMP_UNIT: TempUnit = "F";

// Rounds after converting, never before: rounding the Fahrenheit value first
// and then converting drifts by up to half a degree C for no reason.
// Fahrenheit passes through rounded, since the upstream can send a decimal.
export function convertTemp(tempF: number, unit: TempUnit): number {
  if (unit === "C") return Math.round(((tempF - 32) * 5) / 9);
  return Math.round(tempF);
}

// Null-tolerant display form. Every number on the 7-day panel is nullable -
// the route keeps a row whenever it has a date and fills the rest with nulls
// so rows never shift position - and those holes render as "--" with no
// degree sign, exactly as they did before units were switchable.
export function formatTemp(
  tempF: number | null | undefined,
  unit: TempUnit
): string {
  if (tempF == null || !Number.isFinite(tempF)) return "--";
  return `${convertTemp(tempF, unit)}°`;
}

// Anything other than a stored "C" means Fahrenheit, including a missing key,
// a corrupted value, and a throwing localStorage (Safari private mode, an
// embedded webview with site data blocked). Never throws.
export function readStoredTempUnit(): TempUnit {
  try {
    return window.localStorage.getItem(TEMP_UNIT_STORAGE_KEY) === "C"
      ? "C"
      : DEFAULT_TEMP_UNIT;
  } catch {
    return DEFAULT_TEMP_UNIT;
  }
}

// Best effort. A device that cannot persist still switches units for the
// session; it just forgets on the next load, which beats throwing inside a
// click handler.
export function storeTempUnit(unit: TempUnit): void {
  try {
    window.localStorage.setItem(TEMP_UNIT_STORAGE_KEY, unit);
  } catch {
    // Ignored on purpose - see above.
  }
}
