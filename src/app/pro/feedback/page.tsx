import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentContractor, isEstablishedPro } from "@/lib/contractor";
import { readFeedbackState } from "@/lib/proFeedbackServer";
import {
  FEEDBACK_CARD_TITLE,
  feedbackCreditDollars,
} from "@/lib/proFeedback";
import FeedbackForm from "./FeedbackForm";

// "Tell us what you think, get $5 in lead credit."
//
// A private product-feedback form for pros, and the one-time bonus lead credit
// that thanks them for filling it in. Read src/lib/proFeedback.ts before
// touching any copy here: this is NOT a rating and NOT an app-store review,
// nothing on this page may use the word "rating" next to the credit, and the
// credit may never be tied to a store review. Paying for those is forbidden by
// App Store Review Guidelines 1.1.7 / 3.2.2 and Google Play policy, and the
// FTC treats an undisclosed incentivised review as deceptive.
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
          {FEEDBACK_CARD_TITLE}
        </h1>
        <p className="mt-2 text-sm text-stone-600 dark:text-stone-400">
          Two questions, about a minute. A real person reads every one. The{" "}
          {feedbackCreditDollars()} is bonus credit: it pays lead fees, it is
          not cash and it does not pay for a membership.
        </p>
      </div>

      {state.sent ? (
        // One note per business, ever, which is also what makes the credit
        // once-only. Say so plainly rather than letting them retype it and
        // meet a refusal at the end.
        <div className="card space-y-3">
          <p className="text-sm text-stone-700 dark:text-stone-300">
            You have already sent us feedback. Thank you.
            {state.claimed
              ? ` Your ${feedbackCreditDollars()} of lead credit is in your wallet.`
              : ` Your ${feedbackCreditDollars()} unlocks once your license is confirmed or you place your first lead.`}
          </p>
          <div className="flex flex-wrap gap-2">
            <Link href="/pro" className="btn-secondary">
              Back to Home
            </Link>
            {/* Still somewhere to go with more to say: the support form takes
                a message with no once-ever limit on it. */}
            <Link href="/pro/help" className="btn-secondary">
              Contact support
            </Link>
          </div>
        </div>
      ) : (
        <FeedbackForm established={established} />
      )}
    </div>
  );
}
