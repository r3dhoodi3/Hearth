import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import {
  TOPIC_GUARD_HOMEOWNER,
  TOPIC_GUARD_PRO,
  messageHasImage,
  newTurnHasImage,
} from "./aiGuard";
import { hasAskableContent, newestUserMessage } from "./askRequest";

function routeSource(rel: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../app/api/${rel}`, import.meta.url)),
    "utf8"
  );
}

describe("topic guard wording", () => {
  const guards = [
    ["homeowner", TOPIC_GUARD_HOMEOWNER],
    ["pro", TOPIC_GUARD_PRO],
  ] as const;

  for (const [side, guard] of guards) {
    it(`${side}: states the scope rule up front`, () => {
      expect(guard).toContain("STAY ON TOPIC");
      expect(guard).toContain("overrides everything else");
    });

    it(`${side}: refuses unrelated questions with one friendly sentence`, () => {
      expect(guard).toContain("do NOT answer it");
      expect(guard).toMatch(/one friendly sentence/);
      // Some concrete off-topic examples must be named, or the rule is vague
      // enough for the model to talk itself past it.
      for (const topic of ["homework", "coding", "trivia", "news", "medical"]) {
        expect(guard).toContain(topic);
      }
    });

    it(`${side}: answers the home part of a mixed question, declines the rest`, () => {
      expect(guard).toContain("MIXES");
      expect(guard).toContain("as a favour");
      expect(guard).toMatch(/one short clause/);
    });

    it(`${side}: keeps judgment for questions that are on topic in disguise`, () => {
      expect(guard).toContain("in disguise");
      expect(guard).toContain("12x14");
      expect(guard).toContain("60 psi");
    });

    it(`${side}: declines quietly, with no lecture and no blocks`, () => {
      expect(guard).toContain("do not lecture");
      expect(guard).toContain("policies");
      expect(guard).toContain("POSTJOB");
      expect(guard).toContain("OPTIONS");
    });

    it(`${side}: uses no em dash`, () => {
      expect(guard).not.toContain("—");
    });
  }

  it("both sides share the exact same behaviour half", () => {
    // The scope sentence differs by side; everything after "That means ..."
    // must be identical, so a fix to one side can never silently skip the
    // other.
    const tail = (s: string) => s.slice(s.indexOf("If a message is unrelated"));
    expect(tail(TOPIC_GUARD_HOMEOWNER).length).toBeGreaterThan(200);
    expect(tail(TOPIC_GUARD_HOMEOWNER)).toBe(tail(TOPIC_GUARD_PRO));
  });

  it("scopes each side to its own audience", () => {
    expect(TOPIC_GUARD_HOMEOWNER).toContain("homeowner's home");
    expect(TOPIC_GUARD_HOMEOWNER).toContain("insurance and property taxes");
    expect(TOPIC_GUARD_PRO).toContain("contractor's trade");
    expect(TOPIC_GUARD_PRO).toContain("Hearth for Pros");
  });
});

describe("both routes use the shared guard", () => {
  it("the homeowner route imports and applies TOPIC_GUARD_HOMEOWNER", () => {
    const src = routeSource("ask/route.ts");
    expect(src).toContain('from "@/lib/aiGuard"');
    expect(src).toContain("TOPIC_GUARD_HOMEOWNER");
  });

  it("the pro route imports and applies TOPIC_GUARD_PRO", () => {
    const src = routeSource("pro-ask/route.ts");
    expect(src).toContain('from "@/lib/aiGuard"');
    expect(src).toContain("TOPIC_GUARD_PRO");
  });

  it("neither route re-declares the guard text inline", () => {
    for (const rel of ["ask/route.ts", "pro-ask/route.ts"]) {
      expect(routeSource(rel).match(/STAY ON TOPIC/g)).toBeNull();
    }
  });
});

describe("photo detection", () => {
  it("spots a message carrying an image", () => {
    expect(messageHasImage({ role: "user", image: "abc" })).toBe(true);
    expect(messageHasImage({ role: "user", content: "hi" })).toBe(false);
    expect(messageHasImage({ role: "user", image: "" })).toBe(false);
    expect(messageHasImage({ role: "user", image: 42 })).toBe(false);
    expect(messageHasImage(null)).toBe(false);
    expect(messageHasImage("nope")).toBe(false);
  });

  it("only gates on the newest turn, not a replayed history", () => {
    const old = { role: "user", content: "here", image: "aaa" };
    const reply = { role: "assistant", content: "that is a water heater" };
    const now = { role: "user", content: "how old is it likely to be?" };
    // A photo three turns back must not lock a plain text question.
    expect(newTurnHasImage([old, reply, now])).toBe(false);
    expect(newTurnHasImage([reply, now, { role: "user", image: "bbb" }])).toBe(
      true
    );
  });

  it("is safe on junk input", () => {
    expect(newTurnHasImage(undefined)).toBe(false);
    expect(newTurnHasImage([])).toBe(false);
    expect(newTurnHasImage("messages")).toBe(false);
    expect(newTurnHasImage([null])).toBe(false);
    // A trailing assistant entry is the canned greeting, never an upload.
    expect(newTurnHasImage([{ role: "assistant", image: "aaa" }])).toBe(false);
  });
});

// TWO HELPERS, ONE DEFINITION OF "the newest turn".
//
// These disagreed. newTurnHasImage read strictly the last array element and
// gave up if it was an assistant turn; hasAskableContent scanned BACKWARDS
// past a trailing assistant turn to find the last thing the person actually
// sent. A history ending in a stray assistant entry (a malformed client, a
// replayed greeting) therefore had a question according to one and no photo
// according to the other, and the photo gate in /api/ask is the thing standing
// between a free account and the paid vision model. Both now go through
// newestUserMessage in src/lib/askRequest.ts, so the gap cannot reopen.
describe("the photo gate and the emptiness check agree on the newest turn", () => {
  const photoTurn = { role: "user", content: "what is this?", image: "aaa" };
  const greeting = { role: "assistant", content: "Hi, ask me anything" };

  it("sees a photo behind a trailing assistant turn, as the other helper does", () => {
    const history = [photoTurn, greeting];
    // Both helpers reach past the assistant tail to the same message.
    expect(newestUserMessage(history)).toBe(photoTurn);
    expect(hasAskableContent(history)).toBe(true);
    // The one that used to say false: a free account's photo question walked
    // straight past the Plus gate on exactly this shape.
    expect(newTurnHasImage(history)).toBe(true);
  });

  it("agrees on every shape the clients can produce", () => {
    const histories: unknown[][] = [
      [],
      [greeting],
      [{ role: "user", content: "text only" }],
      [photoTurn],
      [photoTurn, greeting],
      [photoTurn, greeting, { role: "user", content: "and now text" }],
      [{ role: "user", content: "old", image: "aaa" }, greeting, greeting],
      [null, photoTurn],
    ];
    for (const history of histories) {
      const newest = newestUserMessage(history);
      expect(newTurnHasImage(history)).toBe(messageHasImage(newest));
    }
  });
});
