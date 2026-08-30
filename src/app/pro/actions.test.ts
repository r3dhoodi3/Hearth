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
vi.mock("@/lib/leadPricing", () => ({ bestLeadDiscount: vi.fn() }));
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
// Spied directly rather than let the real trackServerEvent run against the
// throwing createAdminClient mock above: that mock exists to prove nothing
// admin-client-shaped runs after a FAILED write, and trackServerEvent's own
// internal try/catch would just swallow that throw silently either way,
// leaving no way to assert signup_pro / onboarding_done actually fired.
vi.mock("@/lib/trackServer", () => ({ trackServerEvent: vi.fn() }));

import { saveCompanyAction, verifyLicenseNowAction } from "./actions";
import { setFlash } from "@/lib/flash";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { trackServerEvent } from "@/lib/trackServer";
import { lookupCslbLicense } from "@/lib/cslb";
import { licenseNameMatches } from "@/lib/licenseMatch";

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
  vi.mocked(trackServerEvent).mockClear();
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

  // HIGH-19: contact_phone had no server-side floor at all - only the
  // onboarding wizard's client-side gate checked it, and only on first
  // signup. The profile-edit form posts this same field on every later save
  // too, so both paths need the same PHONE_DIGITS rule.
  it("onboarding, blank phone: flashes in place, never a same-path redirect", async () => {
    await expect(
      saveCompanyAction(fd({ name: "Ivy Plumbing" }))
    ).resolves.toBeUndefined();

    expect(setFlash).toHaveBeenCalledWith(
      "Add a phone number so homeowners can reach you.",
      "error"
    );
    expect(redirect).not.toHaveBeenCalled();
    expect(revalidatePath).toHaveBeenCalledWith("/pro/onboarding");
    expect(lastInsert).toBeNull();
  });

  it("onboarding, a partial phone number: flashes the same 10-digit message the wizard shows", async () => {
    await expect(
      saveCompanyAction(fd({ name: "Ivy Plumbing", contact_phone: "714555" }))
    ).resolves.toBeUndefined();

    expect(setFlash).toHaveBeenCalledWith(
      "Enter a full 10-digit phone number.",
      "error"
    );
    expect(lastInsert).toBeNull();
  });

  it("profile save: an emptied-out phone number is refused, not saved silently", async () => {
    existingContractor = {
      id: "contractor-1",
      name: "Acme Plumbing",
      contact_phone: "(714) 555-0100",
      license_number: null,
      license_verified_status: "unverified",
      service_state: null,
    };

    await expect(
      saveCompanyAction(fd({ name: "Acme Plumbing", contact_phone: "" }))
    ).resolves.toBeUndefined();

    expect(setFlash).toHaveBeenCalledWith(
      "Add a phone number so homeowners can reach you.",
      "error"
    );
    expect(revalidatePath).toHaveBeenCalledWith("/pro/profile");
    expect(lastUpdate).toBeNull();
  });
});

// MED-21: WizardFooter's submittedRef latch (OnboardingCompanyForm.tsx)
// stops a same-tick double click, but not two genuinely separate requests
// (a slow network retry, two tabs). Migration 0072's contractors_unique_user
// index means the losing request's insert comes back 23505 - this pins down
// that the action treats that as a success (falls through to the same
// downstream work a clean insert triggers) instead of flashing a scary,
// wrong "Couldn't save your company profile."
describe("saveCompanyAction: double-submit race (23505)", () => {
  const UNIQUE_VIOLATION = {
    code: "23505",
    message:
      'duplicate key value violates unique constraint "contractors_unique_user"',
  };

  it("treats a unique-violation insert as success, not a failure", async () => {
    insertError = UNIQUE_VIOLATION;

    // Continuing past the "failed" insert reaches the same downstream work a
    // clean insert does (the preferred-side stamp), which is exactly what
    // this file's throwing createAdminClient mock exists to prove - a plain
    // resolve here would mean the action stopped short instead.
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
    ).rejects.toThrow(/createAdminClient must not be called|REDIRECT/);

    expect(setFlash).not.toHaveBeenCalledWith(
      expect.stringContaining("Couldn't save"),
      "error"
    );
  });
});

