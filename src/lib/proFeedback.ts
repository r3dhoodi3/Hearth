// "Tell us what you think, get $5 in lead credit" - the pro side's product
// feedback form and the one-time bonus credit that thanks a pro for filling it
// in. This file is the PURE half: limits, copy, and validation, with no
// imports, so the page, the action and a test can all read the same strings.
//
// WHAT THIS IS NOT, and must never become. It is NOT tied to an App Store or
// Play rating, a public review, or anything in app_feedback's rating kinds
// (rate_clicked / rated / loved). Paying for a store rating is forbidden by
// App Store Review Guidelines 1.1.7 / 3.2.2 and Google Play policy, and the
// FTC treats an undisclosed incentivised review as deceptive - see the long
// note in src/lib/reviewPrompt.ts, which says exactly this and names this
// idea. What is paid for here is a private note to us about the product, sent
// through a form only the pro and Hearth ever see, on a table of its own
// (public.pro_feedback, migration 0144). No copy on this feature may use the
// word "rating", and nothing here may ever read or write a store-review row.

// The credit, in cents. BONUS credit: the non-cash, lead-fee-only kind the
// wallet already has, granted as a bonus_grants tranche exactly like the
// membership and referral credits. It can never pay for the Pro membership -
// the Pro checkout is Stripe-only and never reads the wallet, and it stays
// that way.
export const FEEDBACK_CREDIT_CENTS = 500;

// One claim per contractor account, ever. The uniqueness lives in
// promo_claims' primary key (user_id, promo_key), which is what makes the
// grant idempotent under two taps at once.
export const FEEDBACK_PROMO_KEY = "pro_feedback_credit";

// A note short enough to be a shrug is not feedback. 20 characters is the
// floor the form states up front, not a surprise on submit.
export const FEEDBACK_MIN_MESSAGE = 20;
export const FEEDBACK_MAX_MESSAGE = 2000;

export const FEEDBACK_CREDIT_LABEL = "Feedback thank-you credit";

export function feedbackCreditDollars(): string {
  return `$${(FEEDBACK_CREDIT_CENTS / 100).toFixed(0)}`;
}

// The card's headline, in one place: Home, /pro/help and the form itself all
// say the same thing.
export const FEEDBACK_CARD_TITLE = `Tell us what you think, get ${feedbackCreditDollars()} in lead credit`;

// What a pro who has not yet qualified is told. Plain and true: the credit is
// real, it just needs a verified business or a first lead behind it, because
// otherwise a fresh throwaway account is a $5 vending machine. Their words
// still get through either way.
export const FEEDBACK_LOCKED_NOTE =
  "You can send your feedback now, and we read every message. The $5 credit is added to your wallet once your license is confirmed or you place your first lead.";

export type FeedbackFormError =
  | "score"
  | "message_short"
  | "message_long"
  | "already"
  | "failed";

// One sentence per refusal, shared by the action and the form so the screen
// never shows a message the server would not have sent.
export const FEEDBACK_ERROR_COPY: Record<FeedbackFormError, string> = {
  score: "Please pick a score from 1 to 5 first.",
  message_short: `Please tell us a little more. Your message needs at least ${FEEDBACK_MIN_MESSAGE} characters.`,
  message_long: "That message is longer than we can store. Please shorten it a little.",
  already: "You have already sent us your feedback. Thank you.",
  failed: "We could not save your feedback. Please try again in a moment.",
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
