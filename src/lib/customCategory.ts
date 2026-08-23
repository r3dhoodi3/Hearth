// Moderation gate for the ONE free-text service a pro can type into
// CategoryPicker's "Other" box (see saveCompanyAction in src/app/pro/actions.ts).
//
// Why this needs a gate at all: that string is the only field on a contractor
// row that is not drawn from a canonical list, and it is rendered verbatim in
// front of homeowners on the public /p/<slug> page and on the browse cards.
// The 100-character cap bounded its LENGTH, and nothing bounded its CONTENT,
// so the field doubled as a free billboard on a public page - a phone number
// or a URL routed homeowners off-platform before Hearth ever saw the job, and
// a slur sat next to a pro's name with no review step in between.
//
// This is a plain-text filter, not real moderation. It is deliberately
// conservative: it rejects a small set of unmistakable abuses and lets
// everything else through, because a false reject costs an honest pro their
// wording and there is no appeal path built. On rejection the caller drops the
// custom value and keeps the rest of the save.

import { JOB_CATEGORIES } from "@/lib/constants";

// Common English profanity, slurs, and sexual terms. Lowercase, matched on
// word boundaries with the leetspeak folding below, so "cleaning" never trips
// on a substring and "f#ck" does not walk past. Kept here rather than imported
// from src/lib/censor.ts on purpose: censor() MASKS chat text and its list is
// tuned for that, while this one has to REJECT a public label outright and
// carries terms (the sexual-services ones) that would be wrong to star out of
// a private message.
const BLOCKED_TERMS = [
  // profanity
  "fuck",
  "motherfucker",
  "shit",
  "bullshit",
  "bitch",
  "asshole",
  "bastard",
  "dick",
  "cock",
  "piss",
  "prick",
  "twat",
  "wanker",
  "douche",
  "jackass",
  "goddamn",
  // Deliberately NOT "crap": a mild word is not worth rejecting an honest
  // listing over, and crape myrtle is a real Southern California landscaping
  // job. (The stem-length floor on the suffix expansion below would now keep
  // "crapes" from matching a four-letter "crap" anyway, but the reason to
  // leave it out never depended on that.)
  "arse",
  // "fuck" is four letters, so the stem-length floor below deliberately gives
  // it no suffixes. This is the one inflected form common enough to be worth
  // listing outright - "Best fucking plumber" is what people actually type.
  "fucking",
  // slurs / hate speech
  "nigger",
  "nigga",
  "chink",
  "spic",
  "kike",
  "gook",
  "wetback",
  "beaner",
  "coon",
  "raghead",
  "towelhead",
  "fag",
  "faggot",
  "dyke",
  "tranny",
  "retard",
  "cunt",
  // sexual / adult services
  "porn",
  "pornhub",
  "blowjob",
  "handjob",
  "escort",
  "hooker",
  "whore",
  "slut",
  "milf",
  "anal",
  "boobs",
  "tits",
  "pussy",
  "penis",
  "vagina",
  "cum",
  "nude",
  "nudes",
  "xxx",
  "sex",
  "onlyfans",
  "stripper",
  "brothel",
];

// Leet / look-alike substitutions, per letter (the letter itself included).
// Same table as src/lib/censor.ts: this is the evasion people actually try.
const LEET: Record<string, string> = {
  a: "a@4",
  b: "b8",
  e: "e3",
  g: "g9",
  i: "i1!",
  l: "l1",
  o: "o0",
  s: "s5$",
  t: "t7",
  z: "z2",
};

// Up to two separator characters between letters, so "f u c k", "f-u-c-k" and
// "f.u.c.k" all collapse onto the same word.
const SEP = "[\\s._*\\-]{0,2}";

// Suffix expansion, and why it is gated on the length of the stem.
//
// A blocked term rarely arrives bare - "escorts", "pornhubbed" - so the four
// genuine English inflections are folded in. The trouble is that the same
// expansion applied to a SHORT stem is where every false positive came from:
// the four- and five-letter slurs and body words are prefixes of ordinary
// trade words, and "chink" + "ing" is chinking, the real job of sealing the
// gaps between logs on a log home. "er" and "in" made it worse still - they
// are not inflections of anything, they are word-builders, and they turned
// "cock" into cocker (a spaniel, a groomer's listing) and "retard" into
// retarder (a concrete set retarder, a real product a mason lists).
//
// So: only stems of 5+ characters get suffixes at all, and the suffix list is
// the four real inflections. A short stem still has to match verbatim, which
// is what the word boundaries below were always for.
const SUFFIX = "(?:s|es|ing|ed)?";
const MIN_SUFFIXABLE_STEM = 5;

function charClass(ch: string): string {
  const variants = LEET[ch] ?? ch;
  // Escape the characters that are special inside a regex character class.
  const escaped = variants.replace(/[\]\\^-]/g, "\\$&");
  return `[${escaped}]`;
}

function wordPattern(word: string): string {
  const body = word.split("").map(charClass).join(SEP);
  return word.length >= MIN_SUFFIXABLE_STEM ? body + SUFFIX : body;
}

// Boundaries so a blocked term never matches inside a legitimate word:
// "spicy" must not trip "spic", "scummy" must not trip "cum".
const BLOCKED_RE = new RegExp(
  `(?<![a-z0-9])(?:${BLOCKED_TERMS.map(wordPattern).join("|")})(?![a-z0-9])`,
  "i"
);

