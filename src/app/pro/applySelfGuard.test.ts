import { beforeEach, describe, expect, it, vi } from "vitest";

// SEC-1 self-apply guard, action level: a dual-side account (a contractors
// row and a properties row on the same auth user) must not be able to apply
// to, or pay to apply to, its own posted job. This is the friendly early
// refusal in src/app/pro/actions.ts (applyToJobAction); the real enforcement
// is the SQL guard added to public.apply_to_lead() by migration
// 0161_lead_owner_exclusion.sql. Harness mirrors
// src/app/pro/applyInsuranceGate.test.ts.

class RedirectSignal extends Error {
  constructor(public path: string) {
    super(`REDIRECT:${path}`);
  }
}

const sessionUser = { id: "user-1", email: "pro@example.com", user_metadata: {} };

// The contractor assertContractor() resolves. user_id is what the self-apply
// guard compares against the property owner.
let contractor: Record<string, unknown>;
// The contractor_leads row the admin pre-check reads.
let leadRow: Record<string, unknown> | null;
let leadReadError: { code: string; message: string } | null;
// The properties row the self-apply pre-check reads, keyed off
// leadRow.property_id.
let propertyRow: Record<string, unknown> | null;
let propertyReadError: { code: string; message: string } | null;
// Every rpc() call the actions make, so the tests can assert the charge RPC
// was (or was never) reached.
let rpcCalls: Array<{ name: string; args: unknown }>;
// What rpc() should answer for the charge functions.
let rpcResult: { data: unknown; error: { message: string } | null };

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: async () => ({ data: { user: sessionUser } }) },
    rpc: vi.fn(async (name: string, args: unknown) => {
      rpcCalls.push({ name, args });
      if (name === "my_applications") return { data: [], error: null };
      return rpcResult;
    }),
  })),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(() => ({
    from: (table: string) => ({
      select: () => {
        const chain: any = {
          eq: () => chain,
          maybeSingle: async () => {
            if (table === "contractor_leads") {
              return { data: leadRow, error: leadReadError };
            }
            if (table === "properties") {
              return { data: propertyRow, error: propertyReadError };
            }
            // lead_applications: the replay guard (no existing application)
            // and the receipt read (no fee row is fine, the receipt omits
            // the amount).
            return { data: null, error: null };
          },
        };
        return chain;
      },
      insert: async () => ({ error: null }),
    }),
  })),
}));

vi.mock("@/lib/contractor", () => ({
  getCurrentContractor: vi.fn(async () => contractor),
  countPaidLeadApplications: vi.fn(),
}));

vi.mock("@/lib/flash", () => ({ setFlash: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => null })),
}));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((path: string) => {
    throw new RedirectSignal(path);
  }),
}));
vi.mock("@/lib/notify", () => ({ sendNotification: vi.fn() }));
vi.mock("@/lib/leadPricing", () => ({
  bestLeadDiscount: vi.fn(() => ({ fee: 99, off: 0, kind: null })),
}));
vi.mock("@/lib/subscription", () => ({
  hasProPlan: vi.fn(async () => false),
  hasActivePaidProPlan: vi.fn(async () => false),
}));
vi.mock("@/lib/reviewRequest", () => ({ requestReviewForWonLead: vi.fn() }));
vi.mock("@/lib/cslb", () => ({ lookupCslbLicense: vi.fn() }));
vi.mock("@/lib/licenseMatch", () => ({
  licenseDigits: vi.fn(),
  licenseNameMatches: vi.fn(),
}));
vi.mock("@/lib/checkr", () => ({ createCandidateAndInvite: vi.fn() }));
vi.mock("@/lib/activeJobConflicts", () => ({
  findActiveJobConflicts: vi.fn(async () => new Map()),
}));
vi.mock("@/lib/risk/signals", () => ({ recordSignal: vi.fn(async () => {}) }));
vi.mock("@/app/(auth)/recordTermsAcceptance", () => ({
  recordTermsAcceptance: vi.fn(),
}));
vi.mock("@/lib/trackServer", () => ({ trackServerEvent: vi.fn() }));

import { applyToJobAction } from "./actions";
import { setFlash } from "@/lib/flash";

function applyForm(): FormData {
  const f = new FormData();
  f.set("id", "0b0b0b0b-0b0b-0b0b-0b0b-0b0b0b0b0b0b");
  return f;
}

function chargeRpcCalls(): string[] {
  return rpcCalls.map((c) => c.name).filter((n) => n === "apply_to_lead");
}

beforeEach(() => {
  contractor = {
    id: "contractor-1",
    user_id: "user-1",
    name: "Ivy Roofing",
    serves_orange_county: true,
    insurance_expires: "2099-01-01",
  };
  leadRow = {
    owner_closed_at: null,
    payout_amount: 99,
    created_at: new Date().toISOString(),
    category: "cleaning",
    property_id: "property-1",
  };
  leadReadError = null;
  propertyRow = { user_id: "some-other-homeowner" };
  propertyReadError = null;
  rpcCalls = [];
  rpcResult = { data: true, error: null };
  vi.mocked(setFlash).mockClear();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("applyToJobAction: SEC-1 self-apply guard", () => {
  it("dual-side account applying to its own posted job: refused, charge RPC never called", async () => {
    // Same auth user on both sides: the property owner IS this pro.
    propertyRow = { user_id: "user-1" };
    await applyToJobAction(applyForm());
    expect(setFlash).toHaveBeenCalledWith(
      "You cannot apply to your own job.",
      "error"
    );
    expect(chargeRpcCalls()).toEqual([]);
  });

  it("a job posted by a different homeowner: the apply goes through normally", async () => {
    propertyRow = { user_id: "some-other-homeowner" };
    await applyToJobAction(applyForm());
    expect(setFlash).not.toHaveBeenCalledWith(
      "You cannot apply to your own job.",
      "error"
    );
    expect(chargeRpcCalls()).toEqual(["apply_to_lead"]);
  });

  it("property_id missing from the pre-check read: pre-check is skipped (advisory only), apply proceeds to the RPC backstop", async () => {
    leadRow = { ...leadRow, property_id: null };
    await applyToJobAction(applyForm());
    expect(setFlash).not.toHaveBeenCalledWith(
      "You cannot apply to your own job.",
      "error"
    );
    expect(chargeRpcCalls()).toEqual(["apply_to_lead"]);
  });

  it("property owner read failed: falls through (advisory only), never blocks a legit apply on its own", async () => {
    propertyRow = null;
    propertyReadError = { code: "57014", message: "canceling statement" };
    await applyToJobAction(applyForm());
    expect(setFlash).not.toHaveBeenCalledWith(
      "You cannot apply to your own job.",
      "error"
    );
    expect(chargeRpcCalls()).toEqual(["apply_to_lead"]);
  });

  it("pre-check missed it but the SQL backstop (0161) fired: the raw raise is translated into the friendly message", async () => {
    // e.g. the pre-check's properties read raced a property transfer, or was
    // simply not reached. The database's own guard inside apply_to_lead is
    // the real enforcement and must still produce the same friendly copy.
    propertyRow = { user_id: "some-other-homeowner" };
    rpcResult = {
      data: null,
      error: { message: "You cannot apply to your own job." },
    };
    await applyToJobAction(applyForm());
    expect(chargeRpcCalls()).toEqual(["apply_to_lead"]);
    expect(setFlash).toHaveBeenCalledWith(
      "You cannot apply to your own job.",
      "error"
    );
  });
});
