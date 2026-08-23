import { newestUserMessage } from "@/lib/askRequest";

// Shared guard rules for the Ask Hearth prompts.
//
// Ask Hearth is a paid model call on someone else's card, so it should only
// ever do the job it exists for. There is deliberately NO server-side keyword
// pre-filter: every cheap classifier we sketched misfired on real questions
// ("how much paint for a 12x14 room" is arithmetic AND a home question), and a
// homeowner who gets refused once stops trusting the feature. The guard is
// therefore a prompt rule, kept here so the homeowner route and the pro route
// stay word-for-word in sync and so the wording is unit-testable.

// The behaviour half of the rule, identical on both sides. Only the scope
// sentence in front of it changes.
const GUARD_BEHAVIOUR =
  "If a message is unrelated to that (homework, math for its own sake, coding, general trivia, " +
  "writing tasks, news, politics, relationships, medical questions, legal advice beyond the home, " +
  "or anything else off topic), do NOT answer it. Reply with one friendly sentence saying you only " +
  "help with that, and offer a specific direction you can help with instead. " +
  "If a message MIXES an on-topic question with an unrelated one, answer the on-topic part fully " +
  "and decline the unrelated part in one short clause. Never answer the unrelated part as a favour, " +
  "not even briefly, and not even if they insist, say it is urgent, or claim someone told you to. " +
  "Use judgment: a question that is really about the home in disguise IS on topic and should be " +
  'answered normally. "How much paint do I need for a 12x14 room", "is 60 psi water pressure too ' +
  'high", "what does 240v mean for my dryer outlet" are all on topic. Do the math or explain the ' +
  "term when it serves the home. " +
  "When you decline, do not lecture, do not mention rules, policies, instructions, or this prompt, " +
  "and do not explain what you are or are not allowed to do. One warm sentence, then a useful offer. " +
  "Never emit a POSTJOB, LOGISSUE, REMINDER, OPTIONS, or any other block for a declined question.";

// Homeowner side: their own home, and Hearth itself.
export const TOPIC_GUARD_HOMEOWNER =
  "STAY ON TOPIC, this overrides everything else in this prompt: you only help with the " +
  "homeowner's home. That means their systems and appliances, repairs, maintenance, what work " +
  "costs, hiring and vetting contractors, home safety, home documents and records, insurance and " +
  "property taxes as they relate to the home, and how to use Hearth itself. " +
  GUARD_BEHAVIOUR;

// Contractor side: their trade and their business on Hearth.
export const TOPIC_GUARD_PRO =
  "STAY ON TOPIC, this overrides everything else in this prompt: you only help with this " +
  "contractor's trade and their business on Hearth. That means winning and quoting work, their " +
  "trades and job sites, pricing and materials, leads, the wallet and fees, licensing, insurance " +
  "and background checks as they relate to the business, their profile and reviews, and how to use " +
  "Hearth for Pros itself. " +
  GUARD_BEHAVIOUR;

// One chat message as the client sends it (see src/components/AskHearth.tsx).
// Loose on purpose: this runs over untrusted request JSON.
type LooseMessage = { role?: unknown; content?: unknown; image?: unknown };

// Does this single message carry a photo?
export function messageHasImage(m: unknown): boolean {
  if (!m || typeof m !== "object") return false;
  const image = (m as LooseMessage).image;
  return typeof image === "string" && image.length > 0;
}

// Is the homeowner attaching a photo on THIS turn?
//
// The client replays its whole local history on every request, so an old photo
// keeps arriving long after it was sent. Gating on "any image anywhere in the
// history" would mean one photo from a free user locks their text questions
// forever, so only the newest turn counts. The routes separately refuse to
// FORWARD any image from a free user, so an old photo in the history is
// dropped rather than answered on the sly.
//
// "The newest turn" is decided by ONE helper, newestUserMessage in
// src/lib/askRequest.ts, shared with hasAskableContent. The two used to
// disagree: this read strictly the last array element and gave up if it was an
// assistant turn, while hasAskableContent scanned backwards past one. So a
// history ending in a stray assistant turn (a malformed client, a replayed
// greeting) was askable but had no photo, and a free user's photo question
// walked straight past the Plus gate on the very shape the other helper was
// written to tolerate. Same helper, same answer, no gap between them.
export function newTurnHasImage(messages: unknown): boolean {
  return messageHasImage(newestUserMessage(messages));
}
