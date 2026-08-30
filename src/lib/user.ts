import { cache } from "react";
import { createClient } from "@/lib/supabase/server";
import { getUser } from "@/lib/auth";
import type { UserProfile } from "@/lib/database.types";

// The current user's public.users row PLUS whether the read itself failed.
// Cached per request, and the single place this row is fetched: any page that
// needs a column off users should read it through here rather than opening a
// second round trip for its own two columns (the dashboard's free-credit
// check used to do exactly that, which cost a whole extra query for a row the
// app shell had already loaded on the same request).
//
// The `errored` flag exists because "no row" and "the read broke" are not the
// same answer, and at least one caller has to fail OPEN on the second one:
// telling a homeowner a one-time free credit is spent when it never was is
// not recoverable from the UI.
export const getUserProfileResult = cache(
  async (): Promise<{ profile: UserProfile | null; errored: boolean }> => {
    const user = await getUser();
    if (!user) return { profile: null, errored: false };

    const supabase = await createClient();
    const { data, error } = await supabase
      .from("users")
      .select("*")
      .eq("id", user.id)
      .maybeSingle();

    if (error) return { profile: null, errored: true };
    return { profile: data ?? null, errored: false };
  }
);

// The current user's public.users row (their personal account: name, phone,
// email). Auto-provisioned on sign-up by a trigger, so it should always exist
// for a signed-in user. Cached per request. Unchanged for callers: a failed
// read still reads as null here, exactly as before.
export const getUserProfile = cache(async (): Promise<UserProfile | null> => {
  return (await getUserProfileResult()).profile;
});
