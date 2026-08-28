"use server";

import { createClient } from "@/lib/supabase/server";
import type { GuideSide } from "@/lib/appGuide";

// Stamps "this account has seen the first-run guide" so it does not come back
// on their laptop after they closed it on their phone.
//
// OWNERSHIP: the update runs through the caller's OWN session client, filtered
// to their own id, so there are two independent locks on it - the explicit
// eq() below and the "users self update" RLS policy (migration 0002), which
// alone makes it impossible for this action to touch another account's row no
// matter what a crafted call passes. Nothing about the target row is taken
// from the caller: `side` only picks which of two columns on their own row
// gets a timestamp, and anything that is not exactly "pro" is treated as the
// homeowner side.
//
// Best effort and silent on failure. The worst case of a dropped write is that
// the guide could appear once more on a different device, which is a far
// smaller problem than an error toast thrown over somebody's first minute in
// the app. In particular, if migration 0137 has not been applied to the live
// database yet, this errors on every call and the localStorage mirror in
// AppGuide.tsx quietly carries the whole feature at once-per-browser.
export async function markGuideSeenAction(side: GuideSide): Promise<void> {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;

    // Spelled out as two literal objects rather than a computed key: a
    // computed key widens to a plain string index and drops the generated
    // column types on the way through, which is exactly the check that would
    // catch a typo'd column name here.
    const now = new Date().toISOString();
    const patch =
      side === "pro" ? { pro_guide_seen_at: now } : { guide_seen_at: now };
    const { error } = await supabase
      .from("users")
      .update(patch)
      .eq("id", user.id);
    if (error) throw error;
  } catch (err) {
    console.error("markGuideSeenAction failed:", err);
  }
}
