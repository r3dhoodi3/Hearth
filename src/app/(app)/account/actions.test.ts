import { beforeEach, describe, expect, it, vi } from "vitest";

// saveAccountAction (./actions.ts) writes the homeowner's name and phone on
// their own session client, and the SMS-consent pair through the service role
// (migration 0139 locks those two columns against everyone else).
//
// WHAT THIS FILE PINS. Consent under TCPA is given for a NUMBER, not for an
// account. The action used to carry sms_consent straight across a phone
// change, so editing the number left OakTend holding a "yes" that the new
// number never gave - and the checkbox, still ticked from the previous save,
// re-posted "on" every time. Damages are per text, so the flag now drops with
// the number and has to be granted again, and the person is told that it did.
//
// A NEXT_REDIRECT is not a crash - it is Next's own throw-to-navigate
// mechanism - so the redirect mock reproduces that shape and the helper below
// catches only that marker. Anything else thrown fails the test.

class RedirectSignal extends Error {
  constructor(public path: string) {
    super(`REDIRECT:${path}`);
  }
}

type Row = Record<string, unknown>;

let sessionUser: { id: string } | null = { id: "user-1" };

// What the session client's select on public.users answers.
let currentRow: Row | null = null;

let lastProfileUpdate: Row | null = null;
let lastConsentUpdate: Row | null = null;
let profileError: { code?: string; message?: string } | null = null;
let consentError: { code?: string; message?: string } | null = null;
// What the admin client's rate_limit_hit RPC answers for the SMS opt-in
// confirmation send (src/lib/smsOptinLimit.ts). Defaults to "allowed".
let rateLimitResult: { data: boolean | null; error: { message: string } | null } = {
  data: true,
  error: null,
};
// Every row saveAccountAction's opt-in confirmation send (via
// sendNotification -> the in-app "notifications" insert) writes on the
// session client, so a test can assert the confirmation fired - or didn't -
// without mocking the whole of src/lib/notify.ts.
let notificationInserts: Row[] = [];

// src/lib/notify.ts (imported by ./actions.ts for the SMS opt-in
// confirmation send) imports "server-only" to fail the build if it ever
// reaches a Client Component; vitest has no such module, same mock every
// other test that pulls this file in uses.
vi.mock("server-only", () => ({}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: {
      getUser: async () => ({ data: { user: sessionUser } }),
      updateUser: async () => ({ error: null }),
    },
    from: (table: string) => {
      if (table === "notifications") {
        return {
          insert: async (row: Row) => {
            notificationInserts.push(row);
            return { error: null };
          },
        };
      }
      if (table !== "users") {
        throw new Error(`test does not expect a read/write on "${table}"`);
      }
      return {
        select: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: currentRow }) }),
        }),
        update: (values: Row) => {
          lastProfileUpdate = values;
          return { eq: async () => ({ error: profileError }) };
        },
      };
    },
  })),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(() => ({
    rpc: vi.fn(async (fn: string) => {
      if (fn === "rate_limit_hit") return rateLimitResult;
      throw new Error(`test does not expect rpc "${fn}"`);
    }),
    from: (table: string) => {
      if (table !== "users") {
        throw new Error(`admin write went to "${table}", not users`);
      }
      return {
        update: (values: Row) => {
          lastConsentUpdate = values;
          return { eq: async () => ({ error: consentError }) };
        },
      };
    },
  })),
}));

// src/lib/stripe.ts imports "server-only", which throws outside a server
// component. Nothing in saveAccountAction touches it.
vi.mock("@/lib/stripe", () => ({ stripe: {} }));
vi.mock("@supabase/supabase-js", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/flash", () => ({ setFlash: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((path: string) => {
    throw new RedirectSignal(path);
  }),
}));

import { saveAccountAction } from "./actions";
import { setFlash } from "@/lib/flash";

