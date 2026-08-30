import { describe, it, expect, vi, beforeEach } from "vitest";

// The pro side's free AI back-office drafts (migration 0145): two per
// contractor account, then the Hearth Pro wall. Admin client mocked, so the
// claim/refund contract is proved without a database.

const rpc = vi.fn();
const maybeSingle = vi.fn();

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: (...a: unknown[]) => rpc(...a),
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: () => maybeSingle() }),
      }),
    }),
  }),
}));

import {
  claimProDraft,
  refundProDraft,
  proDraftsLeft,
} from "@/lib/freeAiTasteServer";
import {
  FREE_PRO_DRAFTS,
  PRO_TOOLS_PAYWALL,
  proDraftMeterLabel,
} from "@/lib/freeAiTaste";

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("the offer", () => {
  it("is two free drafts, and the wall says exactly that", () => {
    expect(FREE_PRO_DRAFTS).toBe(2);
    expect(PRO_TOOLS_PAYWALL.message).toContain("2 free drafts");
    expect(PRO_TOOLS_PAYWALL.link).toBe("/pro/plus?reason=tools");
  });

  it("meters in front of the tap, in whole numbers", () => {
    expect(proDraftMeterLabel(2)).toBe("2 of 2 free drafts left");
    expect(proDraftMeterLabel(1)).toBe("1 of 2 free drafts left");
    expect(proDraftMeterLabel(0)).toBe("No free drafts left");
  });
});

describe("claimProDraft", () => {
  it("never touches the counter for a member", async () => {
    const res = await claimProDraft("c1", true);
    expect(res).toEqual({ allowed: true, claimed: false });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("spends one for a non-member and reports it as claimed", async () => {
    rpc.mockResolvedValue({ data: true, error: null });
    const res = await claimProDraft("c1", false);
    expect(res).toEqual({ allowed: true, claimed: true });
    expect(rpc).toHaveBeenCalledWith("claim_pro_free_taste", {
      p_contractor: "c1",
      p_limit: FREE_PRO_DRAFTS,
    });
  });

  it("refuses once the allowance is gone", async () => {
    rpc.mockResolvedValue({ data: false, error: null });
    expect(await claimProDraft("c1", false)).toEqual({
      allowed: false,
      claimed: false,
    });
  });

  it("fails CLOSED when migration 0145 is not live (members are already let through; free pros wait for the paste)", async () => {
    // A previously members-only feature must not start refusing everybody
    // because SQL has not been pasted yet, and nobody may be told they spent
    // a draft the database cannot prove they spent.
    rpc.mockResolvedValue({
      data: null,
      error: {
        code: "PGRST202",
        message: "Could not find the function public.claim_pro_free_taste",
      },
    });
    expect(await claimProDraft("c1", false)).toEqual({
      allowed: false,
      claimed: false,
    });
  });

  it("FAILS CLOSED on any other database error", async () => {
    // A blip that silently disabled the gate would cost real money on the paid
    // model and announce nothing.
    rpc.mockResolvedValue({
      data: null,
      error: { code: "57014", message: "canceling statement due to timeout" },
    });
    expect(await claimProDraft("c1", false)).toEqual({
      allowed: false,
      claimed: false,
    });
  });
});

describe("refundProDraft", () => {
  it("does nothing when nothing was claimed", async () => {
    await refundProDraft("c1", false);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("hands the draft back after a failed model call", async () => {
    rpc.mockResolvedValue({ data: null, error: null });
    await refundProDraft("c1", true);
    expect(rpc).toHaveBeenCalledWith("refund_pro_free_taste", {
      p_contractor: "c1",
    });
  });

  it("never throws when the refund itself fails", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "nope" } });
    await expect(refundProDraft("c1", true)).resolves.toBeUndefined();
  });
});

describe("proDraftsLeft", () => {
  it("shows no meter to a member", async () => {
    expect(await proDraftsLeft("c1", true)).toBeNull();
  });

  it("counts down from the limit", async () => {
    maybeSingle.mockResolvedValue({
      data: { free_tool_drafts_used: 1 },
      error: null,
    });
    expect(await proDraftsLeft("c1", false)).toBe(FREE_PRO_DRAFTS - 1);
  });

  it("never goes negative", async () => {
    maybeSingle.mockResolvedValue({
      data: { free_tool_drafts_used: 99 },
      error: null,
    });
    expect(await proDraftsLeft("c1", false)).toBe(0);
  });

  it("shows nothing rather than a guess when the counter cannot be read", async () => {
    maybeSingle.mockResolvedValue({ data: null, error: { message: "nope" } });
    expect(await proDraftsLeft("c1", false)).toBeNull();
  });
});
