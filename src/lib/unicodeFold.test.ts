import { describe, expect, it } from "vitest";
import {
  fold,
  foldPreservingLength,
  hasBidiControl,
  isAcceptableCustomCategory,
} from "@/lib/customCategory";
import { censor } from "@/lib/censor";

// The moderation lists in customCategory.ts and censor.ts were ASCII-only.
// They caught "f#ck" and "f u c k" and nothing at all from the two evasions
// that cost an attacker no effort whatsoever: a zero-width character between
// two letters, and a Cyrillic or Greek letter that is the same picture as the
// Latin one. Both render identically to a human reader - on a public /p/<slug>
// page, in a chat message - and both used to sail through every pattern.
//
// Characters are built with String.fromCharCode rather than typed as literals,
// on purpose: a zero-width space pasted into a test file is invisible in the
// editor and in every diff, so a "failing" assertion would be unreadable.

const ZWSP = String.fromCharCode(0x200b); // zero-width space
const ZWNJ = String.fromCharCode(0x200c); // zero-width non-joiner
const SOFT_HYPHEN = String.fromCharCode(0x00ad);
const VARIATION_16 = String.fromCharCode(0xfe0f);
const WORD_JOINER = String.fromCharCode(0x2060);

const CYR_A = String.fromCharCode(0x0430); // Cyrillic small a
const CYR_C = String.fromCharCode(0x0441); // Cyrillic small es, looks like c
const CYR_O = String.fromCharCode(0x043e); // Cyrillic small o
const CYR_E = String.fromCharCode(0x0435); // Cyrillic small ie, looks like e
const GREEK_O = String.fromCharCode(0x03bf); // Greek small omicron
const GREEK_A = String.fromCharCode(0x03b1); // Greek small alpha
const ARMENIAN_O = String.fromCharCode(0x0585); // Armenian small letter oh

// Combining/enclosing marks and format characters (Mn/Me/Cf): drawn OVER a
// base letter rather than being a letter in their own right, so an exact
// letter-by-letter pattern never sees them unless they are stripped first.
const COMBINING_DIAERESIS = String.fromCharCode(0x0308); // Mn
const ENCLOSING_CIRCLE = String.fromCharCode(0x20dd); // Me
// A Unicode "tag" character (supplementary plane, Cf), the block used to
// smuggle invisible text after an emoji. Built with fromCodePoint since it is
// outside the BMP; the value carried is arbitrary, only its category matters.
const TAG_CHAR = String.fromCodePoint(0xe0069);

// Bidi controls: the RTL/LTR overrides and the directional isolates. These
// reorder how everything AFTER them renders, not just themselves, which is
// why the gate rejects a string containing one outright rather than folding
// around it.
const RLO = String.fromCharCode(0x202e); // right-to-left override
const PDF = String.fromCharCode(0x202c); // pop directional formatting
const LRI = String.fromCharCode(0x2066); // left-to-right isolate
const PDI = String.fromCharCode(0x2069); // pop directional isolate

describe("fold", () => {
  it("removes the invisible characters used to break up a word", () => {
    expect(fold(`f${ZWSP}u${ZWSP}c${ZWSP}k`)).toBe("fuck");
    expect(fold(`sh${ZWNJ}it`)).toBe("shit");
    expect(fold(`re${SOFT_HYPHEN}tard`)).toBe("retard");
    expect(fold(`co${WORD_JOINER}on`)).toBe("coon");
    expect(fold(`ok${VARIATION_16}`)).toBe("ok");
  });

  it("maps Cyrillic and Greek look-alikes onto Latin", () => {
    expect(fold(`fu${CYR_C}k`)).toBe("fuck");
    expect(fold(`${CYR_C}${CYR_O}${CYR_O}n`)).toBe("coon");
    expect(fold(`p${GREEK_O}rn`)).toBe("porn");
    expect(fold(`${GREEK_A}n${CYR_A}l`)).toBe("anal");
  });

  it("maps the Armenian look-alike onto Latin", () => {
    expect(fold(`p${ARMENIAN_O}rn`)).toBe("porn");
  });

  it("strips a combining mark rather than leaving it to dodge an exact letter match", () => {
    // "n" + "i" + COMBINING DIAERESIS + "gger" reads as "nïgger" to a human
    // and, unstripped, matches no letter pattern in this file. NFKC would
    // have RECOMPOSED the mark onto the "i" into the single character "ï",
    // which is exactly as unmatchable; NFKD decomposes the other way and
    // leaves the mark on its own to be removed.
    expect(fold(`n${"i"}${COMBINING_DIAERESIS}gger`)).toBe("nigger");
  });

  it("strips an enclosing mark", () => {
    expect(fold(`c${ENCLOSING_CIRCLE}oon`)).toBe("coon");
  });

  it("strips a Unicode tag character (the emoji-smuggling block)", () => {
    expect(fold(`sh${TAG_CHAR}it`)).toBe("shit");
  });

  it("still folds precomposed accents to plain ASCII for matching, without touching honest names", () => {
    // fold() only ever answers a yes/no; the stored value is untouched. NFKD
    // decomposes the accent off the base letter and the mark is then
    // stripped, which is exactly what keeps these from ever colliding with a
    // blocked term while still being harmless to real names.
    expect(fold("José")).toBe("Jose");
    expect(fold("Müller")).toBe("Muller");
    expect(fold("Núñez")).toBe("Nunez");
    expect(fold("Söhne")).toBe("Sohne");
  });

  it("applies NFKC, so compatibility spellings collapse to plain ASCII", () => {
    // Fullwidth forms, U+FF26 onward.
    const fullwidth = [0xff26, 0xff35, 0xff23, 0xff2b]
      .map((c) => String.fromCharCode(c))
      .join("");
    expect(fold(fullwidth)).toBe("FUCK");
  });

  it("leaves ordinary text exactly as it was", () => {
    expect(fold("Solar panel cleaning")).toBe("Solar panel cleaning");
    expect(fold("Crape myrtle trimming")).toBe("Crape myrtle trimming");
    expect(fold("")).toBe("");
  });
});

