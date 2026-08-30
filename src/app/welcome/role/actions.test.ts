import { beforeEach, describe, expect, it, vi } from "vitest";

// chooseRoleAction's established-account guard.
//
// The guard is a ROW check: an account that owns a contractors row or a home
// has built a side, so the picker must never re-stamp it. What it could not
// tell apart was "there is no row" from "we could not read the rows" - a
// non-schema DB error made getCurrentContractor() return null, getSides()
// reported hasPro/hasHome false, and the guard sailed straight past on an
// outage that had nothing to do with this account. Fail-open on a security
// guard, so it is now refused with a plain retry message.
//
// A NEXT_REDIRECT is Next's throw-to-navigate mechanism, not a crash, so the
// mock reproduces that shape and the assertions catch only that marker.

class RedirectSignal extends Error {
  constructor(public path: string) {
    super(`REDIRECT:${path}`);
  }
}

type Sides = {
  hasPro: boolean;
  hasHome: boolean;
  preferred: "homeowner" | "contractor" | null;
  checked?: boolean;
};

const sessionUser = {
  id: "user-1",
  email: "someone@example.com",
  user_metadata: {} as Record<string, unknown>,
};

let sides: Sides = {
  hasPro: false,
  hasHome: false,
  preferred: null,
  checked: true,
};
let updateCalls = 0;
let updateError: { message: string } | null = null;

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: {
      getUser: async () => ({ data: { user: sessionUser } }),
      refreshSession: async () => ({ error: null }),
    },
  })),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(() => ({
    auth: {
      admin: {
        updateUserById: async () => {
          updateCalls++;
          return { error: updateError };
        },
      },
    },
  })),
}));

// landingFor stays real (it is pure, and lives in ./roleRouting), so a bad
// refusal cannot be hidden by a stubbed destination.
vi.mock("@/lib/contractor", async () => {
  const routing = await import("@/lib/roleRouting");
  return {
    getSides: vi.fn(async () => sides),
    landingFor: routing.landingFor,
  };
});

vi.mock("@/lib/flash", () => ({ setFlash: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((path: string) => {
    throw new RedirectSignal(path);
  }),
}));
vi.mock("@/app/(auth)/recordTermsAcceptance", () => ({
  recordTermsAcceptance: vi.fn(),
}));

import { chooseRoleAction } from "./actions";
import { setFlash } from "@/lib/flash";

function fd(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

beforeEach(() => {
  sides = { hasPro: false, hasHome: false, preferred: null, checked: true };
  updateCalls = 0;
  updateError = null;
  vi.mocked(setFlash).mockClear();
});

describe("chooseRoleAction: the row guard cannot fail open", () => {
  it("refuses when the row lookup errored and a role stamp already exists", async () => {
    sides = {
      hasPro: false,
      hasHome: false,
      preferred: "contractor",
      checked: false,
    };

    await expect(chooseRoleAction(fd({ role: "homeowner" }))).rejects.toThrow(
      "REDIRECT:/welcome/role"
    );

    expect(setFlash).toHaveBeenCalledWith(
      "We couldn't check your account just now. Try again in a minute.",
      "error"
    );
    // The whole point: nothing was re-stamped on the strength of a read that
    // never ran.
    expect(updateCalls).toBe(0);
  });

  it("refuses a failed read even with no role stamp: the stamp says nothing about the rows", async () => {
    // "No stamp" is read off user metadata, not off the rows that failed to
    // load - an OAuth account can own a contractors row or a property without
    // ever having been stamped. So a failed check is refused either way.
    sides = {
      hasPro: false,
      hasHome: false,
      preferred: null,
      checked: false,
    };

    await expect(chooseRoleAction(fd({ role: "contractor" }))).rejects.toThrow(
      "REDIRECT:/welcome/role"
    );

    expect(setFlash).toHaveBeenCalledWith(
      "We couldn't check your account just now. Try again in a minute.",
      "error"
    );
    expect(updateCalls).toBe(0);
  });

  it("a clean 'no rows' answer is still a real answer, and the choice is made", async () => {
    sides = {
      hasPro: false,
      hasHome: false,
      preferred: "contractor",
      checked: true,
    };

    await expect(chooseRoleAction(fd({ role: "homeowner" }))).rejects.toThrow(
      "REDIRECT:/onboarding"
    );
    expect(setFlash).not.toHaveBeenCalled();
    expect(updateCalls).toBe(1);
  });

  it("an account that demonstrably owns a side is bounced to it, as before", async () => {
    sides = {
      hasPro: true,
      hasHome: false,
      preferred: "contractor",
      checked: true,
    };

    await expect(chooseRoleAction(fd({ role: "homeowner" }))).rejects.toThrow(
      "REDIRECT:/pro"
    );
    expect(updateCalls).toBe(0);
  });
});

// A failed role stamp used to `throw new Error("Could not save your choice")`.
// Next masks a server-side throw in production, so the person got the generic
// "Something went sideways" boundary instead - no picker under it, no way back
// to the choice they were making, and the message written for them never
// reached them. It comes back through the flash cookie now, on the picker
// itself, with any carried ?next= intact.
describe("chooseRoleAction: a failed stamp is shown, not thrown", () => {
  it("flashes the retry message and returns to the picker", async () => {
    updateError = { message: "auth admin unavailable" };

    await expect(chooseRoleAction(fd({ role: "homeowner" }))).rejects.toThrow(
      "REDIRECT:/welcome/role"
    );
    expect(setFlash).toHaveBeenCalledWith(
      "Could not save your choice. Please try again.",
      "error"
    );
  });

  it("keeps the destination the picker was carrying", async () => {
    updateError = { message: "auth admin unavailable" };

    await expect(
      chooseRoleAction(fd({ role: "contractor", next: "/dashboard" }))
    ).rejects.toThrow("REDIRECT:/welcome/role?next=%2Fdashboard");
  });
});
