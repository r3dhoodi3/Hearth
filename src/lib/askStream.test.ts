import { describe, expect, it } from "vitest";
import {
  NDJSON_CONTENT_TYPE,
  NDJSON_HEADERS,
  encodeDelta,
  encodeDone,
  ndjsonBody,
  parseNdjsonChunk,
} from "./askStream";

// The wire format between the two chat routes and the shared chat client. It
// is the whole contract between them, so the cases below are the ones that
// actually break a streamed answer: a chunk boundary landing mid-line, several
// lines arriving at once, and an answer whose own text contains newlines.

describe("encoding", () => {
  it("writes one line per delta, newline terminated", () => {
    expect(encodeDelta("Your water ")).toBe('{"delta":"Your water "}\n');
  });

  it("escapes a newline INSIDE a delta so it can't end the line", () => {
    // The answers are full of line breaks (bullets, headers), and a raw one
    // in the payload would split a single delta into two unparseable halves.
    const line = encodeDelta("Next steps:\n- Call a pro");
    expect(line.split("\n")).toHaveLength(2); // the terminator, and nothing else
    expect(JSON.parse(line)).toEqual({ delta: "Next steps:\n- Call a pro" });
  });

  it("carries the same fields the single-shot JSON body carried", () => {
    const line = encodeDone({
      answer: "It is 12 years old.",
      freeRemaining: 2,
      freeLimit: 3,
    });
    expect(JSON.parse(line)).toEqual({
      done: true,
      answer: "It is 12 years old.",
      freeRemaining: 2,
      freeLimit: 3,
    });
  });

  it("omits the meter for a route that never sends one (the pro copilot)", () => {
    expect(JSON.parse(encodeDone({ answer: "Here you go." }))).toEqual({
      done: true,
      answer: "Here you go.",
    });
  });

  it("keeps a null meter as null rather than dropping it", () => {
    // null means "this viewer has no allowance to show" (a member), which the
    // client reads differently from the field being absent.
    const parsed = JSON.parse(
      encodeDone({ answer: "ok", freeRemaining: null, freeLimit: null })
    );
    expect(parsed.freeRemaining).toBeNull();
    expect(parsed.freeLimit).toBeNull();
  });
});

describe("parseNdjsonChunk", () => {
  it("returns whole lines and keeps the partial tail back", () => {
    const { lines, rest } = parseNdjsonChunk("", '{"delta":"a"}\n{"del');
    expect(lines).toEqual(['{"delta":"a"}']);
    expect(rest).toBe('{"del');
  });

  it("rejoins a line split across two chunks", () => {
    // The exact failure this function exists for: a TCP read boundary in the
    // middle of a JSON object. Parsing each chunk on its own throws away the
    // delta; carrying the tail forward recovers it whole.
    const first = parseNdjsonChunk("", '{"delta":"wa');
    expect(first.lines).toEqual([]);
    const second = parseNdjsonChunk(first.rest, 'ter heater"}\n');
    expect(second.lines).toEqual(['{"delta":"water heater"}']);
    expect(second.rest).toBe("");
    expect(JSON.parse(second.lines[0])).toEqual({ delta: "water heater" });
  });

  it("hands back every line when several arrive in one chunk", () => {
    const { lines, rest } = parseNdjsonChunk(
      "",
      encodeDelta("a") + encodeDelta("b") + encodeDone({ answer: "ab" })
    );
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[2])).toMatchObject({ done: true, answer: "ab" });
    expect(rest).toBe("");
  });

  it("survives a line split one byte before its newline", () => {
    const whole = encodeDelta("hello");
    const a = parseNdjsonChunk("", whole.slice(0, whole.length - 1));
    expect(a.lines).toEqual([]);
    const b = parseNdjsonChunk(a.rest, "\n");
    expect(JSON.parse(b.lines[0])).toEqual({ delta: "hello" });
  });

  it("drops blank lines rather than handing back unparseable ones", () => {
    const { lines } = parseNdjsonChunk("", '\n\n{"delta":"a"}\n');
    expect(lines).toEqual(['{"delta":"a"}']);
  });

  it("reassembles a whole answer fed one character at a time", () => {
    // The pathological case: a chunk boundary at every position.
    const wire = encodeDelta("one ") + encodeDelta("two") + encodeDone({
      answer: "one two",
    });
    let rest = "";
    const seen: string[] = [];
    for (const ch of wire) {
      const out = parseNdjsonChunk(rest, ch);
      rest = out.rest;
      seen.push(...out.lines);
    }
    expect(seen.map((l) => JSON.parse(l))).toEqual([
      { delta: "one " },
      { delta: "two" },
      { done: true, answer: "one two" },
    ]);
    expect(rest).toBe("");
  });
});

describe("headers", () => {
  it("tells the client it is a stream, and every proxy not to buffer it", () => {
    expect(NDJSON_HEADERS["content-type"]).toContain(NDJSON_CONTENT_TYPE);
    // Without these a proxy is free to hold the whole body until the response
    // ends, which is exactly the ten-second wait streaming removes.
    expect(NDJSON_HEADERS["x-accel-buffering"]).toBe("no");
    expect(NDJSON_HEADERS["cache-control"]).toContain("no-cache");
    expect(NDJSON_HEADERS["cache-control"]).toContain("no-transform");
  });
});

describe("ndjsonBody", () => {
  async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let out = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out += decoder.decode(value, { stream: true });
    }
    return out;
  }

  it("writes what the producer emits, then closes", async () => {
    const body = ndjsonBody(async (emit) => {
      emit(encodeDelta("a"));
      emit(encodeDelta("b"));
      emit(encodeDone({ answer: "ab" }));
    });
    const text = await readAll(body);
    expect(text.trimEnd().split("\n")).toHaveLength(3);
    expect(JSON.parse(text.trimEnd().split("\n")[2])).toMatchObject({
      done: true,
    });
  });

  it("errors the stream if the producer throws, rather than closing clean", async () => {
    // A clean close with no terminal line would look to the client like a
    // finished answer. The routes never do this (they catch and emit a
    // terminal line), and if one ever did, the client must see a broken
    // connection.
    const body = ndjsonBody(async () => {
      throw new Error("boom");
    });
    await expect(readAll(body)).rejects.toThrow("boom");
  });
});
