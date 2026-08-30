import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

// The route builds a session-bound Supabase client, which reaches next/headers
// and is unresolvable under vitest - mocked with a factory the same way the
// health and cron route tests do it.

let currentUser: { id: string } | null = { id: "user-1" };
let upsertError: { code?: string; message?: string } | null = null;
let deleteError: { code?: string; message?: string } | null = null;
let remainingCount = 0;
let storedPrefs: Record<string, unknown> | null = null;

// Everything the route did, in order, so a test can assert on the write rather
// than on a return value alone.
let upserts: Array<{ row: Record<string, unknown>; onConflict?: string }> = [];
let deletes: Array<Record<string, unknown>> = [];
let prefUpdates: Array<Record<string, unknown>> = [];

vi.mock("server-only", () => ({}));
// The write moved to the admin client on 2026-08-30 (RLS upsert could not take
// over a shared device's row); the admin mock reuses the server mock's fake
// client so the same `upserts` recorder sees it.
vi.mock("@/lib/supabase/admin", async () => {
  const srv = await import("@/lib/supabase/server");
  const client = await srv.createClient();
  return { createAdminClient: () => client };
});
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: currentUser } }) },
    from(table: string) {
      if (table === "users") {
        return {
          select: () => ({
            eq: () => ({
              single: async () => ({ data: { notification_prefs: storedPrefs } }),
            }),
          }),
          update: (row: Record<string, unknown>) => {
            prefUpdates.push(row);
            return { eq: async () => ({ error: null }) };
          },
        };
      }
      // push_subscriptions
      return {
        upsert: async (
          row: Record<string, unknown>,
          options?: { onConflict?: string }
        ) => {
          upserts.push({ row, onConflict: options?.onConflict });
          return { error: upsertError };
        },
        delete: () => {
          const filters: Record<string, unknown> = {};
          const chain = {
            eq(column: string, value: unknown) {
              filters[column] = value;
              // The route chains two .eq() calls and awaits the result, so the
              // chain has to be thenable as well as chainable.
              return chain;
            },
            then(resolve: (v: { error: unknown }) => void) {
              deletes.push({ ...filters });
              resolve({ error: deleteError });
            },
          };
          return chain;
        },
        select: () => ({
          eq: async () => ({ count: remainingCount }),
        }),
      };
    },
  }),
}));

import { DELETE, POST } from "./route";

const APPLE_ENDPOINT = "https://web.push.apple.com/abcdef";

