import { beforeEach, describe, expect, it, vi } from "vitest";

// trackServerEvent used to be copy-pasted verbatim into src/app/pro/actions.ts
// and src/app/(app)/contractors/actions.ts. This is the one shared copy now
// (src/lib/trackServer.ts); these tests pin the three behaviors every caller
// relies on: it writes the right row, it degrades gracefully instead of
// throwing when the table is missing, and it never throws even when the admin
// client itself blows up - analytics must never be able to break a caller.

let insertResult: { error: { code?: string; message?: string } | null } = {
  error: null,
};
const insertedRows: Record<string, unknown>[] = [];
const logSafeCalls: unknown[][] = [];

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(() => ({
    from: (table: string) => ({
      insert: (row: Record<string, unknown>) => {
        if (table !== "app_events") {
          throw new Error(`unexpected table: ${table}`);
        }
        insertedRows.push(row);
        return Promise.resolve(insertResult);
      },
    }),
  })),
}));

vi.mock("@/lib/logSafe", () => ({
  logSafe: (...args: unknown[]) => {
    logSafeCalls.push(args);
  },
}));

import { trackServerEvent } from "./trackServer";

beforeEach(() => {
  insertResult = { error: null };
  insertedRows.length = 0;
  logSafeCalls.length = 0;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("trackServerEvent", () => {
  it("writes the event, props, and user id to app_events", async () => {
    await trackServerEvent("user-1", "checkout_started", { plan: "monthly" });

    expect(insertedRows).toHaveLength(1);
    expect(insertedRows[0]).toEqual({
      event: "checkout_started",
      props: { plan: "monthly" },
      user_id: "user-1",
    });
  });

  it("allows a null user id for a signed-out visitor", async () => {
    await trackServerEvent(null, "contact_sent", {});
    expect(insertedRows[0].user_id).toBeNull();
  });

  it("defaults props to null when none are given", async () => {
    await trackServerEvent("user-1", "some_event");
    expect(insertedRows[0].props).toBeNull();
  });

  it("degrades to a log line instead of throwing when the table is missing", async () => {
    insertResult = { error: { code: "PGRST205", message: "could not find" } };

    await expect(
      trackServerEvent("user-1", "plan_built", { task_count: 3 })
    ).resolves.toBeUndefined();

    expect(logSafeCalls).toHaveLength(1);
    expect(logSafeCalls[0][1]).toBe("plan_built");
  });

  it("logs, not throws, on a real insert failure", async () => {
    insertResult = { error: { code: "23505", message: "conflict" } };

    await expect(
      trackServerEvent("user-1", "home_claimed", { match_source: "real" })
    ).resolves.toBeUndefined();

    expect(console.error).toHaveBeenCalledWith(
      "trackServerEvent(home_claimed): insert failed:",
      "conflict"
    );
  });

  it("never throws even when the admin client itself blows up", async () => {
    const { createAdminClient } = await import("@/lib/supabase/admin");
    (createAdminClient as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () => {
        throw new Error("boom");
      }
    );

    await expect(
      trackServerEvent("user-1", "ask_asked", { tier: "free" })
    ).resolves.toBeUndefined();
  });
});
