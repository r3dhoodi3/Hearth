import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

// Source-pattern tests: this route imports the service-role client, the Stripe
// client and the Claude client, so it cannot be imported and driven here (the
// same reason src/lib/aiUsage.test.ts reads it as text). The decision the gate
// makes IS driven for real, in src/lib/establishedPro.test.ts.
//
// What this pins: anyone can register a company and start asking a paid model
// questions for free. The copilot now stays locked until the business is real,
// and the lock has to sit in front of the counter, the context build and the
// model call - a lock that runs after any of those still costs money.

function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

const route = src("./route.ts");
const page = src("../../pro/ask/page.tsx");

const UNLOCK_COPY =
  "Ask Hearth opens once your business is verified: add a California license number we can confirm, or place your first lead. Hearth Pro members get it right away.";

describe("the pro copilot is locked until the business is real", () => {
  it("asks isEstablishedPro", () => {
    expect(route).toContain(
      'import { getCurrentContractor, isEstablishedPro } from "@/lib/contractor"'
    );
    expect(route).toContain("await isEstablishedPro(contractor.id)");
  });

  it("locks BEFORE counting, before the context build, before the model", () => {
    const gate = route.indexOf("await isEstablishedPro(contractor.id)");
    expect(gate).toBeGreaterThan(-1);
    for (const later of ["countAskUsage(", "streamText(", "wrapUntrusted("]) {
      const at = route.indexOf(later);
      expect(at).toBeGreaterThan(-1);
      expect(gate).toBeLessThan(at);
    }
  });

  it("answers with the copy that says how to unlock", () => {
    expect(route).toContain(UNLOCK_COPY);
    // A refusal with no next step reads as a bug, so the answer carries the
    // link the sentence is talking about.
    expect(route).toContain('link: { href: "/pro/profile", label: "Add your license" }');
  });

  it("returns before anything is spent", () => {
    const gate = route.indexOf("if (!(await isEstablishedPro(contractor.id)))");
    const gateReturn = route.indexOf("return NextResponse.json({", gate);
    const counted = route.indexOf("countAskUsage(");
    expect(gate).toBeGreaterThan(-1);
    expect(gateReturn).toBeGreaterThan(gate);
    expect(gateReturn).toBeLessThan(counted);
  });
});

describe("the pro ask page shows the lock instead of a dead composer", () => {
  it("reads the same helper the route does", () => {
    expect(page).toContain("isEstablishedPro(contractor.id)");
  });

  it("renders the unlock note and no chat when locked", () => {
    expect(page).toContain('data-testid="pro-ask-locked"');
    expect(page).toContain("Ask Hearth opens once your business is verified");
    expect(page).toContain(
      "Add a California license number we can confirm, or place your"
    );
    // The composer is the other branch of the same ternary, so a locked pro
    // never gets a box to type into.
    expect(page).toMatch(/!established \?[\s\S]*\) : \([\s\S]*<AskHearth/);
  });
});