describe("foldPreservingLength", () => {
  // The whole contract. censor() masks a SPAN of the caller's text and hands
  // the rest back untouched, so an index found in the folded copy has to be
  // the same index in the original. If this property breaks, censor starts
  // masking the wrong characters.
  const samples = [
    "nothing to see here",
    `f${ZWSP}u${ZWSP}c${ZWSP}k`,
    `fu${CYR_C}k`,
    `${GREEK_A}n${CYR_A}l`,
    "plain ascii, 123, punctuation!",
    "an emoji: \u{1F600} and text after",
    "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467} family sequence",
    "the fi ligature: ﬁnish",
    "combining accent: é",
    `n${"i"}${COMBINING_DIAERESIS}gger`,
    `c${ENCLOSING_CIRCLE}oon`,
    `sh${TAG_CHAR}it`,
  ];

  it("never changes the UTF-16 length", () => {
    for (const s of samples) {
      expect(foldPreservingLength(s).length, JSON.stringify(s)).toBe(s.length);
    }
  });

  it("turns invisibles into a separator the existing patterns already accept", () => {
    expect(foldPreservingLength(`f${ZWSP}uck`)).toBe("f.uck");
  });

  it("maps homoglyphs one character for one character", () => {
    expect(foldPreservingLength(`fu${CYR_C}k`)).toBe("fuck");
    expect(foldPreservingLength(`p${GREEK_O}rn`)).toBe("porn");
  });

  it("leaves a multi-unit code point alone rather than collapsing it", () => {
    // The fi ligature NFKC-expands to two characters, which would shift every
    // index after it, so it is deliberately skipped here.
    expect(foldPreservingLength("ﬁnish")).toBe("ﬁnish");
  });

  it("turns a combining/enclosing mark or tag character into the same separator, never removing it", () => {
    // Each of these is a single code point sitting on its own in the walked
    // string (never decomposed here), so swapping it for "." is always
    // length-safe - unlike fold()'s NFKD pass, which can split ONE character
    // into a base plus a mark.
    expect(foldPreservingLength(`n${"i"}${COMBINING_DIAERESIS}gger`)).toBe(
      "ni.gger"
    );
    expect(foldPreservingLength(`c${ENCLOSING_CIRCLE}oon`)).toBe("c.oon");
    // TAG_CHAR is a supplementary-plane code point - a surrogate pair, so two
    // UTF-16 units - which is exactly why the placeholder is repeated
    // ch.length times rather than written as a single character.
    expect(foldPreservingLength(`sh${TAG_CHAR}it`)).toBe("sh..it");
  });
});

describe("hasBidiControl", () => {
  it("flags a right-to-left override or an isolate anywhere in the string", () => {
    expect(hasBidiControl(`Roofing ${RLO}gnicivres${PDF}`)).toBe(true);
    expect(hasBidiControl(`${LRI}Plumbing${PDI}`)).toBe(true);
  });

  it("leaves ordinary text, including accented names, alone", () => {
    expect(hasBidiControl("José Núñez Plumbing")).toBe(false);
    expect(hasBidiControl("Solar panel cleaning")).toBe(false);
    expect(hasBidiControl("")).toBe(false);
  });
});

