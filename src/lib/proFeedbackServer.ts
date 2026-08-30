import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { isMissingSchemaError } from "@/lib/dbErrors";
import { FEEDBACK_CREDIT_CENTS, FEEDBACK_PROMO_KEY } from "@/lib/proFeedback";
import { trackServerEvent } from "@/lib/trackServer";

// The database half of the pro feedback credit (see src/lib/proFeedback.ts for
// what it is, and for the rule that it is never tied to a store rating).
//
// Service-role only, so none of it ships to the browser. Everything here fails
// SOFT: the feedback itself is the point, and a pro's note must never be lost
// because a wallet write hiccuped. A missed grant is recoverable - the Home tab
// retries it on the next render (see hasFeedback / hasClaimedFeedbackCredit
// below and their use in src/app/pro/page.tsx).

export type FeedbackState = {
  // Has this contractor already sent us feedback?
  sent: boolean;
  // Has the $5 already landed in their wallet?
  claimed: boolean;
};

// Both facts in two tiny indexed reads. Returns { sent: false, claimed: false }
// when either read fails or migration 0144 is not live yet, which renders as
// "the card is still on offer" - the safe direction, since the grant itself is
// idempotent and would simply refuse a second time.
export async function readFeedbackState(
  contractorId: string,
  userId: string
): Promise<FeedbackState> {
  try {
    const admin = createAdminClient();
    const [feedback, claim] = await Promise.all([
      (admin as any)
        .from("pro_feedback")
        .select("contractor_id")
        .eq("contractor_id", contractorId)
        .maybeSingle(),
      (admin as any)
        .from("promo_claims")
        .select("promo_key")
        .eq("user_id", userId)
        .eq("promo_key", FEEDBACK_PROMO_KEY)
        .maybeSingle(),
    ]);
    return {
      sent: Boolean(feedback?.data),
      claimed: Boolean(claim?.data),
    };
  } catch {
    return { sent: false, claimed: false };
  }
}

// Store one pro's feedback. Returns "ok", "already" (the unique index on
// contractor_id refused a second row), or "failed".
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
    // 23505 is the unique violation on contractor_id: one note per business,
    // which is also what makes the credit once-ever.
    if ((error as { code?: string }).code === "23505") return "already";
    console.error("pro_feedback insert failed:", error);
    return "failed";
  } catch (err) {
    console.error("pro_feedback insert threw:", err);
    return "failed";
  }
}

// Grant the one-time $5 of bonus lead credit, atomically and idempotently.
//
// All of the safety lives in the SQL function (migration 0144): it inserts the
// promo_claims row and credits the wallet in ONE transaction, and only on the
// insert actually landing, so a second call - a double tap, two tabs, a retry
// from the Home tab below - returns false and moves no money. This wrapper
// only decides what to do with that answer.
//
// Returns true when THIS call is the one that credited the wallet.
export async function grantFeedbackCredit(
  contractorId: string
): Promise<boolean> {
  try {
    const admin = createAdminClient();
    const { data, error } = await (admin as any).rpc("grant_feedback_credit", {
      p_contractor: contractorId,
      p_amount_cents: FEEDBACK_CREDIT_CENTS,
    });
    if (error) throw error;
    const granted = data === true;
    if (granted) {
      // Funnel analytics (docs/ANALYTICS.md), only on the call that actually
      // moved money, never on a retry that found the claim already spent.
      // Both call sites (the feedback form, the Home tab's qualify-later
      // retry) only carry contractorId, so the account id is looked up here
      // rather than threading userId through both of them just for this.
      // Best-effort: a lookup or track hiccup must never cost the pro the
      // credit that already landed above.
      try {
        const { data: row } = await (admin as any)
          .from("contractors")
          .select("user_id")
          .eq("id", contractorId)
          .maybeSingle();
        if (row?.user_id) {
          await trackServerEvent(row.user_id, "feedback_credit_claimed");
        }
      } catch {
        /* analytics only; the grant above already succeeded */
      }
    }
    return granted;
  } catch (err) {
    // Migration 0144 not live yet reads as "no credit granted", which is the
    // truth: nothing moved. The pro's feedback is already stored either way,
    // and the Home tab retries the grant on the next render once the SQL is
    // pasted. Logged, not thrown, so a wallet problem never eats the note.
    if (isMissingSchemaError(err as { code?: string; message?: string })) {
      console.warn(
        "grant_feedback_credit is missing: paste supabase/PASTE-ME-live-2026-08-29-feedback-credit.sql (migration 0144). Feedback is still being stored."
      );
      return false;
    }
    console.error("grant_feedback_credit failed:", err);
    return false;
  }
}
