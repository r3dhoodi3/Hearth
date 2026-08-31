// "Report a bug, get $5 in lead credit" - the pro side's bug-report page and
// the one-time bonus credit that thanks a pro for the first report. This file
// is the PURE half: limits, copy, and validation, with no imports, so the
// page, the action and a test can all read the same strings.
//
// THE DEAL, in one place so every surface says it the same way. The FIRST
// report a business ever sends earns the $5 the moment it is sent (once the
// business qualifies, see FEEDBACK_LOCKED_NOTE). Every LATER report is stored
// and read by a real person, and pays nothing automatically: a report that
// uncovers something real can earn up to $15 at our discretion, which is the
// long-standing "Found a bug?" offer, and is a human decision, never a code
// path. No copy here may promise money for a later report.
//
// WHAT THIS IS NOT, and must never become. It is NOT tied to an App Store or
// Play rating, a public review, or anything in app_feedback's rating kinds
// (rate_clicked / rated / loved). Paying for a store rating is forbidden by
// App Store Review Guidelines 1.1.7 / 3.2.2 and Google Play policy, and the
// FTC treats an undisclosed incentivised review as deceptive - see the long
// note in src/lib/reviewPrompt.ts, which says exactly this and names this
// idea. What is paid for here is a private note to us about the product, sent
// through a form only the pro and Hearth ever see, on a table of its own
// (public.pro_feedback, migrations 0144 and 0152). No copy on this feature may
// use the word "rating", and nothing here may ever read or write a
// store-review row.

// The automatic credit, in cents. BONUS credit: the non-cash, lead-fee-only
// kind the wallet already has, granted as a bonus_grants tranche exactly like
// the membership and referral credits. It can never pay for the Pro
// membership: the Pro checkout is Stripe-only and never reads the wallet, and
// it stays that way.
export const FEEDBACK_CREDIT_CENTS = 500;

// One claim per contractor account, ever. The uniqueness lives in
// promo_claims' primary key (user_id, promo_key), which is what makes the
// grant idempotent under two taps at once. Since migration 0152 a business can
// send as many reports as it likes; this key is the only thing the money
// listens to.
export const FEEDBACK_PROMO_KEY = "pro_feedback_credit";

// A note short enough to be a shrug is not a report. 20 characters is the
// floor the form states up front, not a surprise on submit.
export const FEEDBACK_MIN_MESSAGE = 20;
export const FEEDBACK_MAX_MESSAGE = 2000;

export const FEEDBACK_CREDIT_LABEL = "Feedback thank-you credit";

export function feedbackCreditDollars(): string {
  return `$${(FEEDBACK_CREDIT_CENTS / 100).toFixed(0)}`;
}

// The ceiling of the DISCRETIONARY thank-you for a later report that uncovers
// something real. This is the same "up to $15" the /pro/help bug card has
// offered all along. It is a label, not an amount any code grants: paying it
// is a human decision made while reading reports, outside the app.
export const FEEDBACK_BOUNTY_CAP_LABEL = "$15";

// The card's headline, in one place: Home, /pro/help and the page itself all
// say the same thing.
export const FEEDBACK_CARD_TITLE = `Report a bug, get ${feedbackCreditDollars()} in lead credit`;

// What counts, stated before anyone types. Plain examples, and the door stays
// open to non-bugs so nobody self-censors a good idea.
export const FEEDBACK_WHAT_COUNTS =
  "A bug is anything that does not do what it says: a button that does nothing, a number that is wrong, a page that will not load, a message that never arrives. Ideas and complaints are welcome here too.";

// The deal, stated up front to a business that has not earned the credit yet.
// Honest about later reports: read by a person, no automatic pay, possible
// discretionary thank-you. Never a promise.
export const FEEDBACK_DEAL_NOTE = `Your first report earns the ${feedbackCreditDollars()} the moment you send it. Later reports do not pay on their own: a person reads every one, and a report that uncovers something real can earn up to ${FEEDBACK_BOUNTY_CAP_LABEL} in credit at our discretion.`;

// The same deal, restated for a business that already collected the $5, shown
// above the form so nobody sends a second report expecting a second credit.
export const FEEDBACK_REPEAT_NOTE = `You have already earned the ${feedbackCreditDollars()}. You can keep sending reports: we read every one, and a report that uncovers something real can earn up to ${FEEDBACK_BOUNTY_CAP_LABEL} in credit at our discretion.`;

// What a pro who has not yet qualified is told. Plain and true: the credit is
// real, it just needs a verified business or a first lead behind it, because
// otherwise a fresh throwaway account is a $5 vending machine. Their words
// still get through either way.
export const FEEDBACK_LOCKED_NOTE =
  "You can send your report now, and we read every message. The $5 credit is added to your wallet once your license is confirmed or you place your first lead.";

// The success line when THIS submission earned the credit.
export const FEEDBACK_CREDITED_NOTE = `${feedbackCreditDollars()} in lead credit has been added to your wallet. It is credit rather than cash, so it goes toward your lead fees.`;

// The success line for every later report: warm, and quiet about money.
export const FEEDBACK_THANKS_NOTE =
  "Thank you. A real person reads every report.";

// Which of the three success screens a submission earned. "credited" means
// this call moved the $5; "locked" means the first note is stored and the
// credit is waiting on qualification (the Home tab grants it later); "thanks"
// means the note is stored and no money moved, by design.
export type FeedbackOutcome = "credited" | "locked" | "thanks";

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

// The five answers to "How is Hearth working for you?". Numbers with words, so
// nobody has to guess whether 1 is good or bad.
export const FEEDBACK_SCORE_LABELS: Array<{ value: number; label: string }> = [
  { value: 1, label: "Badly" },
  { value: 2, label: "Not great" },
  { value: 3, label: "It's okay" },
  { value: 4, label: "Good" },
  { value: 5, label: "Great" },
];
