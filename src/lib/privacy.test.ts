import { describe, expect, it, vi, beforeEach } from "vitest";
import type { createAdminClient } from "@/lib/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;

// Tests for the pro_clients de-identification purge added to src/lib/privacy.ts
// (see the "De-identify a pro's CRM copy" block in eraseUserData). The privacy
// policy (04-privacy-policy.md section 12) now promises that deleting a
// homeowner account removes their name, phone, email, and address from a
// pro's client tracker, keeping only the pro's own notes and job history.
//
// Mock shape: a small generic query-builder mock, tailored to exactly the
// tables/operations eraseUserData and its helpers touch. Each table's
// terminal call (maybeSingle/plain-await/update/delete) is resolved by a
// per-test `resolver(table, spec)` function, where `spec` records the chain
// of .select()/.eq()/.in()/.or()/.update()/.delete() calls made against it.
// This keeps the mock honest about which query hit which table with which
// filter, without hard-coding call order.

type Op =
  | { op: "eq"; col: string; val: unknown }
  | { op: "in"; col: string; vals: unknown[] }
  | { op: "or"; expr: string }
  | { op: "not"; col: string; condition: string; val: unknown }
  | { op: "gte"; col: string; val: unknown }
  | { op: "limit"; n: number };

type Spec = {
  table: string;
  type: "select" | "update" | "delete" | "insert";
  cols?: string;
  values?: Record<string, unknown>;
  ops: Op[];
};

type Resolved = { data?: unknown; error?: unknown };
type Resolver = (table: string, spec: Spec) => Resolved;

function makeAdmin(resolver: Resolver) {
  // `any` on purpose: this recursively returns itself from every chain method
  // (.select().eq().in()...), which a precise recursive type isn't worth
  // writing for a test-only mock.
  function builder(table: string, spec: Spec): any {
    const terminal = () => {
      const r = resolver(table, spec);
      return { data: r.data ?? null, error: r.error ?? null };
    };
    const api = {
      select: (cols?: string) => builder(table, { ...spec, type: "select", cols }),
      eq: (col: string, val: unknown) =>
        builder(table, { ...spec, ops: [...spec.ops, { op: "eq", col, val }] }),
      in: (col: string, vals: unknown[]) =>
        builder(table, { ...spec, ops: [...spec.ops, { op: "in", col, vals }] }),
      or: (expr: string) =>
        builder(table, { ...spec, ops: [...spec.ops, { op: "or", expr }] }),
      not: (col: string, condition: string, val: unknown) =>
        builder(table, { ...spec, ops: [...spec.ops, { op: "not", col, condition, val }] }),
      gte: (col: string, val: unknown) =>
        builder(table, { ...spec, ops: [...spec.ops, { op: "gte", col, val }] }),
      limit: (n: number) => builder(table, { ...spec, ops: [...spec.ops, { op: "limit", n }] }),
      update: (values: Record<string, unknown>) =>
        builder(table, { ...spec, type: "update", values }),
      delete: () => builder(table, { ...spec, type: "delete" }),
      insert: (values: Record<string, unknown>) =>
        builder(table, { ...spec, type: "insert", values }),
      maybeSingle: async () => terminal(),
      single: async () => terminal(),
      then: (resolve: (v: Resolved) => unknown, reject?: (e: unknown) => unknown) =>
        Promise.resolve(terminal()).then(resolve, reject),
    };
    return api;
  }

  return {
    from: (table: string) => builder(table, { table, type: "select", ops: [] }),
    storage: {
      from: () => ({
        list: async () => ({ data: [], error: null }),
        remove: async () => ({ error: null }),
      }),
    },
    auth: { admin: { getUserById: async () => ({ data: { user: null } }) } },
  } as unknown as Admin;
}

// findProClientIdsToScrub / scrubProClientContactInfo are pure enough to test
// directly against the mock above, independent of the full eraseUserData flow.
import {
  findProClientIdsToScrub,
  scrubProClientContactInfo,
  eraseUserData,
  DEIDENTIFIED_CLIENT_NAME,
} from "./privacy";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

