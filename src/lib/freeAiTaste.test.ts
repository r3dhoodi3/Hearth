import { beforeEach, describe, expect, it, vi } from "vitest";

// The free-taste gate on the two AI reads that used to be unmetered
// (/api/extract-document, /api/ingest-inspection).
//
// The server half imports the service-role Supabase client, which is
// "server-only" and throws the moment it is imported outside a server
// component, so it is mocked out here the way src/lib/aiUsage.test.ts mocks it
// for the refund paths. That means the real claim/refund/read logic runs
// against a fake `users` table and a fake RPC that behaves the way migration
// 0135's functions do, instead of being asserted at the level of source text.

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => currentAdmin,
}));

// Whatever fakeAdmin() built for the test that is running.
let currentAdmin: any = null;

const {
  FREE_DOC_READS,
  FREE_INSPECTION_READS,
  FREE_TASTE_PAYWALL,
  QUOTE_TASTE_PAYWALL,
  tasteMeterLabel,
} = await import("@/lib/freeAiTaste");

const { claimFreeTaste, refundFreeTaste, freeTastesLeft } = await import(
  "@/lib/freeAiTasteServer"
);

// A stand-in for the two migration-0135 functions plus the row they move,
// with the same semantics: the claim only succeeds while the counter is under
// the limit, and the refund never goes below zero.
function fakeAdmin(
  used: Record<string, number>,
  opts: {
    // The error the RPC answers with, if any. The SHAPE matters now: a
    // missing-schema shape fails open (0135 not pasted yet), anything else
    // fails closed.
    rpcError?: { code?: string; message?: string };
    selectThrows?: boolean;
  } = {}
) {
  const calls: Array<{ fn: string; args: any }> = [];
  return {
    used,
    calls,
    rpc(fn: string, args: any) {
      calls.push({ fn, args });
      if (opts.rpcError) {
        return Promise.resolve({ data: null, error: opts.rpcError });
      }
      const column =
        args.p_feature === "document"
          ? "free_doc_reads_used"
          : args.p_feature === "inspection"
            ? "free_inspection_reads_used"
            : null;
      if (!column) return Promise.resolve({ data: false, error: null });
      if (fn === "claim_free_ai_taste") {
        if ((used[column] ?? 0) < args.p_limit) {
          used[column] = (used[column] ?? 0) + 1;
          return Promise.resolve({ data: true, error: null });
        }
        return Promise.resolve({ data: false, error: null });
      }
      if (fn === "refund_free_ai_taste") {
        used[column] = Math.max(0, (used[column] ?? 0) - 1);
        return Promise.resolve({ data: null, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    },
    from() {
      return {
        select(column: string) {
          return {
            eq() {
              return {
                maybeSingle: async () =>
                  opts.selectThrows
                    ? { data: null, error: { message: "no such column" } }
                    : { data: { [column]: used[column] ?? 0 }, error: null },
              };
            },
          };
        },
      };
    },
  };
}

beforeEach(() => {
  currentAdmin = fakeAdmin({});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("the taste itself", () => {
  it("is 2 document reads and 1 inspection import", () => {
    expect(FREE_DOC_READS).toBe(2);
    expect(FREE_INSPECTION_READS).toBe(1);
  });
});

describe("claimFreeTaste, free account", () => {
  it("passes with nothing used", async () => {
    const admin = fakeAdmin({});
    currentAdmin = admin;
    const res = await claimFreeTaste("u1", false, "document");
    expect(res.allowed).toBe(true);
    expect(res.claimed).toBe(true);
    expect(admin.used.free_doc_reads_used).toBe(1);
  });

  it("passes on the second document read and refuses the third", async () => {
    const admin = fakeAdmin({});
    currentAdmin = admin;
    await expect(claimFreeTaste("u1", false, "document")).resolves.toEqual({
      allowed: true,
      claimed: true,
    });
    await expect(claimFreeTaste("u1", false, "document")).resolves.toEqual({
      allowed: true,
      claimed: true,
    });
    // Two used: the paywall.
    await expect(claimFreeTaste("u1", false, "document")).resolves.toEqual({
      allowed: false,
      claimed: false,
    });
    expect(admin.used.free_doc_reads_used).toBe(2);
  });

  it("refuses a document read when the counter already sits at the limit", async () => {
    currentAdmin = fakeAdmin({ free_doc_reads_used: FREE_DOC_READS });
    await expect(claimFreeTaste("u1", false, "document")).resolves.toEqual({
      allowed: false,
      claimed: false,
    });
  });

  it("gives exactly one inspection import, then refuses", async () => {
    const admin = fakeAdmin({});
    currentAdmin = admin;
    await expect(claimFreeTaste("u1", false, "inspection")).resolves.toEqual({
      allowed: true,
      claimed: true,
    });
    await expect(claimFreeTaste("u1", false, "inspection")).resolves.toEqual({
      allowed: false,
      claimed: false,
    });
    expect(admin.used.free_inspection_reads_used).toBe(1);
  });

  it("keeps the two counters separate", async () => {
    const admin = fakeAdmin({ free_doc_reads_used: FREE_DOC_READS });
    currentAdmin = admin;
    // Out of document reads, but the inspection import is untouched.
    await expect(claimFreeTaste("u1", false, "document")).resolves.toEqual({
      allowed: false,
      claimed: false,
    });
    await expect(claimFreeTaste("u1", false, "inspection")).resolves.toEqual({
      allowed: true,
      claimed: true,
    });
  });
});

describe("claimFreeTaste, Plus", () => {
  it("never refuses, and never touches a counter", async () => {
    const admin = fakeAdmin({ free_doc_reads_used: 99 });
    currentAdmin = admin;
    for (let i = 0; i < 5; i++) {
      await expect(claimFreeTaste("u1", true, "document")).resolves.toEqual({
        allowed: true,
        claimed: false,
      });
    }
    await expect(claimFreeTaste("u1", true, "inspection")).resolves.toEqual({
      allowed: true,
      claimed: false,
    });
    // Not one RPC call: a paying member is not metered here at all.
    expect(admin.calls).toHaveLength(0);
    expect(admin.used.free_doc_reads_used).toBe(99);
  });
});

describe("a failed model call does not spend a taste", () => {
  it("hands a document read back", async () => {
    const admin = fakeAdmin({});
    currentAdmin = admin;
    const { claimed } = await claimFreeTaste("u1", false, "document");
    expect(admin.used.free_doc_reads_used).toBe(1);
    // What the route does when generateJson throws or returns nothing usable.
    await refundFreeTaste("u1", "document", claimed);
    expect(admin.used.free_doc_reads_used).toBe(0);
    // And the read is available again, which is the whole promise.
    await expect(claimFreeTaste("u1", false, "document")).resolves.toEqual({
      allowed: true,
      claimed: true,
    });
  });

  it("hands the inspection import back", async () => {
    const admin = fakeAdmin({});
    currentAdmin = admin;
    const { claimed } = await claimFreeTaste("u1", false, "inspection");
    await refundFreeTaste("u1", "inspection", claimed);
    expect(admin.used.free_inspection_reads_used).toBe(0);
  });

  it("is a no-op when nothing was claimed (a Plus member's failed call)", async () => {
    const admin = fakeAdmin({ free_doc_reads_used: 1 });
    currentAdmin = admin;
    await refundFreeTaste("u1", "document", false);
    expect(admin.calls).toHaveLength(0);
    expect(admin.used.free_doc_reads_used).toBe(1);
  });

  it("never drives a counter below zero", async () => {
    const admin = fakeAdmin({});
    currentAdmin = admin;
    await refundFreeTaste("u1", "document", true);
    expect(admin.used.free_doc_reads_used).toBe(0);
  });
});

describe("a missing migration fails OPEN, every other failure fails CLOSED", () => {
  // NOTE ON ORDERING: the "0135 is missing" warning is logged ONCE PER
  // PROCESS, and this is the first test in the file that triggers it. A new
  // fail-open test added ABOVE this one would consume that single warning and
  // make the count assertion below fail.
  it("lets the read through when 0135 is not applied, and says so once", async () => {
    currentAdmin = fakeAdmin(
      {},
      {
        // What PostgREST answers when the function does not exist.
        rpcError: {
          code: "PGRST202",
          message:
            "Could not find the function public.claim_free_ai_taste(p_feature, p_limit, p_user) in the schema cache",
        },
      }
    );
    await expect(claimFreeTaste("u1", false, "document")).resolves.toEqual({
      allowed: true,
      // Nothing moved, so there is nothing to refund later.
      claimed: false,
    });
    // A second request in the same process is still allowed...
    await expect(claimFreeTaste("u1", false, "document")).resolves.toEqual({
      allowed: true,
      claimed: false,
    });
    // ...but only says it once. The line is an operator instruction ("paste
    // the SQL"), and one per request buries it.
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(console.warn).mock.calls[0][0])).toContain("0135");
  });

  it("also fails open on the pre-PostgREST shape of the same problem", async () => {
    currentAdmin = fakeAdmin(
      {},
      { rpcError: { code: "42883", message: "function does not exist" } }
    );
    await expect(claimFreeTaste("u1", false, "document")).resolves.toEqual({
      allowed: true,
      claimed: false,
    });
  });

  it("REFUSES on a timeout rather than handing out a free run at the model", async () => {
    // The failure mode that used to be invisible: any transient error silently
    // disabled the paywall and logged one console.error nobody reads. A blip
    // must not be worth more than a Plus membership.
    currentAdmin = fakeAdmin(
      {},
      {
        rpcError: {
          code: "57014",
          message: "canceling statement due to statement timeout",
        },
      }
    );
    await expect(claimFreeTaste("u1", false, "document")).resolves.toEqual({
      allowed: false,
      claimed: false,
    });
  });

  it("REFUSES when the RPC is there but the caller is not allowed to run it", async () => {
    currentAdmin = fakeAdmin(
      {},
      {
        rpcError: {
          code: "42501",
          message: "permission denied for function claim_free_ai_taste",
        },
      }
    );
    await expect(claimFreeTaste("u1", false, "inspection")).resolves.toEqual({
      allowed: false,
      claimed: false,
    });
  });

  it("still never meters a Plus member, whatever the database is doing", async () => {
    currentAdmin = fakeAdmin(
      {},
      { rpcError: { code: "57014", message: "canceling statement" } }
    );
    await expect(claimFreeTaste("u1", true, "document")).resolves.toEqual({
      allowed: true,
      claimed: false,
    });
  });

  it("shows no meter rather than a guess when the column cannot be read", async () => {
    currentAdmin = fakeAdmin({}, { selectThrows: true });
    await expect(freeTastesLeft("u1", false, "document")).resolves.toBeNull();
  });
});

describe("freeTastesLeft", () => {
  it("is the full allowance for a brand-new free account", async () => {
    currentAdmin = fakeAdmin({});
    await expect(freeTastesLeft("u1", false, "document")).resolves.toBe(2);
    await expect(freeTastesLeft("u1", false, "inspection")).resolves.toBe(1);
  });

  it("counts down and floors at zero", async () => {
    currentAdmin = fakeAdmin({ free_doc_reads_used: 1 });
    await expect(freeTastesLeft("u1", false, "document")).resolves.toBe(1);
    currentAdmin = fakeAdmin({ free_doc_reads_used: 5 });
    await expect(freeTastesLeft("u1", false, "document")).resolves.toBe(0);
  });

  it("is null for a Plus member, so no meter is ever shown to them", async () => {
    const admin = fakeAdmin({ free_doc_reads_used: 2 });
    currentAdmin = admin;
    await expect(freeTastesLeft("u1", true, "document")).resolves.toBeNull();
  });
});

describe("the copy", () => {
  it("names the exact number left, before the tap", () => {
    expect(tasteMeterLabel("document", 2)).toBe("2 of 2 free reads left");
    expect(tasteMeterLabel("document", 1)).toBe("1 of 2 free reads left");
    expect(tasteMeterLabel("inspection", 1)).toBe("1 free inspection read");
  });

  it("points every refusal at a reason the /plus page actually handles", () => {
    expect(FREE_TASTE_PAYWALL.document.link).toBe("/plus?reason=documents");
    expect(FREE_TASTE_PAYWALL.inspection.link).toBe("/plus?reason=inspection");
    expect(QUOTE_TASTE_PAYWALL.link).toBe("/plus?reason=quote");
  });

  it("states the fact and the benefit, with no urgency or guilt language", () => {
    const lines = [
      FREE_TASTE_PAYWALL.document.message,
      FREE_TASTE_PAYWALL.inspection.message,
      QUOTE_TASTE_PAYWALL.message,
    ];
    for (const line of lines) {
      expect(line).toMatch(/Plus/);
      // No em dashes anywhere in this repo, copy included. Written as an
      // escape so the character itself never appears in the source.
      expect(line).not.toContain(String.fromCharCode(0x2014));
      expect(line.toLowerCase()).not.toMatch(
        /now only|hurry|don't miss|last chance|act fast|limited time/
      );
    }
  });

  it("replaces the quote analyzer's old cold wall with the benefit line", () => {
    expect(QUOTE_TASTE_PAYWALL.message).toBe(
      "You've used your free quote check. Plus reads every quote, flags padding, and writes the negotiation message."
    );
  });
});
