import { beforeEach, describe, expect, it, vi } from "vitest";

// The real module builds a browser client from NEXT_PUBLIC_ env vars, which is
// not what this test is about: it is about the loader only importing it once
// and handing every caller the same client.
const createClient = vi.fn(() => ({ id: Math.random() }));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => createClient(),
}));

import { getSupabase, resetSupabaseForTests } from "@/lib/lazySupabase";

describe("getSupabase", () => {
  beforeEach(() => {
    resetSupabaseForTests();
    createClient.mockClear();
  });

  it("builds exactly one client, however many callers ask", async () => {
    const [a, b] = await Promise.all([getSupabase(), getSupabase()]);
    const c = await getSupabase();
    expect(a).toBe(b);
    expect(b).toBe(c);
    // One client per tab was the guarantee the old module-scope
    // `createClient()` call gave; concurrent callers must not race into two.
    expect(createClient).toHaveBeenCalledTimes(1);
  });

  it("resolves to a usable client rather than the module namespace", async () => {
    const client = await getSupabase();
    expect(client).toBeTruthy();
    expect(typeof client).toBe("object");
  });
});
