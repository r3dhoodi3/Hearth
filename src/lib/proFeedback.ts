// "Report a bug" - the pro side's bug-report page. This file is the PURE
// half: limits, copy, and validation, with no imports, so the page, the
// action and a test can all read the same strings.
//
// THE DEAL, in one place so every surface says it the same way (C7,
// 2026-09-07). Every report a business sends is stored as status='pending'
// and pays NOTHING automatically. A person reads every report; a report they
// confirm is a real bug can earn up to $15 in bonus lead credit, granted by
// hand through verify_pro_feedback() (migration 0157) after review. No copy
// here may promise instant money for any report, first or later.
//
// This used to auto-credit $5 the moment the FIRST report was sent (see git
// history / migration 0144's grant_feedback_credit). That function still
// exists in the database, unused: nothing in the app calls it any more.
//
// WHAT THIS IS NOT, and must never become. It is NOT tied to an App Store or
// Play rating, a public review, or anything in app_feedback's rating kinds
// (rate_clicked / rated / loved). Paying for a store rating is forbidden by
// App Store Review Guidelines 1.1.7 / 3.2.2 and Google Play policy, and the
// FTC treats an undisclosed incentivised review as deceptive - see the long
// note in src/lib/reviewPrompt.ts, which says exactly this and names this
// idea. What is paid for here is a private note to us about the product, sent
// through a form only the pro and OakTend ever see, on a table of its own
// (public.pro_feedback, migrations 0144, 0152, 0157). No copy on this feature
// may use the word "rating", and nothing here may ever read or write a
// store-review row.

// A note short enough to be a shrug is not a report. 20 characters is the
// floor the form states up front, not a surprise on submit.
export const FEEDBACK_MIN_MESSAGE = 20;
export const FEEDBACK_MAX_MESSAGE = 2000;

// The ceiling of the credit a VERIFIED report can earn. Not an amount any
// code grants automatically: paying it is a human decision made while
// reading reports, run by hand through verify_pro_feedback (0157), outside
// the app.
export const FEEDBACK_BOUNTY_CAP_LABEL = "$15";

// The card's headline, in one place: Home, /pro/help and the page itself all
// say the same thing. No dollar amount in the headline: nothing is instant
// any more, so the amount only ever appears in the reviewed-and-verified copy
// below.
export const FEEDBACK_CARD_TITLE = "Report a bug";

// What counts, stated before anyone types. Plain examples, and the door stays
// open to non-bugs so nobody self-censors a good idea.
export const FEEDBACK_WHAT_COUNTS =
  "A bug is anything that does not do what it says: a button that does nothing, a number that is wrong, a page that will not load, a message that never arrives. Ideas and complaints are welcome here too.";

// THE ONE SENTENCE for this feature (C7's exact wording), shown both before a
// pro submits (sets the expectation) and after (confirms it). Every report is
// reviewed by a person; nothing pays until they mark it verified.
export const FEEDBACK_PENDING_NOTE =
  "Thanks. We review every report; verified bugs earn up to $15 in credit.";

// Which outcome a submission produced. There is only one now: the report was
// stored and is waiting on review. Kept as a type (rather than a bare
// boolean) so a future outcome - "duplicate", say - has somewhere to go
// without reshaping every caller.
export type FeedbackOutcome = "pending";

export type FeedbackFormError =
  | "score"
  | "message_short"
  | "message_long"
  | "already"
  | "rate_limited"
  | "failed";

// One sentence per refusal, shared by the action and the form so the screen
// never shows a message the server would not have sent.
export const FEEDBACK_ERROR_COPY: Record<FeedbackFormError, string> = {
  score: "Please pick a score from 1 to 5 first.",
  message_short: `Please tell us a little more. Your message needs at least ${FEEDBACK_MIN_MESSAGE} characters.`,
  message_long: "That message is longer than we can store. Please shorten it a little.",
  already: "You have already sent us your feedback. Thank you.",
  rate_limited:
    "You have sent a few reports in a row. Please wait a bit before sending another.",
  failed: "We could not save your report. Please try again in a moment.",
};

// Validate what the form posted. Pure, so both the client-side hint and the
// server can run the identical rule.
export function validateFeedback(input: {
  score: number;
  message: string;
}): FeedbackFormError | null {
  if (!Number.isInteger(input.score) || input.score < 1 || input.score > 5) {
    return "score";
  }
  const trimmed = input.message.trim();
  if (trimmed.length < FEEDBACK_MIN_MESSAGE) return "message_short";
  if (trimmed.length > FEEDBACK_MAX_MESSAGE) return "message_long";
  return null;
}

// The five answers to "How is OakTend working for you?". Numbers with words, so
// nobody has to guess whether 1 is good or bad.
export const FEEDBACK_SCORE_LABELS: Array<{ value: number; label: string }> = [
  { value: 1, label: "Poorly" },
  { value: 2, label: "Not great" },
  { value: 3, label: "It's okay" },
  { value: 4, label: "Good" },
  { value: 5, label: "Great" },
];
