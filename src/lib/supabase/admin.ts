// Build-time guard: this module reads SUPABASE_SERVICE_ROLE_KEY, so importing
// it from a Client Component must fail the build, not ship the key.
import "server-only";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";

// Service-role Supabase client for trusted server-side jobs that have no user
// session (e.g. the Stripe webhook crediting a wallet). Bypasses RLS, so only
// ever use it in server-only code with values you've validated yourself.
export function createAdminClient() {
  return createClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
}
