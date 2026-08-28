import { beforeEach, describe, expect, it, vi } from "vitest";

// postJobAction's failure floors.
//
// Every one of them used to end in setFlash() + redirect("/contractors"): a
// bare path with no query string. The page prefills the post-a-job form from
// searchParams, so dropping them reset the form to blank, and the flash
// travels in a cookie that FlashToast only reads when it re-renders - which a
// redirect to the SAME path does not guarantee. Two testers on 2026-08-28 hit
// exactly that and reported "Posting..., then a blank form, no error at all".
//
// These tests pin the fix: nothing is ever inserted, the owner keeps what they
// typed, and the reason travels in the URL as an ?error= code the page turns
// into a visible sentence under the Post job button.
//
// A NEXT_REDIRECT is not a crash - it is Next's own throw-to-navigate
// mechanism - so the mock reproduces that shape and the assertions catch only
// that marker. A raw `new Error(...)` escaping the action fails the test
// instead of being swallowed.

class RedirectSignal extends Error {
  constructor(public path: string) {
    super(`REDIRECT:${path}`);
  }
}

const sessionUser = {
  id: "user-1",
  email: "owner@example.com",
  user_metadata: {} as Record<string, unknown>,
};

// An Orange County home, already ownership-checked so the lazy RentCast
// re-check (and its parcel lookup) never runs in these tests.
const LAUNCH_PROPERTY = {
  id: "property-1",
  user_id: "user-1",
  address_line1: "123 Main St",
  unit: null,
  city: "Fountain Valley",
  state: "CA",
  zip: "92708",
  ownership_status: "verified",
  ownership_checked_at: "2026-08-01T00:00:00.000Z",
};

let activeProperty: Record<string, unknown> | null = LAUNCH_PROPERTY;
let rateLimitAnswers: (boolean | null)[] = [];

vi.mock("@/lib/property", () => ({
  getActiveProperty: vi.fn(async () => activeProperty),
  formatAddressLine: vi.fn(
    (p: { address_line1?: string }) => p.address_line1 ?? ""
  ),
}));

// Any read or write through either client is a failure here: every path under
// test is supposed to turn the owner around BEFORE touching a table. A call
// therefore throws rather than returning a stub, so "nothing was inserted" is
// proved by the test rather than asserted about a mock nobody exercised.
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: async () => ({ data: { user: sessionUser } }) },
    from: (table: string) => {
      throw new Error(`postJobAction must not touch "${table}" on this path`);
    },
    storage: {
      from: () => ({ remove: async () => ({ error: null }) }),
    },
  })),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(() => ({
    // The only admin call a rejected post is allowed to make: the fixed-window
    // rate limiter. Answers come off a queue so each test can decide which of
    // the two buckets (hourly, then daily) says no.
    rpc: vi.fn(async () => ({
      data: rateLimitAnswers.length ? rateLimitAnswers.shift() : true,
      error: null,
    })),
    from: (table: string) => {
      throw new Error(`postJobAction must not write "${table}" on this path`);
    },
  })),
}));

vi.mock("@/lib/flash", () => ({ setFlash: vi.fn(async () => {}) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({ get: () => undefined, set: () => {} })),
  headers: vi.fn(async () => ({ get: () => null })),
}));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((path: string) => {
    throw new RedirectSignal(path);
  }),
}));

vi.mock("@/lib/parcel", () => ({
  lookupParcel: vi.fn(() => {
    throw new Error("a metered parcel lookup must not run on a rejected post");
  }),
}));
vi.mock("@/lib/proAlerts", () => ({
  alertProsForNewLead: vi.fn(() => {
    throw new Error("pros must not be alerted about a job that was rejected");
  }),
}));
vi.mock("@/lib/notify", () => ({ sendNotification: vi.fn() }));
vi.mock("@/lib/subscription", () => ({ hasPlus: vi.fn(async () => false) }));
vi.mock("@/lib/blocks", () => ({ isBlockedBetween: vi.fn(async () => false) }));

import { postJobAction } from "./actions";
import { POST_JOB_ERRORS } from "./postJobErrors";
import { setFlash } from "@/lib/flash";
import { redirect } from "next/navigation";

