// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  alreadyAsked,
  freshest,
  isUnanswered,
  lastUserMessage,
  type Msg,
} from "./AskHearth";

// The pure state reads Ask Hearth makes about a conversation. Each one exists
// because of a specific way the chat used to misbehave, so the cases below are
// those bugs, not coverage for its own sake.

const greeting: Msg = { role: "assistant", content: "Hi, I'm Hearth." };
const ask = (content: string): Msg => ({ role: "user", content, ts: 1 });
const reply = (content: string): Msg => ({
  role: "assistant",
  content,
  ts: 2,
});

describe("lastUserMessage", () => {
  it("is null when the owner has said nothing yet", () => {
    expect(lastUserMessage([])).toBeNull();
    expect(lastUserMessage([greeting])).toBeNull();
  });

  it("finds the newest question, not the first", () => {
    const msgs = [greeting, ask("Old one"), reply("Sure"), ask("New one")];
    expect(lastUserMessage(msgs)?.content).toBe("New one");
  });

  it("skips back past the assistant's reply", () => {
    const msgs = [greeting, ask("Only one"), reply("Answer")];
    expect(lastUserMessage(msgs)?.content).toBe("Only one");
  });
});

describe("alreadyAsked", () => {
  // The guard on the /ask page's ?q= and on a question forwarded from
  // elsewhere in the app. A false here costs a second paid model call, one of
  // three daily free questions, and a duplicate bubble under the first.
  it("recognizes the question the conversation just asked", () => {
    const msgs = [greeting, ask("Why is my heater loud?"), reply("Sediment.")];
    expect(alreadyAsked(msgs, "Why is my heater loud?")).toBe(true);
  });

  it("ignores surrounding whitespace on either side", () => {
    const msgs = [greeting, ask("Why is my heater loud?")];
    expect(alreadyAsked(msgs, "  Why is my heater loud?  ")).toBe(true);
  });

  it("does not match an OLDER question, only the newest", () => {
    const msgs = [greeting, ask("First thing"), reply("Ok"), ask("Second")];
    expect(alreadyAsked(msgs, "First thing")).toBe(false);
    expect(alreadyAsked(msgs, "Second")).toBe(true);
  });

  it("says no on an empty conversation, so a real question gets asked", () => {
    expect(alreadyAsked([], "Why is my heater loud?")).toBe(false);
    expect(alreadyAsked([greeting], "Why is my heater loud?")).toBe(false);
  });

  it("never matches on an empty question", () => {
    expect(alreadyAsked([greeting, ask("")], "")).toBe(false);
    expect(alreadyAsked([greeting, ask("Something")], "   ")).toBe(false);
  });
});

describe("isUnanswered", () => {
  // A reload mid-request leaves the question saved with nothing after it.
  it("is true when the conversation ends on a question", () => {
    expect(isUnanswered([greeting, ask("Still waiting?")])).toBe(true);
  });

  it("is false once a reply has landed", () => {
    expect(isUnanswered([greeting, ask("Q"), reply("A")])).toBe(false);
  });

  it("is false for a conversation that has not started", () => {
    expect(isUnanswered([])).toBe(false);
    expect(isUnanswered([greeting])).toBe(false);
  });

  it("is true for an orphan question sitting behind an answered one", () => {
    const msgs = [greeting, ask("First"), reply("Answer"), ask("Second")];
    expect(isUnanswered(msgs)).toBe(true);
  });
});

describe("freshest", () => {
  // The guard on which list the next question is appended to. It exists for
  // one reported failure: a finished answer disappeared from the transcript
  // the moment the next question was sent, because the in-memory conversation
  // had fallen behind the saved one and the new turn was built on the shorter
  // list.
  it("takes the saved list when it has everything in memory and more", () => {
    const memory = [greeting, ask("Q1")];
    const saved = [greeting, ask("Q1"), reply("A1")];
    expect(freshest(memory, saved)).toBe(saved);
  });

  it("keeps memory when the two agree", () => {
    const memory = [greeting, ask("Q1"), reply("A1")];
    const saved = [greeting, ask("Q1"), reply("A1")];
    expect(freshest(memory, saved)).toBe(memory);
  });

  it("keeps memory when the saved list is shorter", () => {
    // Another instance on the page deleted an orphan question or cleared the
    // chat. Memory already followed that; do not put it back.
    const memory = [greeting, ask("Q1"), reply("A1")];
    expect(freshest(memory, [greeting])).toBe(memory);
    expect(freshest(memory, [])).toBe(memory);
  });

  it("keeps memory when the saved list disagrees about a message it has", () => {
    // Not "memory fell behind" - the two conversations have diverged, and the
    // longer one is not automatically the right one.
    const memory = [greeting, ask("Q1")];
    const saved = [greeting, ask("Something else"), reply("A")];
    expect(freshest(memory, saved)).toBe(memory);
  });

  it("takes the saved list for a memory that lost everything", () => {
    const saved = [greeting, ask("Q1"), reply("A1")];
    expect(freshest([], saved)).toBe(saved);
  });
});
