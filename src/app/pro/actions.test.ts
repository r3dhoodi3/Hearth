import { beforeEach, describe, expect, it, vi } from "vitest";

// saveCompanyAction's two contractors writes (insert on first-time setup,
// update on a profile save) used to end in a bare `if (error) throw new
// Error(error.message)`. That crashed straight past every other setFlash()/
// redirect() convention in this file into Next's generic error boundary -
// "Something went sideways" - with none of the fields the pro just typed
// still on screen. It actually happened live: migration 0129 widened the
// launch_cities check constraint in code before the matching database
// migration had been pasted in, so an ordinary city pick on the live database
// tripped the narrower constraint still in force there (23514,
// contractors_launch_cities_subset). These tests pin the fix - the write
// never throws, the pro is told something specific and actionable, and
// nothing downstream of the failed write (license status, CSLB check, terms
// acceptance, side stamp) ever runs.
//
// A NEXT_REDIRECT is not a crash - it is Next's own throw-to-navigate
// mechanism (see the NEXT_REDIRECT-digest comments elsewhere in this
// codebase, e.g. RequestQuoteForm.tsx) - so the mock below reproduces that
// exact shape rather than a plain no-op, and the tests catch only that
// specific marker. Anything else thrown - in particular the old raw
// `new Error(error.message)` - surfaces as a real test failure instead of
// being swallowed by an overly forgiving catch.

class RedirectSignal extends Error {
  constructor(public path: string) {
    super(`REDIRECT:${path}`);
  }
}

const sessionUser: { id: string; email: string; user_metadata: Record<string, unknown> } = {
  id: "user-1",
  email: "pro@example.com",
  user_metadata: {},
};

let existingContractor: Record<string, unknown> | null = null;
let lastInsert: Record<string, unknown> | null = null;
let lastUpdate: Record<string, unknown> | null = null;
let insertError: { code: string; message: string } | null = null;
let updateError: { code: string; message: string } | null = null;

const LAUNCH_CITIES_SUBSET_ERROR = {
  code: "23514",
  message:
    'new row for relation "contractors" violates check constraint "contractors_launch_cities_subset"',
};

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: async () => ({ data: { user: sessionUser } }) },
    rpc: vi.fn(async () => ({ data: null, error: null })),
    from: (table: string) => {
      if (table !== "contractors") {
        throw new Error(`test does not expect a write to "${table}"`);
      }
      return {
        insert: async (values: Record<string, unknown>) => {
          lastInsert = values;
          return { error: insertError };
        },
        update: (values: Record<string, unknown>) => {
          lastUpdate = values;
          return { eq: async () => ({ error: updateError }) };
        },
      };
    },
  })),
}));

// Nothing after a failed write should reach the admin client (the license
// pending-status write, the CSLB verify's own writes, or the preferred-side
// stamp) - so a call here is itself proof the "nothing else is written"
// requirement broke, and the test fails on this throw rather than silently
// passing.
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(() => {
    throw new Error(
      "createAdminClient must not be called after a failed contractors write"
    );
  }),
}));

