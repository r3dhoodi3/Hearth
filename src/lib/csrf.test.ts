import { describe, expect, it } from "vitest";
import { isSameOrigin, sameOriginGuard } from "./csrf";

function req(headers: Record<string, string>): Request {
  return new Request("https://gethearth.vercel.app/api/ask", {
    method: "POST",
    headers,
  });
}

describe("isSameOrigin", () => {
  it("accepts the app's own fetches", () => {
    expect(
      isSameOrigin(
        req({
          host: "gethearth.vercel.app",
          origin: "https://gethearth.vercel.app",
          "sec-fetch-site": "same-origin",
        })
      )
    ).toBe(true);
  });

  it("accepts a request the user started themselves", () => {
    // sec-fetch-site: none is a typed URL or a bookmark, never a page on
    // another site posting on the user's behalf.
    expect(isSameOrigin(req({ host: "gethearth.vercel.app", "sec-fetch-site": "none" }))).toBe(
      true
    );
  });

  it("refuses a post the browser says came from another site", () => {
    expect(
      isSameOrigin(
        req({
          host: "gethearth.vercel.app",
          origin: "https://evil.example",
          "sec-fetch-site": "cross-site",
        })
      )
    ).toBe(false);
  });

  it("refuses on a mismatched Origin when Sec-Fetch-Site is absent", () => {
    // Older Safari sends no Sec-Fetch-Site; Origin is the fallback.
    expect(
      isSameOrigin(
        req({ host: "gethearth.vercel.app", origin: "https://evil.example" })
      )
    ).toBe(false);
  });

  it("uses x-forwarded-host, which is what Vercel sets", () => {
    // Behind the proxy the Host header is the internal one, so comparing
    // against it would refuse every real request.
    expect(
      isSameOrigin(
        req({
          host: "internal.vercel.internal",
          "x-forwarded-host": "gethearth.vercel.app",
          origin: "https://gethearth.vercel.app",
        })
      )
    ).toBe(true);
  });

  it("takes the first entry when a proxy chain comma-joins the host", () => {
    expect(
      isSameOrigin(
        req({
          "x-forwarded-host": "gethearth.vercel.app, inner.local",
          origin: "https://gethearth.vercel.app",
        })
      )
    ).toBe(true);
  });

  it("ignores scheme and case, which CSRF does not turn on", () => {
    expect(
      isSameOrigin(
        req({ host: "GetHearth.vercel.app", origin: "http://gethearth.vercel.app" })
      )
    ).toBe(true);
  });

  it("allows a caller that sends neither header", () => {
    // A browser always sends Origin on a POST, so "neither header" means a
    // non-browser client (curl, a monitor, a native app). Refusing those would
    // break real things and stop no attack. The route's own session check is
    // still what decides whether anything happens.
    expect(isSameOrigin(req({ host: "gethearth.vercel.app" }))).toBe(true);
  });

  it("allows an unparseable Origin rather than guessing", () => {
    expect(
      isSameOrigin(req({ host: "gethearth.vercel.app", origin: "null" }))
    ).toBe(true);
  });
});

describe("sameOriginGuard", () => {
  it("returns nothing for a request the route should handle", () => {
    expect(
      sameOriginGuard(
        req({ host: "gethearth.vercel.app", "sec-fetch-site": "same-origin" })
      )
    ).toBeNull();
  });

  it("returns a 403 that says nothing useful", async () => {
    const res = sameOriginGuard(
      req({ host: "gethearth.vercel.app", "sec-fetch-site": "cross-site" })
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
    // No hint about whether a session existed or what the route does.
    expect(await res!.json()).toEqual({ error: "Forbidden" });
  });
});
