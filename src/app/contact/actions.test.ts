import { beforeEach, describe, expect, it, vi } from "vitest";

// sendContactMessageAction used to setFlash()+redirect(await
// successDestination()) on success - a toast on top of whatever page the
// visitor landed on next, easy to miss. It now redirects straight to a
// dedicated confirmation page (src/app/contact/thanks/page.tsx) and sets no
// flash at all, on both the real success path and the honeypot's pretend
// success (they must stay indistinguishable to a bot).
//
// A NEXT_REDIRECT is not a crash - it is Next's own throw-to-navigate
// mechanism - so the mock reproduces that shape and the helper below catches
// only that marker. Anything else thrown fails the test.

class RedirectSignal extends Error {
  constructor(public path: string) {
    super(`REDIRECT:${path}`);
  }
}

let rpcAnswers: Record<string, unknown> = {};
let insertError: { message?: string } | null = null;
let lastInsert: Record<string, unknown> | null = null;
// The app_events write trackServerEvent makes on a real send (docs/ANALYTICS.md).
let trackedEvents: Record<string, unknown>[] = [];

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(() => ({
    rpc: vi.fn(async (fn: string) => {
      if (fn === "rate_limit_hit") return { data: true, error: null };
      if (fn === "match_support_contact") {
        return { data: rpcAnswers.match ?? null, error: null };
      }
      throw new Error(`unexpected rpc "${fn}"`);
    }),
    from: (table: string) => {
      if (table === "app_events") {
        return {
          insert: (row: Record<string, unknown>) => {
            trackedEvents.push(row);
            return Promise.resolve({ error: null });
          },
        };
      }
      if (table !== "support_messages") {
        throw new Error(`unexpected write to "${table}"`);
      }
      return {
        insert: (values: Record<string, unknown>) => {
          lastInsert = values;
          return Promise.resolve({ error: insertError });
        },
      };
    },
  })),
}));

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => null })),
}));

vi.mock("next/navigation", () => ({
  redirect: vi.fn((path: string) => {
    throw new RedirectSignal(path);
  }),
}));

import { sendContactMessageAction } from "./actions";

function fd(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

// The action always ends in a redirect(), which throws. Swallow only that
// marker; anything else is a real failure.
async function run(fields: Record<string, string>): Promise<string> {
  try {
    await sendContactMessageAction(fd(fields));
  } catch (e) {
    if (e instanceof RedirectSignal) return e.path;
    throw e;
  }
  throw new Error("sendContactMessageAction returned without redirecting");
}

beforeEach(() => {
  rpcAnswers = {};
  insertError = null;
  lastInsert = null;
  trackedEvents = [];
});

describe("sendContactMessageAction redirect target", () => {
  it("redirects to /contact/thanks on a real success", async () => {
    const to = await run({
      name: "Alex Rivera",
      email: "alex@example.com",
      message: "The quote form on my job posting is not saving.",
    });
    expect(to).toBe("/contact/thanks");
    expect(lastInsert).toMatchObject({ user_id: null, email: "alex@example.com" });
  });

  // docs/ANALYTICS.md: user_id is always null here, even though this same
  // message might get silently matched to an account elsewhere in the action
  // - that match is an unverified guess, not a confirmed identity, and must
  // never be used to attribute an analytics event.
  it("records contact_sent with no user id and no message text", async () => {
    await run({
      name: "Alex Rivera",
      email: "alex@example.com",
      message: "The quote form on my job posting is not saving.",
    });
    expect(trackedEvents).toHaveLength(1);
    expect(trackedEvents[0]).toEqual({
      event: "contact_sent",
      props: {},
      user_id: null,
    });
  });

  it("redirects to /contact/thanks on the honeypot path too, without inserting anything", async () => {
    const to = await run({
      name: "Bot",
      email: "bot@example.com",
      message: "Anything at all here, it does not matter.",
      company_website: "https://spam.example",
    });
    expect(to).toBe("/contact/thanks");
    // A bot must see the exact same outcome as a real sender - no insert
    // happened, so it gets no signal to tell the two apart.
    expect(lastInsert).toBeNull();
    // Nor does it get counted as a real contact_sent.
    expect(trackedEvents).toHaveLength(0);
  });

  it("does not redirect on a validation failure and stays on /contact", async () => {
    const res = await sendContactMessageAction(
      fd({ name: "Alex", email: "alex@example.com", message: "too short" })
    );
    expect(res).toEqual({ ok: false, error: expect.any(String) });
    expect(lastInsert).toBeNull();
  });
});
