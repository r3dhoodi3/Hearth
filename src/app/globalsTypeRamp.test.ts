import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

// CR3#3 / CR3#12 (PLAN A1#8): a documented 4px spacing scale and four
// type-ramp classes in globals.css, not migrated onto any call site yet.
// Reads the source directly, same reasoning as navShellBreakpoint.test.ts:
// this is a fact about the CSS file, and jsdom applies no CSS anyway.
const globalsCss = readFileSync(
  fileURLToPath(new URL("./globals.css", import.meta.url)),
  "utf8"
);

describe("globals.css spacing scale and type ramp", () => {
  it("documents the 4px spacing scale", () => {
    expect(globalsCss).toMatch(/Spacing scale \(CR3#12\)/);
    expect(globalsCss).toContain("4px");
  });

  it("defines the four type-ramp classes, size only, no color", () => {
    for (const cls of [
      ".text-display",
      ".text-title",
      ".text-body",
      ".text-label",
    ]) {
      expect(globalsCss).toContain(cls);
    }
    // The example CR3 itself gives, verbatim.
    expect(globalsCss).toContain(
      ".text-title {\n    @apply text-lg font-semibold sm:text-xl;\n  }"
    );
    // Deliberately no forced color: a call site keeps its own text-stone-*/
    // dark: utility and only swaps the size.
    const rampBlock = globalsCss.slice(
      globalsCss.indexOf(".text-display"),
      globalsCss.indexOf(".text-label {") + 200
    );
    expect(rampBlock).not.toMatch(/text-stone-\d/);
  });

  it("does not migrate any existing call site this wave", () => {
    // .stat-number and .stat-label predate this ramp and keep their own
    // sizing; CR3 explicitly deferred migrating them.
    expect(globalsCss).toContain("NOT migrated onto any existing call site this wave");
  });
});
