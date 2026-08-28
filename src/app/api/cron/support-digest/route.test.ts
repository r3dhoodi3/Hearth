import type { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendNotification, sendOutboundChannels } from "@/lib/notify";
import { FOUNDER } from "@/lib/constants";

// The route pulls in the service-role client and the notifier, both of which
// import "server-only" and are unresolvable under vitest. Mocked with
// factories, so the route itself can be imported and driven for real.

// What .from("support_messages") reads back, and the error it reads back with.
let supportRows: Record<string, unknown>[] = [];
let supportError: { code?: string; message?: string } | null = null;
// Set once by the first support_messages query, cleared for the second, so a
// test can prove the fallback query actually runs.
let supportSelects: string[] = [];

// What .from("users") reads back for the owner lookup.
let ownerRow: Record<string, unknown> | null = { id: "owner_1" };
// What .from("notifications") reads back, i.e. whether today's digest already
// went out.
let existingDigest: Record<string, unknown> | null = null;

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => fakeAdmin(),
}));

vi.mock("@/lib/notify", () => ({
  sendNotification: vi.fn(async () => true),
  sendOutboundChannels: vi.fn(async () => {}),
}));
// The in-app row (short body, no contact details) ...
const notify = vi.mocked(sendNotification);
// ... and the email that carries the detail.
const outbound = vi.mocked(sendOutboundChannels);

// What was written to notifications.body, and what was emailed.
const storedInput = () => notify.mock.calls[0][1] as Record<string, any>;
const emailedInput = () => outbound.mock.calls[0][0] as Record<string, any>;

