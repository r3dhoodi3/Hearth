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

// ---------------------------------------------------------------------------
// Unicode folding, and why the leet table below is not enough on its own
// ---------------------------------------------------------------------------
// The LEET table and the separator class catch ASCII evasion ("f#ck",
// "f u c k"). They do nothing about the two tricks that cost an attacker
// nothing at all:
//
//   1. Invisible characters. "f​u​c​k" renders as one word to
//      every human reader and matches no pattern here, because a zero-width
//      space is not in SEP. Same for a soft hyphen, the bidi controls, and the
//      variation selectors.
//   2. Homoglyphs. Cyrillic "а" (U+0430) and Greek "ο" (U+03BF) are pixel-
//      identical to Latin "a" and "o" in every font this app ships. A slur
//      spelled with two of them reads exactly the same on a public profile
//      and matches nothing.
//
// Compatibility forms are the third: NFKC turns fullwidth "ｆｕｃｋ", the
// circled and squared letters, and the ligatures into their plain ASCII
// equivalents in one call.
//
// TWO folds, because there are two jobs:
//
//   fold()                - the full fold. Free to change length (NFKC
//                           expands, invisibles are deleted). Used where the
//                           answer is a yes/no on the whole string, so the
//                           folded copy never has to line up with the
//                           original: isAcceptableCustomCategory here, and
//                           isAcceptablePublicText in src/lib/publicText.ts.
//   foldPreservingLength() - the same fold, restricted to substitutions that
//                           keep the UTF-16 length identical, so a match found
//                           at index i in the folded copy is the same span at
//                           index i of the original. That is what src/lib/
//                           censor.ts needs: it MASKS a span of the caller's
//                           text and hands the rest back untouched, so it must
//                           never return a normalized rewrite of somebody's
//                           chat message.
//
// Invisibles fold to "." rather than to nothing in the length-preserving
// version, because "." is already in SEP: "f​u​c​k" becomes
// "f.u.c.k", which the existing separator rule matches, with every index
// still where it was.

// Format/invisible characters an evader inserts between letters, written as
// CODE POINT RANGES rather than as a regex with escapes in it. Two reasons:
// a literal zero-width character inside a character class is invisible in the
// editor and in every diff (exactly the property this list exists to defeat),
// and a hex number is something a reviewer can look up.
//
//   00ad          soft hyphen
//   200b - 200f   zero-width space, ZWNJ, ZWJ, LRM, RLM
//   2028 - 202f   line/paragraph separator, the bidi overrides, narrow NBSP
//   2060 - 206f   word joiner, invisible operators, deprecated format chars
//   fe00 - fe0f   variation selectors
const INVISIBLE_RANGES: readonly (readonly [number, number])[] = [
  [0x00ad, 0x00ad],
  [0x200b, 0x200f],
  [0x2028, 0x202f],
  [0x2060, 0x206f],
  [0xfe00, 0xfe0f],
];

function isInvisible(ch: string): boolean {
  const cp = ch.codePointAt(0);
  if (cp === undefined) return false;
  return INVISIBLE_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi);
}

// Bidi control characters that reorder how the SURROUNDING text renders
// without changing what it is. Folding these away (the way the invisible
// ranges above already do, for matching purposes) is not enough on its own,
// because the raw string - override characters and all - is what gets stored
// and rendered everywhere else a business name or service description shows
// up. A string that reads one way on this form and a different way wherever
// it renders next is refused outright rather than folded, which is why this
// is exported for isAcceptableCustomCategory and isAcceptablePublicText to
// check BEFORE they ever call fold().
//
// Written as escaped hex ranges, not literal characters, for the same reason
// INVISIBLE_RANGES is: a literal bidi control pasted into a character class is
// invisible in the editor and in every diff, and a hex number is something a
// reviewer can look up.
//   202a - 202e   LRE, RLE, PDF, LRO, RLO (the overrides)
//   2066 - 2069   LRI, RLI, FSI, PDI (the isolates)
const BIDI_CONTROL_RE = /[\u202A-\u202E\u2066-\u2069]/;

export function hasBidiControl(s: string): boolean {
  return BIDI_CONTROL_RE.test(s);
}

// Combining marks (Mn), enclosing marks (Me), and format characters (Cf) - a
// broader net than the hand-picked INVISIBLE_RANGES above. Mn/Me are how an
// accent or a circle/keycap is drawn OVER a base letter rather than being a
// letter in their own right: "n" + COMBINING DIAERESIS (U+0308) reads as "nï"
// to a human and, left unstripped, matches no exact-letter pattern in this
// file - see fold() below for how NFKD turns that into plain "nigger" for
// matching. Cf additionally covers the invisible Unicode "tag" characters at
// U+E0000-U+E007F, used to smuggle invisible text after an emoji; that block
// is spelled out explicitly too, on the same reasoning as INVISIBLE_RANGES
// above - a supplementary-plane range as a hex number is something a reviewer
// can look up, rather than trusting \p{Cf} alone to cover it.
const STRIP_CATEGORY_RE = /[\p{Mn}\p{Me}\p{Cf}]/u;