// findProClientIdsToScrub's email branch now reads the account's VERIFIED
// auth email (admin.auth.admin.getUserById), never the editable
// public.users.email column - see the SECURITY note atop the function. This
// swaps makeAdmin's default (a userless lookup, i.e. no email signal at all)
// for a specific email, per test.
function withAuthEmail(admin: Admin, email: string | null): Admin {
  (admin as unknown as { auth: { admin: { getUserById: unknown } } }).auth.admin.getUserById =
    async () => ({ data: { user: email ? { email } : null }, error: null });
  return admin;
}

describe("findProClientIdsToScrub", () => {
  it("matches rows whose lead_id is one of the homeowner's own leads", async () => {
    const admin = makeAdmin((table, spec) => {
      if (table === "pro_clients") {
        const byLead = spec.ops.some((o) => "col" in o && o.col === "lead_id");
        if (byLead) return { data: [{ id: "client-1" }] };
        return { data: [] };
      }
      if (table === "contractor_leads") return { data: [] };
      return { data: [] };
    });

    const ids = await findProClientIdsToScrub(admin, "user-1", ["lead-1"]);
    expect(ids).toEqual(["client-1"]);
  });

  it("matches an unlinked row by normalized email, scoped to a contractor who received one of this homeowner's leads", async () => {
    const admin = withAuthEmail(
      makeAdmin((table, spec) => {
        if (table === "pro_clients") {
          if (spec.type === "select" && spec.cols?.includes("email")) {
            const scoped = spec.ops.some(
              (o) => "col" in o && o.col === "contractor_id" && "vals" in o && (o as { vals: unknown[] }).vals.includes("contractor-9")
            );
            if (!scoped) return { data: [] };
            return {
              data: [
                { id: "client-2", email: "j.ane@gmail.com" },
                { id: "client-3", email: "someone-else@example.com" },
              ],
            };
          }
          return { data: [] }; // the lead_id branch: no match
        }
        if (table === "contractor_leads") {
          return { data: [{ contractor_id: "contractor-9" }] };
        }
        return { data: [] };
      }),
      "Jane+promo@Gmail.com"
    );

    const ids = await findProClientIdsToScrub(admin, "user-1", ["lead-1"]);
    expect(ids).toEqual(["client-2"]);
  });

  it("never matches by phone even when the account phone equals the row phone", async () => {
    // users.phone is unverified and freely editable, so phone is no longer a
    // matching signal at all (see the SECURITY note atop
    // findProClientIdsToScrub). A row that only matches on phone must never
    // be scrubbed, even for an account with no lead relationship to it.
    const admin = makeAdmin((table, spec) => {
      if (table === "pro_clients") {
        if (spec.type === "select" && spec.cols?.includes("phone")) {
          return {
            data: [{ id: "client-4", email: null, phone: "714-555-0134" }],
          };
        }
        return { data: [] };
      }
      return { data: [] };
    });

    const ids = await findProClientIdsToScrub(admin, "user-1", []);
    expect(ids).toEqual([]);
  });

  it("dedupes a row that matches both by lead_id and by email", async () => {
    const admin = withAuthEmail(
      makeAdmin((table, spec) => {
        if (table === "pro_clients") {
          const byLead = spec.ops.some((o) => "col" in o && o.col === "lead_id");
          if (byLead) return { data: [{ id: "client-6" }] };
          return { data: [{ id: "client-6", email: "jane@example.com" }] };
        }
        if (table === "contractor_leads") {
          return { data: [{ contractor_id: "contractor-1" }] };
        }
        return { data: [] };
      }),
      "jane@example.com"
    );

    const ids = await findProClientIdsToScrub(admin, "user-1", ["lead-1"]);
    expect(ids).toEqual(["client-6"]);
  });

  it("skips the candidate scan entirely when the auth account has no verified email", async () => {
    let candidateQueried = false;
    const admin = withAuthEmail(
      makeAdmin((table, spec) => {
        if (table === "pro_clients") {
          if (spec.type === "select" && spec.cols?.includes("email")) {
            candidateQueried = true;
          }
          return { data: [] };
        }
        if (table === "contractor_leads") return { data: [{ contractor_id: "contractor-1" }] };
        return { data: [] };
      }),
      null
    );

    const ids = await findProClientIdsToScrub(admin, "user-1", ["lead-1"]);
    expect(ids).toEqual([]);
    expect(candidateQueried).toBe(false);
  });

  it("does not scrub a row belonging to a contractor who never received a lead from this homeowner, even when the email matches", async () => {
    // The matching row sits under contractor-OTHER, which contractor_leads
    // says never got a lead from this homeowner (only contractor-1 did) - so
    // the candidate query, scoped to contractor-1 only, must never surface
    // it, even though the email itself matches perfectly.
    const admin = withAuthEmail(
      makeAdmin((table, spec) => {
        if (table === "pro_clients") {
          if (spec.type === "select" && spec.cols?.includes("email")) {
            const inOp = spec.ops.find(
              (o) => "col" in o && o.col === "contractor_id"
            ) as { vals: unknown[] } | undefined;
            const scopedContractors = inOp?.vals ?? [];
            // Simulate real Postgres filtering: only rows whose contractor_id
            // is in the queried set come back.
            const allRows = [
              { id: "client-victim", email: "jane@example.com", contractor_id: "contractor-OTHER" },
            ];
            return {
              data: allRows.filter((r) => scopedContractors.includes(r.contractor_id)),
            };
          }
          return { data: [] };
        }
        if (table === "contractor_leads") {
          return { data: [{ contractor_id: "contractor-1" }] };
        }
        return { data: [] };
      }),
      "jane@example.com"
    );

    const ids = await findProClientIdsToScrub(admin, "user-1", ["lead-1"]);
    expect(ids).toEqual([]);
  });
});

