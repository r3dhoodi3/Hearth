"use server";

import { revalidatePath } from "next/cache";
import { getCurrentContractor, isEstablishedPro } from "@/lib/contractor";
import { ok, err, type ActionResult } from "@/lib/actionResult";
import { PRO_LEADS_HREF } from "@/lib/constants";
import {
  FEEDBACK_ERROR_COPY,
  FEEDBACK_MAX_MESSAGE,
  validateFeedback,
  type FeedbackOutcome,
} from "@/lib/proFeedback";
import {
  insertProFeedback,
  grantFeedbackCredit,
  proFeedbackRateLimitOk,
  readFeedbackState,
} from "@/lib/proFeedbackServer";

// "Report a bug, get $5 in lead credit", the pro side only.
//
// See src/lib/proFeedback.ts for what this is and, more importantly, what it
// is not: this is a private bug-report and product-feedback form, never an
// app-store rating, and no copy or code path here may ever connect the credit
// to one.
//
// THE MONEY RULE. The first report a business ever sends earns the $5
// immediately (once established, below). Every later report is stored and
// pays NOTHING automatically: the once-ever gate is promo_claims' primary key
// inside grant_feedback_credit (migration 0144), so two tabs submitting at
// the same moment still move the money exactly once, and the loser is told
// "thanks" rather than "credited". A discretionary thank-you for a later
// report that uncovers something real is a human decision made while reading
// pro_feedback rows, never a code path here.
//
// Returns ActionResult rather than redirecting so the form can keep the pro's
// typed note on screen when something is wrong with it. `outcome` picks the
// success screen: "credited" (this submission moved the $5), "locked" (first
// note stored, credit waiting on qualification), or "thanks" (stored, no
// money, by design).
export async function submitProFeedbackAction(input: {
  score: number;
  message: string;
  contactOk: boolean;
}): Promise<ActionResult<{ outcome: FeedbackOutcome }>> {
  const contractor = await getCurrentContractor();
  // Pro side only, and a company row is what makes someone a pro. No company,
  // no wallet to credit and nothing this form is asking about.
  if (!contractor) return err("Only a business account can send this.");

  const message = String(input.message ?? "").slice(0, FEEDBACK_MAX_MESSAGE + 1);
  const score = Number(input.score);
  const problem = validateFeedback({ score, message });
  if (problem) return err(FEEDBACK_ERROR_COPY[problem]);

  // The spam cap, charged after validation so a refused submit never burns a
  // slot. Fails open on a limiter error (see proFeedbackRateLimitOk): this is
  // a spam-class bucket, not a brute-force one.
  const allowed = await proFeedbackRateLimitOk(contractor.user_id ?? "");
  if (!allowed) return err(FEEDBACK_ERROR_COPY.rate_limited);

  const stored = await insertProFeedback({
    contractorId: contractor.id,
    userId: contractor.user_id ?? "",
    score,
    message: message.trim(),
    contactOk: Boolean(input.contactOk),
  });
  // "already" only exists until migration 0152 is pasted live (it drops the
  // one-row-per-business unique index). The note was NOT stored, so stop here.
  if (stored === "already") return err(FEEDBACK_ERROR_COPY.already);
  if (stored === "failed") return err(FEEDBACK_ERROR_COPY.failed);

  // Which screen did this submission earn? The claimed read is advisory (it
  // picks copy); the grant itself is the authority on money. Under a race,
  // both tabs can read claimed=false and both call the grant, and the SQL
  // function pays exactly one of them.
  const [state, established] = await Promise.all([
    readFeedbackState(contractor.id, contractor.user_id ?? ""),
    // THE QUALIFYING GATE. Only an established business earns the credit: a
    // verified license, a paid lead, a settled deposit, or a live Pro
    // membership (isEstablishedPro, which fails closed). Without it, a
    // throwaway signup plus twenty characters of text is a $5 vending
    // machine. Their words still reach us either way; the row above is
    // already stored, and the Home tab retries the grant once they qualify
    // (see src/app/pro/page.tsx). The SQL function is idempotent, so that
    // retry can never double pay.
    isEstablishedPro(contractor.id),
  ]);

  let outcome: FeedbackOutcome;
  if (state.claimed) {
    outcome = "thanks";
  } else if (established) {
    outcome = (await grantFeedbackCredit(contractor.id))
      ? "credited"
      : // The grant refused: someone else's tab won the race, or the wallet
        // write hiccuped (in which case the Home tab's retry still owes them
        // the money). Either way, promising nothing here is the honest copy.
        "thanks";
  } else {
    outcome = "locked";
  }

  // Both pro tabs read the wallet balance, and Home also reads the card's
  // state, so both have to be dropped or the pro is told the money landed on
  // one screen and not the other.
  revalidatePath("/pro");
  revalidatePath(PRO_LEADS_HREF);
  revalidatePath("/pro/billing");
  revalidatePath("/pro/help");

  return ok({ outcome });
}
