import { beforeEach, describe, expect, it, vi } from "vitest";

// blockUserAction / unblockUserAction (./actions.ts) are the write half of
// blocking (migration 0138). Policy-level enforcement lives in the database
// and cannot be exercised here, so what this file pins down is the layer
// ABOVE it: the guards that decide whether a write is even attempted, and
// what is written when it is.
//
// The one that matters most is the IDOR guard. The form never names the
// person being blocked - it names a lead or a contractor profile - and the
// action resolves the counterparty server-side. A caller who is on neither
// side of a lead must get nothing, and every insert must carry the SESSION'S
// user as blocker_user_id, never anything from the form.

type Row = Record<string, unknown>;

let sessionUser: { id: string } | null = { id: "user-homeowner" };

// Rows the admin client hands back, keyed by table.
let leadRow: Row | null = null;
let propertyRow: Row | null = null;
let contractorRow: Row | null = null;

let lastInsert: Row | null = null;
let insertError: { code?: string; message?: string } | null = null;

let lastDeleteFilters: Row | null = null;
let deleteError: { code?: string; message?: string } | null = null;

// Every admin RPC the action made, and what the limiter answers.
let rpcCalls: Array<{ fn: string; args: Row }> = [];
let rateLimitAllows: boolean | null = true;

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

// The USER-scoped client: auth plus the two writes against user_blocks.
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
      delete: () => {
        const filters: Row = {};
        const chain = {
          eq: (col: string, val: unknown) => {
            filters[col] = val;
            lastDeleteFilters = filters;
            // Two .eq() calls in a row, and the second one resolves.
            return Object.assign(Promise.resolve({ error: deleteError }), chain);
          },
        };
        return chain;
      },
    }),
  })),
}));

// The ADMIN client: resolves who the counterparty is, and runs the limiter.
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(() => ({
    rpc: async (fn: string, args: Row) => {
      rpcCalls.push({ fn, args });
      // What rate_limit_hit answers: false means over the limit. `null` is the
      // limiter itself failing, which every call site treats as allow.
      return { data: fn === "rate_limit_hit" ? rateLimitAllows : null };
    },
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => {
            if (table === "contractor_leads") return { data: leadRow };
            if (table === "properties") return { data: propertyRow };
            if (table === "contractors") return { data: contractorRow };
            return { data: null };
          },
        }),
      }),
    }),
  })),
}));

import { blockUserAction, unblockUserAction } from "./actions";

const LEAD = "11111111-1111-4111-8111-111111111111";
const CONTRACTOR = "22222222-2222-4222-8222-222222222222";
const PROPERTY = "33333333-3333-4333-8333-333333333333";
const OTHER_USER = "44444444-4444-4444-8444-444444444444";

