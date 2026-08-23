import type { AiLimitReason } from "@/lib/aiUsage";

// ONE translation from "why the counter said no" into "what the person is
// told", shared by all eleven AI tool routes.
//
// countAiUsage has always reported four distinct reasons (see AiLimitReason in
// src/lib/aiUsage.ts), but most of the tool routes collapsed them back into a
// single `reason: "rate_limited"` on the way out, and a handful hand-rolled a
// second branch for "counter_unavailable" with their own wording. Two things
// went wrong with that:
//
//  - A BURST refusal read as "you are out for the day". It is not: the person
//    is a few seconds early, their allowance is untouched, and the honest
//    answer is "give it a minute", not a trip to the billing page.
//  - An owner-wide ceiling read the same way. That one is Hearth's ceiling,
//    not theirs, and telling someone who has used nothing today that they hit
//    a limit is simply false.
//
// So the mapping lives here, once, and each route spreads the result into its
// own response shape rather than re-deciding the wording.
//
// The three client-facing values, and why they are only three: a client can
// meaningfully do three different things, and no more. "rate_limited" is the
// one case where the person's own allowance is genuinely spent (offer more
// room). "busy" means come back shortly, with nothing to buy and nothing to
// fix. "unavailable" means Hearth could not tell, which is a bug on our side.
export type AiClientReason = "rate_limited" | "busy" | "unavailable";

export type AiReasonPayload = {
  reason: AiClientReason;
  error: string;
};

// The daily cap. The only refusal where the person actually spent something,
// and the only one where more allowance is the real answer.
const DAILY_COPY = "You've hit today's AI limit. It resets at midnight.";

// A burst refusal. The window is minutes wide (AI_TOOL_BURST_WINDOW_SECONDS is
// five), so say minutes, and say it in one short line: this is the refusal a
// person is most likely to see by accident, from a double tap or an impatient
// retry, and it clears itself.
const BURST_COPY = "Give it a minute and try again.";

// An owner-wide breaker or hourly ceiling. Hearth's own ceiling, so it is
// worded as Hearth being busy, with no upsell attached.
const BUSY_COPY = "Hearth's AI is busy right now. Try again in a few minutes.";

// The counter itself failed and we denied to be safe. Not a limit, a bug, and
// the person has nothing to fix on their end.
const UNAVAILABLE_COPY =
  "Hearth couldn't check your usage just now. Please try again in a few minutes.";

/**
 * Turn a counter refusal into the two fields every tool route sends back.
 *
 * Callers keep their own response field names (`analysis: null`, `packet:
 * null`, and so on) and spread this in for `reason` and `error`:
 *
 *   return NextResponse.json({ packet: null, ...reasonToClientPayload(reason) });
 *
 * A null reason should not happen (countAiUsage only returns one alongside
 * overLimit), so it is treated as the counter being unreadable rather than
 * silently claiming the person hit a limit.
 */
export function reasonToClientPayload(
  reason: AiLimitReason | null
): AiReasonPayload {
  switch (reason) {
    case "user_daily":
      return { reason: "rate_limited", error: DAILY_COPY };
    case "user_burst":
      return { reason: "busy", error: BURST_COPY };
    case "global":
      return { reason: "busy", error: BUSY_COPY };
    case "counter_unavailable":
    default:
      return { reason: "unavailable", error: UNAVAILABLE_COPY };
  }
}
