import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

// The database half of pro feedback (see src/lib/proFeedback.ts for what it
// is, and for the rule that it is never tied to a store rating).
//
// Service-role only, so none of it ships to the browser.
//
// C7 (2026-09-07): this used to also grant a one-time $5 bonus credit the
// moment the first report was sent (grantFeedbackCredit, calling migration
// 0144's grant_feedback_credit()). That automatic path is gone: every report
// now stores as status='pending' and money moves only through
// verify_pro_feedback() (migration 0157), run by hand from the Supabase SQL
// editor after a person confirms the report is real. Nothing in this file
// calls it - see the PASTE-ME file's header for the exact command.

export type FeedbackState = {
  // Has this contractor already sent us at least one report?
  sent: boolean;
};

// Returns { sent: false } when the read fails or the table isn't live yet,
// which renders as "the form is fresh" - the safe direction, since sending a
// report a second time costs nothing (0152 dropped the one-per-business cap).
export async function readFeedbackState(
  contractorId: string
): Promise<FeedbackState> {
  try {
    const admin = createAdminClient();
    const { data } = await (admin as any)
      .from("pro_feedback")
      .select("contractor_id")
      .eq("contractor_id", contractorId)
      .maybeSingle();
    return { sent: Boolean(data) };
  } catch {
    return { sent: false };
  }
}

// The spam cap on report writes, same rate_limit_hit bucket shape the
// homeowner /feedback form and both support forms use, and the same fail-OPEN
// posture: only an explicit `false` blocks, so a limiter outage can never
// stop a real pro from telling us something. Five an hour, matching the
// homeowner form: since migration 0152 a business can send any number of
// reports, and each one is attacker-controllable text a person later reads.
export async function proFeedbackRateLimitOk(userId: string): Promise<boolean> {
  try {
    const admin = createAdminClient();
    const { data: allowed } = await (admin as any).rpc("rate_limit_hit", {
      p_bucket: `pro-feedback:${userId}`,
      p_limit: 5,
      p_window_seconds: 3600,
    });
    return allowed !== false;
  } catch {
    return true;
  }
}

// Store one pro's report. Returns "ok", "already", or "failed". "already" is
// the unique index on contractor_id refusing a second row, which only exists
// until migration 0152 is pasted live: after it, a business can send as many
// reports as it likes and this path never fires. Every stored row defaults to
// status='pending' (migration 0157's column default): nothing here decides
// money, review does.
export async function insertProFeedback(input: {
  contractorId: string;
  userId: string;
  score: number;
  message: string;
  contactOk: boolean;
}): Promise<"ok" | "already" | "failed"> {
  try {
    const admin = createAdminClient();
    const { error } = await (admin as any).from("pro_feedback").insert({
      contractor_id: input.contractorId,
      user_id: input.userId,
      score: input.score,
      message: input.message,
      contact_ok: input.contactOk,
    });
    if (!error) return "ok";
    // 23505 is the unique violation on contractor_id, which migration 0152
    // drops. Until that paste is live, a second report from the same business
    // is refused here rather than lost silently.
    if ((error as { code?: string }).code === "23505") return "already";
    console.error("pro_feedback insert failed:", error);
    return "failed";
  } catch (err) {
    console.error("pro_feedback insert threw:", err);
    return "failed";
  }
}