function isTagCharacter(ch: string): boolean {
  const cp = ch.codePointAt(0);
  return cp !== undefined && cp >= 0xe0000 && cp <= 0xe007f;
}

function isStrippableMark(ch: string): boolean {
  return isTagCharacter(ch) || STRIP_CATEGORY_RE.test(ch);
}

// Cyrillic and Greek letters that are visually identical (or near enough) to a
// Latin letter in a normal UI font. Deliberately NOT a full confusables table:
// this is the short list of characters that actually turn up in homoglyph
// evasion, and every entry is a single BMP code unit, so substituting one is
// always length-preserving. Keyed by code point for the same reason the
// invisible list is: a literal Cyrillic small a and a Latin small a are the
// same picture, and only the number tells them apart.
const HOMOGLYPHS = new Map<number, string>([
  // Cyrillic lowercase
  [0x0430, "a"],
  [0x0432, "b"],
  [0x0435, "e"],
  [0x043a, "k"],
  [0x043c, "m"],
  [0x043d, "h"],
  [0x043e, "o"],
  [0x0440, "p"],
  [0x0441, "c"],
  [0x0442, "t"],
  [0x0443, "y"],
  [0x0445, "x"],
  [0x0455, "s"],
  [0x0456, "i"],
  [0x0457, "i"],
  [0x0458, "j"],
  [0x04bb, "h"],
  [0x04cf, "l"],
  [0x0501, "d"],
  // Cyrillic uppercase
  [0x0405, "S"],
  [0x0406, "I"],
  [0x0408, "J"],
  [0x0410, "A"],
  [0x0412, "B"],
  [0x0415, "E"],
  [0x041a, "K"],
  [0x041c, "M"],
  [0x041d, "H"],
  [0x041e, "O"],
  [0x0420, "P"],
  [0x0421, "C"],
  [0x0422, "T"],
  [0x0423, "Y"],
  [0x0425, "X"],
  // Greek lowercase
  [0x03b1, "a"],
  [0x03b5, "e"],
  [0x03b9, "i"],
  [0x03ba, "k"],
  [0x03bd, "v"],
  [0x03bf, "o"],
  [0x03c1, "p"],
  [0x03c3, "o"],
  [0x03c4, "t"],
  [0x03c5, "u"],
  [0x03c7, "x"],
  // Greek uppercase
  [0x0391, "A"],
  [0x0392, "B"],
  [0x0395, "E"],
  [0x0396, "Z"],
  [0x0397, "H"],
  [0x0399, "I"],
  [0x039a, "K"],
  [0x039c, "M"],
  [0x039d, "N"],
  [0x039f, "O"],
  [0x03a1, "P"],
  [0x03a4, "T"],
  [0x03a5, "Y"],
  [0x03a7, "X"],
  // Additional Cyrillic/Greek look-alikes, added when the block above missed
  // one that is a genuinely common confusable rather than a hypothetical.
  [0x04c0, "I"], // CYRILLIC LETTER PALOCHKA - a bare vertical stroke used as I/l
  [0x0500, "D"], // CYRILLIC CAPITAL LETTER KOMI DE - symmetric with 0x0501 above
  [0x03b7, "n"], // GREEK SMALL LETTER ETA - reads as a Latin n in most UI fonts
  // Armenian: this script is otherwise unrepresented above, so this is a new
  // family, not a gap in an existing one.
  [0x0585, "o"], // ARMENIAN SMALL LETTER OH - pixel-identical to Latin o
]);

function homoglyphFor(ch: string): string | undefined {
  const cp = ch.codePointAt(0);
  return cp === undefined ? undefined : HOMOGLYPHS.get(cp);
}

// The full fold: NFKD, invisibles and combining/enclosing/format marks
// removed, homoglyphs mapped to Latin. Length is NOT preserved - see the note
// above for which callers may use this.
//
// NFKD, not NFKC, is what defeats "n" + "i" + COMBINING DIAERESIS + "gger":
// NFKC would canonically RECOMPOSE the "i" and its mark into the single
// precomposed character "ï", which matches no letter pattern in this file.
// NFKD decomposes the other way and leaves the mark on its own, where
// isStrippableMark removes it below, so the result is the plain letters
// "nigger". Compatibility spellings (fullwidth, circled, ligatures) still
// collapse to plain ASCII either way, since that half of the mapping does not
// involve combining marks. The same decomposition turns "José" into "Jose"
// and "Müller" into "Muller" for MATCHING purposes only - fold() never
// touches the value that actually gets stored, it only answers a yes/no.
export function fold(input: string): string {
  let out = "";
  for (const ch of input.normalize("NFKD")) {
    if (isInvisible(ch) || isStrippableMark(ch)) continue;
    out += homoglyphFor(ch) ?? ch;
  }
  return out;
}

