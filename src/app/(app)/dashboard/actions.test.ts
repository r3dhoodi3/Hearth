import { beforeEach, describe, expect, it, vi } from "vitest";

// B6 tester bug: "after finishing all tasks and clicking 'add more', clearing
// a new task says 'Couldn't update reminder. Please try again.'"
//
// Root cause: generateMaintenancePlanAction only excluded titles that were
// still OPEN. Once every reminder for the day was checked off, re-running the
// plan recreated the SAME titles as fresh open rows. Checking one of those
// back off then collided with migration 0063's
// maintenance_tasks_history_dedupe_idx - a unique index on (property_id,
// lower(title), completion day) among 'done' rows - because the title had
// already been completed once, that same UTC day, minutes earlier. Postgres
// 23505, surfaced to the owner as a generic, unrecoverable "Couldn't update
// reminder" with no way to check that box ever again.
//
// These tests pin both halves of the fix: the plan generator now also skips a
// title finished earlier today (so the collision is never created), and
// completeReminderAction treats that specific 23505 as "already done today
// under this title" rather than a hard failure, if one ever still occurs.
//
// The verifier pass added three more: the generator's reads are narrowed by
// status (an unfiltered read of every task a home ever had can be truncated
// by PostgREST's max-rows and silently lose an open title), the title
// comparison is case-insensitive to match the index's own lower(title) key,
// and the 23505 recovery delete is pinned to status = 'open' so it can never
// remove a completed history row.

type TaskRow = { title: string; status: string; completed_at: string | null };

let activeProperty: Record<string, unknown> | null;
let plus = true;
let homeSystems: { system_type: string }[] = [];
let existingTasks: TaskRow[] = [];
let insertedRows: Record<string, unknown>[] | null = null;
let updateError: { code: string; message: string } | null = null;
let deletes: Record<string, string>[] = [];
let selectFilters: Record<string, string>[] = [];

const sessionUser = { id: "user-1", email: "owner@example.com" };

vi.mock("@/lib/property", () => ({
  getActiveProperty: vi.fn(async () => activeProperty),
}));
vi.mock("@/lib/subscription", () => ({ hasPlus: vi.fn(async () => plus) }));
vi.mock("@/lib/flash", () => ({ setFlash: vi.fn(async () => {}) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((path: string) => {
    throw new Error(`REDIRECT:${path}`);
  }),
}));
vi.mock("@/lib/trackServer", () => ({ trackServerEvent: vi.fn(async () => {}) }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(() => ({
    from: () => ({
      update: () => ({ eq: () => ({ is: () => ({ select: async () => ({ data: [], error: null }) }) }) }),
    }),
  })),
}));

// A tiny stand-in for the PostgREST builder: chainable .eq()/.gte() that
// records what it was asked for, resolved by awaiting it. Filtering happens
// here rather than being ignored, so a test can prove the action asked the
// database the narrow question instead of reading the whole table.
function selectBuilder() {
  const filters: Record<string, string> = {};
  const builder: any = {
    eq(col: string, val: string) {
      filters[col] = val;
      return builder;
    },
    gte(col: string, val: string) {
      filters[`${col}__gte`] = val;
      return builder;
    },
    then(resolve: (v: { data: TaskRow[] }) => void) {
      selectFilters.push({ ...filters });
      const rows = existingTasks.filter((t) => {
        if (filters.status && t.status !== filters.status) return false;
        const gte = filters["completed_at__gte"];
        if (gte && !(t.completed_at && t.completed_at >= gte)) return false;
        return true;
      });
      resolve({ data: rows });
    },
  };
  return builder;
}

function deleteBuilder() {
  const filters: Record<string, string> = {};
  const builder: any = {
    eq(col: string, val: string) {
      filters[col] = val;
      return builder;
    },
    then(resolve: (v: { error: null }) => void) {
      deletes.push({ ...filters });
      resolve({ error: null });
    },
  };
  return builder;
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: async () => ({ data: { user: sessionUser } }) },
    from: (table: string) => {
      if (table === "home_systems") {
        return {
          select: () => ({
            eq: async () => ({ data: homeSystems }),
          }),
        };
      }
      if (table === "maintenance_tasks") {
        return {
          select: () => selectBuilder(),
          insert: async (rows: Record<string, unknown>[]) => {
            insertedRows = rows;
            return { error: null };
          },
          update: () => ({
            eq: () => (updateError ? { error: updateError } : { error: null }),
          }),
          delete: () => deleteBuilder(),
        };
      }
      throw new Error(`unexpected table "${table}"`);
    },
  })),
}));

