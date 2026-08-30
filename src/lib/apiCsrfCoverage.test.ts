import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Every state-changing API route either checks that the request came from our
// own site, or is named below with the reason it cannot.
//
// This is a source scan rather than a runtime test on purpose: the failure mode
// it exists to catch is a NEW route landing without the guard, and no runtime
// test of the routes that exist today can see that.

const API_ROOT = path.join(process.cwd(), "src", "app", "api");

// Routes that must NOT have the same-origin check, each with the reason. A
// webhook is called by a machine on another network, so "not from our site" is
// the normal case for it, and each of these authenticates with something
// stronger than an Origin header.
const EXEMPT: Record<string, string> = {
  "stripe/webhook": "Stripe signature (constructEvent), called by Stripe",
  "checkr/webhook": "X-Checkr-Signature, called by Checkr",
  "twilio/inbound": "Twilio request signature, called by Twilio",
  track:
    "public analytics beacon: unauthenticated by design, so there is no session to forge",
};

function routeFiles(dir: string, prefix = ""): { name: string; file: string }[] {
  const out: { name: string; file: string }[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...routeFiles(full, prefix ? `${prefix}/${entry.name}` : entry.name));
    } else if (entry.name === "route.ts" || entry.name === "route.tsx") {
      out.push({ name: prefix, file: full });
    }
  }
  return out;
}

const MUTATING = /export async function (POST|PUT|DELETE|PATCH)\b/;

describe("same-origin coverage on state-changing API routes", () => {
  const routes = routeFiles(API_ROOT);

  it("finds the routes at all, so a rename cannot make this test vacuous", () => {
    expect(routes.length).toBeGreaterThan(30);
  });

  for (const { name, file } of routes) {
    const src = readFileSync(file, "utf8");
    if (!MUTATING.test(src)) continue;

    // A cron route authenticates with CRON_SECRET and is called by Vercel's
    // scheduler, which is not a browser and sends no Origin.
    if (name.startsWith("cron/")) {
      it(`${name} requires the cron secret`, () => {
        expect(src).toContain("process.env.CRON_SECRET");
        // Fails closed: no secret configured means nobody gets in.
        expect(src).toContain("if (!expected) return false");
        expect(src).toContain("timingSafeEqual");
      });
      continue;
    }

    if (name in EXEMPT) {
      it(`${name} is exempt: ${EXEMPT[name]}`, () => {
        expect(EXEMPT[name].length).toBeGreaterThan(0);
      });
      continue;
    }

    it(`${name} refuses a cross-site caller`, () => {
      expect(src).toContain('from "@/lib/csrf"');
      expect(src).toContain("sameOriginGuard(req)");
    });
  }
});
