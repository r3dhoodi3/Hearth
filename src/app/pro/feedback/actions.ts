"use server";

import { revalidatePath } from "next/cache";
import { getCurrentContractor } from "@/lib/contractor";
import { ok, err, type ActionResult } from "@/lib/actionResult";
import { PRO_LEADS_HREF } from "@/lib/constants";
import {
  FEEDBACK_ERROR_COPY,
  FEEDBACK_MAX_MESSAGE,
  validateFeedback,
  type FeedbackOutcome,
} from "@/lib/proFeedback";
import { insertProFeedback, proFeedbackRateLimitOk } from "@/lib/proFeedbackServer";

// "Report a bug", the pro side only.
//
// See src/lib/proFeedback.ts for what this is and, more importantly, what it
// is not: this is a private bug-report and product-feedback form, never an
// app-store rating, and no copy or code path here may ever connect any credit
// to one.
//
// THE MONEY RULE (C7, 2026-09-07). Every report stores as status='pending'
// (the column default from migration 0157) and pays NOTHING automatically -
// this action never touches the wallet. A person reads every report; a
// report they confirm is real can earn up to $15 in bonus lead credit,
// granted by hand through verify_pro_feedback() (0157) after review. That is
// a human decision made outside this code path, never something a submit
// here can trigger.
//
// Returns ActionResult rather than redirecting so the form can keep the pro's
// typed note on screen when something is wrong with it.
export async function submitProFeedbackAction(input: {
  score: number;
  message: string;
  contactOk: boolean;
}): Promise<ActionResult<{ outcome: FeedbackOutcome }>> {
  const contractor = await getCurrentContractor();
  // Pro side only, and a company row is what makes someone a pro.
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

  // Home and /pro/help both show whether this business has ever sent a
  // report, so both have to be dropped or one screen shows stale state.
  revalidatePath("/pro");
  revalidatePath(PRO_LEADS_HREF);
  revalidatePath("/pro/help");

  return ok({ outcome: "pending" });
}
