import { redirect } from "next/navigation";
import { getCurrentContractor, isEstablishedPro } from "@/lib/contractor";
import { readFeedbackState } from "@/lib/proFeedbackServer";
import {
  FEEDBACK_CARD_TITLE,
  FEEDBACK_WHAT_COUNTS,
  feedbackCreditDollars,
} from "@/lib/proFeedback";
import FeedbackForm from "./FeedbackForm";

// "Report a bug, get $5 in lead credit."
//
// The pro side's dedicated bug-report page. The first report a business ever
// sends earns the one-time $5 bonus lead credit immediately (once
// established); every later report is stored, read by a person, and pays
// nothing automatically. Read src/lib/proFeedback.ts before touching any copy
// here: this is NOT a rating and NOT an app-store review, nothing on this
// page may use the word "rating" next to the credit, and the credit may never
// be tied to a store review. Paying for those is forbidden by App Store
// Review Guidelines 1.1.7 / 3.2.2 and Google Play policy, and the FTC treats
// an undisclosed incentivised review as deceptive.
export default async function ProFeedbackPage() {
  const contractor = await getCurrentContractor();
  if (!contractor) redirect("/pro/onboarding");

  const [state, established] = await Promise.all([
    readFeedbackState(contractor.id, contractor.user_id ?? ""),
    isEstablishedPro(contractor.id),
  ]);

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-stone-900 dark:text-stone-100">
          {/* Once the $5 is collected, the headline stops selling it. The
              deal note inside the form says what later reports are worth. */}
          {state.claimed ? "Report a bug" : FEEDBACK_CARD_TITLE}
        </h1>
        <p className="mt-2 text-sm text-stone-600 dark:text-stone-400">
          {FEEDBACK_WHAT_COUNTS}
          {!state.claimed && (
            <>
              {" "}
              The {feedbackCreditDollars()} is bonus credit: it pays lead fees,
              it is not cash and it does not pay for a membership.
            </>
          )}
        </p>
      </div>

      {/* Always the form: since migration 0152 a business can send as many
          reports as it likes. Only the money is once-ever, and the form's
          deal note says so before the first keystroke. */}
      <FeedbackForm established={established} claimed={state.claimed} />
    </div>
  );
}
