import { describe, expect, it } from "vitest";
import {
  fold,
  foldPreservingLength,
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
});
