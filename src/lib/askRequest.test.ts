import { describe, expect, it } from "vitest";
import {
  hasAskableContent,
  newestUserMessage,
  pickImageIndexes,
  IMAGE_RECENT_TURNS,
} from "./askRequest";

// A history the way the chat clients actually send it: alternating turns,
// `content` always a string, `image` present only when a photo was attached.
function msg(role: "user" | "assistant", content: string, image?: string) {
  return image ? { role, content, image } : { role, content };
}

describe("newestUserMessage", () => {
  it("finds the last user turn", () => {
    const history = [
      msg("user", "first"),
      msg("assistant", "reply"),
      msg("user", "second"),
    ];
    expect(newestUserMessage(history)?.content).toBe("second");
  });

  it("skips a trailing assistant turn rather than reading it as the question", () => {
    const history = [msg("user", "hello"), msg("assistant", "hi there")];
    expect(newestUserMessage(history)?.content).toBe("hello");
  });

  it("is null for junk", () => {
    expect(newestUserMessage(null)).toBeNull();
    expect(newestUserMessage([])).toBeNull();
    expect(newestUserMessage("nope")).toBeNull();
    expect(newestUserMessage([msg("assistant", "greeting")])).toBeNull();
  });
});

describe("hasAskableContent", () => {
  it("accepts a real question", () => {
    expect(hasAskableContent([msg("user", "why is my heater loud")])).toBe(true);
  });

  // The bug: an empty newest turn built an empty content list, the API
  // rejected it with a 400, and the homeowner had already been charged one of
  // three daily questions for it.
  it("rejects an empty or whitespace-only newest turn", () => {
    expect(hasAskableContent([msg("user", "")])).toBe(false);
    expect(hasAskableContent([msg("user", "   ")])).toBe(false);
    expect(hasAskableContent([msg("user", "\n\t  \n")])).toBe(false);
  });

  it("rejects an empty turn even when EARLIER turns had text", () => {
    // The client replays the whole conversation, so "there is text somewhere
    // in the history" is not the same question as "did they just ask
    // something".
    const history = [
      msg("user", "how old is my water heater"),
      msg("assistant", "about 12 years"),
      msg("user", "  "),
    ];
    expect(hasAskableContent(history)).toBe(false);
  });

  it("accepts a bare photo with no text", () => {
    expect(hasAskableContent([msg("user", "", "AAAA")])).toBe(true);
  });

  it("rejects a missing or malformed history", () => {
    expect(hasAskableContent([])).toBe(false);
    expect(hasAskableContent(null)).toBe(false);
    expect(hasAskableContent([{ role: "user" }])).toBe(false);
    expect(hasAskableContent([{ role: "user", content: 42 }])).toBe(false);
  });
});

describe("pickImageIndexes", () => {
  const OPTS = { maxImages: 4, maxChars: 100 };

  // Build a history where every user turn carries a photo, so the only thing
  // deciding which are kept is the selection rule itself.
  function withPhotos(count: number) {
    return Array.from({ length: count }, (_, i) =>
      msg("user", `q${i}`, `img${i}`)
    );
  }

  it("keeps the NEWEST photos, not the oldest", () => {
    // Six photos in the window, room for four. The old forward-walking code
    // kept 0,1,2,3 and dropped the photo the question was actually about.
    const history = withPhotos(6);
    expect([...pickImageIndexes(history, OPTS)].sort((a, b) => a - b)).toEqual([
      2, 3, 4, 5,
    ]);
  });

  it("always includes the newest turn's photo", () => {
    const history = withPhotos(20);
    expect(pickImageIndexes(history, OPTS).has(19)).toBe(true);
  });

  it("never reaches back past the recent window", () => {
    // 20 turns, only the last IMAGE_RECENT_TURNS are eligible, so an old
    // photo stops riding along at full vision price on every later question.
    const history = withPhotos(20);
    const picked = [...pickImageIndexes(history, { ...OPTS, maxImages: 99 })];
    expect(Math.min(...picked)).toBe(20 - IMAGE_RECENT_TURNS);
    expect(picked.length).toBe(IMAGE_RECENT_TURNS);
  });

  it("honours an explicit window", () => {
    const history = withPhotos(10);
    const picked = pickImageIndexes(history, {
      ...OPTS,
      maxImages: 99,
      recentTurns: 2,
    });
    expect([...picked].sort((a, b) => a - b)).toEqual([8, 9]);
  });

  it("skips oversized photos and takes the next newest instead", () => {
    const history = [
      msg("user", "a", "small-1"),
      msg("user", "b", "small-2"),
      msg("user", "c", "x".repeat(500)),
    ];
    const picked = pickImageIndexes(history, { maxImages: 2, maxChars: 100 });
    expect([...picked].sort((a, b) => a - b)).toEqual([0, 1]);
  });

  it("ignores turns with no photo, and junk entries", () => {
    const history = [
      msg("user", "text only"),
      null,
      { role: "user", content: "x", image: 42 },
      msg("user", "with photo", "img"),
    ];
    expect([...pickImageIndexes(history, OPTS)]).toEqual([3]);
  });

  it("returns nothing when images are not allowed at all", () => {
    const history = withPhotos(3);
    expect(pickImageIndexes(history, { ...OPTS, maxImages: 0 }).size).toBe(0);
  });

  // Indexes, not messages: the caller maps the history in its original order
  // and asks this set whether each turn keeps its photo, so the pictures land
  // back in the conversation in the order they were actually sent.
  it("returns positions into the ORIGINAL history", () => {
    const history = [
      msg("user", "one"),
      msg("assistant", "reply"),
      msg("user", "two", "photo"),
    ];
    expect([...pickImageIndexes(history, OPTS)]).toEqual([2]);
  });
});
