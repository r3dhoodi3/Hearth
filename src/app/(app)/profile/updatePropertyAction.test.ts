import { beforeEach, describe, expect, it, vi } from "vitest";

// updatePropertyAction (src/app/(app)/profile/actions.ts) is the save path
// for the home-details editor. The two things worth pinning down with a real
// test, not just reading the source: (1) a blank box in the form must leave
// the stored value untouched rather than nulling it - see the blank-field
// comment on the action itself for why that's the right default here - and
// (2) each column keeps the type its migration gives it (year_built/sqft/
// beds/lot_size_sqft are int, baths is numeric(3,1)), so a fractional beds
// value doesn't reach Postgres as a type error and a real half-bath doesn't
// get truncated away.

// The signed-in caller, and the home they are looking at. user_id matches by
// default: the OWNER case. A household member (see the ownership tests at the
// bottom) sees the same home from getActiveProperty with somebody else's
// user_id on it.
const SESSION_USER = "user-owner";
const property = { id: "prop-1", user_id: SESSION_USER };
let sessionUser: { id: string } | null = { id: SESSION_USER };

vi.mock("@/lib/property", () => ({
  getActiveProperty: vi.fn(async () => property),
}));

vi.mock("@/lib/flash", () => ({
  setFlash: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

// Same DEFAULT_LIFESPANS export other actions in this file need at import
// time, even though updatePropertyAction itself never reads it.
vi.mock("@/lib/health", () => ({
  DEFAULT_LIFESPANS: {},
}));

let lastUpdate: Record<string, unknown> | null = null;
let updateError: { message: string } | null = null;
// What .select("id") hands back after the update. An empty array is the shape
// PostgREST returns when RLS filtered the row out: no error, no rows, and
// (before the fix) a cheerful "Home details saved".
let updatedRows: Array<{ id: string }> = [{ id: "prop-1" }];

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: {
      getUser: async () => ({ data: { user: sessionUser } }),
    },
    from: (_table: string) => ({
      update: (values: Record<string, unknown>) => {
        lastUpdate = values;
        return {
          eq: () => ({
            select: async () => ({
              data: updateError ? null : updatedRows,
              error: updateError,
            }),
          }),
        };
      },
    }),
  })),
}));

import { updatePropertyAction } from "./actions";
import { getActiveProperty } from "@/lib/property";

function fd(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

beforeEach(() => {
  lastUpdate = null;
  updateError = null;
  updatedRows = [{ id: "prop-1" }];
  sessionUser = { id: SESSION_USER };
  vi.mocked(getActiveProperty).mockResolvedValue(property as any);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("updatePropertyAction", () => {
  it("writes only the fields the owner actually filled in, leaving blank boxes untouched", async () => {
    const result = await updatePropertyAction(
      fd({
        year_built: "1998",
        sqft: "",
        beds: "3",
        baths: "",
        lot_size_sqft: "",
        purchase_date: "",
      })
    );
    expect(result.ok).toBe(true);
    expect(lastUpdate).toEqual({ year_built: 1998, beds: 3 });
  });

  it("writes nothing at all when every box is blank, instead of nulling every column", async () => {
    // Was: an empty PATCH went to the database and came back a success. Now
    // the action short-circuits, because a zero-row response has to mean one
    // thing only - "the write was refused" - for the check below to work.
    const result = await updatePropertyAction(fd({}));
    expect(result.ok).toBe(true);
    expect(lastUpdate).toBeNull();
  });

  it("rejects an out-of-range year built with a named error rather than silently dropping it to null", async () => {
    const result = await updatePropertyAction(fd({ year_built: "3050" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/year built/i);
    // Never reached the database at all - a bad field must not save the rest.
    expect(lastUpdate).toBeNull();
  });

  it("keeps a half-bath value, since baths is numeric(3,1)", async () => {
    const result = await updatePropertyAction(fd({ baths: "2.5" }));
    expect(result.ok).toBe(true);
    expect(lastUpdate).toEqual({ baths: 2.5 });
  });

  it("truncates a fractional beds value, since beds is an int column", async () => {
    const result = await updatePropertyAction(fd({ beds: "3.9" }));
    expect(result.ok).toBe(true);
    expect(lastUpdate).toEqual({ beds: 3 });
  });

  it("rejects a malformed purchase date instead of writing garbage", async () => {
    const result = await updatePropertyAction(fd({ purchase_date: "13/2024" }));
    expect(result.ok).toBe(false);
    expect(lastUpdate).toBeNull();
  });

  it("accepts a valid purchase date", async () => {
    const result = await updatePropertyAction(
      fd({ purchase_date: "2020-05-14" })
    );
    expect(result.ok).toBe(true);
    expect(lastUpdate).toEqual({ purchase_date: "2020-05-14" });
  });

  it("returns an error instead of saving when there is no active property", async () => {
    vi.mocked(getActiveProperty).mockResolvedValueOnce(null);
    const result = await updatePropertyAction(fd({ year_built: "1998" }));
    expect(result.ok).toBe(false);
    expect(lastUpdate).toBeNull();
  });

  it("returns an error when the database write fails", async () => {
    updateError = { message: "boom" };
    const result = await updatePropertyAction(fd({ year_built: "1998" }));
    expect(result.ok).toBe(false);
  });

  it("rejects a bathroom count the column cannot hold, and names the range", async () => {
    // properties.baths is numeric(3,1), so 99.9 is the ceiling. 100 used to
    // pass validation and come back as an unexplained "couldn't save" from
    // Postgres (22003), taking every other edit in the submit with it.
    const result = await updatePropertyAction(fd({ baths: "100" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("99.9");
    expect(lastUpdate).toBeNull();
  });

  it("still accepts the largest value that fits", async () => {
    const result = await updatePropertyAction(fd({ baths: "99.9" }));
    expect(result.ok).toBe(true);
    expect(lastUpdate).toEqual({ baths: 99.9 });
  });
});

describe("only the home's owner can save", () => {
  it("refuses a household member, in words, before touching the database", async () => {
    // getActiveProperty returns a home the caller is an active MEMBER of as
    // well as one they own, but the only UPDATE policy on properties is
    // "properties owner update". Without this guard the member's session
    // client matched zero rows, PostgREST returned no error, and the action
    // said "Home details saved" over an edit that was thrown away.
    vi.mocked(getActiveProperty).mockResolvedValue({
      id: "prop-1",
      user_id: "somebody-else",
    } as any);
    const result = await updatePropertyAction(fd({ year_built: "1998" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/owner/i);
    expect(lastUpdate).toBeNull();
  });

  it("refuses when nobody is signed in", async () => {
    sessionUser = null;
    const result = await updatePropertyAction(fd({ year_built: "1998" }));
    expect(result.ok).toBe(false);
    expect(lastUpdate).toBeNull();
  });

  it("never reports success for an update that matched no rows", async () => {
    // The backstop: if a policy change ever filters the owner's own write out,
    // the action must say so rather than show a save toast over nothing.
    updatedRows = [];
    const result = await updatePropertyAction(fd({ year_built: "1998" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/couldn't save/i);
  });
});
