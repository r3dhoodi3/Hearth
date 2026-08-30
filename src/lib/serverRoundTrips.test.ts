import { describe, expect, it, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";

// Round-trip guarantees for the signed-in pages (speed wave, 2026-08-30).
//
// Each of these was a measured Supabase round trip that a page paid on every
// render and did not need to. They are easy to put back by accident - a second
// `.from("users")`, a dropped `.limit()`, an `await` that walks back out of a
// Promise.all - and none of them changes anything visible, so nothing else in
// the suite would notice. Hence source-text assertions, the same convention
// src/app/pro/leads/page.test.tsx already uses for this page's query shape.

// Hoisted so the module mocks below (which vitest lifts to the top of the
// file) can close over it before ./user is imported.
const state = vi.hoisted(() => ({
  data: null as unknown,
  error: null as unknown,
}));

vi.mock("@/lib/auth", () => ({
  getUser: vi.fn(async () => ({ id: "user-1" })),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: state.data, error: state.error }),
        }),
      }),
    }),
  })),
}));

const root = path.join(__dirname, "..");
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8");

describe("dashboard reads the users row once per request", () => {
  const page = read("app/(app)/dashboard/page.tsx");

  it("does not open its own users query for the free-taste credits", () => {
    // The two credit columns come off the users row the app shell already
    // loaded (getUserProfileResult, React-cached). A `.from("users")` here
    // would be a second query against a row this request already has.
    expect(page).not.toContain('.from("users")');
    expect(page).toContain("getUserProfileResult");
  });

  it("still fails open when that read errored", () => {
    // A homeowner must never be told a one-time free credit is spent when it
    // never was, so an unreadable row means "both credits available".
    expect(page).toContain(
      "if (errored) return { planUnused: true, quoteUnused: true };"
    );
  });
});

describe("pro pages keep their list reads bounded", () => {
  it("the assigned-leads board caps the wide contractor_leads read", () => {
    const page = read("app/pro/leads/page.tsx");
    // issue_description and material_notes are unbounded free text, so this
    // is the one read on the page that grows without limit with a pro's
    // history. Both branches of the missing-column cascade need the cap.
    const capped = page.match(/\.limit\(500\)/g) ?? [];
    expect(capped.length).toBeGreaterThanOrEqual(2);
  });

  it("the leads board writes its funnel event after the response", () => {
    const page = read("app/pro/leads/page.tsx");
    expect(page).toContain('import { after } from "next/server";');
    expect(page).not.toContain("await trackServerEvent");
  });

  it("/pro/business computes time-to-apply inside its one query wave", () => {
    const page = read("app/pro/business/page.tsx");
    // It only needs contractor.id, so it belongs in the wave, not behind it:
    // awaited afterwards it was two more stacked round trips before render.
    expect(page).not.toContain("await computeResponseTimeMinutes");
    expect(page).toContain(
      "computeResponseTimeMinutes(createAdminClient(), contractor.id),"
    );
  });
});

describe("the Ask Hearth greeting asks for one reminder, not all of them", () => {
  it("limits the maintenance_tasks read to the row it reads back", () => {
    const greeting = read("lib/greeting.ts");
    const tasksRead = greeting.slice(greeting.indexOf('"maintenance_tasks"'));
    expect(tasksRead.slice(0, 700)).toContain(".limit(1)");
  });
});

// getUserProfile's contract has to be exactly what it was before the shared
// read was factored out: a failed query reads as null, not as a throw and not
// as an empty row. Only getUserProfileResult can tell the two apart.
describe("getUserProfileResult", () => {
  beforeEach(() => {
    state.data = null;
    state.error = null;
  });

  it("reports a read failure separately from a missing row", async () => {
    const { getUserProfileResult, getUserProfile } = await import("./user");
    state.error = { message: "boom" };
    const result = await getUserProfileResult();
    expect(result.errored).toBe(true);
    expect(result.profile).toBeNull();
    // The old getUserProfile contract: a failed read is null to its callers.
    expect(await getUserProfile()).toBeNull();
  });
});
