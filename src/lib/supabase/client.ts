import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";

// Supabase client for Client Components ("use client").
// Return type annotated explicitly - see the note in ./server.ts for why the
// @supabase/ssr@0.5.x inferred type collapses query results to `never`.
export function createClient(): SupabaseClient<Database> {
  return createBrowserClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      // Secure in production, matching ./server.ts and ./middleware.ts. All
      // three write the same cookie, so if one of them omitted the flag the
      // next write from that one would quietly clear it again. Conditional on
      // NODE_ENV for the same reason: a Secure cookie is dropped on
      // http://localhost. NEXT_PUBLIC_ is not needed - Next inlines
      // process.env.NODE_ENV into the browser bundle.
      cookieOptions: { secure: process.env.NODE_ENV === "production" },
    }
  ) as unknown as SupabaseClient<Database>;
}
