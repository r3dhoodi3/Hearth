import { redirect } from "next/navigation";
import { getCurrentContractor } from "@/lib/contractor";
import { FEEDBACK_CARD_TITLE, FEEDBACK_WHAT_COUNTS } from "@/lib/proFeedback";
import FeedbackForm from "./FeedbackForm";

// "Report a bug."
//
// The pro side's dedicated bug-report page. Every report is stored pending
// review (C7, 2026-09-07): a person reads it, and a report confirmed real can
// earn up to $15 in bonus lead credit, granted by hand after review - never
// automatically. Read src/lib/proFeedback.ts before touching any copy here:
// this is NOT a rating and NOT an app-store review, nothing on this page may
// use the word "rating" next to the credit, and the credit may never be tied
// to a store review. Paying for those is forbidden by App Store Review
// Guidelines 1.1.7 / 3.2.2 and Google Play policy, and the FTC treats an
// undisclosed incentivised review as deceptive.
export default async function ProFeedbackPage() {
  const contractor = await getCurrentContractor();
  if (!contractor) redirect("/pro/onboarding");

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-stone-900 dark:text-stone-100">
          {FEEDBACK_CARD_TITLE}
        </h1>
        <p className="mt-2 text-sm text-stone-600 dark:text-stone-400">
          {FEEDBACK_WHAT_COUNTS} Credit is bonus credit: it pays lead fees, it
          is not cash and it does not pay for a membership.
        </p>
      </div>

      {/* Since migration 0152 a business can send as many reports as it
          likes. FeedbackForm's own FEEDBACK_PENDING_NOTE says what happens
          next before the first keystroke. */}
      <FeedbackForm />
    </div>
  );
}