function post(body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new Request("https://hearth.test/api/push/subscribe", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

function del(body: unknown): NextRequest {
  return new Request("https://hearth.test/api/push/subscribe", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

const GOOD_BODY = {
  endpoint: APPLE_ENDPOINT,
  keys: { p256dh: "public-key", auth: "auth-secret" },
  side: "pro",
};

beforeEach(() => {
  currentUser = { id: "user-1" };
  upsertError = null;
  deleteError = null;
  remainingCount = 0;
  storedPrefs = null;
  upserts = [];
  deletes = [];
  prefUpdates = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/push/subscribe", () => {
  // Authenticated in the route itself, not just in middleware: middleware
  // redirects page navigations and is explicitly not a security boundary.
  it("refuses an anonymous caller", async () => {
    currentUser = null;
    const response = await POST(post(GOOD_BODY));
    expect(response.status).toBe(401);
    expect(upserts).toEqual([]);
  });

  it("refuses a cross-site request", async () => {
    const response = await POST(post(GOOD_BODY, { "sec-fetch-site": "cross-site" }));
    expect(response.status).toBe(403);
    expect(upserts).toEqual([]);
  });

  it("stores the device against the signed-in account, upserting on endpoint", async () => {
    const response = await POST(post(GOOD_BODY));
    expect(response.status).toBe(200);
    expect(upserts).toHaveLength(1);
    expect(upserts[0].onConflict).toBe("endpoint");
    expect(upserts[0].row).toMatchObject({
      user_id: "user-1",
      endpoint: APPLE_ENDPOINT,
      p256dh: "public-key",
      auth: "auth-secret",
      side: "pro",
    });
    expect(upserts[0].row.last_used_at).toBeTruthy();
  });

  // The endpoint is a URL the server will later POST to, chosen by the client.
  // Without an allowlist that is a server-side request to any host the caller
  // likes.
  it.each([
    "https://evil.example/push",
    "http://web.push.apple.com/abc",
    "https://fcm.googleapis.com.evil.test/abc",
    "not-a-url",
  ])("refuses the endpoint %s", async (endpoint) => {
    const response = await POST(post({ ...GOOD_BODY, endpoint }));
    expect(response.status).toBe(400);
    expect(upserts).toEqual([]);
  });

  it.each([
    ["fcm.googleapis.com", "https://fcm.googleapis.com/fcm/send/x"],
    ["web.push.apple.com", APPLE_ENDPOINT],
    ["mozilla", "https://updates.push.services.mozilla.com/wpush/v2/x"],
  ])("accepts a real %s endpoint", async (_name, endpoint) => {
    const response = await POST(post({ ...GOOD_BODY, endpoint }));
    expect(response.status).toBe(200);
  });

  it("refuses a body with no keys", async () => {
    const response = await POST(post({ endpoint: APPLE_ENDPOINT }));
    expect(response.status).toBe(400);
  });

  it("caps an oversized value rather than storing it", async () => {
    const response = await POST(
      post({ ...GOOD_BODY, keys: { p256dh: "x".repeat(400), auth: "a" } })
    );
    expect(response.status).toBe(400);
    expect(upserts).toEqual([]);
  });

  // Turning it on is explicit consent, so it clears any earlier opt-out - and
  // it must MERGE into the jsonb, because the CAN-SPAM email opt-out lives
  // there too.
  it("clears the push opt-out without disturbing the email opt-out", async () => {
    storedPrefs = { email_opt_out: true, pro_messages: false, push_opt_out: true };
    await POST(post(GOOD_BODY));
    expect(prefUpdates).toHaveLength(1);
    expect(prefUpdates[0].notification_prefs).toEqual({
      email_opt_out: true,
      pro_messages: false,
      push_opt_out: false,
    });
  });

  // A live database that has not had migration 0143 yet: say so plainly rather
  // than pretending the device is registered.
  it("answers 503 when the table does not exist yet", async () => {
    upsertError = { code: "PGRST205", message: "Could not find the table" };
    const response = await POST(post(GOOD_BODY));
    expect(response.status).toBe(503);
  });

  it("rate limits a caller that hammers it", async () => {
    currentUser = { id: "flooder" };
    let last = 200;
    for (let i = 0; i < 40; i += 1) {
      last = (await POST(post(GOOD_BODY))).status;
    }
    expect(last).toBe(429);
  });
});

describe("DELETE /api/push/subscribe", () => {
  it("refuses an anonymous caller", async () => {
    currentUser = null;
    const response = await DELETE(del({ endpoint: APPLE_ENDPOINT }));
    expect(response.status).toBe(401);
    expect(deletes).toEqual([]);
  });

  // Never trust an id that arrived from a browser: the delete is scoped to the
  // caller's own user_id as well as to the endpoint.
  it("deletes only this account's row for that endpoint", async () => {
    currentUser = { id: "user-2" };
    const response = await DELETE(del({ endpoint: APPLE_ENDPOINT }));
    expect(response.status).toBe(200);
    expect(deletes).toEqual([{ endpoint: APPLE_ENDPOINT, user_id: "user-2" }]);
  });

  it("refuses a body with no endpoint", async () => {
    const response = await DELETE(del({}));
    expect(response.status).toBe(400);
    expect(deletes).toEqual([]);
  });

  // Turning it off on the LAST device means "stop pushing me", and that has to
  // survive the device or the next visit silently re-subscribes it.
  it("records the account-wide opt-out when no devices are left", async () => {
    remainingCount = 0;
    await DELETE(del({ endpoint: APPLE_ENDPOINT }));
    expect(prefUpdates).toHaveLength(1);
    expect(prefUpdates[0].notification_prefs).toMatchObject({ push_opt_out: true });
  });

  it("leaves the account-wide preference alone when other devices remain", async () => {
    remainingCount = 2;
    await DELETE(del({ endpoint: APPLE_ENDPOINT }));
    expect(prefUpdates).toEqual([]);
  });
});
