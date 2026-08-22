import { cache } from "react";
import { createClient } from "@/lib/supabase/server";
import { getUser } from "@/lib/auth";
import type { UserProfile } from "@/lib/database.types";

// The current user's public.users row (their personal account: name, phone,
// email). Auto-provisioned on sign-up by a trigger, so it should always exist
// for a signed-in user. Cached per request.
export const getUserProfile = cache(async (): Promise<UserProfile | null> => {
  const user = await getUser();
  if (!user) return null;

  const supabase = await createClient();
  const { data } = await supabase
    .from("users")
    .select("*")
    .eq("id", user.id)
    .maybeSingle();

  return data ?? null;
});