describe("scrubProClientContactInfo", () => {
  it("nulls contact fields and replaces the name, keeping everything else", async () => {
    let captured: { values?: Record<string, unknown>; ids?: unknown } = {};
    const admin = makeAdmin((table, spec) => {
      if (table === "pro_clients" && spec.type === "update") {
        const inOp = spec.ops.find((o) => "col" in o && o.col === "id");
        captured = {
          values: spec.values,
          ids: inOp && "vals" in inOp ? inOp.vals : undefined,
        };
        return { data: null, error: null };
      }
      return { data: [] };
    });

    const { error } = await scrubProClientContactInfo(admin, ["client-1", "client-2"]);
    expect(error).toBeNull();
    expect(captured.ids).toEqual(["client-1", "client-2"]);
    expect(captured.values).toMatchObject({
      client_name: DEIDENTIFIED_CLIENT_NAME,
      email: null,
      phone: null,
      address: null,
    });
    expect(captured.values?.stage).toBeUndefined();
    expect(captured.values?.note).toBeUndefined();
  });

  it("is a no-op that never touches the database when there are no ids", async () => {
    let called = false;
    const admin = makeAdmin(() => {
      called = true;
      return { data: null, error: null };
    });
    const { error } = await scrubProClientContactInfo(admin, []);
    expect(error).toBeNull();
    expect(called).toBe(false);
  });

  it("surfaces a failed update as an error rather than swallowing it", async () => {
    const admin = makeAdmin((table, spec) => {
      if (table === "pro_clients" && spec.type === "update") {
        return { data: null, error: { message: "db down" } };
      }
      return { data: [] };
    });
    const { error } = await scrubProClientContactInfo(admin, ["client-1"]);
    expect(error).toEqual({ message: "db down" });
  });
});

