import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";

// Loads the Supabase browser client ON DEMAND, after hydration.
//
// WHY. supabase-js is the single largest thing in the browser bundle: 49.6 kB
// gzipped (auth + postgrest + realtime + storage), and a static
// `import { createClient } from "@/lib/supabase/client"` in any client
// component pulls all of it into that route's First Load JS. Measured on
// 2026-08-30 it was roughly a quarter of the JavaScript a signed-in page had
// to download and parse before it could become interactive - on every app
// route, homeowner and pro.
//
// Nothing needs it for the first paint. Every use is a poll, a realtime
// subscription, an upload or a click handler, all of which run after
// hydration. So the import moves inside a dynamic import(): webpack puts
// supabase-js in its own async chunk, the route no longer blocks on it, and
// the first call (an effect a tick after mount) fetches it.
//
// Both the client and the in-flight promise are memoized at module scope, so
// however many components ask, the module is evaluated once and exactly one
// browser client exists per tab - same guarantee the old direct createClient()
// call had, since createBrowserClient itself is memoized per-origin.
//
// The two imports above are `import type`, erased at compile time, so this
// module carries no runtime dependency on supabase-js.
let cached: SupabaseClient<Database> | null = null;
let pending: Promise<SupabaseClient<Database>> | null = null;

export function getSupabase(): Promise<SupabaseClient<Database>> {
  if (cached) return Promise.resolve(cached);
  if (!pending) {
    pending = import("@/lib/supabase/client").then((m) => {
      cached = m.createClient();
      pending = null;
      return cached;
    });
  }
  return pending;
}

// Test seam only: drops the memoized client so a test can assert the loader
// imports once per module lifetime rather than inheriting another test's.
export function resetSupabaseForTests(): void {
  cached = null;
  pending = null;
}
