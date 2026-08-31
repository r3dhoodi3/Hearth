// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, act, cleanup, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// The push mounts and the vitals reporter are irrelevant to the toast under
// test (service workers do not exist in jsdom anyway), so they are stubbed to
// nothing, same idiom as Nav.test.tsx.
vi.mock("@/components/PushRegistrar", () => ({ default: () => null }));
vi.mock("@/components/PushPrompt", () => ({ default: () => null }));
vi.mock("@/components/WebVitals", () => ({ default: () => null }));
vi.mock("@/lib/pushPrompt", () => ({ markPushMoment: vi.fn() }));

// A hand-rolled Supabase stub in the UnreadProvider.test.tsx style, with one
// upgrade: the messages builder actually APPLIES gt/neq/in filters instead of
// returning every row. That matters here, because the regression under test is
// precisely that the query used to lack the `.in("lead_id", ...)` scope - a
// mock that ignores filters could not tell the fixed query from the buggy one.
const state = vi.hoisted(() => ({
  properties: [{ id: "prop-1" }] as { id: string }[],
  leads: [{ id: "lead-1" }] as { id: string }[],
  contractors: [] as { id: string }[],
  messages: [] as {
    id: string;
    lead_id: string;
    sender_role: string;
    body: string;
    created_at: string;
  }[],
  messagesQueried: 0,
}));

vi.mock("@/lib/supabase/client", () => {
  function builder(rows: () => unknown[]) {
    const api: Record<string, unknown> = {};
    Object.assign(api, {
      select: () => api,
      eq: () => api,
      in: () => api,
      order: () => api,
      limit: () => api,
      maybeSingle: async () => ({ data: rows()[0] ?? null }),
      then: (resolve: (v: { data: unknown[] }) => unknown) =>
        Promise.resolve({ data: rows() }).then(resolve),
    });
    return api;
  }
  function messagesBuilder() {
    state.messagesQueried += 1;
    type Row = Record<string, string>;
    let rows: Row[] = state.messages.slice();
    const api: Record<string, unknown> = {};
    Object.assign(api, {
      select: () => api,
      gt: (column: string, value: string) => {
        rows = rows.filter((r) => r[column] > value);
        return api;
      },
      neq: (column: string, value: string) => {
        rows = rows.filter((r) => r[column] !== value);
        return api;
      },
      in: (column: string, values: string[]) => {
        rows = rows.filter((r) => values.includes(r[column]));
        return api;
      },
      order: () => api,
      limit: () => api,
      then: (resolve: (v: { data: Row[] }) => unknown) =>
        Promise.resolve({ data: rows }).then(resolve),
    });
    return api;
  }
  return {
    createClient: () => ({
      from: (table: string) => {
        if (table === "messages") return messagesBuilder();
        if (table === "properties") return builder(() => state.properties);
        if (table === "contractor_leads") return builder(() => state.leads);
        if (table === "contractors") return builder(() => state.contractors);
        return builder(() => []);
      },
      auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) },
    }),
  };
});

import NewMessageNotifier from "./NewMessageNotifier";

// A created_at safely later than the component's mount-time sinceRef.
const future = () => new Date(Date.now() + 60000).toISOString();

// The poll chains several awaits (lazy client, lead resolution, messages,
// name lookup), so each settle drains the microtask queue a few times and
// lets React flush the resulting state updates.
async function settle() {
  for (let i = 0; i < 3; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

beforeEach(() => {
  state.properties = [{ id: "prop-1" }];
  state.leads = [{ id: "lead-1" }];
  state.contractors = [];
  state.messages = [];
  state.messagesQueried = 0;
});

afterEach(cleanup);

describe("NewMessageNotifier dual-role scoping", () => {
  // The reported bug: a dual-role (homeowner + pro) account's RLS can read
  // messages on its business's leads too, so its own outgoing contractor
  // messages toasted as "Your pro" on the homeowner side. The lead scope must
  // keep any message outside this side's lead set from ever toasting.
  it("does not toast a contractor message on a lead outside the homeowner's set", async () => {
    state.messages = [
      {
        id: "m-1",
        lead_id: "business-lead-99",
        sender_role: "contractor",
        body: "quote sent from my business side",
        created_at: future(),
      },
    ];
    render(<NewMessageNotifier role="homeowner" />);
    await settle();
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByText("Your pro")).toBeNull();
  });

  it("toasts a contractor message on a lead the homeowner side owns", async () => {
    state.messages = [
      {
        id: "m-2",
        lead_id: "lead-1",
        sender_role: "contractor",
        body: "On my way now",
        created_at: future(),
      },
    ];
    render(<NewMessageNotifier role="homeowner" />);
    await settle();
    expect(screen.getByRole("status")).toBeInTheDocument();
    // The mock's lead rows carry no embedded contractor name, so the toast
    // falls back to the generic label; the link must point at the homeowner
    // chat for that lead.
    expect(screen.getByText("Your pro")).toBeInTheDocument();
    expect(screen.getByRole("link")).toHaveAttribute("href", "/chats?lead=lead-1");
    expect(screen.getByText("On my way now")).toBeInTheDocument();
  });

  // The mirror image on the pro side: an incoming homeowner-side message on a
  // lead that is not one of this business's leads must not toast there.
  it("does not toast a homeowner message on a lead outside the contractor's set", async () => {
    state.contractors = [{ id: "contractor-1" }];
    state.leads = [{ id: "lead-1" }];
    state.messages = [
      {
        id: "m-3",
        lead_id: "home-lead-42",
        sender_role: "homeowner",
        body: "hello from my own home side",
        created_at: future(),
      },
    ];
    render(<NewMessageNotifier role="contractor" />);
    await settle();
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByText("Homeowner")).toBeNull();
  });

  it("skips the messages query entirely when this side has no leads", async () => {
    state.properties = [];
    state.leads = [];
    render(<NewMessageNotifier role="homeowner" />);
    await settle();
    expect(state.messagesQueried).toBe(0);
    expect(screen.queryByRole("status")).toBeNull();
  });
});