import { completeReminderAction, generateMaintenancePlanAction } from "./actions";

beforeEach(() => {
  activeProperty = { id: "property-1", user_id: "user-1" };
  plus = true;
  homeSystems = [];
  existingTasks = [];
  insertedRows = null;
  updateError = null;
  deletes = [];
  selectFilters = [];
});

describe("generateMaintenancePlanAction", () => {
  it("skips a title already completed today, so it never recreates a doomed duplicate", async () => {
    const todayIso = new Date().toISOString();
    existingTasks = [
      { title: "Test smoke and CO detectors", status: "done", completed_at: todayIso },
    ];

    await generateMaintenancePlanAction();

    expect(insertedRows).not.toBeNull();
    const titles = (insertedRows ?? []).map((r) => r.title);
    expect(titles).not.toContain("Test smoke and CO detectors");
    expect(titles).toContain("Clean gutters and downspouts");
  });

  it("matches the index's lower(title) key, so different casing still collides", async () => {
    existingTasks = [
      {
        title: "test smoke AND co detectors",
        status: "done",
        completed_at: new Date().toISOString(),
      },
    ];

    await generateMaintenancePlanAction();

    const titles = (insertedRows ?? []).map((r) => r.title);
    expect(titles).not.toContain("Test smoke and CO detectors");
  });

  it("still recreates a title completed on an earlier day (it's due again, not doomed to collide)", async () => {
    existingTasks = [
      {
        title: "Test smoke and CO detectors",
        status: "done",
        completed_at: "2020-01-01T00:00:00.000Z",
      },
    ];

    await generateMaintenancePlanAction();

    const titles = (insertedRows ?? []).map((r) => r.title);
    expect(titles).toContain("Test smoke and CO detectors");
  });

  it("still skips a title that's simply still open, as before", async () => {
    existingTasks = [
      { title: "Clean gutters and downspouts", status: "open", completed_at: null },
    ];

    await generateMaintenancePlanAction();

    const titles = (insertedRows ?? []).map((r) => r.title);
    expect(titles).not.toContain("Clean gutters and downspouts");
    expect(titles).toContain("Test smoke and CO detectors");
  });

  it("asks the database two narrow questions instead of reading every task ever", async () => {
    await generateMaintenancePlanAction();

    const taskReads = selectFilters.filter((f) => f.property_id === "property-1");
    expect(taskReads).toHaveLength(2);
    expect(taskReads.some((f) => f.status === "open")).toBe(true);
    const doneRead = taskReads.find((f) => f.status === "done");
    expect(doneRead).toBeDefined();
    // Bounded to today's completions, matching the index's UTC-day window.
    expect(doneRead?.["completed_at__gte"]).toBe(
      `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`
    );
  });
});

describe("completeReminderAction", () => {
  it("treats the history-dedupe collision as already done, not a failure", async () => {
    updateError = {
      code: "23505",
      message:
        'duplicate key value violates unique constraint "maintenance_tasks_history_dedupe_idx"',
    };

    const res = await completeReminderAction("task-1");

    expect(res.ok).toBe(true);
    // The now-redundant duplicate row is removed rather than left stuck, and
    // ONLY while it is still open: a 'done' history row carries the owner's
    // own cost_cents / performed_by and must never be deleted by this path.
    expect(deletes).toEqual([{ id: "task-1", status: "open" }]);
  });

  it("still reports a real failure as an error, unchanged", async () => {
    updateError = { code: "42501", message: "permission denied" };

    const res = await completeReminderAction("task-1");

    expect(res.ok).toBe(false);
    expect(deletes).toEqual([]);
  });
});
