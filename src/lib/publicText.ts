// Moderation gate for the free-text fields that get rendered verbatim on a
// PUBLIC page: contractors.name (the business name, on /p/<slug>, the browse
// cards, every share card, the job board), contractors.about (the Pro-member
// blurb on /p/<slug>), and reviews.comment (a homeowner's review text, shown
// on ContractorReviews.tsx, the pro's public page, and the review share
// card). All three are unreviewed free text with no editor in between the
// writer and the public page, so all three run through the same gate.
//
// Neither had a content check. The custom-service box got one
// (isAcceptableCustomCategory, src/lib/customCategory.ts) precisely because it
// is unreviewed free text on a public page - and the business name is the
// larger surface of the two: it is what every homeowner reads first, it is the
// text in the OpenGraph card that gets shared, and it is the one field a pro
// can rewrite at any time from their own profile form.
//
// The two abuses that matter here:
//
//   1. Slurs and profanity next to a business name, with no review step in
//      between. censor() (src/lib/censor.ts) already owns that list; its
//      `flagged` bit is the answer.
//   2. Off-platform contact routes. A name of "Joe's Plumbing 714-555-0100"
//      or "Joe's - joe@example.com" turns the public directory into a bypass
//      around the lead record, the chat transcript and the review request.
//
// Both run against fold() (NFKC, invisibles stripped, Cyrillic/Greek
// homoglyphs mapped to Latin), so the zero-width and look-alike spellings are
// gated the same as the plain ones.
//
// This is a REJECT gate, not a rewrite: the caller refuses the save and says
// why, the same shape as CUSTOM_CATEGORY_REJECTED. Masking a business name or
// quietly storing "[hidden until you reply]" inside one would be worse than
// refusing it, because the pro would never learn what happened.
//
// ---------------------------------------------------------------------------
// WHY THIS FILE IS MORE FORGIVING THAN THE CUSTOM-SERVICE BOX
// ---------------------------------------------------------------------------
// A rejected custom service costs a pro one optional field. A rejected
// BUSINESS NAME costs them the entire save - the name is required, so there is
// nothing to fall back to - and, worse, it is a name they may have been
// trading under for thirty years. There is no appeal path built. So a false
// positive here is expensive in a way it is not there, and both rules below
// are deliberately loosened against the two false-positive families that
// actually occur:
//
//   - SURNAMES that collide with the block lists. "Dick's Plumbing", "Van
//     Dyke Drainage", "Spicer Roofing", "Coons Heating" are all real, ordinary
//     businesses, and every one of them tripped this gate on its first draft.
//     They are handled the way customCategory.ts already handles "chinking"
//     and "retarder": by taking the colliding word OUT of the copy the block
//     list reads, never by weakening the block list.
//
//   - DIGITS THAT ARE NOT A PHONE NUMBER. The first draft used
//     redactContact() (src/lib/redact.ts), whose rule is "any run carrying
//     seven or more digits". That rule is correct for its own job - masking a
//     stranger's application message, where a false positive costs nothing -
//     and completely wrong here: a CSLB licence number, a founded-in year
//     range, and a review count are all seven-plus digits, so "CSLB #1023456",
//     "Family owned 2005-2025" and "Serving OC since 1998. 250 five-star
//     reviews." were all refused. This file uses customCategory's PHONE_RE
//     instead, which matches the actual ten-digit North American SHAPE and
//     nothing else.

import { censor } from "@/lib/censor";
import {
  ALLOWED_WORDS,
  allowedWordsPattern,
  fold,
  hasBidiControl,
  EMAIL_RE,
  PHONE_RE,
} from "@/lib/customCategory";

// Words that are a slur or a profanity to the block lists and a person's name
// on a van. Each one is a real, checkable business name, not a hypothetical:
//
//   dick / dicks   Dick's Plumbing, Dick Smith Heating. "Dick" is one of the
//                  most common mid-century given names in the country.
//   spicer         Spicer Roofing. censor's suffix expansion turns the slur
//                  "spic" into "spicer" all by itself, which is how an
//                  ordinary surname became unusable.
//   coons          Coons Heating. A surname (and a place name: Coons Rapids).
//   hoe / hoes     A garden hoe. On a home-services platform this is a tool,
//                  and a landscaper is entitled to name it.
//   dyke           already in ALLOWED_WORDS for the drainage sense; Van Dyke
//                  is also a surname, and both reach this list through it.
//
// DELIBERATELY NOT HERE: the bare singular "coon". "Coons" is a surname people
// actually carry; "Coon" standing alone in a company name is far likelier to
// be the slur than the surname, and that is the line this list draws. Same
// reasoning as customCategory.ts's note on "crap": the fix for a wrong
// rejection is a named word added here, not a hole in the block list.
const NAME_COLLISIONS = [
  "dick",
  "dicks",
  "spicer",
  "spicers",
  "coons",
  "hoe",
  "hoes",
];

// The full allowlist for public text: everything the custom-service box
// already forgives, plus the surname collisions above. Built through
// customCategory's own builder so the word-boundary rule cannot drift between
// the two files.
const PUBLIC_TEXT_ALLOWED_RE = allowedWordsPattern([
  ...ALLOWED_WORDS,
  ...NAME_COLLISIONS,
]);

// True when this string is safe to store and show on a public page.
// An empty string is acceptable here (the callers decide whether the field is
// required); only content is judged.
export function isAcceptablePublicText(s: unknown): boolean {
  if (typeof s !== "string") return false;
  // A bidi override/isolate changes how everything AFTER it renders on the
  // public page, not just itself, so this is checked on the raw string,
  // before folding could hide it - same reasoning and same helper as
  // isAcceptableCustomCategory in customCategory.ts.
  if (hasBidiControl(s)) return false;
  const folded = fold(s);
  if (!folded.trim()) return true;

  // The allowlist is subtracted BEFORE censor() reads the string, exactly as
  // isAcceptableCustomCategory does it: an allowlisted word is a known
  // false-positive collision, so it is removed from the copy the block list
  // sees. It is never a reason to skip the contact checks below, which run on
  // the full string.
  if (censor(folded.replace(PUBLIC_TEXT_ALLOWED_RE, " ")).flagged) return false;

  // A phone number or an email address anywhere in the value. PHONE_RE matches
  // a ten-digit North American shape, so a licence number, a ZIP pair, a year
  // range and a review count all survive.
  if (PHONE_RE.test(folded)) return false;
  if (EMAIL_RE.test(folded)) return false;

  return true;
}

// The messages shown when one of these is refused. Exported so the actions and
// their tests quote the same string, same pattern as CUSTOM_CATEGORY_REJECTED.
export const COMPANY_NAME_REJECTED =
  "We couldn't use that business name. Take out any phone number, email address, or language that wouldn't work on a public page.";

export const ABOUT_REJECTED =
  "We couldn't use that about section. Take out any phone number, email address, or language that wouldn't work on a public page.";

export const REVIEW_COMMENT_REJECTED =
  "Reviews can't include phone numbers, email addresses, or offensive language. Please edit and try again.";
