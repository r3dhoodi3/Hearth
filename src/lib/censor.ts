// Chat censorship - masks profanity, slurs, and hate speech before a message is
// stored. Best-effort client-side filter (not a substitute for real moderation).
// Catches common evasion: leet substitutions (f3=e, 1=i, $=s, @=a …),
// separators between letters (f u c k, f-u-c-k, f.u.c.k), and - since the
// Unicode fold below - zero-width characters between letters, fullwidth and
// other compatibility forms, and Cyrillic/Greek homoglyphs.

import { foldPreservingLength } from "@/lib/customCategory";

// General profanity - masked, but not severe enough to auto-report.
const PROFANITY = [
  "fuck",
  "motherfuck",
  "shit",
  "bitch",
  "asshole",
  "bastard",
  "dick",
  "piss",
  "twat",
  "prick",
  "wanker",
  "douche",
  "jackass",
  "pussy",
  "goddamn",
];

// Slurs / hate speech - masked AND auto-flagged for review.
const SLURS = [
  // racist
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
  // sexist / demeaning
  "cunt",
  "slut",
  "whore",
  "skank",
  "thot",
  "hoe",
  // homophobic / transphobic / ableist
  "fag",
  "faggot",
  "dyke",
  "tranny",
  "retard",
];

// Leet / look-alike substitutions, per letter (the letter itself is included).
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

// Up to 2 separator chars allowed between letters (spaces, dots, dashes, *).
const SEP = "[\\s._*\\-]{0,2}";
const SUFFIX = "(?:s|es|ing|ed|er|in|in')?";

function charClass(ch: string): string {
  const variants = LEET[ch] ?? ch;
  // Escape characters that are special inside a regex character class.
  const escaped = variants.replace(/[\]\\^-]/g, "\\$&");
  return `[${escaped}]`;
}

function wordPattern(word: string): string {
  return word.split("").map(charClass).join(SEP) + SUFFIX;
}

function buildRe(words: string[]): RegExp {
  const body = words.map(wordPattern).join("|");
  // Boundaries: not preceded/followed by a normal word char, so we don't match
  // inside legit words (e.g. "spicy" won't trip "spic").
  return new RegExp(`(?<![a-z0-9])(?:${body})(?![a-z0-9])`, "gi");
}

const SLUR_RE = buildRe(SLURS);
const PROFANITY_RE = buildRe(PROFANITY);

// Collect the [start, end) spans a global regex matches in `haystack`.
// Zero-length matches are skipped and lastIndex is nudged, so a pattern whose
// every part is optional can never spin here.
function spansOf(re: RegExp, haystack: string): [number, number][] {
  const spans: [number, number][] = [];
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(haystack)) !== null) {
    if (m[0].length === 0) {
      re.lastIndex += 1;
      continue;
    }
    spans.push([m.index, m.index + m[0].length]);
  }
  return spans;
}

// Returns the cleaned text, whether anything was masked (`flagged`), and whether
// a slur/hate term was used (`slur`) - the latter triggers an auto-report.
//
// Matching runs against foldPreservingLength(input), NOT against input: that is
// what makes "f<zero width space>uck", fullwidth letters, and a Cyrillic "о"
// match the same patterns their plain-ASCII spellings do. The fold is chosen
// specifically so it cannot change the UTF-16 length, which means a match found
// at [i, j) of the folded copy is the same span of the ORIGINAL string. Masking
// therefore happens on the original, character for character, and every
// unmatched character is handed back exactly as it was typed. A chat message
// must come out of this function as the person wrote it, not as a normalized
// rewrite of what they wrote.
export function censor(input: string): {
  clean: string;
  flagged: boolean;
  slur: boolean;
} {
  const folded = foldPreservingLength(input);

  const slurSpans = spansOf(SLUR_RE, folded);
  const profanitySpans = spansOf(PROFANITY_RE, folded);
  const spans = [...slurSpans, ...profanitySpans].sort((a, b) => a[0] - b[0]);

  if (spans.length === 0) {
    return { clean: input, flagged: false, slur: false };
  }

  // Merge overlaps so a span covered by both lists is masked once, at its full
  // width, rather than twice at different offsets.
  let clean = "";
  let cursor = 0;
  for (const [start, end] of spans) {
    if (end <= cursor) continue;
    const from = Math.max(start, cursor);
    clean += input.slice(cursor, from);
    clean += "*".repeat(end - from);
    cursor = end;
  }
  clean += input.slice(cursor);

  return { clean, flagged: true, slur: slurSpans.length > 0 };
}