function fd(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

beforeEach(() => {
  sessionUser = { id: "user-homeowner" };
  leadRow = { property_id: PROPERTY, contractor_id: CONTRACTOR };
  propertyRow = { user_id: "user-homeowner" };
  contractorRow = { user_id: "user-pro" };
  lastInsert = null;
  insertError = null;
  lastDeleteFilters = null;
  deleteError = null;
  rpcCalls = [];
  rateLimitAllows = true;
});

describe("blockUserAction", () => {
  it("blocks the pro when the homeowner on the lead asks", async () => {
    const res = await blockUserAction(fd({ lead_id: LEAD }));
    expect(res.ok).toBe(true);
    expect(lastInsert).toEqual({
      blocker_user_id: "user-homeowner",
      blocked_user_id: "user-pro",
      reason: null,
    });
  });

  it("blocks the homeowner when the pro on the same lead asks", async () => {
    sessionUser = { id: "user-pro" };
    const res = await blockUserAction(fd({ lead_id: LEAD }));
    expect(res.ok).toBe(true);
    expect(lastInsert).toMatchObject({
      blocker_user_id: "user-pro",
      blocked_user_id: "user-homeowner",
    });
  });

  it("refuses a caller who is on neither side of the lead, and writes nothing", async () => {
    sessionUser = { id: "user-stranger" };
    const res = await blockUserAction(fd({ lead_id: LEAD }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/conversation/i);
    expect(lastInsert).toBeNull();
  });

  it("gives the same refusal for a lead that does not exist, so ids cannot be probed", async () => {
    leadRow = null;
    propertyRow = null;
    contractorRow = null;
    const res = await blockUserAction(fd({ lead_id: LEAD }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/conversation/i);
    expect(lastInsert).toBeNull();
  });

  it("resolves the pro's account from the contractor id on a profile block", async () => {
    contractorRow = { user_id: "user-pro" };
    const res = await blockUserAction(fd({ contractor_id: CONTRACTOR }));
    expect(res.ok).toBe(true);
    expect(lastInsert).toMatchObject({
      blocker_user_id: "user-homeowner",
      blocked_user_id: "user-pro",
    });
  });

  it("never takes the blocker from the form", async () => {
    const res = await blockUserAction(
      fd({
        lead_id: LEAD,
        blocker_user_id: OTHER_USER,
        blocked_user_id: OTHER_USER,
      })
    );
    expect(res.ok).toBe(true);
    expect(lastInsert).toMatchObject({
      blocker_user_id: "user-homeowner",
      blocked_user_id: "user-pro",
    });
  });

  it("refuses a block of your own account", async () => {
    contractorRow = { user_id: "user-homeowner" };
    const res = await blockUserAction(fd({ contractor_id: CONTRACTOR }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/your own account/i);
    expect(lastInsert).toBeNull();
  });

  it("rejects a non-UUID id before any query runs", async () => {
    const res = await blockUserAction(fd({ contractor_id: "not-a-uuid" }));
    expect(res.ok).toBe(false);
    expect(lastInsert).toBeNull();
  });

  it("refuses when nothing identifies who to block", async () => {
    const res = await blockUserAction(fd({}));
    expect(res.ok).toBe(false);
    expect(lastInsert).toBeNull();
  });

  it("refuses when nobody is signed in", async () => {
    sessionUser = null;
    const res = await blockUserAction(fd({ lead_id: LEAD }));
    expect(res.ok).toBe(false);
    expect(lastInsert).toBeNull();
  });

  it("treats an already-blocked duplicate as success, not an error", async () => {
    insertError = { code: "23505", message: "duplicate key" };
    const res = await blockUserAction(fd({ lead_id: LEAD }));
    expect(res.ok).toBe(true);
  });

  it("says blocking is not switched on yet when migration 0138 is missing", async () => {
    insertError = {
      code: "PGRST205",
      message: "Could not find the table 'public.user_blocks' in the schema cache",
    };
    const res = await blockUserAction(fd({ lead_id: LEAD }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/isn't switched on yet/i);
  });

  it("meters new blocks per account, keyed on the session user", async () => {
    // The UNIQUE constraint stops repeats of the same PAIR, not a sweep that
    // blocks every pro on the board one id at a time. This is the only bound
    // on that loop.
    await blockUserAction(fd({ lead_id: LEAD }));
    const limiter = rpcCalls.find((c) => c.fn === "rate_limit_hit");
    expect(limiter).toBeDefined();
    expect(limiter!.args.p_bucket).toBe("block:user-homeowner");
    expect(limiter!.args.p_limit).toBe(30);
    expect(limiter!.args.p_window_seconds).toBe(3600);
  });

  it("refuses, and writes nothing, once the hourly limit is spent", async () => {
    rateLimitAllows = false;
    const res = await blockUserAction(fd({ lead_id: LEAD }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/wait a bit/i);
    expect(lastInsert).toBeNull();
  });

  it("still blocks when the limiter itself is broken", async () => {
    // Fail open, like every other rate_limit_hit call here: a limiter hiccup
    // must not stop someone blocking the person harassing them.
    rateLimitAllows = null;
    const res = await blockUserAction(fd({ lead_id: LEAD }));
    expect(res.ok).toBe(true);
    expect(lastInsert).toMatchObject({ blocked_user_id: "user-pro" });
  });

  it("does not spend limiter budget on a request it was going to refuse", async () => {
    sessionUser = { id: "user-stranger" };
    const res = await blockUserAction(fd({ lead_id: LEAD }));
    expect(res.ok).toBe(false);
    expect(rpcCalls.filter((c) => c.fn === "rate_limit_hit")).toHaveLength(0);
  });

  it("keeps an optional reason, trimmed and capped", async () => {
    const res = await blockUserAction(
      fd({ lead_id: LEAD, reason: `  ${"x".repeat(600)}  ` })
    );
    expect(res.ok).toBe(true);
    expect(String((lastInsert as Row).reason)).toHaveLength(500);
  });
});

describe("unblockUserAction", () => {
  it("scopes the delete to the caller as well as the target", async () => {
    const res = await unblockUserAction(fd({ blocked_user_id: OTHER_USER }));
    expect(res.ok).toBe(true);
    expect(lastDeleteFilters).toEqual({
      blocker_user_id: "user-homeowner",
      blocked_user_id: OTHER_USER,
    });
  });

  it("rejects a non-UUID target without touching the database", async () => {
    const res = await unblockUserAction(fd({ blocked_user_id: "nope" }));
    expect(res.ok).toBe(false);
    expect(lastDeleteFilters).toBeNull();
  });

  it("refuses when nobody is signed in", async () => {
    sessionUser = null;
    const res = await unblockUserAction(fd({ blocked_user_id: OTHER_USER }));
    expect(res.ok).toBe(false);
    expect(lastDeleteFilters).toBeNull();
  });

  it("reports a failed delete instead of claiming it worked", async () => {
    deleteError = { code: "42501", message: "permission denied" };
    const res = await unblockUserAction(fd({ blocked_user_id: OTHER_USER }));
    expect(res.ok).toBe(false);
  });
});
