import "server-only";
import { createClient } from "@/lib/supabase/server";

// The database half of the pro Home tab (see src/lib/proHome.ts for the pure
// half and why the two are split).

// How many homeowners sent the last word in a conversation and have not heard
// back. This is the "waiting on your reply" number in the Home greeting.
//
// Not the nav's unread badge: that one is per-device (it compares against a
// "seen" cookie written in the browser), so it cannot be computed on the
// server at all. This is the honest server-side version of the same worry -
// a thread whose newest message came from the homeowner - and it is the same
// for the pro on every device.
//
// Bounded exactly like UnreadProvider's poll: the newest 50 messages across
// this pro's leads. A pro with more than 50 newer messages than that has a
// bigger number than this reports, which is the safe direction to be wrong in.
// Returns 0 on any read failure: a greeting must never invent work.
export async function countAwaitingReply(leadIds: string[]): Promise<number> {
  if (!leadIds.length) return 0;
  try {
    const supabase = await createClient();
    const { data, error } = await supabase
      .from("messages")
      .select("lead_id, sender_role, created_at")
      .in("lead_id", leadIds)
      .order("created_at", { ascending: false })
      .limit(50);
    if (error || !data) return 0;
    // Rows arrive newest first, so the first row seen for a lead IS its newest
    // message. A lead counts only when that message came from the homeowner.
    const seen = new Set<string>();
    let waiting = 0;
    for (const m of data as any[]) {
      if (seen.has(m.lead_id)) continue;
      seen.add(m.lead_id);
      if (m.sender_role === "homeowner") waiting += 1;
    }
    return waiting;
  } catch {
    return 0;
  }
}
