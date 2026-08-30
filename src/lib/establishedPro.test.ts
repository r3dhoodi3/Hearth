import { describe, it, expect, beforeEach, vi } from "vitest";

// isEstablishedPro is the gate in front of the pro copilot: anyone can type a
// company name into the pro signup, so the paid model stays shut until the
// account has done something a pretend business does not do. The module chain
// underneath it is all server-only, so the pieces it talks to are stubbed and
// the decision itself is driven for real.
vi.mock("server-only", () => ({}));
// The license read moved to the admin client on 2026-08-30 (0069 hides the
// column from the RLS allowlist), so the admin mock hands back the same fake
// database the server mock builds: one set of knobs drives both.
vi.mock("@/lib/supabase/admin", async () => {
  const srv = await import("@/lib/supabase/server");
  const client = await srv.createClient();
  return { createAdminClient: () => client };
});
vi.mock("@/lib/auth", () => ({
  getUser: async () => null,
  getVerifiedUser: async () => null,
}));

let hasPro = false;
vi.mock("@/lib/subscription", () => ({ hasProPlan: async () => hasPro }));

// What each table answers. `null` count stands for a read that FAILED, which
// must never read as "has paid".
let licenseStatus: string | null = "unverified";
let licenseError: { message: string } | null = null;
let paidLeads: number | null = 0;
let leadError: { message: string } | null = null;
let walletId: string | null = "wal_1";
let walletError: { message: string } | null = null;
let deposits: number | null = 0;
let depositError: { message: string } | null = null;
// Every table the helper touched, so a test can assert what it did NOT read.
let touched: string[] = [];

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from(table: string) {
      touched.push(table);
      const api: Record<string, unknown> = {};
      const chain = () => api;
      Object.assign(api, {
        select: chain,
        eq: chain,
        is: chain,
        gt: chain,
        limit: chain,
        maybeSingle: () => {
          if (table === "contractors") {
            return Promise.resolve({
              data: licenseError
                ? null
                : { license_verified_status: licenseStatus },
              error: licenseError,
            });
          }
          if (table === "wallets") {
            return Promise.resolve({
              data: walletError || !walletId ? null : { id: walletId },
              error: walletError,
            });
          }
          return Promise.resolve({ data: null, error: null });
        },
        // The head+count queries are awaited directly.
        then: (resolve: (v: unknown) => unknown) => {
          const answer =
            table === "lead_applications"
              ? { count: paidLeads, error: leadError }
              : { count: deposits, error: depositError };
          return Promise.resolve(answer).then(resolve);
        },
      });
      return api;
    },
  }),
}));

const { isEstablishedPro } = await import("./contractor");

beforeEach(() => {
  hasPro = false;
  licenseStatus = "unverified";
  licenseError = null;
  paidLeads = 0;
  leadError = null;
  walletId = "wal_1";
  walletError = null;
  deposits = 0;
  depositError = null;
  touched = [];
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("isEstablishedPro", () => {
  it("unlocks a paying Hearth Pro member without reading anything else", async () => {
    hasPro = true;
    expect(await isEstablishedPro("con_paid")).toBe(true);
    expect(touched).toEqual([]);
  });

  it("unlocks a CSLB-confirmed license", async () => {
    licenseStatus = "verified";
    expect(await isEstablishedPro("con_lic")).toBe(true);
  });

  it("does not unlock a license that is merely claimed", async () => {
    for (const status of ["unverified", "pending", "failed", null]) {
      licenseStatus = status;
      expect(await isEstablishedPro(`con_${status}`)).toBe(false);
    }
  });

  it("unlocks a pro who has paid for a lead", async () => {
    paidLeads = 1;
    expect(await isEstablishedPro("con_lead")).toBe(true);
  });

  it("unlocks a pro whose deposit settled", async () => {
    deposits = 1;
    expect(await isEstablishedPro("con_dep")).toBe(true);
  });

  it("stays locked for a fresh signup with nothing behind it", async () => {
    expect(await isEstablishedPro("con_new")).toBe(false);
  });

  it("fails CLOSED on an unreadable count", async () => {
    // null is "we could not read it", and an outage must not become free model
    // calls. Each read is tested on its own so one failing open cannot hide
    // behind another.
    paidLeads = null;
    leadError = { message: "boom" };
    expect(await isEstablishedPro("con_err1")).toBe(false);

    paidLeads = 0;
    leadError = null;
    walletError = { message: "boom" };
    expect(await isEstablishedPro("con_err2")).toBe(false);

    walletError = null;
    deposits = null;
    depositError = { message: "boom" };
    expect(await isEstablishedPro("con_err3")).toBe(false);

    depositError = null;
    deposits = 0;
    licenseError = { message: "boom" };
    expect(await isEstablishedPro("con_err4")).toBe(false);
  });

  it("does not count a wallet with no deposit row", async () => {
    walletId = null;
    expect(await isEstablishedPro("con_nowallet")).toBe(false);
  });
});
