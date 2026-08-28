import { beforeEach, describe, expect, it, vi } from "vitest";

// saveAccountAction (./actions.ts) writes the homeowner's name and phone on
// their own session client, and the SMS-consent pair through the service role
// (migration 0139 locks those two columns against everyone else).
//
// WHAT THIS FILE PINS. Consent under TCPA is given for a NUMBER, not for an
// account. The action used to carry sms_consent straight across a phone
// change, so editing the number left Hearth holding a "yes" that the new
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

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: {
      getUser: async () => ({ data: { user: sessionUser } }),
      updateUser: async () => ({ error: null }),
    },
    from: (table: string) => {
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
