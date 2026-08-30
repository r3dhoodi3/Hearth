import type { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendNotification } from "@/lib/notify";

// The route pulls in the service-role client and the notifier, both of which
// import "server-only" and are unresolvable under vitest. Mocked with
// factories, same pattern every other cron test in this app uses, so the
// route itself can be imported and driven for real.

// What .from("subscriptions") reads back for the past_due candidates.
let pastDueRows: Record<string, unknown>[] = [];
let subsError: { message: string } | null = null;

// What .from("notifications") reads back for the webhook's own first notice
// (matched by selecting "url, created_at") and for this cron's own dedupe
// check (matched by selecting "id"). Keyed by test rather than by a real
// query planner, since the fake below has no SQL to run.
let firstNotice: Record<string, unknown> | null = null;
let existingFollowup: Record<string, unknown> | null = null;

// What .from("users") reads back for the email lookup.
let userRow: Record<string, unknown> | null = { email: "member@example.com" };

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => fakeAdmin(),
}));

vi.mock("@/lib/notify", () => ({ sendNotification: vi.fn(async () => true) }));
const notify = vi.mocked(sendNotification);

function fakeAdmin() {
  return {
    from(table: string) {
      const api: Record<string, unknown> = {};
      const chain = () => api;
      let selectedColumns = "";
      Object.assign(api, {
        select: (columns: string) => {
          selectedColumns = columns;
          return api;
        },
        eq: chain,
        not: chain,
        like: chain,
        order: chain,
        limit: (n: number) => {
          // The subscriptions query is awaited directly after .limit(), never
          // through .maybeSingle() - that is what distinguishes it here from
          // the two notifications lookups and the user lookup, which all end
          // in .maybeSingle().
          if (table === "subscriptions") {
            return Promise.resolve({ data: pastDueRows, error: subsError });
          }
          return api;
        },
        maybeSingle: () => {
          if (table === "notifications") {
            const data =
              selectedColumns === "id" ? existingFollowup : firstNotice;
            return Promise.resolve({ data, error: null });
          }
          if (table === "users") {
            return Promise.resolve({ data: userRow, error: null });
          }
          return Promise.resolve({ data: null, error: null });
        },
      });
      return api;
    },
  };
}

function req(headers: Record<string, string> = {}) {
  return {
    headers: { get: (key: string) => headers[key.toLowerCase()] ?? null },
  } as unknown as NextRequest;
}

function authed() {
  return req({ authorization: "Bearer cron-secret-value" });
}

const NOW = new Date("2026-08-30T12:00:00.000Z");

function hoursAgo(h: number): string {
  return new Date(NOW.getTime() - h * 60 * 60 * 1000).toISOString();
}

const ORIGINAL_SECRET = process.env.CRON_SECRET;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  pastDueRows = [{ user_id: "user_1", plan: "monthly", status: "past_due" }];
  subsError = null;
  firstNotice = {
    url: "/plus?billing=past_due&invoice=in_123",
    created_at: hoursAgo(80),
  };
  existingFollowup = null;
  userRow = { email: "member@example.com" };
  notify.mockClear();
  notify.mockResolvedValue(true);
  process.env.CRON_SECRET = "cron-secret-value";
});

afterEach(() => {
  vi.useRealTimers();
  if (ORIGINAL_SECRET === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = ORIGINAL_SECRET;
  vi.restoreAllMocks();
});

describe("the follow-up cron is gated by CRON_SECRET like every other cron", () => {
  it("401s with no credential at all", async () => {
    const { GET } = await import("./route");
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(notify).not.toHaveBeenCalled();
  });

  it("401s on a wrong secret", async () => {
    const { GET } = await import("./route");
    expect((await GET(req({ authorization: "Bearer nope" }))).status).toBe(401);
  });

  it("401s on a secret of the wrong LENGTH without throwing", async () => {
    // timingSafeEqual throws on a length mismatch, so the length check has to
    // come first or an attacker gets a 500 oracle instead of a 401.
    const { GET } = await import("./route");
    expect(
      (await GET(req({ authorization: "Bearer short" }))).status
    ).toBe(401);
  });

  it("refuses everything when CRON_SECRET is not configured", async () => {
    delete process.env.CRON_SECRET;
    const { GET } = await import("./route");
    expect((await GET(req({ authorization: "Bearer anything" }))).status).toBe(401);
  });

  it("accepts the x-cron-secret header for a manual run", async () => {
    const { GET } = await import("./route");
    const res = await GET(req({ "x-cron-secret": "cron-secret-value" }));
    expect(res.status).toBe(200);
    expect(notify).toHaveBeenCalledTimes(1);
  });
});

describe("who gets a follow-up", () => {
  it("sends one 72+ hours after the first notice for a still-past_due row", async () => {
    const { GET } = await import("./route");
    const res = await GET(authed());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ checked: 1, notified: 1 });
    expect(notify).toHaveBeenCalledTimes(1);
    const [, input] = notify.mock.calls[0];
    expect(input.kind).toBe("payment_failed_followup");
    expect(input.userId).toBe("user_1");
    expect(input.email).toBe("member@example.com");
    expect(input.phone).toBeNull();
    // The helpful, non-alarming tone the owner asked for.
    expect(input.body).toContain(
      "Your card did not go through. Update it in a minute and nothing changes."
    );
    // Deduped on the SAME invoice id the webhook's first notice carried.
    expect(input.url).toContain("invoice=in_123");
    expect(input.url).toContain("billing=past_due_followup");
  });

  it("does nothing before 72 hours have passed", async () => {
    firstNotice = { ...firstNotice, created_at: hoursAgo(10) };
    const { GET } = await import("./route");
    const body = await (await GET(authed())).json();
    expect(body).toEqual({ checked: 1, notified: 0 });
    expect(notify).not.toHaveBeenCalled();
  });

  it("skips a row with no first notice on file", async () => {
    // Can happen if the plan name was unrecognized when the webhook fired -
    // the row was flagged past_due but no notice was ever written.
    firstNotice = null;
    const { GET } = await import("./route");
    const body = await (await GET(authed())).json();
    expect(body).toEqual({ checked: 1, notified: 0 });
    expect(notify).not.toHaveBeenCalled();
  });

  it("does not send a second follow-up for the same invoice", async () => {
    existingFollowup = { id: "notif_1" };
    const { GET } = await import("./route");
    const body = await (await GET(authed())).json();
    expect(body).toEqual({ checked: 1, notified: 0 });
    expect(notify).not.toHaveBeenCalled();
  });

  it("skips a row whose stored plan is unrecognized", async () => {
    pastDueRows = [{ user_id: "user_2", plan: "some_future_plan", status: "past_due" }];
    const { GET } = await import("./route");
    const body = await (await GET(authed())).json();
    expect(body).toEqual({ checked: 1, notified: 0 });
    expect(notify).not.toHaveBeenCalled();
  });

  it("reports the query error without throwing when the subscriptions read fails", async () => {
    subsError = { message: "db unavailable" };
    const { GET } = await import("./route");
    const res = await GET(authed());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.error).toBe("db unavailable");
    expect(notify).not.toHaveBeenCalled();
  });

  it("checks nothing and sends nothing with no past_due rows", async () => {
    pastDueRows = [];
    const { GET } = await import("./route");
    const body = await (await GET(authed())).json();
    expect(body).toEqual({ checked: 0, notified: 0 });
    expect(notify).not.toHaveBeenCalled();
  });
});