// Real words that collide with the block list, checked BEFORE it and removed
// from the string the block list sees. An honest pro loses their wording with
// no appeal path when this filter is wrong, so a known collision is worth
// naming outright rather than hoping the boundary rules cover it.
//
// Each one is a real trade word:
//   chinking    sealing the gaps between logs on a log home ("chink" + "ing")
//   retarder    a concrete set retarder ("retard" + "er")
//   dyke        a levee/drainage dyke - also a slur, and the trade meaning is
//               the one a service box is being used for
//   cocker      cocker spaniel, for a groomer's listing
//   cockroach   pest control
//   shingles    roofing
//   sheetrock   drywall
//   asphalt     paving
//   scunthorpe  the town the whole class of bug is named after
//
// Several of these already survive on the word boundaries alone; they are
// listed anyway, because the list is meant to be the place this gets fixed
// when someone reports a rejection, not a puzzle about which rule saved it.
const ALLOWED_WORDS = [
  "chinking",
  "retarder",
  "dyke",
  "cocker",
  "cockroach",
  "shingles",
  "sheetrock",
  "asphalt",
  "scunthorpe",
];

// Whole words only, same boundary rule as the block list. Global, because a
// listing may well contain more than one of them.
const ALLOWED_RE = new RegExp(
  `(?<![a-z0-9])(?:${ALLOWED_WORDS.join("|")})(?![a-z0-9])`,
  "gi"
);

// Off-platform contact routes. A pro who lists "call 714-555-0100" as their
// service is using the public directory as a bypass around every part of the
// product that protects the homeowner (the lead record, the chat transcript,
// the review request).
const URL_RE =
  /(https?:\/\/|www\.|\b[a-z0-9][a-z0-9-]*\.(?:com|net|org|io|co|us|biz|info|shop|site|xyz|app|dev|me|tv|link)\b)/i;
const EMAIL_RE = /[a-z0-9._%+-]+\s*(?:@|\(at\)|\[at\])\s*[a-z0-9.-]+\.[a-z]{2,}/i;
// A PHONE SHAPE, not "enough digits". The old rule was any run of seven or
// more digits with phone punctuation between them, which is a description of
// far more than a phone number: a contractor's license number ("Lic 1234567"),
// a pair of ZIPs someone serves ("92646 92647"), a ZIP+4, and a year range all
// carry seven or more digits and were all rejected, each one costing an honest
// pro their wording.
//
// So this matches the actual North American shape and nothing else:
//   - an optional country code, "+1" or "1"
//   - exactly ten digits, in at most four punctuated groups (3-3-4, with the
//     area code optionally parenthesized)
//   - one separator character between groups at most, so a match can never
//     span more than a single whitespace run and two unrelated numbers on
//     either side of a line break can't be read as one phone number
//   - not butted up against more digits on either end, so a long ID that
//     happens to contain ten digits is not a phone number
//
// A seven-digit local number with no area code no longer trips this. That is
// the deliberate trade: it is indistinguishable from a license number, and
// the license number is the one an honest pro actually types.
const PHONE_RE =
  /(?<!\d)(?:\+?1[ .\-]?)?(?:\(\d{3}\)|\d{3})[ .\-]?\d{3}[ .\-]?\d{4}(?!\d)/;

// The canonical labels and values from JOB_CATEGORIES, normalized. A custom
// entry that just restates one of these is not a custom service: it is a
// duplicate that would render twice on the profile card, and (worse) it stores
// a non-canonical string the job-matching equality check can never match, so
// the pro silently stops receiving that category's jobs.
const CANONICAL = new Set<string>(
  JOB_CATEGORIES.flatMap((c) => [normalize(c.value), normalize(c.label)])
);

function normalize(s: string): string {
  return s.toLowerCase().replace(/[\s_\-&/]+/g, " ").trim();
}

// True when this string is safe to store and show as a pro's custom service.
// Anything falsy, blank, or over the caller's cap is rejected too, so this is
// a single gate rather than one of several the caller has to remember.
export function isAcceptableCustomCategory(s: unknown): boolean {
  if (typeof s !== "string") return false;
  const trimmed = s.trim();
  if (!trimmed || trimmed.length > 100) return false;

  // Needs to actually be words. Three letters is the floor: "AC" is a real
  // trade abbreviation but it is already covered by HVAC, while "!!!", "$$$",
  // and "2 4 7" are decoration, not a service name.
  const letters = trimmed.replace(/[^a-z]/gi, "");
  if (letters.length < 3) return false;

  if (URL_RE.test(trimmed)) return false;
  if (EMAIL_RE.test(trimmed)) return false;
  if (PHONE_RE.test(trimmed)) return false;
  // The allowlist is checked first, by taking its words OUT of the string the
  // block list reads. Only the block list gets the trimmed-down copy: an
  // allowlisted word is a false-positive collision, never a reason to skip the
  // URL/phone/canonical checks on the rest of the sentence.
  if (BLOCKED_RE.test(trimmed.replace(ALLOWED_RE, " "))) return false;
  if (CANONICAL.has(normalize(trimmed))) return false;

  return true;
}

// The one message shown when a custom service is dropped. Exported so the
// action and its test quote the same string.
export const CUSTOM_CATEGORY_REJECTED =
  "We couldn't use that custom service name. Pick from the list or try a plainer description.";