// D8 / migration 0141. owner_name is the newest column on contractors, so it
// is the one a live database is most likely missing - either outright, or as a
// column-level grant 0085's allowlist could not know about. It must save when
// it can, degrade quietly when it cannot, and never be the reason a company
// fails to be created.
describe("saveCompanyAction: owner_name", () => {
  const NO_GRANT = {
    code: "42501",
    message: "permission denied for column owner_name of relation contractors",
  };
  const MISSING_COLUMN = {
    code: "PGRST204",
    message:
      "Could not find the 'owner_name' column of 'contractors' in the schema cache",
  };
  // A city answer is required to get past the launch gate and reach the
  // insert at all; without one the action lands on the waitlist instead.
  const inLaunchArea = {
    contact_phone: "7145550100",
    service_state: "CA",
    service_cities_present: "1",
    service_cities: ["Irvine"],
  };

  // An insert that SUCCEEDS runs the admin-client work after it (the pending
  // license status, the side stamp), and this file's createAdminClient mock
  // deliberately throws so the failure-path tests can prove nothing downstream
  // ran. These two tests want the opposite - a successful write - so they
  // swallow that marker and assert on the row that was actually sent.
  async function saveExpectingSuccess(form: FormData) {
    await expect(saveCompanyAction(form)).rejects.toThrow(
      /createAdminClient must not be called|REDIRECT/
    );
  }

  it("writes a trimmed owner name on first-time setup", async () => {
    await saveExpectingSuccess(
      fd({ name: "Ivy Plumbing", owner_name: "  Alex Rivera  ", ...inLaunchArea })
    );
    expect(lastInsert?.owner_name).toBe("Alex Rivera");
  });

  it("never touches a stored owner name when the form did not carry the field", async () => {
    existingContractor = {
      id: "contractor-1",
      name: "Acme Plumbing",
      owner_name: "Alex Rivera",
      license_number: null,
      license_verified_status: "unverified",
      service_state: null,
    };
    await saveCompanyAction(fd({ name: "Acme Plumbing", contact_phone: "7145550100" }));
    // Absent, not null: a lean post must not blank what is stored.
    expect(lastUpdate).not.toHaveProperty("owner_name");
  });

  it("refuses a one-character owner name, the same floor the column's CHECK has", async () => {
    await expect(
      saveCompanyAction(
        fd({ name: "Ivy Plumbing", owner_name: "A", ...inLaunchArea })
      )
    ).resolves.toBeUndefined();
    expect(setFlash).toHaveBeenCalledWith("Enter the owner's name.", "error");
    expect(lastInsert).toBeNull();
  });

  it("creates the company anyway when the live database has no owner_name column", async () => {
    // The first insert fails with the missing-column fingerprint; the retry
    // drops owner_name and succeeds. Signup must never be blocked on a
    // migration nobody has pasted yet. The console.error the retry logs is
    // where the error is cleared, so the second attempt goes through.
    insertError = MISSING_COLUMN;
    const spy = vi.spyOn(console, "error").mockImplementation(() => {
      insertError = null;
    });

    await saveExpectingSuccess(
      fd({ name: "Ivy Plumbing", owner_name: "Alex Rivera", ...inLaunchArea })
    );

    // The row landed, without the field this database cannot hold yet.
    expect(lastInsert).not.toBeNull();
    expect(lastInsert).not.toHaveProperty("owner_name");
    spy.mockRestore();
  });

  it("tells the pro when a profile save had to drop the owner name", async () => {
    existingContractor = {
      id: "contractor-1",
      name: "Acme Plumbing",
      owner_name: null,
      license_number: null,
      license_verified_status: "unverified",
      service_state: null,
    };
    updateError = NO_GRANT;
    const spy = vi.spyOn(console, "error").mockImplementation(() => {
      updateError = null;
    });

    await saveCompanyAction(
      fd({
        name: "Acme Plumbing",
        owner_name: "Alex Rivera",
        contact_phone: "7145550100",
      })
    );

    // The save DID succeed; a plain "Profile saved." would be a lie the pro
    // only discovers on a reload.
    expect(setFlash).toHaveBeenCalledWith(
      "Saved. Owner name could not be stored yet.",
      "warning"
    );
    spy.mockRestore();
  });
});