vi.mock("@/lib/contractor", () => ({
  getCurrentContractor: vi.fn(async () => existingContractor),
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
vi.mock("@/lib/leadPricing", () => ({ agingLeadFee: vi.fn() }));
vi.mock("@/lib/subscription", () => ({ hasProPlan: vi.fn() }));
vi.mock("@/lib/reviewRequest", () => ({ requestReviewForWonLead: vi.fn() }));
vi.mock("@/lib/cslb", () => ({ lookupCslbLicense: vi.fn() }));
vi.mock("@/lib/licenseMatch", () => ({
  licenseDigits: vi.fn(),
  licenseNameMatches: vi.fn(),
}));
vi.mock("@/lib/checkr", () => ({ createCandidateAndInvite: vi.fn() }));
vi.mock("@/lib/activeJobConflicts", () => ({ findActiveJobConflicts: vi.fn() }));
vi.mock("@/lib/risk/signals", () => ({ recordSignal: vi.fn(async () => {}) }));
vi.mock("@/app/(auth)/recordTermsAcceptance", () => ({
  recordTermsAcceptance: vi.fn(),
}));

import { saveCompanyAction } from "./actions";
import { setFlash } from "@/lib/flash";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";

function fd(fields: Record<string, string | string[]>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (Array.isArray(v)) {
      for (const item of v) f.append(k, item);
    } else {
      f.set(k, v);
    }
  }
  return f;
}

beforeEach(() => {
  existingContractor = null;
  lastInsert = null;
  lastUpdate = null;
  insertError = null;
  updateError = null;
  vi.mocked(setFlash).mockClear();
  vi.mocked(revalidatePath).mockClear();
  vi.mocked(redirect).mockClear();
  vi.mocked(createAdminClient).mockClear();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("saveCompanyAction: contractors write failure", () => {
  it("first-time setup: a launch_cities check-constraint violation never throws, and nothing downstream runs", async () => {
    insertError = LAUNCH_CITIES_SUBSET_ERROR;

    let caught: unknown = null;
    try {
      await saveCompanyAction(
        fd({
          name: "Ivy Plumbing",
          contact_phone: "7145550100",
          service_state: "CA",
          service_cities_present: "1",
          service_cities: ["Irvine"],
        })
      );
    } catch (e) {
      caught = e;
    }

    // The only thing allowed to have been thrown is the redirect signal -
    // Next's own navigation mechanism, not a crash. Anything else (in
    // particular the old `new Error(error.message)`) fails this assertion.
    expect(caught).toBeInstanceOf(RedirectSignal);
    expect((caught as RedirectSignal).path).toBe("/pro/onboarding");

    expect(setFlash).toHaveBeenCalledWith(
      "We couldn't save your service area just now. Pick specific cities and try again, or come back a little later.",
      "error"
    );
    // setFlash before redirect, matching every other floor in this action.
    expect(vi.mocked(setFlash).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(redirect).mock.invocationCallOrder[0]
    );

    // Nothing downstream of the failed insert ran: no admin-client write
    // (license pending status, side stamp), and the insert was attempted
    // exactly once - no silent retry papering over the constraint failure.
    expect(createAdminClient).not.toHaveBeenCalled();
    expect(lastInsert).not.toBeNull();
  });

  it("profile save: a launch_cities check-constraint violation never throws, flashes in place, and writes nothing else", async () => {
    existingContractor = {
      id: "contractor-1",
      name: "Acme Plumbing",
      license_number: null,
      license_verified_status: "unverified",
      service_state: null,
    };
    updateError = LAUNCH_CITIES_SUBSET_ERROR;

    // Same name as stored: keeps isAcceptablePublicText out of the way so
    // this test is only exercising the write-failure path.
    await expect(
      saveCompanyAction(
        fd({
          name: "Acme Plumbing",
          contact_phone: "7145550100",
        })
      )
    ).resolves.toBeUndefined();

    expect(setFlash).toHaveBeenCalledWith(
      "We couldn't save your service area just now. Pick specific cities and try again, or come back a little later.",
      "error"
    );
    // No redirect for the profile form - see the comment on this branch in
    // actions.ts: redirecting back to the exact path already on screen is
    // the same-path App Router footgun that used to strand /pro/profile on
    // its loading.tsx boundary. setFlash() + revalidatePath() on the SAME
    // path is the pattern FlashToast expects instead.
    expect(redirect).not.toHaveBeenCalled();
    expect(revalidatePath).toHaveBeenCalledWith("/pro/profile");
    expect(createAdminClient).not.toHaveBeenCalled();
    expect(lastUpdate).not.toBeNull();
  });

  it("profile save: any other database error gets the generic copy, not the service-area message", async () => {
    existingContractor = {
      id: "contractor-1",
      name: "Acme Plumbing",
      license_number: null,
      license_verified_status: "unverified",
      service_state: null,
    };
    updateError = { code: "53300", message: "too many connections" };

    await saveCompanyAction(
      fd({ name: "Acme Plumbing", contact_phone: "7145550100" })
    );

    expect(setFlash).toHaveBeenCalledWith(
      "Couldn't save your company profile just now. Please try again.",
      "error"
    );
    expect(redirect).not.toHaveBeenCalled();
    expect(createAdminClient).not.toHaveBeenCalled();
  });
});