describe("eraseUserData: pro_clients de-identification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("scrubs a matching pro_clients row and records it as de-identified, not retained", async () => {
    const state = {
      updateCalls: [] as Spec[],
      loggedSummary: null as Record<string, unknown> | null,
    };

    const { createAdminClient } = await import("@/lib/supabase/admin");
    const admin = makeAdmin((table, spec) => {
      switch (table) {
        case "properties":
          return { data: [{ id: "prop-1" }] };
        case "contractors":
          // Homeowner-only account: no contractor listing of their own.
          return spec.type === "delete" ? { data: null, error: null } : { data: null };
        case "contractor_leads":
          return { data: [{ id: "lead-1" }] };
        case "pro_clients": {
          if (spec.type === "update") {
            state.updateCalls.push(spec);
            return { data: null, error: null };
          }
          const byLead = spec.ops.some((o) => "col" in o && o.col === "lead_id");
          if (byLead) return { data: [{ id: "client-1" }] };
          return { data: [] };
        }
        case "users":
          return { data: { email: null, phone: null } };
        case "privacy_actions":
          state.loggedSummary = spec.values as Record<string, unknown>;
          return { data: null, error: null };
        default:
          return { data: [], error: null };
      }
    });
    vi.mocked(createAdminClient).mockReturnValue(admin);

    const summary = await eraseUserData("user-1");

    expect(summary.proClientsDeidentifiedCount).toBe(1);
    expect(summary.deidentified.some((s) => s.includes("1 pro CRM record"))).toBe(true);
    expect(summary.retained.every((s) => !/pro's CRM copy/.test(s))).toBe(true);
    expect(summary.retained.every((s) => !/is NOT removed/.test(s))).toBe(true);
    expect(state.updateCalls).toHaveLength(1);
    expect(state.updateCalls[0].values).toMatchObject({
      client_name: DEIDENTIFIED_CLIENT_NAME,
      email: null,
      phone: null,
      address: null,
    });
    // The audit log entry carries the real count, not just prose.
    expect(state.loggedSummary).toMatchObject({
      action: "delete",
      user_id: "user-1",
      summary: expect.objectContaining({ proClientsDeidentifiedCount: 1 }),
    });
  });

  it("reports zero scrubbed and no crash when nothing matches", async () => {
    const { createAdminClient } = await import("@/lib/supabase/admin");
    const admin = makeAdmin((table, spec) => {
      switch (table) {
        case "properties":
          return { data: [] };
        case "contractors":
          return { data: null };
        case "users":
          return { data: { email: "jane@example.com", phone: null } };
        case "pro_clients":
          return { data: [] };
        default:
          return { data: [], error: null };
      }
    });
    vi.mocked(createAdminClient).mockReturnValue(admin);

    const summary = await eraseUserData("user-2");
    expect(summary.proClientsDeidentifiedCount).toBe(0);
    expect(summary.deidentified).toEqual([]);
    expect(summary.failed).toEqual([]);
  });

  it("dual-side account: own contractor listing still cascades normally alongside the scrub", async () => {
    const state = { contractorDeleted: false };
    const { createAdminClient } = await import("@/lib/supabase/admin");
    const admin = makeAdmin((table, spec) => {
      switch (table) {
        case "properties":
          return { data: [{ id: "prop-1" }] };
        case "contractors":
          if (spec.type === "delete") {
            state.contractorDeleted = true;
            return { data: null, error: null };
          }
          return { data: { id: "contractor-1" } };
        case "contractor_leads": {
          const propOp = spec.ops.some((o) => "col" in o && o.col === "property_id");
          if (propOp) return { data: [{ id: "lead-1" }] };
          return { data: [] }; // this account's own assigned leads
        }
        case "pro_clients": {
          if (spec.type === "update") return { data: null, error: null };
          const byLead = spec.ops.some((o) => "col" in o && o.col === "lead_id");
          if (byLead) return { data: [{ id: "client-1" }] };
          return { data: [] };
        }
        case "users":
          return { data: { email: null, phone: null } };
        default:
          return { data: [], error: null };
      }
    });
    vi.mocked(createAdminClient).mockReturnValue(admin);

    const summary = await eraseUserData("user-3");
    expect(state.contractorDeleted).toBe(true);
    expect(summary.contractorDeleteFailed).toBe(false);
    expect(summary.proClientsDeidentifiedCount).toBe(1);
  });
});
