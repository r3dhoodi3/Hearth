"use server";

import { revalidatePath } from "next/cache";
import { getCurrentContractor, isEstablishedPro } from "@/lib/contractor";
import { ok, err, type ActionResult } from "@/lib/actionResult";
import { PRO_LEADS_HREF } from "@/lib/constants";
import {
  FEEDBACK_ERROR_COPY,
  FEEDBACK_MAX_MESSAGE,
  validateFeedback,
} from "@/lib/proFeedback";
import {
  insertProFeedback,
  grantFeedbackCredit,
} from "@/lib/proFeedbackServer";

// "Tell us what you think, get $5 in lead credit", the pro side only.
//
// See src/lib/proFeedback.ts for what this is and, more importantly, what it
// is not: this is a private product-feedback form, never an app-store rating,
// and no copy or code path here may ever connect the credit to one.
//
// Returns ActionResult rather than redirecting so the form can keep the pro's
// typed note on screen when something is wrong with it. `granted` says whether
// THIS submission is the one that credited the wallet, which is what the
// success screen reads to decide between "thanks, $5 is in your wallet" and
// "thanks, the credit unlocks once you qualify".
export async function submitProFeedbackAction(input: {
  score: number;
  message: string;
  contactOk: boolean;
}): Promise<ActionResult<{ granted: boolean }>> {
  const contractor = await getCurrentContractor();
  // Pro side only, and a company row is what makes someone a pro. No company,
  // no wallet to credit and nothing this form is asking about.
  if (!contractor) return err("Only a business account can send this.");

  const message = String(input.message ?? "").slice(0, FEEDBACK_MAX_MESSAGE + 1);
  const score = Number(input.score);
  const problem = validateFeedback({ score, message });
  if (problem) return err(FEEDBACK_ERROR_COPY[problem]);

  const stored = await insertProFeedback({
    contractorId: contractor.id,
    userId: contractor.user_id ?? "",
    score,
    message: message.trim(),
    contactOk: Boolean(input.contactOk),
  });
  if (stored === "already") return err(FEEDBACK_ERROR_COPY.already);
  if (stored === "failed") return err(FEEDBACK_ERROR_COPY.failed);

  // THE GATE. Only an established business earns the credit: a verified
  // license, a paid lead, a settled deposit, or a live Pro membership (worker
  // C's isEstablishedPro, which fails closed). Without it, a throwaway signup
  // plus twenty characters of text is a $5 vending machine. Their words still
  // reach us either way - the row above is already stored.
  //
  // A pro who is not established yet is not shut out forever: the Home tab
  // retries this grant on its next render once they qualify (see
  // readFeedbackState / grantFeedbackCredit in src/app/pro/page.tsx). The SQL
  // function is idempotent, so the retry can never double pay.
  const established = await isEstablishedPro(contractor.id);
  const granted = established
    ? await grantFeedbackCredit(contractor.id)
    : false;

  // Both pro tabs read the wallet balance, and Home also reads the card's
  // state, so both have to be dropped or the pro is told the money landed on
  // one screen and not the other.
  revalidatePath("/pro");
  revalidatePath(PRO_LEADS_HREF);
  revalidatePath("/pro/billing");
  revalidatePath("/pro/help");

  return ok({ granted });
}