function fakeAdmin() {
  return {
    from(table: string) {
      const api: Record<string, unknown> = {};
      const chain = () => api;
      Object.assign(api, {
        select: (columns: string) => {
          if (table === "support_messages") supportSelects.push(columns);
          return api;
        },
        eq: chain,
        order: chain,
        limit: () => {
          if (table === "support_messages") {
            // The first call may fail with a missing-column error; the
            // fallback call always succeeds, which is what lets a test assert
            // the retry produced a digest.
            const isFirst = supportSelects.length === 1;
            return Promise.resolve({
              data: isFirst && supportError ? null : supportRows,
              error: isFirst ? supportError : null,
            });
          }
          return api;
        },
        maybeSingle: () => {
          if (table === "users") {
            return Promise.resolve({ data: ownerRow, error: null });
          }
          if (table === "notifications") {
            return Promise.resolve({ data: existingDigest, error: null });
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

function message(over: Record<string, unknown> = {}) {
  return {
    id: "sm_1",
    user_id: null,
    name: "Dana",
    email: "dana@example.com",
    message: "My water heater is leaking and nobody called back.",
    priority: false,
    created_at: "2026-08-27T17:05:00.000Z",
    ...over,
  };
}

const ORIGINAL_SECRET = process.env.CRON_SECRET;

beforeEach(() => {
  supportRows = [];
  supportError = null;
  supportSelects = [];
  ownerRow = { id: "owner_1" };
  existingDigest = null;
  notify.mockClear();
  notify.mockResolvedValue(true);
  outbound.mockClear();
  process.env.CRON_SECRET = "cron-secret-value";
});

afterEach(() => {
  if (ORIGINAL_SECRET === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = ORIGINAL_SECRET;
  vi.restoreAllMocks();
});

describe("the digest is gated by CRON_SECRET like every other cron", () => {
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
    // Fail closed: an unconfigured deployment must be dead to this route, not
    // open to it.
    delete process.env.CRON_SECRET;
    const { GET } = await import("./route");
    expect((await GET(req({ authorization: "Bearer anything" }))).status).toBe(401);
  });

  it("accepts the x-cron-secret header for a manual run", async () => {
    supportRows = [message()];
    const { GET } = await import("./route");
    const res = await GET(req({ "x-cron-secret": "cron-secret-value" }));
    expect(res.status).toBe(200);
    expect(notify).toHaveBeenCalledTimes(1);
  });
});

describe("what the owner actually gets told", () => {
  it("emails a digest naming the sender, the source, and the message", async () => {
    supportRows = [message()];
    const { GET } = await import("./route");

    const res = await GET(authed());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ ok: true, open: 1, notified: true });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(outbound).toHaveBeenCalledTimes(1);

    const emailed = emailedInput();
    expect(emailed.userId).toBe("owner_1");
    expect(emailed.kind).toBe("support_digest");
    expect(emailed.title).toBe("1 support message is waiting");
    expect(emailed.body).toContain("dana@example.com");
    expect(emailed.body).toContain("contact form");
    expect(emailed.body).toContain("water heater is leaking");
    // It goes to the founder address in constants, not to a second copy of it.
    expect(emailed.email).toBe(FOUNDER.email);
    // Other people's contact details never go out by SMS.
    expect(emailed.phone).toBeNull();
  });

  it("stores only a count and a shape in the notification row", async () => {
    // notifications has no TTL and nothing deletes it, so a daily digest
    // carrying senders' emails and free text would build a permanent second
    // copy of the support inbox. The stored row says how much is waiting and
    // what kind; the detail lives in the transient email.
    supportRows = [
      message({ id: "a", email: "dana@example.com", priority: true }),
      message({ id: "b", user_id: "u-1", email: null, name: null }),
      message({ id: "c", email: "sam@example.com" }),
    ];
    const { GET } = await import("./route");
    await GET(authed());

    const stored = storedInput();
    expect(stored.title).toBe("3 support messages are waiting");
    expect(stored.body).toContain("3 support messages are waiting.");
    expect(stored.body).toContain("1 from Pro members");
    expect(stored.body).toContain("1 from signed-in members");
    expect(stored.body).toContain("2 from the contact form");
    // Not one word of anyone else's.
    expect(stored.body).not.toContain("dana@example.com");
    expect(stored.body).not.toContain("sam@example.com");
    expect(stored.body).not.toContain("water heater");
    expect(stored.body).not.toContain("Dana");
    // And this call must not send anything: no address, no phone.
    expect(stored.email).toBeNull();
    expect(stored.phone).toBeNull();
  });

  it("does not email the detail when the in-app row could not be written", async () => {
    supportRows = [message()];
    notify.mockResolvedValueOnce(false);
    const { GET } = await import("./route");

    const body = await (await GET(authed())).json();

    expect(body).toMatchObject({ notified: false });
    expect(outbound).not.toHaveBeenCalled();
  });

  it("marks a Pro member's message so it can be triaged first", async () => {
    supportRows = [message({ priority: true })];
    const { GET } = await import("./route");
    await GET(authed());
    expect(emailedInput().body).toContain("[PRO]");
  });

  it("says 'in-app' for a signed-in sender and never prints their id", async () => {
    supportRows = [
      message({ user_id: "11111111-2222-3333-4444-555555555555", email: null, name: null }),
    ];
    const { GET } = await import("./route");
    await GET(authed());

    const emailed = emailedInput();
    expect(emailed.body).toContain("in-app");
    expect(emailed.body).toContain("a signed-in member");
    // A raw uuid is not something the owner can act on from an email.
    expect(emailed.body).not.toContain("11111111-2222");
    expect(storedInput().body).not.toContain("11111111-2222");
  });

  it("caps the list and says how many more are waiting", async () => {
    // 26 rows: the route fetches MAX_LISTED + 1 precisely so it can tell.
    supportRows = Array.from({ length: 26 }, (_, i) =>
      message({ id: `sm_${i}`, email: `person${i}@example.com` })
    );
    const { GET } = await import("./route");
    await GET(authed());

    const emailed = emailedInput();
    expect(emailed.title).toBe("25+ support messages are waiting");
    expect(emailed.body).toContain("More than 25 are open");
    // The 26th is fetched but never listed.
    expect(emailed.body).not.toContain("person25@example.com");
    expect(emailed.body).toContain("person24@example.com");
    // The stored row names nobody at all, listed or not.
    expect(storedInput().body).not.toContain("person0@example.com");
  });

  it("collapses newlines so one message stays one line", async () => {
    supportRows = [message({ message: "line one\n\nline two" })];
    const { GET } = await import("./route");
    await GET(authed());
    expect(emailedInput().body).toContain("line one line two");
  });
});

describe("it stays quiet when it should", () => {
  it("sends nothing when no message is open", async () => {
    // A daily "0 messages" note is the mail that trains someone to ignore the
    // channel.
    supportRows = [];
    const { GET } = await import("./route");

    const body = await (await GET(authed())).json();

    expect(body).toMatchObject({ ok: true, open: 0, notified: false });
    expect(notify).not.toHaveBeenCalled();
  });

  it("does not re-send today's digest on a re-run", async () => {
    supportRows = [message()];
    existingDigest = { id: "n_1" };
    const { GET } = await import("./route");

    const body = await (await GET(authed())).json();

    expect(body).toMatchObject({ ok: true, open: 1, notified: false });
    expect(notify).not.toHaveBeenCalled();
  });
});

describe("it degrades instead of failing", () => {
  it("retries without the newer columns when the live DB lacks them", async () => {
    // A live database missing 0038's `priority` must still produce a digest,
    // not a silent daily failure.
    supportError = { code: "42703", message: 'column "priority" does not exist' };
    supportRows = [message()];
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { GET } = await import("./route");

    const body = await (await GET(authed())).json();

    expect(supportSelects).toHaveLength(2);
    expect(supportSelects[0]).toContain("priority");
    expect(supportSelects[1]).not.toContain("priority");
    expect(body).toMatchObject({ ok: true, notified: true });
  });

  it("does not retry a real query error, and 200s rather than looping", async () => {
    // A non-2xx would have the platform mark the run failed and retry inside
    // the same minute, which fixes nothing.
    supportError = { code: "57014", message: "canceling statement due to timeout" };
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { GET } = await import("./route");

    const res = await GET(authed());

    expect(supportSelects).toHaveLength(1);
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(false);
    expect(notify).not.toHaveBeenCalled();
  });

  it("reports the backlog even when no account matches the founder address", async () => {
    // sendNotification is built around a user row (the bell, the CAN-SPAM
    // unsubscribe token), so there is nothing to send through. The messages are
    // safe in the table and the next run retries.
    supportRows = [message()];
    ownerRow = null;
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { GET } = await import("./route");

    const res = await GET(authed());

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: false, open: 1, notified: false });
    expect(notify).not.toHaveBeenCalled();
  });
});
