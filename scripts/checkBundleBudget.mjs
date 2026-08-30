#!/usr/bin/env node
// Bundle-size budget gate. Runs an isolated `next build`, reads the First
// Load JS Next prints for each route in perf-budget.json's baseline, and
// fails (non-zero exit) if any tracked route grew more than
// PERCENT_TOLERANCE over the checked-in number. Used both by
// `npm run perf:budget` locally and by .github/workflows/bundle-budget.yml
// on every PR - a route ballooning past its budget should be a red CI check,
// not something the owner notices for the first time in Lighthouse weeks
// later.
//
// Plain JS/ESM, not TypeScript: this runs as a standalone script via
// `node scripts/checkBundleBudget.mjs`, with no ts-node/tsx build step in
// this repo to lean on. The pure functions below (parseable, no I/O) are
// exported and covered by scripts/checkBundleBudget.test.mjs.

import { spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const PERCENT_TOLERANCE = 0.1; // 10%, per docs/PERFORMANCE.md

// Converts a size string as Next prints it ("132 kB", "419 B", "1.15 MB")
// into bytes. Next's own formatter (next/dist/build/utils.js prettyBytes) is
// 1024-based, so this matches it unit for unit.
export function sizeStringToBytes(sizeStr) {
  const match = /^([\d.]+)\s*(B|kB|MB)$/.exec(sizeStr.trim());
  if (!match) return null;
  const value = Number(match[1]);
  const unit = match[2];
  const multiplier = unit === "MB" ? 1024 * 1024 : unit === "kB" ? 1024 : 1;
  return Math.round(value * multiplier);
}

// Parses the "Route (app)" table `next build` prints to stdout into
// { "/dashboard": 135168, ... } (route -> First Load JS in bytes). Only
// route rows are kept - sub-rows like "├ chunks/1255-....js" and the
// "+ First Load JS shared by all" footer never start with "/" and are
// skipped, along with anything before the table header.
export function parseFirstLoadJs(buildOutput) {
  const routes = {};
  // Tree-drawing prefix (┌/├/└), the route-type glyph (ƒ/○/●), the route
  // path, its own Size column, then First Load JS. Revalidate/Expire
  // columns some static rows carry after this are ignored.
  const ROW = /^[┌├└]\s+[ƒ○●]\s+(\/\S*)\s+([\d.]+\s*(?:B|kB|MB))\s+([\d.]+\s*(?:B|kB|MB))/;
  for (const line of buildOutput.split("\n")) {
    const rowMatch = ROW.exec(line.trimEnd());
    if (!rowMatch) continue;
    const [, route, , firstLoadJsStr] = rowMatch;
    const bytes = sizeStringToBytes(firstLoadJsStr);
    if (bytes !== null) routes[route] = bytes;
  }
  return routes;
}

// Compares current First Load JS (bytes, from parseFirstLoadJs) against the
// checked-in baseline (also bytes) for every route the baseline tracks.
// Returns one result row per tracked route; a route missing from the current
// build (a rename or removal) is reported, not silently skipped, so the
// baseline file does not go stale without anyone noticing.
export function checkBudget(current, baseline, tolerance = PERCENT_TOLERANCE) {
  return Object.entries(baseline).map(([route, baselineBytes]) => {
    const currentBytes = current[route];
    if (currentBytes === undefined) {
      return { route, baselineBytes, currentBytes: null, ok: false, reason: "route not found in this build" };
    }
    const limit = baselineBytes * (1 + tolerance);
    const ok = currentBytes <= limit;
    const percentChange = ((currentBytes - baselineBytes) / baselineBytes) * 100;
    return { route, baselineBytes, currentBytes, ok, percentChange };
  });
}

function formatKb(bytes) {
  return `${(bytes / 1024).toFixed(1)} kB`;
}

function main() {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.join(scriptDir, "..");
  const baselinePath = path.join(repoRoot, "perf-budget.json");
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));

  const distDir = ".next-budget-check";
  console.log(`Building with NEXT_DIST_DIR=${distDir} to check the bundle budget...`);
  const result = spawnSync("npx", ["next", "build"], {
    cwd: repoRoot,
    env: { ...process.env, NEXT_DIST_DIR: distDir },
    encoding: "utf8",
    shell: process.platform === "win32",
  });

  // Clean up the isolated dist dir regardless of outcome - this script must
  // never leave a build artifact behind for the next `next dev` to trip on.
  try {
    rmSync(path.join(repoRoot, distDir), { recursive: true, force: true });
  } catch {
    /* best effort */
  }

  if (result.status !== 0) {
    console.error(result.stdout);
    console.error(result.stderr);
    console.error("next build failed; cannot check the bundle budget.");
    process.exit(1);
  }

  const current = parseFirstLoadJs(result.stdout);
  const rows = checkBudget(current, baseline.routes);

  let failed = false;
  console.log("\nRoute".padEnd(38) + "Baseline".padEnd(12) + "Current".padEnd(12) + "Change");
  for (const row of rows) {
    if (row.currentBytes === null) {
      failed = true;
      console.log(`${row.route.padEnd(38)}${formatKb(row.baselineBytes).padEnd(12)}MISSING     (${row.reason})`);
      continue;
    }
    const changeStr = `${row.percentChange >= 0 ? "+" : ""}${row.percentChange.toFixed(1)}%`;
    const flag = row.ok ? "" : "  OVER BUDGET";
    if (!row.ok) failed = true;
    console.log(
      `${row.route.padEnd(38)}${formatKb(row.baselineBytes).padEnd(12)}${formatKb(row.currentBytes).padEnd(12)}${changeStr}${flag}`
    );
  }

  if (failed) {
    console.error(
      `\nOne or more routes grew more than ${(PERCENT_TOLERANCE * 100).toFixed(0)}% over the checked-in baseline in perf-budget.json.`
    );
    console.error(
      "If the growth is deliberate (a real new feature, not bundle bloat), update perf-budget.json in the same PR and say why in the description."
    );
    process.exit(1);
  }

  console.log("\nAll tracked routes are within budget.");
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  main();
}
