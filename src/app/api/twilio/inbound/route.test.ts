import { createHmac } from "crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

// The route reaches the admin Supabase client to look up and update the
// texter's users row - mocked with an in-memory fake, same shape as the
// other webhook route tests (push/subscribe, stripe/webhook).

type FakeUser = { id: string; phone: string | null; sms_consent?: boolean };

let users: FakeUser[] = [];
let usersLookupError: { message: string } | null = null;
let updates: Array<{ id: string; fields: Record<string, unknown> }> = [];

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from(table: string) {
      if (table !== "users") throw new Error(`unexpected table ${table}`);
      return {
        select: () => ({
          not: async () => ({
            data: usersLookupError ? null : users,
            error: usersLookupError,
          }),
        }),
        update: (fields: Record<string, unknown>) => ({
          in: async (_col: string, ids: string[]) => {
            for (const id of ids) {
              updates.push({ id, fields });
              const u = users.find((x) => x.id === id);
              if (u) Object.assign(u, fields);
            }
            return { error: null };
          },
        }),
      };
    },
  }),
}));

import { POST } from "./route";

const AUTH_TOKEN = "test-auth-token";
const WEBHOOK_URL = "https://oaktend.test/api/twilio/inbound";

beforeEach(() => {
  process.env.TWILIO_AUTH_TOKEN = AUTH_TOKEN;
  process.env.TWILIO_WEBHOOK_URL = WEBHOOK_URL;
  users = [{ id: "user-1", phone: "(555) 123-4567", sms_consent: true }];
  usersLookupError = null;
  updates = [];
});

afterEach(() => {
  delete process.env.TWILIO_AUTH_TOKEN;
  delete process.env.TWILIO_WEBHOOK_URL;
  vi.restoreAllMocks();
});

// Mirrors computeTwilioSignature in the route: base64(HMAC-SHA1(authToken,
// url + sorted key+value concatenation of every POST param)).
function sign(url: string, params: URLSearchParams, authToken: string): string {
  const sorted = Array.from(params.entries()).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0
  );
  let data = url;
  for (const [key, value] of sorted) data += key + value;
  return createHmac("sha1", authToken).update(data, "utf8").digest("base64");
}

function inbound(
  body: string,
  from = "+15551234567",
  { validSignature = true }: { validSignature?: boolean } = {}
): NextRequest {
  const params = new URLSearchParams({ Body: body, From: from });
  const rawBody = params.toString();
  const signature = validSignature
    ? sign(WEBHOOK_URL, params, AUTH_TOKEN)
    : "bad-signature";
  return new Request(WEBHOOK_URL, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-twilio-signature": signature,
    },
    body: rawBody,
  }) as unknown as NextRequest;
}

async function textOf(response: Response): Promise<string> {
  return response.text();
}

describe("POST /api/twilio/inbound", () => {
  it("rejects a request with no valid signature and touches nothing", async () => {
    const response = await POST(inbound("STOP", "+15551234567", { validSignature: false }));
    expect(response.status).toBe(403);
    expect(updates).toEqual([]);
  });

  it("rejects when TWILIO_AUTH_TOKEN is not configured", async () => {
    delete process.env.TWILIO_AUTH_TOKEN;
    const response = await POST(inbound("STOP"));
    expect(response.status).toBe(403);
  });

  // Carriers require the STOP-family confirmation to be the single, final
  // message - and only that message - sent back.
  it.each(["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT", "REVOKE", "OPT OUT", "opt   out"])(
    "replies with the STOP confirmation and flips consent off for %s",
    async (keyword) => {
      const response = await POST(inbound(keyword));
      expect(response.status).toBe(200);
      const xml = await textOf(response);
      expect(xml).toContain("You have opted out of OakTend text messages");
      expect(xml).toContain("Reply START to opt back in");
      // Exactly one <Message>, never bundled with HELP or anything else.
      expect((xml.match(/<Message>/g) ?? []).length).toBe(1);
      expect(updates).toEqual([{ id: "user-1", fields: { sms_consent: false } }]);
    }
  );

  it.each(["START", "YES", "UNSTOP"])(
    "replies with the opt-in confirmation and flips consent on for %s",
    async (keyword) => {
      users = [{ id: "user-1", phone: "(555) 123-4567", sms_consent: false }];
      const response = await POST(inbound(keyword));
      expect(response.status).toBe(200);
      const xml = await textOf(response);
      expect(xml).toContain("You have opted in to OakTend text messages");
      expect(xml).toContain("Msg&amp;data rates may apply");
      expect(xml).toContain("Reply STOP to opt out, HELP for help");
      expect(updates).toHaveLength(1);
      expect(updates[0].id).toBe("user-1");
      expect(updates[0].fields.sms_consent).toBe(true);
      expect(updates[0].fields.sms_consent_at).toBeTruthy();
    }
  );

  it("answers HELP with the support auto-reply and never touches consent", async () => {
    const response = await POST(inbound("HELP"));
    expect(response.status).toBe(200);
    const xml = await textOf(response);
    expect(xml).toContain("OakTend: home maintenance help");
    expect(xml).toContain("Msg&amp;data rates may apply");
    expect(updates).toEqual([]);
  });

  it("answers INFO the same as HELP", async () => {
    const response = await POST(inbound("INFO"));
    const xml = await textOf(response);
    expect(xml).toContain("OakTend: home maintenance help");
  });

  it("still sends the STOP confirmation when no matching user is found", async () => {
    users = [];
    const response = await POST(inbound("STOP"));
    expect(response.status).toBe(200);
    const xml = await textOf(response);
    expect(xml).toContain("You have opted out of OakTend text messages");
    expect(updates).toEqual([]);
  });

  it("still sends the STOP confirmation when the users lookup fails", async () => {
    usersLookupError = { message: "boom" };
    const response = await POST(inbound("STOP"));
    expect(response.status).toBe(200);
    const xml = await textOf(response);
    expect(xml).toContain("You have opted out of OakTend text messages");
  });

  it("replies with an empty TwiML ack for an unrecognized message", async () => {
    const response = await POST(inbound("Thanks for the reminder!"));
    expect(response.status).toBe(200);
    const xml = await textOf(response);
    expect(xml).toBe("<Response></Response>");
    expect(updates).toEqual([]);
  });

  it("does not advance sms_consent_at on a re-sent STOP (already off)", async () => {
    users = [{ id: "user-1", phone: "(555) 123-4567", sms_consent: false }];
    const response = await POST(inbound("STOP"));
    expect(response.status).toBe(200);
    expect(updates).toEqual([{ id: "user-1", fields: { sms_consent: false } }]);
  });
});
