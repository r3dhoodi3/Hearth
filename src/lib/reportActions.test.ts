import { beforeEach, describe, expect, it, vi } from "vitest";

// reportContentAction (./reportActions.ts) is the report path for a REVIEW or
// a PRO PROFILE (migration 0138). The database re-checks reporter_id =
// auth.uid() in the "reports insert" policy, which cannot be exercised here,
// so this file pins the layer above it: the target has to be real, the reason
// has to be one of the offered ones, the reporter is always the session's
// user, and a database that has not been migrated yet says so honestly
// instead of showing a thank-you for a report nobody will read.

type Row = Record<string, unknown>;

let sessionUser: { id: string } | null = { id: "user-1" };

let reviewRow: Row | null = { id: "review-1" };
let contractorRow: Row | null = { id: "contractor-1" };
let targetLookupError: { message: string } | null = null;
// The contractors lookup that decides reporter_role. Separate from the
// contractors lookup that verifies a profile target: they filter on different
// columns, so the mock tracks which column was used.
let proRowForRole: Row | null = null;

let rateLimitAllowed: boolean | null = true;
let lastInsert: Row | null = null;
let insertError: { code?: string; message?: string } | null = null;

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: {
      getUser: async () => ({ data: { user: sessionUser } }),
    },
    from: (_table: string) => ({
      insert: async (values: Row) => {
        lastInsert = values;
        return { error: insertError };
      },
    }),
  })),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(() => ({
    rpc: async () => ({ data: rateLimitAllowed }),
    from: (table: string) => ({
      select: () => ({
        eq: (column: string) => ({
          maybeSingle: async () => {
            if (table === "reviews") {
              return { data: reviewRow, error: targetLookupError };
            }
            if (table === "contractors") {
              return column === "user_id"
                ? { data: proRowForRole, error: null }
                : { data: contractorRow, error: targetLookupError };
            }
            return { data: null, error: null };
          },
        }),
      }),
    }),
  })),
}));

import { reportContentAction } from "./reportActions";

const REVIEW = "11111111-1111-4111-8111-111111111111";
const CONTRACTOR = "22222222-2222-4222-8222-222222222222";

function fd(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

beforeEach(() => {
  sessionUser = { id: "user-1" };
  reviewRow = { id: "review-1" };
  contractorRow = { id: "contractor-1" };
  targetLookupError = null;
  proRowForRole = null;
  rateLimitAllowed = true;
  lastInsert = null;
  insertError = null;
});

describe("reportContentAction", () => {
  it("records a review report against the caller, with no lead", async () => {
    const res = await reportContentAction(
      fd({
        target_type: "review",
        target_id: REVIEW,
        reason: "Harassment or abuse",
      })
    );
    expect(res.ok).toBe(true);
    expect(lastInsert).toEqual({
      lead_id: null,
      reporter_id: "user-1",
      reporter_role: "homeowner",
      reason: "Harassment or abuse",
      target_type: "review",
      target_id: REVIEW,
    });
  });

  it("appends the optional note to the stored reason", async () => {
    await reportContentAction(
      fd({
        target_type: "contractor",
        target_id: CONTRACTOR,
        reason: "Spam or a scam",
        note: "  asked me to pay in gift cards  ",
      })
    );
    expect((lastInsert as Row).reason).toBe(
      "Spam or a scam - asked me to pay in gift cards"
    );
  });

  it("marks the reporter as a contractor when the account has a pro row", async () => {
    proRowForRole = { id: "contractor-9" };
    await reportContentAction(
      fd({
        target_type: "review",
        target_id: REVIEW,
        reason: "Something else",
      })
    );
    expect((lastInsert as Row).reporter_role).toBe("contractor");
  });

  it("never takes the reporter from the form", async () => {
    await reportContentAction(
      fd({
        target_type: "review",
        target_id: REVIEW,
        reason: "Something else",
        reporter_id: "somebody-else",
      })
    );
    expect((lastInsert as Row).reporter_id).toBe("user-1");
  });

  it("refuses a target that does not exist, and writes nothing", async () => {
    reviewRow = null;
    const res = await reportContentAction(
      fd({
        target_type: "review",
        target_id: REVIEW,
        reason: "Something else",
      })
    );
    expect(res.ok).toBe(false);
    expect(lastInsert).toBeNull();
  });

  it("refuses a target type outside the two the CHECK constraint allows", async () => {
    const res = await reportContentAction(
      fd({ target_type: "lead", target_id: REVIEW, reason: "Something else" })
    );
    expect(res.ok).toBe(false);
    expect(lastInsert).toBeNull();
  });

  it("refuses a reason that is not one of the offered ones", async () => {
    const res = await reportContentAction(
      fd({
        target_type: "review",
        target_id: REVIEW,
        reason: "made up reason",
      })
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/pick a reason/i);
    expect(lastInsert).toBeNull();
  });

  it("rejects a non-UUID target id before any query runs", async () => {
    const res = await reportContentAction(
      fd({ target_type: "review", target_id: "nope", reason: "Something else" })
    );
    expect(res.ok).toBe(false);
    expect(lastInsert).toBeNull();
  });

  it("refuses when nobody is signed in", async () => {
    sessionUser = null;
    const res = await reportContentAction(
      fd({
        target_type: "review",
        target_id: REVIEW,
        reason: "Something else",
      })
    );
    expect(res.ok).toBe(false);
    expect(lastInsert).toBeNull();
  });

  it("stops a flood at the rate limit", async () => {
    rateLimitAllowed = false;
    const res = await reportContentAction(
      fd({
        target_type: "review",
        target_id: REVIEW,
        reason: "Something else",
      })
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/wait a bit/i);
    expect(lastInsert).toBeNull();
  });

  it("still files the report when the rate limiter itself is unavailable", async () => {
    // Fail open: an RPC hiccup must never swallow a real abuse report.
    rateLimitAllowed = null;
    const res = await reportContentAction(
      fd({
        target_type: "review",
        target_id: REVIEW,
        reason: "Something else",
      })
    );
    expect(res.ok).toBe(true);
  });

  it("treats a second identical report as done, not as a failure", async () => {
    // Migration 0139 adds a unique index on (reporter_id, target_type,
    // target_id): filing the same report twice is now a 23505 instead of a
    // duplicate row in the moderation inbox. Reporting it as an error would
    // just have the reporter try a third time.
    insertError = { code: "23505", message: "duplicate key value" };
    const res = await reportContentAction(
      fd({
        target_type: "review",
        target_id: REVIEW,
        reason: "Something else",
      })
    );
    expect(res.ok).toBe(true);
    // The line the sheet shows instead of its default thank-you.
    if (res.ok) expect(res.data).toMatch(/already reported this/i);
  });

  it("points at the contact form when migration 0138 has not been applied", async () => {
    insertError = {
      code: "PGRST204",
      message: "Could not find the 'target_type' column of 'reports'",
    };
    const res = await reportContentAction(
      fd({
        target_type: "review",
        target_id: REVIEW,
        reason: "Something else",
      })
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/contact form/i);
  });
});