// The same fold, with every substitution checked to keep the UTF-16 length
// identical, so an index into the result is the same index in the input:
//   - invisibles become "." (already a separator character in SEP)
//   - homoglyphs map one BMP unit to one ASCII unit
//   - a combining/enclosing mark or format character (isStrippableMark) also
//     becomes "." rather than being removed: the input here is walked
//     character by character and never decomposed, so a mark like this is
//     always a single code point on its own, and swapping it for a same-
//     length placeholder is always safe. "n" + COMBINING DIAERESIS + "gger"
//     therefore folds to "n.gger", which the existing separator rule matches.
//   - NFKC is applied per character and kept only when the result is the same
//     length, so the "fi" ligature is left alone and no surrogate pair is ever
//     collapsed
export function foldPreservingLength(input: string): string {
  let out = "";
  for (const ch of input) {
    if (isInvisible(ch)) {
      out += ".".repeat(ch.length);
      continue;
    }
    const homoglyph = homoglyphFor(ch);
    if (homoglyph !== undefined && homoglyph.length === ch.length) {
      out += homoglyph;
      continue;
    }
    if (isStrippableMark(ch)) {
      out += ".".repeat(ch.length);
      continue;
    }
    const normalized = ch.normalize("NFKC");
    out += normalized.length === ch.length ? normalized : ch;
  }
  return out;
}

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
export const ALLOWED_WORDS = [
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
//
// Exported as a BUILDER rather than only as a finished regex because
// src/lib/publicText.ts needs the same rule over a longer word list: a
// business NAME collides with the block lists far more often than a service
// description does (surnames - Dick, Spicer, Coons, Van Dyke - are the whole
// problem), and the boundary rule is the part that must not be re-typed
// slightly differently in two places.
export function allowedWordsPattern(words: readonly string[]): RegExp {
  return new RegExp(
    `(?<![a-z0-9])(?:${words.join("|")})(?![a-z0-9])`,
    "gi"
  );
}

const ALLOWED_RE = allowedWordsPattern(ALLOWED_WORDS);

// Off-platform contact routes. A pro who lists "call 714-555-0100" as their
// service is using the public directory as a bypass around every part of the
// product that protects the homeowner (the lead record, the chat transcript,
// the review request).
const URL_RE =
  /(https?:\/\/|www\.|\b[a-z0-9][a-z0-9-]*\.(?:com|net|org|io|co|us|biz|info|shop|site|xyz|app|dev|me|tv|link)\b)/i;
export const EMAIL_RE =
  /[a-z0-9._%+-]+\s*(?:@|\(at\)|\[at\])\s*[a-z0-9.-]+\.[a-z]{2,}/i;
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
export const PHONE_RE =
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
  // The length cap is measured on what the pro actually typed, BEFORE folding:
  // a 100-character cap that folding could shrink would let a longer string in
  // through a pile of zero-width characters.
  if (!trimmed || trimmed.length > 100) return false;

  // A bidi override/isolate changes how everything AFTER it renders, not just
  // itself, so this runs on the raw string, before folding could hide it, and
  // rejects outright rather than trying to fold around it. See hasBidiControl
  // above.
  if (hasBidiControl(trimmed)) return false;

  // Everything below reads the FOLDED copy (see fold() above): a zero-width
  // space between two letters, a fullwidth alphabet, and a Cyrillic look-alike
  // are all evasions of every pattern in this file, and each one costs an
  // attacker nothing. The stored value is still the pro's original string -
  // this function only answers yes or no.
  const folded = fold(trimmed);

  // Needs to actually be words. Three letters is the floor: "AC" is a real
  // trade abbreviation but it is already covered by HVAC, while "!!!", "$$$",
  // and "2 4 7" are decoration, not a service name.
  const letters = folded.replace(/[^a-z]/gi, "");
  if (letters.length < 3) return false;

  if (URL_RE.test(folded)) return false;
  if (EMAIL_RE.test(folded)) return false;
  if (PHONE_RE.test(folded)) return false;
  // The allowlist is checked first, by taking its words OUT of the string the
  // block list reads. Only the block list gets the trimmed-down copy: an
  // allowlisted word is a false-positive collision, never a reason to skip the
  // URL/phone/canonical checks on the rest of the sentence.
  if (BLOCKED_RE.test(folded.replace(ALLOWED_RE, " "))) return false;
  if (CANONICAL.has(normalize(folded))) return false;

  return true;
}

// The one message shown when a custom service is dropped. Exported so the
// action and its test quote the same string.
export const CUSTOM_CATEGORY_REJECTED =
  "We couldn't use that custom service name. Pick from the list or try a plainer description.";
