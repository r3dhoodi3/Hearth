// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, act, cleanup } from "@testing-library/react";

// A hand-rolled Supabase stub: every query is a chainable thenable that
// resolves to whatever rows the current test set up, and every channel records
// the postgres_changes config it was handed so the subscription's filter can be
// asserted. vi.hoisted because vi.mock's factory runs before module scope.
const state = vi.hoisted(() => ({
  properties: [{ id: "prop-1" }] as { id: string }[],
  leads: [{ id: "lead-1" }] as { id: string }[],
  messages: [] as { lead_id: string; sender_role: string; created_at: string }[],
  configs: [] as Record<string, unknown>[],
  removed: 0,
}));

vi.mock("@/lib/supabase/client", () => {
  function builder(rows: () => unknown[]) {
    const api: Record<string, unknown> = {};
    Object.assign(api, {
      select: () => api,
      eq: () => api,
      in: () => api,
      is: () => api,
      order: () => api,
      limit: () => api,
      maybeSingle: async () => ({ data: rows()[0] ?? null }),
      then: (resolve: (v: { data: unknown[] }) => unknown) =>
        Promise.resolve({ data: rows() }).then(resolve),
    });
    return api;
  }
  return {
    createClient: () => ({
      from: (table: string) => {
        if (table === "properties") return builder(() => state.properties);
        if (table === "contractor_leads") return builder(() => state.leads);
        if (table === "messages") return builder(() => state.messages);
        return builder(() => []);
      },
      auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) },
      channel: () => ({
        on: function (_event: string, config: Record<string, unknown>) {
          state.configs.push(config);
          return this;
        },
        subscribe: () => ({}),
      }),
      removeChannel: () => {
        state.removed += 1;
      },
    }),
  };
});

import UnreadProvider from "./UnreadProvider";

// The poll chains several awaits before it can hand the lead set to the
// subscription effect, so each settle has to drain the microtask queue and let
// React flush the resulting state update.
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  state.properties = [{ id: "prop-1" }];
  state.leads = [{ id: "lead-1" }];
  state.messages = [];
  state.configs.length = 0;
  state.removed = 0;
});

afterEach(cleanup);

describe("UnreadProvider realtime scoping", () => {
  // The old filter was `sender_role=eq.contractor`: every message written by
  // any contractor anywhere, trimmed to this user's rows by RLS alone. The
  // lead-scoped filter means the server never considers another household's
  // conversation in the first place.
  it("subscribes to the user's own leads, not to a whole-table role stream", async () => {
    render(
      <UnreadProvider role="homeowner">
        <span>badge</span>
      </UnreadProvider>
    );
    await settle();
    expect(state.configs).toHaveLength(1);
    expect(state.configs[0]).toMatchObject({
      event: "INSERT",
      table: "messages",
      filter: "lead_id=in.(lead-1)",
    });
    expect(String(state.configs[0].filter)).not.toContain("sender_role");
  });

  // A lead created after mount would otherwise never be watched, because the
  // filter is baked into the channel at subscribe time.
  it("re-subscribes when a new lead shows up", async () => {
    render(
      <UnreadProvider role="homeowner">
        <span>badge</span>
      </UnreadProvider>
    );
    await settle();
    state.leads = [{ id: "lead-2" }, { id: "lead-1" }];
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await settle();
    expect(state.configs).toHaveLength(2);
    expect(state.configs[1]).toMatchObject({
      filter: "lead_id=in.(lead-2,lead-1)",
    });
    // The stale channel is torn down rather than left joined alongside the new one.
    expect(state.removed).toBeGreaterThanOrEqual(1);
  });

  it("subscribes to nothing when the account has no leads", async () => {
    state.leads = [];
    render(
      <UnreadProvider role="homeowner">
        <span>badge</span>
      </UnreadProvider>
    );
    await settle();
    expect(state.configs).toHaveLength(0);
  });
});
