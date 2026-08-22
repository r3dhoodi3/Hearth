import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { cookies } from "next/headers";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";

type CookieToSet = { name: string; value: string; options: CookieOptions };

// Supabase client for Server Components, Server Actions, and Route Handlers.
// Reads/writes the auth session from Next's cookie store.
//
// The return type is annotated explicitly: @supabase/ssr@0.5.x's createServerClient
// signature predates supabase-js@2.107's reworked SupabaseClient generics, so its
// inferred type collapses query results to `never`. supabase-js's own
// SupabaseClient<Database> resolves correctly, and at runtime the ssr client IS
// exactly that, so we cast to it. Remove the cast once ssr is upgraded to match.
//
// async since Next 15: cookies() returns a Promise there, so the cookie store
// has to be awaited before the adapter below can read it. Every caller awaits
// createClient() as a result.
export async function createClient(): Promise<SupabaseClient<Database>> {
  const cookieStore = await cookies();

  return createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet: CookieToSet[]) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // Called from a Server Component where cookies are read-only.
            // Safe to ignore - middleware refreshes the session cookie.
          }
        },
      },
    }
  ) as unknown as SupabaseClient<Database>;
}
