import { describe, expect, it } from "vitest";
import { clientIpFromHeaders } from "./clientIp";

// A minimal Headers-like stand-in so the tests read exactly what the callers
// pass (a real Headers, or Next's ReadonlyHeaders, both satisfy get()).
function h(map: Record<string, string>): Pick<Headers, "get"> {
  return { get: (k: string) => map[k.toLowerCase()] ?? null };
}

describe("clientIpFromHeaders", () => {
  it("prefers Vercel's own header over anything the client can set", () => {
    // The attack: the client prepends its own X-Forwarded-For. Vercel's
    // header is not copied from the client, so it wins outright.
    expect(
      clientIpFromHeaders(
        h({
          "x-vercel-forwarded-for": "203.0.113.7",
          "x-forwarded-for": "9.9.9.9, 203.0.113.7",
        })
      )
    ).toBe("203.0.113.7");
  });

  it("takes the LAST x-forwarded-for hop, never the spoofable first one", () => {
    // "9.9.9.9" is attacker-supplied and sits at the front; the real client
    // IP is the hop the edge appended at the end.
    expect(clientIpFromHeaders(h({ "x-forwarded-for": "9.9.9.9, 198.51.100.4" }))).toBe(
      "198.51.100.4"
    );
  });

  it("returns the single hop when there is only one", () => {
    expect(clientIpFromHeaders(h({ "x-forwarded-for": "198.51.100.4" }))).toBe(
      "198.51.100.4"
    );
  });

  it("falls back to x-real-ip when no forwarded chain is present", () => {
    expect(clientIpFromHeaders(h({ "x-real-ip": "198.51.100.9" }))).toBe(
      "198.51.100.9"
    );
  });

  it("returns null when nothing usable is present", () => {
    expect(clientIpFromHeaders(h({}))).toBeNull();
    expect(clientIpFromHeaders(h({ "x-forwarded-for": "" }))).toBeNull();
    expect(clientIpFromHeaders(h({ "x-forwarded-for": " , " }))).toBeNull();
  });

  it("cannot be tricked by a trailing empty hop", () => {
    // A client appending a trailing comma must not push a blank to the end.
    expect(clientIpFromHeaders(h({ "x-forwarded-for": "203.0.113.7, " }))).toBe(
      "203.0.113.7"
    );
  });
});
