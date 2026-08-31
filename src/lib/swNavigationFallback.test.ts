import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// public/sw.js and public/warming.html are plain files served verbatim, so no
// bundler ever type-checks them. These tests read the shipped bytes and pin
// down the invariants the cold-start fallback depends on: the worker only
// intercepts same-origin GET navigations, the warming screen is precached
// under a bumped version, and the screen itself makes zero external requests
// (it has to paint while the network is the whole problem).

const swSource = readFileSync(join(process.cwd(), "public", "sw.js"), "utf8");
const warmingSource = readFileSync(
  join(process.cwd(), "public", "warming.html"),
  "utf8"
);

describe("public/sw.js navigation fallback", () => {
  it("bumped VERSION past hearth-sw-1, or the new worker never ships", () => {
    const match = swSource.match(/const VERSION = "([^"]+)"/);
    expect(match).not.toBeNull();
    expect(match?.[1]).not.toBe("hearth-sw-1");
  });

  it("guards the fetch handler to GET navigations only", () => {
    // The guards are what keep the handler away from form posts, server
    // actions, API calls, and asset requests. If either line disappears, the
    // worker starts racing traffic it must never touch.
    expect(swSource).toContain('if (request.method !== "GET") return;');
    expect(swSource).toContain('if (request.mode !== "navigate") return;');
  });

  it("stays on its own origin", () => {
    expect(swSource).toContain("self.location.origin");
  });

  it("never intercepts /auth/ or /api/ navigations", () => {
    // /auth/ GETs consume one-time codes (OAuth PKCE, email confirmation):
    // the timeout does not abort the underlying request, so the server can
    // spend the code while the client sees the warming screen, and the
    // screen's retry would replay a spent code and break the sign-in.
    // /api/ covers downloads (<a download> routes through the handler as a
    // navigation) and route handlers that are not pages at all.
    expect(swSource).toContain('url.pathname.startsWith("/auth/")');
    expect(swSource).toContain('url.pathname.startsWith("/api/")');
  });

  it("precaches the warming screen, bypassing the HTTP cache", () => {
    expect(swSource).toContain('const WARMING_URL = "/warming.html"');
    expect(swSource).toContain('{ cache: "reload" }');
  });

  it("keeps the push handlers that were the worker's first job", () => {
    expect(swSource).toContain('self.addEventListener("push"');
    expect(swSource).toContain('self.addEventListener("notificationclick"');
  });
});

describe("public/warming.html", () => {
  it("makes no external requests: every src and href is inline-only", () => {
    // The screen is shown precisely when the network is slow or gone, so a
    // single external fetch (a font, an icon, a /_next chunk) would mean a
    // fallback that itself fails to paint. Only fragment links and data: URIs
    // are allowed; today the page needs neither.
    const attrs = [...warmingSource.matchAll(/\b(?:src|href)\s*=\s*"([^"]*)"/g)];
    for (const [, value] of attrs) {
      expect(value.startsWith("#") || value.startsWith("data:"), value).toBe(
        true
      );
    }
    // Belt and suspenders: no URL-bearing loaders at all.
    expect(warmingSource).not.toMatch(/<link\s/i);
    expect(warmingSource).not.toMatch(/@import/);
    expect(warmingSource).not.toMatch(/url\(\s*["']?https?:/i);
  });

  it("is marked noindex, because it is a fallback screen and not a page", () => {
    expect(warmingSource).toContain('<meta name="robots" content="noindex">');
  });

  it("contains no em dashes, per house style", () => {
    // Built from a char code so this test file does not carry the byte
    // itself. (A string literal written with a double backslash would search
    // for the six characters of the escape sequence and never match a real
    // em dash, which is the vacuous check this replaces.)
    expect(warmingSource.includes(String.fromCharCode(0x2014))).toBe(false);
  });

  it("carries the probe-then-reload retry logic", () => {
    // The service worker serves this content at the ORIGINAL URL, so a
    // reload re-requests the real page. The retry probes with a plain fetch
    // first (which the worker does not intercept, so it can outwait a cold
    // start) and only reloads once the server answered; the backoff keeps a
    // dead server from being hammered. The delays, the probe, and the
    // expiring attempt counter are the load-bearing pieces.
    expect(warmingSource).toContain("location.reload()");
    expect(warmingSource).toContain("probeThenReload");
    expect(warmingSource).toContain('cache: "no-store"');
    expect(warmingSource).toContain("[2500, 5000, 10000]");
    expect(warmingSource).toContain("15000");
    expect(warmingSource).toContain("sessionStorage");
    expect(warmingSource).toContain("hearth.warming.attempts");
  });

  it("names the VERSION coupling, so an edit here ships to installed devices", () => {
    // Installed clients only refetch this file when sw.js itself changes, so
    // the file must carry the warning that edits require a VERSION bump.
    expect(warmingSource).toContain("MUST bump VERSION in");
  });

  it("shows the slow-connection line and a tappable retry button", () => {
    expect(warmingSource).toContain("Still connecting.");
    expect(warmingSource).toContain('id="retry"');
    expect(warmingSource).toContain("min-height: 44px");
  });
});