describe("censor with the fold", () => {
  it("catches a zero-width split", () => {
    const r = censor(`you ${"f" + ZWSP + "u" + ZWSP + "c" + ZWSP + "k"} off`);
    expect(r.flagged).toBe(true);
    // Seven characters of input (four letters plus three zero-width ones),
    // seven stars out, and the words on either side untouched.
    expect(r.clean).toBe("you ******* off");
  });

  it("catches a Cyrillic homoglyph", () => {
    const r = censor(`what a ${"b" + "i" + "t" + CYR_C + "h"}`);
    expect(r.flagged).toBe(true);
    expect(r.slur).toBe(false);
    expect(r.clean).toBe("what a *****");
  });

  it("still flags a slur, and still says so", () => {
    const r = censor(`a ${CYR_C}hink`);
    expect(r.flagged).toBe(true);
    expect(r.slur).toBe(true);
  });

  it("returns clean text byte for byte when nothing matches", () => {
    const input = "Hi! Can you come by Tuesday? The rate is $150/hr.";
    const r = censor(input);
    expect(r).toEqual({ clean: input, flagged: false, slur: false });
  });

  it("masks only the matched span, and keeps the same total length", () => {
    const input = "the shit is broken";
    const r = censor(input);
    expect(r.clean).toBe("the **** is broken");
    expect(r.clean.length).toBe(input.length);
  });

  it("does not normalize the rest of the message", () => {
    // Somebody writing in Cyrillic, or using a ligature, gets their text back
    // as they typed it. Only a matched span is ever replaced.
    const input = `Привет ﬁnish`;
    expect(censor(input).clean).toBe(input);
  });
});

describe("isAcceptableCustomCategory with the fold", () => {
  it("rejects a blocked term hidden behind zero-width characters", () => {
    expect(isAcceptableCustomCategory(`Sh${ZWSP}it removal`)).toBe(false);
    expect(isAcceptableCustomCategory(`Es${ZWNJ}cort service`)).toBe(false);
  });

  it("rejects a blocked term spelled with homoglyphs", () => {
    expect(isAcceptableCustomCategory(`Fu${CYR_C}k everything`)).toBe(false);
    expect(isAcceptableCustomCategory(`P${GREEK_O}rn studio cleanup`)).toBe(
      false
    );
    expect(isAcceptableCustomCategory(`${CYR_E}scort service`)).toBe(false);
  });

  it("rejects a fullwidth spelling", () => {
    const fullwidth = [0xff33, 0xff25, 0xff38]
      .map((c) => String.fromCharCode(c))
      .join("");
    expect(isAcceptableCustomCategory(`${fullwidth} work`)).toBe(false);
  });

  it("rejects a phone number written with fullwidth digits", () => {
    // NFKC turns fullwidth digits into ASCII digits, which is what makes the
    // phone pattern see it at all.
    const digits = "714５５５０１００";
    expect(isAcceptableCustomCategory(`Drywall ${digits}`)).toBe(false);
  });

  it("measures the length cap on what was typed, not on the folded copy", () => {
    // 100 real characters plus 60 zero-width ones is 160 characters of stored
    // value. Folding first would have read it as 100 and let it through.
    const padded = "a".repeat(100) + ZWSP.repeat(60);
    expect(padded.length).toBe(160);
    expect(isAcceptableCustomCategory(padded)).toBe(false);
  });

  it("still accepts the honest trades it always did", () => {
    expect(isAcceptableCustomCategory("Solar panel cleaning")).toBe(true);
    expect(isAcceptableCustomCategory("Crape myrtle trimming")).toBe(true);
    expect(isAcceptableCustomCategory("Log home chinking")).toBe(true);
  });

  it("rejects a slur spelled with a combining mark splitting a letter", () => {
    expect(
      isAcceptableCustomCategory(`n${"i"}${COMBINING_DIAERESIS}gger removal`)
    ).toBe(false);
  });

  it("rejects a slur hidden behind an enclosing mark", () => {
    expect(isAcceptableCustomCategory(`c${ENCLOSING_CIRCLE}oon cleanup`)).toBe(
      false
    );
  });

  it("rejects a blocked term split by a Unicode tag character", () => {
    expect(isAcceptableCustomCategory(`sh${TAG_CHAR}it removal`)).toBe(false);
  });

  it("rejects the Armenian look-alike spelling", () => {
    expect(isAcceptableCustomCategory(`p${ARMENIAN_O}rn cleanup`)).toBe(false);
  });

  it("rejects any string carrying a bidi override or isolate outright", () => {
    expect(isAcceptableCustomCategory(`Roofing ${RLO}gnicivres${PDF}`)).toBe(
      false
    );
    expect(isAcceptableCustomCategory(`${LRI}Plumbing${PDI} service`)).toBe(
      false
    );
  });

  it("still accepts real names with precomposed accents", () => {
    expect(isAcceptableCustomCategory("José Núñez Plumbing")).toBe(true);
    expect(isAcceptableCustomCategory("Müller & Söhne HVAC")).toBe(true);
  });
});
