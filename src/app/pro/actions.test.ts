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
  it("first-time setup: a launch_cities check-constraint violation never throws, never redirects, and nothing downstream runs", async () => {
    insertError = LAUNCH_CITIES_SUBSET_ERROR;

    // No redirect here either - see the comment on this branch in actions.ts.
    // A tester found this the hard way: redirect("/pro/onboarding") while
    // already ON /pro/onboarding is the same same-path App Router footgun the
    // profile branch below was already fixed for, and it left the wizard
    // itself unmounted behind the error banner (no form, no Back button)
    // until a manual reload. setFlash() + revalidatePath() on the SAME path
    // keeps the wizard mounted with whatever the pro already typed.
    await expect(
      saveCompanyAction(
        fd({
          name: "Ivy Plumbing",
          contact_phone: "7145550100",
          service_state: "CA",
          service_cities_present: "1",
          service_cities: ["Irvine"],
        })
      )
    ).resolves.toBeUndefined();

    expect(setFlash).toHaveBeenCalledWith(
      "We couldn't save your service area just now. Pick specific cities and try again, or come back a little later.",
      "error"
    );
    expect(redirect).not.toHaveBeenCalled();
    expect(revalidatePath).toHaveBeenCalledWith("/pro/onboarding");

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

// The write-failure branch above was fixed for the same-path footgun; the
// VALIDATION floors earlier in the same action still ended in
// redirect("/pro/onboarding"), which is the identical bug on a path the pro
// reaches far more often - an empty company name or a missed city is an
// ordinary typo, not a database outage. Each one left the wizard stranded on
// its loading.tsx boundary with the error banner and no form under it.
//
// The profile half is deliberately unchanged: /pro/profile is a real
// navigation for a pro who submitted from anywhere else, so those still
// redirect.
describe("saveCompanyAction: validation floors", () => {
  it("onboarding, no city picked: flashes in place, never a same-path redirect", async () => {
    await expect(
      saveCompanyAction(
        fd({
          name: "Ivy Plumbing",
          contact_phone: "7145550100",
          // The form asked the city question and the pro answered nothing.
          service_cities_present: "1",
        })
      )
    ).resolves.toBeUndefined();

    expect(setFlash).toHaveBeenCalledWith(
      "Pick at least one city you serve.",
      "error"
    );
    expect(redirect).not.toHaveBeenCalled();
    expect(revalidatePath).toHaveBeenCalledWith("/pro/onboarding");
    // The action really stopped: without the explicit `return` the missing
    // redirect() throw would let it fall through and create the company.
    expect(lastInsert).toBeNull();
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it("onboarding, blank company name: flashes in place, never a same-path redirect", async () => {
    await expect(
      saveCompanyAction(fd({ name: "   ", contact_phone: "7145550100" }))
    ).resolves.toBeUndefined();

    expect(setFlash).toHaveBeenCalledWith("Enter your company name.", "error");
    expect(redirect).not.toHaveBeenCalled();
    expect(revalidatePath).toHaveBeenCalledWith("/pro/onboarding");
    expect(lastInsert).toBeNull();
  });

  it("onboarding, a bad review link: flashes in place, never a same-path redirect", async () => {
    await expect(
      saveCompanyAction(
        fd({
          name: "Ivy Plumbing",
          contact_phone: "7145550100",
          yelp_url: "https://not-yelp.example.com/biz/ivy-plumbing",
        })
      )
    ).resolves.toBeUndefined();

    expect(setFlash).toHaveBeenCalledWith(
      expect.stringContaining("Yelp business page link"),
      "error"
    );
    expect(redirect).not.toHaveBeenCalled();
    expect(revalidatePath).toHaveBeenCalledWith("/pro/onboarding");
    expect(lastInsert).toBeNull();
  });

  it("profile save flashes in place too: /pro/profile posts to itself", async () => {
    existingContractor = {
      id: "contractor-1",
      name: "Acme Plumbing",
      license_number: null,
      license_verified_status: "unverified",
      service_state: null,
    };

    await expect(
      saveCompanyAction(fd({ name: "   ", contact_phone: "7145550100" }))
    ).resolves.toBeUndefined();

    expect(setFlash).toHaveBeenCalledWith("Enter your company name.", "error");
    expect(redirect).not.toHaveBeenCalled();
    expect(revalidatePath).toHaveBeenCalledWith("/pro/profile");
    expect(lastUpdate).toBeNull();
  });
});
