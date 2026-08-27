import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Eleven AI tool routes each called countAiUsage to charge a usage up front,
// then had a try/catch around the model call that returned "failed" on a
// thrown error without ever handing the charge back - unlike the chat routes
// (/api/ask, /api/pro-ask) and the two owner-wide ceiling checks inside
// countAiUsage itself, which have always refunded on exactly this path (see
// src/lib/aiUsage.test.ts). A pro or homeowner charged for a request that
// never reached the model, because Claude timed out or the API errored, had
// their daily allowance spent on nothing.
//
// Source-text assertions, not imports: these route files (and quoteAnalysis)
// pull in the service-role Supabase client transitively, which is
// "server-only" and throws outside a server component - the same reason
// aiUsage.test.ts and aiGuard.test.ts read source rather than importing it.

function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

// The eleven routes named in the audit. Each calls countAiUsage directly
// (pro-compliance calls it once, from its POST handler) and must reference
// refundAiUsage somewhere in the same file.
const ROUTES_CALLING_COUNT_DIRECTLY = [
  "../app/api/draft-apply/route.ts",
  "../app/api/draft-job/route.ts",
  "../app/api/extract-document/route.ts",
  "../app/api/confirm-system/route.ts",
  "../app/api/analyze-quote/route.ts",
  "../app/api/ingest-inspection/route.ts",
  "../app/api/insurance-packet/route.ts",
  "../app/api/pro-compliance/route.ts",
  "../app/api/pro-past-jobs/route.ts",
  "../app/api/pro-tools/route.ts",
  "../app/api/tax-appeal/route.ts",
];

describe("every countAiUsage caller among the eleven tool routes also refunds", () => {
  it.each(ROUTES_CALLING_COUNT_DIRECTLY)("%s", (rel) => {
    const s = src(rel);
    expect(s).toContain("countAiUsage(");
    expect(s).toContain("refundAiUsage");
    // Actually imported, not just mentioned in a comment.
    expect(s).toMatch(/import\s*\{[^}]*refundAiUsage[^}]*\}\s*from\s*"@\/lib\/aiUsage"/);
  });

  it("refunds inside a catch around the model call, not just anywhere in the file", () => {
    // A weaker "the string appears somewhere" check would pass for a file that
    // imports refundAiUsage and never calls it. Each of these ties the call to
    // the route's own catch block (or, for pro-compliance, the helper's).
    // analyze-quote.ts is excluded here on purpose: its two model calls live
    // in quoteAnalysis.ts, which already catches internally and reports a
    // `threw` flag, so the route refunds via `if (t1Threw)` / `if (t2Threw)`
    // rather than its own catch clause - asserted separately below.
    const withOwnCatch = ROUTES_CALLING_COUNT_DIRECTLY.filter(
      (rel) => !rel.includes("analyze-quote")
    );
    for (const rel of withOwnCatch) {
      const s = src(rel);
      expect(s, rel).toMatch(/catch[\s\S]{0,400}?refundAiUsage\(/);
    }
  });
});

describe("analyze-quote's two-stage pipeline distinguishes a throw from a normal no-result", () => {
  it("quoteAnalysis.ts reports whether the model call actually threw", () => {
    const s = src("./quoteAnalysis.ts");
    // Both stage runners return `threw`, computed only in their catch blocks,
    // so a normal empty/refused result (data is null, nothing thrown) never
    // looks like a failure worth refunding.
    expect(s).toMatch(/catch \(e\) \{\s*return \{ transcript: null, rateLimited: isRateLimitError\(e\), threw: true \};/);
    expect(s).toMatch(/catch \(e\) \{\s*return \{ diagnosis: null, rateLimited: isRateLimitError\(e\), threw: true \};/);
  });

  it("the route only refunds when a stage actually threw", () => {
    const s = src("../app/api/analyze-quote/route.ts");
    expect(s).toMatch(/if \(t1Threw\) await refundAiUsage\(user\.id\);/);
    expect(s).toMatch(/if \(t2Threw\) await refundAiUsage\(user\.id\);/);
  });
});

describe("a refund never fires on a normal no-result", () => {
  // Every route's "if (!parsed) return ... reason: 'failed'" branch (the
  // model ran and returned nothing usable) sits OUTSIDE the try/catch's catch
  // clause and must not itself carry a refund call - only the catch does.
  const NO_RESULT_ROUTES = [
    "../app/api/draft-apply/route.ts",
    "../app/api/draft-job/route.ts",
    "../app/api/extract-document/route.ts",
    "../app/api/confirm-system/route.ts",
    "../app/api/ingest-inspection/route.ts",
    "../app/api/insurance-packet/route.ts",
    "../app/api/pro-past-jobs/route.ts",
    "../app/api/pro-tools/route.ts",
    "../app/api/tax-appeal/route.ts",
  ];

  it.each(NO_RESULT_ROUTES)("%s refunds only once, in the catch", (rel) => {
    const s = src(rel);
    // Exactly one refundAiUsage call in the whole file: the catch's.
    expect(s.match(/refundAiUsage\(/g)?.length).toBe(1);
  });

  it("pro-compliance refunds only inside extractExpiry's own catch", () => {
    const s = src("../app/api/pro-compliance/route.ts");
    expect(s.match(/refundAiUsage\(/g)?.length).toBe(1);
    // Never fired for a plain "couldn't read a date" result, which returns
    // null WITHOUT throwing (see `if (!parsed) return null;` above it).
    const noResult = s.indexOf("if (!parsed) return null;");
    const refund = s.indexOf("refundAiUsage(");
    expect(noResult).toBeGreaterThan(-1);
    expect(refund).toBeGreaterThan(noResult);
  });
});
