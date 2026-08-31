import { describe, expect, it } from "vitest";
import { myLeadIdsForRole, type Browser } from "./sideLeads";

type Row = Record<string, unknown>;
type Filter = { op: string; column: string; value: unknown };
type Call = { table: string; filters: Filter[] };

// A minimal chainable Supabase stub. Every from() records the table and the
// filters applied to it, and resolves to whatever rows the test wired for that
// table, so each assertion can check both the result and the shape of the
// query that produced it.
function makeClient(tables: Record<string, Row[]>, uid: string | null) {
  const calls: Call[] = [];
  let getUserCalls = 0;
  const client = {
    from(table: string) {
      const call: Call = { table, filters: [] };
      calls.push(call);
      const rows = tables[table] ?? [];
      const api: Record<string, unknown> = {};
      Object.assign(api, {
        select: () => api,
        eq: (column: string, value: unknown) => {
          call.filters.push({ op: "eq", column, value });
          return api;
        },
        in: (column: string, value: unknown) => {
          call.filters.push({ op: "in", column, value });
          return api;
        },
        order: () => api,
        maybeSingle: async () => ({ data: rows[0] ?? null }),
        then: (resolve: (v: { data: Row[] }) => unknown) =>
          Promise.resolve({ data: rows }).then(resolve),
      });
      return api;
    },
    auth: {
      getUser: async () => {
        getUserCalls += 1;
        return { data: { user: uid ? { id: uid } : null } };
      },
    },
  };
  return {
    client: client as unknown as Browser,
    calls,
    getUserCalls: () => getUserCalls,
  };
}

describe("myLeadIdsForRole homeowner path", () => {
  it("resolves properties first, then leads scoped to those properties", async () => {
    const { client, calls } = makeClient(
      {
        properties: [{ id: "prop-1" }, { id: "prop-2" }],
        contractor_leads: [{ id: "lead-2" }, { id: "lead-1" }],
      },
      "user-1"
    );
    const ids = await myLeadIdsForRole(client, "homeowner");
    expect(ids).toEqual(["lead-2", "lead-1"]);
    const leadCall = calls.find((c) => c.table === "contractor_leads");
    expect(leadCall?.filters).toContainEqual({
      op: "in",
      column: "property_id",
      value: ["prop-1", "prop-2"],
    });
  });

  it("returns [] without querying leads when the account has no properties", async () => {
    const { client, calls } = makeClient(
      { properties: [], contractor_leads: [{ id: "lead-1" }] },
      "user-1"
    );
    const ids = await myLeadIdsForRole(client, "homeowner");
    expect(ids).toEqual([]);
    expect(calls.some((c) => c.table === "contractor_leads")).toBe(false);
  });
});

describe("myLeadIdsForRole contractor path", () => {
  it("filters to the user's own contractors row, then that row's leads", async () => {
    const { client, calls } = makeClient(
      {
        contractors: [{ id: "contractor-1" }],
        contractor_leads: [{ id: "lead-9" }],
      },
      "user-1"
    );
    const ids = await myLeadIdsForRole(client, "contractor");
    expect(ids).toEqual(["lead-9"]);
    // The contractors RLS shows other contractors' rows too, so the query must
    // pin the row by user_id explicitly rather than trust RLS to self-scope.
    const contractorCall = calls.find((c) => c.table === "contractors");
    expect(contractorCall?.filters).toContainEqual({
      op: "eq",
      column: "user_id",
      value: "user-1",
    });
    const leadCall = calls.find((c) => c.table === "contractor_leads");
    expect(leadCall?.filters).toContainEqual({
      op: "eq",
      column: "contractor_id",
      value: "contractor-1",
    });
  });

  it("resolves auth.getUser once when a cachedUid holder is reused across calls", async () => {
    const { client, getUserCalls } = makeClient(
      {
        contractors: [{ id: "contractor-1" }],
        contractor_leads: [{ id: "lead-9" }],
      },
      "user-1"
    );
    const holder = { uid: null as string | null };
    await myLeadIdsForRole(client, "contractor", holder);
    await myLeadIdsForRole(client, "contractor", holder);
    expect(getUserCalls()).toBe(1);
    expect(holder.uid).toBe("user-1");
  });

  it("returns [] for a signed-out user", async () => {
    const { client } = makeClient(
      { contractors: [{ id: "contractor-1" }], contractor_leads: [{ id: "lead-9" }] },
      null
    );
    expect(await myLeadIdsForRole(client, "contractor")).toEqual([]);
  });

  it("returns [] when the account has no contractors row", async () => {
    const { client } = makeClient(
      { contractors: [], contractor_leads: [{ id: "lead-9" }] },
      "user-1"
    );
    expect(await myLeadIdsForRole(client, "contractor")).toEqual([]);
  });
});