function fd(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

// A completely filled-in post: category, timing, name, and a description well
// past the 20-character floor. Exactly what the testers submitted.
const FILLED = {
  category: "plumbing",
  timing: "asap",
  homeowner_name: "Jane Doe",
  message:
    "The kitchen sink has been dripping under the cabinet for about a week and the floor is starting to swell.",
};

// Runs the action and returns the path it redirected to, failing the test if
// anything other than a redirect came out.
async function runAndCatchRedirect(form: FormData): Promise<string> {
  let caught: unknown = null;
  try {
    await postJobAction(form);
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(RedirectSignal);
  return (caught as RedirectSignal).path;
}

beforeEach(() => {
  activeProperty = { ...LAUNCH_PROPERTY };
  rateLimitAnswers = [];
  vi.mocked(setFlash).mockClear();
  vi.mocked(redirect).mockClear();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("postJobAction failure paths", () => {
  it("a home outside the launch area keeps the typed values and names the reason", async () => {
    activeProperty = { ...LAUNCH_PROPERTY, zip: "90210", city: "Beverly Hills" };

    const path = await runAndCatchRedirect(fd(FILLED));
    const url = new URL(path, "https://example.test");

    expect(url.pathname).toBe("/contractors");
    expect(url.searchParams.get("error")).toBe("out_of_area");
    // The whole point: nothing the owner typed is lost.
    expect(url.searchParams.get("category")).toBe("plumbing");
    expect(url.searchParams.get("timing")).toBe("asap");
    expect(url.searchParams.get("desc")).toBe(FILLED.message);

    expect(setFlash).toHaveBeenCalledWith(
      POST_JOB_ERRORS.out_of_area,
      "error"
    );
  });

  it("the hourly post limit says so instead of resetting the form", async () => {
    rateLimitAnswers = [false];

    const url = new URL(
      await runAndCatchRedirect(fd(FILLED)),
      "https://example.test"
    );
    expect(url.searchParams.get("error")).toBe("rate_hour");
    expect(url.searchParams.get("desc")).toBe(FILLED.message);
    expect(setFlash).toHaveBeenCalledWith(POST_JOB_ERRORS.rate_hour, "error");
  });

  it("the daily post limit says so instead of resetting the form", async () => {
    // Hourly bucket allows, daily bucket refuses.
    rateLimitAnswers = [true, false];

    const url = new URL(
      await runAndCatchRedirect(fd(FILLED)),
      "https://example.test"
    );
    expect(url.searchParams.get("error")).toBe("rate_day");
    expect(url.searchParams.get("desc")).toBe(FILLED.message);
    expect(setFlash).toHaveBeenCalledWith(POST_JOB_ERRORS.rate_day, "error");
  });

  it("a forged category is refused with a message, not a blank form", async () => {
    const url = new URL(
      await runAndCatchRedirect(fd({ ...FILLED, category: "not_a_category" })),
      "https://example.test"
    );
    expect(url.searchParams.get("error")).toBe("category");
    // The rejected value is NOT echoed back. It used to be, to keep the
    // select from emptying under the owner - but the select can only ever
    // produce a value on the list, so anything else came from a forged or
    // stale post, and re-rendering it means putting attacker-chosen text back
    // into the page's own prefill. The flash says what went wrong; the select
    // falls back to its blank first option, which is honest. Same rule the
    // budget band has always followed.
    expect(url.searchParams.get("category")).toBeNull();
    expect(url.searchParams.get("desc")).toBe(FILLED.message);
    expect(setFlash).toHaveBeenCalledWith(POST_JOB_ERRORS.category, "error");
  });

  it("a too-short description is refused with a message and the text kept", async () => {
    const short = "leak";
    const url = new URL(
      await runAndCatchRedirect(fd({ ...FILLED, message: short })),
      "https://example.test"
    );
    expect(url.searchParams.get("error")).toBe("description");
    expect(url.searchParams.get("desc")).toBe(short);
    expect(setFlash).toHaveBeenCalledWith(POST_JOB_ERRORS.description, "error");
  });

  it("a major-tier job with no budget is refused with a message", async () => {
    const url = new URL(
      await runAndCatchRedirect(fd({ ...FILLED, category: "remodeling" })),
      "https://example.test"
    );
    expect(url.searchParams.get("error")).toBe("budget");
    expect(url.searchParams.get("category")).toBe("remodeling");
    expect(url.searchParams.get("desc")).toBe(FILLED.message);
    expect(setFlash).toHaveBeenCalledWith(POST_JOB_ERRORS.budget, "error");
  });

  it("keeps a budget pick across a rejection, and never echoes a forged one", async () => {
    const kept = new URL(
      await runAndCatchRedirect(
        fd({ ...FILLED, message: "leak", budget_range: "1500-5000" })
      ),
      "https://example.test"
    );
    expect(kept.searchParams.get("error")).toBe("description");
    expect(kept.searchParams.get("budget")).toBe("1500-5000");

    const forged = new URL(
      await runAndCatchRedirect(
        fd({ ...FILLED, message: "leak", budget_range: "'; drop table --" })
      ),
      "https://example.test"
    );
    expect(forged.searchParams.get("budget")).toBeNull();
  });

  // The same rule the budget pick already followed, applied to the other two
  // <select> fields. out_of_area / rate_hour / rate_day all fire BEFORE the
  // authoritative category check further down, so a forged value used to ride
  // into the failure URL and back into the prefilled form unchecked.
  it("never echoes a forged category or timing into the failure URL", async () => {
    rateLimitAnswers = [false];
    const url = new URL(
      await runAndCatchRedirect(
        fd({
          ...FILLED,
          category: "<img src=x onerror=alert(1)>",
          timing: "'; drop table --",
        })
      ),
      "https://example.test"
    );
    expect(url.searchParams.get("error")).toBe("rate_hour");
    expect(url.searchParams.get("category")).toBeNull();
    expect(url.searchParams.get("timing")).toBeNull();
    // The description is free text, so it still comes back untouched.
    expect(url.searchParams.get("desc")).toBe(FILLED.message);
  });

  it("keeps a real category and timing across the same early rejection", async () => {
    rateLimitAnswers = [false];
    const url = new URL(
      await runAndCatchRedirect(fd(FILLED)),
      "https://example.test"
    );
    expect(url.searchParams.get("category")).toBe("plumbing");
    expect(url.searchParams.get("timing")).toBe("asap");
  });

  // The description rides in a URL that a redirect puts in a Location header,
  // so an unbounded paste turns a plain validation error into a request no
  // proxy will carry.
  it("caps the description it carries back at 1000 characters", async () => {
    rateLimitAnswers = [false];
    const huge = "x".repeat(5000);
    const url = new URL(
      await runAndCatchRedirect(fd({ ...FILLED, message: huge })),
      "https://example.test"
    );
    expect(url.searchParams.get("desc")).toHaveLength(1000);
  });

  it("no active home goes to onboarding rather than the crash boundary", async () => {
    activeProperty = null;
    const path = await runAndCatchRedirect(fd(FILLED));
    expect(path).toBe("/onboarding");
  });

  it("every failure code the action can send resolves to a real sentence", async () => {
    for (const message of Object.values(POST_JOB_ERRORS)) {
      expect(message.length).toBeGreaterThan(10);
    }
  });
});