function fd(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

// saveAccountAction always ends in a redirect(), which throws. Swallow only
// that marker.
async function run(fields: Record<string, string>): Promise<string> {
  try {
    await saveAccountAction(fd(fields));
  } catch (e) {
    if (e instanceof RedirectSignal) return e.path;
    throw e;
  }
  throw new Error("saveAccountAction returned without redirecting");
}

const flashes = () => vi.mocked(setFlash).mock.calls.map((c) => String(c[0]));

beforeEach(() => {
  sessionUser = { id: "user-1" };
  currentRow = { sms_consent: false, phone: "555-0100" };
  lastProfileUpdate = null;
  lastConsentUpdate = null;
  profileError = null;
  consentError = null;
  rateLimitResult = { data: true, error: null };
  notificationInserts = [];
  vi.mocked(setFlash).mockClear();
});

describe("saveAccountAction: SMS consent follows the number", () => {
  it("keeps consent on an unchanged number", async () => {
    currentRow = { sms_consent: true, phone: "555-0100" };
    await run({ full_name: "Sam", phone: "555-0100", sms_consent: "on" });
    expect(lastConsentUpdate).toEqual({ sms_consent: true });
    // Already true, so the original grant date is not rewritten.
    expect(lastConsentUpdate).not.toHaveProperty("sms_consent_at");
    expect(flashes()).toEqual(["Account updated."]);
  });

  it("stamps the grant date on a fresh false -> true opt-in", async () => {
    currentRow = { sms_consent: false, phone: "555-0100" };
    await run({ full_name: "Sam", phone: "555-0100", sms_consent: "on" });
    expect(lastConsentUpdate).toMatchObject({ sms_consent: true });
    expect(typeof (lastConsentUpdate as Row).sms_consent_at).toBe("string");
  });

  it("sends the opt-in confirmation once on a fresh false -> true grant", async () => {
    currentRow = { sms_consent: false, phone: "555-0100" };
    await run({ full_name: "Sam", phone: "555-0100", sms_consent: "on" });
    expect(notificationInserts).toHaveLength(1);
    expect(notificationInserts[0]).toMatchObject({
      user_id: "user-1",
      kind: "sms_optin_confirmation",
    });
  });

  it("does not repeat the opt-in confirmation on a re-save that leaves consent already on", async () => {
    currentRow = { sms_consent: true, phone: "555-0100" };
    await run({ full_name: "Sam", phone: "555-0100", sms_consent: "on" });
    expect(notificationInserts).toEqual([]);
  });

  it("does not send the opt-in confirmation when the phoneChanged override forces consent back off", async () => {
    currentRow = { sms_consent: true, phone: "555-0100" };
    await run({ full_name: "Sam", phone: "555-0199", sms_consent: "on" });
    expect(notificationInserts).toEqual([]);
  });

  it("does not send the opt-in confirmation when the box is left unticked", async () => {
    currentRow = { sms_consent: false, phone: "555-0100" };
    await run({ full_name: "Sam", phone: "555-0100" });
    expect(notificationInserts).toEqual([]);
  });

  it("drops consent and its timestamp when the phone changes", async () => {
    currentRow = { sms_consent: true, phone: "555-0100" };
    const to = await run({
      full_name: "Sam",
      phone: "555-0199",
      // The checkbox is still ticked from the previous save: this is exactly
      // the submission that used to carry a stale yes onto a new number.
      sms_consent: "on",
    });
    expect(to).toBe("/account");
    expect(lastProfileUpdate).toEqual({ full_name: "Sam", phone: "555-0199" });
    expect(lastConsentUpdate).toEqual({
      sms_consent: false,
      sms_consent_at: null,
    });
    expect(flashes()[0]).toMatch(/text messages are off for your new number/i);
  });

  it("also drops it when the number is removed entirely", async () => {
    currentRow = { sms_consent: true, phone: "555-0100" };
    await run({ full_name: "Sam", phone: "", sms_consent: "on" });
    expect(lastProfileUpdate).toEqual({ full_name: "Sam", phone: null });
    expect(lastConsentUpdate).toEqual({
      sms_consent: false,
      sms_consent_at: null,
    });
  });

  it("does not nag about texts when there was no consent to lose", async () => {
    currentRow = { sms_consent: false, phone: "555-0100" };
    await run({ full_name: "Sam", phone: "555-0199" });
    expect(lastConsentUpdate).toEqual({
      sms_consent: false,
      sms_consent_at: null,
    });
    expect(flashes()).toEqual(["Account updated."]);
  });

  it("never invents a phone change when no stored row could be read", async () => {
    // A database still missing migration 0073 answers the select with nothing.
    // Assuming the number changed would switch consent off mid-migration.
    currentRow = null;
    await run({ full_name: "Sam", phone: "555-0199", sms_consent: "on" });
    expect(lastConsentUpdate).toMatchObject({ sms_consent: true });
    expect(flashes()).toEqual(["Account updated."]);
  });

  it("writes consent through the admin client, scoped to the session user", async () => {
    await run({ full_name: "Sam", phone: "555-0100" });
    // The session client never carries the two locked columns.
    expect(lastProfileUpdate).toEqual({ full_name: "Sam", phone: "555-0100" });
    expect(lastConsentUpdate).not.toBeNull();
  });
});

// FIX 2 (red team): phone is unverified, so a person could toggle the SMS
// checkbox off and on repeatedly to blast the opt-in confirmation text at
// whatever number they currently have entered. src/lib/smsOptinLimit.ts caps
// this at 2 sends per user per 24 hours via the same rate_limit_hit RPC
// countAskUsage already uses (src/lib/aiUsage.ts). The account save itself
// must never be blocked by this - only the text.
describe("saveAccountAction: SMS opt-in confirmation is rate limited", () => {
  it("does not send once the shared rate limit is already exhausted (e.g. a third toggle within the window)", async () => {
    currentRow = { sms_consent: false, phone: "555-0100" };
    rateLimitResult = { data: false, error: null };
    const to = await run({ full_name: "Sam", phone: "555-0100", sms_consent: "on" });
    expect(to).toBe("/account");
    // The consent flag itself still saves - only the text is withheld.
    expect(lastConsentUpdate).toMatchObject({ sms_consent: true });
    expect(notificationInserts).toEqual([]);
  });

  it("fails closed and does not send when the rate_limit_hit RPC errors", async () => {
    currentRow = { sms_consent: false, phone: "555-0100" };
    rateLimitResult = { data: null, error: { message: "db down" } };
    await run({ full_name: "Sam", phone: "555-0100", sms_consent: "on" });
    expect(notificationInserts).toEqual([]);
  });
});
