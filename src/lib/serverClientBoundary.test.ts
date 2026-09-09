import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// A server module must never import a value out of a "use client" module.
//
// WHY THIS TEST EXISTS. On 2026-09-08 the red team found that the Apple 3.1.1
// / Google Play Billing gate was a silent no-op: src/lib/nativeClientHeader.ts
// (a "server-only" module) imported NATIVE_CLIENT_HEADER from
// src/lib/platform.ts, which starts with "use client". Next replaces a
// "use client" module with client references at the server boundary, so the
// constant read as `undefined` on the server, headers().get(undefined)
// returned null, and every native request sailed through to Stripe Checkout.
// Nothing threw and nothing logged - the only symptom was a security control
// that quietly never fired.
//
// A source scan rather than a runtime test on purpose: the failure mode is a
// NEW import landing across the boundary, and no runtime test of the modules
// that exist today can see that.

const SRC = path.join(process.cwd(), "src");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name))
      out.push(full);
  }
  return out;
}

const files = walk(SRC);

// "use client" is only meaningful as the module's first statement.
function isClientModule(file: string): boolean {
  try {
    const head = readFileSync(file, "utf8").slice(0, 400).trimStart();
    return head.startsWith('"use client"') || head.startsWith("'use client'");
  } catch {
    return false;
  }
}

function isServerOnlyModule(source: string): boolean {
  return /^\s*import\s+["']server-only["']/m.test(source);
}

// Resolve an "@/..." import to the file it points at, or null when it is a
// package import or a path with no matching file (a directory index, a .json,
// an alias this scan does not model).
function resolveAlias(spec: string): string | null {
  if (!spec.startsWith("@/")) return null;
  const base = path.join(SRC, spec.slice(2));
  for (const candidate of [
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, "index.ts"),
    path.join(base, "index.tsx"),
  ]) {
    try {
      readFileSync(candidate, "utf8");
      return candidate;
    } catch {
      // keep looking
    }
  }
  return null;
}

describe("server/client module boundary", () => {
  it("no server-only module imports from a 'use client' module", () => {
    const violations: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      if (!isServerOnlyModule(source)) continue;
      for (const match of source.matchAll(
        /^\s*(?:import|export)[^;]*?from\s+["'](@\/[^"']+)["']/gm
      )) {
        const target = resolveAlias(match[1]);
        if (target && isClientModule(target)) {
          violations.push(
            `${path.relative(process.cwd(), file)} imports ${match[1]} ` +
              `("use client") - a plain value read across that boundary is undefined on the server`
          );
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("the native client header name is a real string on the server side", async () => {
    const { NATIVE_CLIENT_HEADER } = await import("@/lib/nativeHeaderName");
    expect(NATIVE_CLIENT_HEADER).toBe("X-OakTend-Client");
    // The module it lives in must stay free of "use client", or the gate goes
    // back to reading undefined.
    expect(isClientModule(path.join(SRC, "lib", "nativeHeaderName.ts"))).toBe(
      false
    );
  });
});