// docs/ANALYTICS.md. signup_pro fires the moment the contractors row lands;
// onboarding_done fires only once the whole wizard finishes (terms accepted,
// CSLB attempted, preferred side stamped) - two distinct moments in the same
// first-time-setup branch, not duplicate events for the same thing.
describe("saveCompanyAction: funnel analytics (signup_pro / onboarding_done)", () => {
  const inLaunchArea = {
    contact_phone: "7145550100",
    service_state: "CA",
    service_cities_present: "1",
    service_cities: ["Irvine"],
  };

  it("records signup_pro right when the contractor row lands", async () => {
    // No user_metadata.role set, so the preferred-side stamp below still runs
    // and hits this file's throwing createAdminClient mock - proof the row
    // really was created (see the "owner_name" describe block's own comment
    // on this pattern) and, more importantly here, proof signup_pro fired
    // BEFORE that later admin-client work, not after it.
    await expect(
      saveCompanyAction(fd({ name: "Ivy Plumbing", ...inLaunchArea }))
    ).rejects.toThrow(/createAdminClient must not be called|REDIRECT/);

    expect(trackServerEvent).toHaveBeenCalledWith(sessionUser.id, "signup_pro");
  });

  it("records onboarding_done once the wizard actually finishes", async () => {
    // Pre-stamped, so the preferred-side block is skipped and the action can
    // run all the way to its real redirect("/pro") instead of the mock's
    // throwing admin client.
    sessionUser.user_metadata.role = "contractor";
    try {
      await expect(
        saveCompanyAction(fd({ name: "Ivy Plumbing", ...inLaunchArea }))
      ).rejects.toThrow(/REDIRECT/);

      expect(trackServerEvent).toHaveBeenCalledWith(
        sessionUser.id,
        "onboarding_done"
      );
    } finally {
      sessionUser.user_metadata = {};
    }
  });
});

// docs/ANALYTICS.md. license_verified fires only on the write that actually
// lands 'verified' - verifyLicenseNowAction ("Verify now" on /pro/profile) is
// the simplest of verifyContractorLicense's three call sites to drive directly,
// since it needs no contractors insert/update machinery of its own when the
// license number on the form matches what's already on file.
describe("verifyLicenseNowAction: license_verified analytics", () => {
  it("records license_verified for the account, on a real CSLB pass", async () => {
    existingContractor = {
      id: "contractor-1",
      user_id: "user-1",
      name: "Ivy Plumbing",
      license_number: "270663",
      // Not 'verified': a verified number is locked and this action would
      // never reach the CSLB call at all.
      license_verified_status: "pending",
      license_verified_at: null,
      license_verify_detail: null,
      service_state: "CA",
    };
    vi.mocked(lookupCslbLicense).mockResolvedValue({
      outcome: "active",
      businessName: "Ivy Plumbing",
      statusText: "Active",
      classifications: [],
      expires: null,
    } as any);
    vi.mocked(licenseNameMatches).mockReturnValue(true);
    // Two clean admin-client calls, queued in the exact order this path
    // makes them: accountFullName's read (best-effort, for the 0125 name
    // candidates), then the license write itself. Everything before and
    // after them in this file still goes through the throwing base mock, so
    // this only lets through the two calls being exercised here.
    vi.mocked(createAdminClient)
      .mockImplementationOnce(
        () =>
          ({
            from: () => ({
              select: () => ({
                eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
              }),
            }),
          }) as any
      )
      .mockImplementationOnce(
        () =>
          ({
            from: () => ({ update: () => ({ eq: async () => ({ error: null }) }) }),
          }) as any
      );

    // Same license number as stored, so licenseChanged is false and this
    // never touches the (untested-here) license-correction write path.
    await verifyLicenseNowAction(fd({ license_number: "270663" }));

    expect(trackServerEvent).toHaveBeenCalledWith("user-1", "license_verified");
    expect(setFlash).toHaveBeenCalledWith(
      "License verified against the CSLB database.",
      "success"
    );
  });
});
