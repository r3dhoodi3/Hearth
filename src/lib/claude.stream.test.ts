import { beforeEach, describe, expect, it, vi } from "vitest";

// src/lib/claude.ts imports "server-only", which throws the moment it is
// pulled in outside a server component, and the Anthropic SDK, which would
// otherwise want a real key and a real network. Both are stubbed so the
// REQUEST BUILDING can be exercised for real - which is the whole point of
// this file: streamText and generateText must send byte-identical requests, or
// the streamed route quietly runs on a different prompt cache from the one it
// shares with everything else.
vi.mock("server-only", () => ({}));

type Call = { body: any; options: any };
const created: Call[] = [];
const streamed: Call[] = [];

// What the fake stream will replay, set per test.
let events: any[] = [];
let finalMessage: any = null;
let failWith: unknown = null;

class MockAPIError extends Error {
  status: number;
  constructor(status: number, message = "api error") {
    super(message);
    this.status = status;
  }
}
class MockRateLimitError extends MockAPIError {
  constructor() {
    super(429, "rate limited");
  }
}

function fakeStream() {
  return {
    async *[Symbol.asyncIterator]() {
      for (const e of events) {
        if (failWith && e === "throw") throw failWith;
        yield e;
      }
      if (failWith) throw failWith;
    },
    async finalMessage() {
      if (failWith) throw failWith;
      return finalMessage;
    },
  };
}

class MockAnthropic {
  static APIError = MockAPIError;
  static RateLimitError = MockRateLimitError;
  messages = {
    create: async (body: any, options: any) => {
      created.push({ body, options });
      return finalMessage;
    },
    stream: (body: any, options: any) => {
      streamed.push({ body, options });
      return fakeStream();
    },
  };
  constructor(_opts: unknown) {}
}

vi.mock("@anthropic-ai/sdk", () => ({ default: MockAnthropic }));

process.env.ANTHROPIC_API_KEY = "test-key";

const { streamText, generateText, isEmptyPromptError, isRateLimitError } =
  await import("./claude");

const textEvent = (text: string) => ({
  type: "content_block_delta",
  delta: { type: "text_delta", text },
});

const message = (text: string) => ({
  content: [{ type: "text", text }],
  stop_reason: "end_turn",
  usage: {
    input_tokens: 10,
    output_tokens: 4,
    cache_read_input_tokens: 900,
    cache_creation_input_tokens: 0,
  },
});

// The options both chat routes pass, in the shape they pass them.
const ASK_OPTIONS = {
  system: "You are Hearth.",
  systemSuffix: "<<HOME DETAILS nonce>>\nRoof, 2004\n<</HOME DETAILS>>",
  messages: [{ role: "user" as const, text: "Why is my heater loud?" }],
  thinking: false,
  effort: "low" as const,
  maxTokens: 4096,
  timeoutMs: 90_000,
  label: "ask",
};

beforeEach(() => {
  created.length = 0;
  streamed.length = 0;
  events = [textEvent("Hello")];
  finalMessage = message("Hello");
  failWith = null;
});

describe("streamText sends the same request generateText does", () => {
  it("matches it field for field, including where the cache breakpoint sits", async () => {
    await generateText(ASK_OPTIONS);
    streamText(ASK_OPTIONS);
    expect(streamed).toHaveLength(1);
    expect(created).toHaveLength(1);
    expect(streamed[0].body).toEqual(created[0].body);
    // The timeout rides in the request options, not the body, on both paths.
    expect(streamed[0].options).toEqual(created[0].options);
    expect(streamed[0].options).toEqual({ timeout: 90_000 });
  });

  it("keeps the breakpoint on the STABLE block, never after the volatile tail", () => {
    // The whole reason systemSuffix exists: wrapUntrusted mints a fresh nonce
    // per request, so a breakpoint at the end of the full prompt would rewrite
    // the cache every turn and read none of it back.
    streamText(ASK_OPTIONS);
    const system = streamed[0].body.system;
    expect(system).toHaveLength(2);
    expect(system[0].text).toBe(ASK_OPTIONS.system);
    expect(system[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(system[1].text).toBe(ASK_OPTIONS.systemSuffix);
    expect(system[1].cache_control).toBeUndefined();
  });

  it("disables thinking explicitly and carries the effort setting", () => {
    // Omitting `thinking` is NOT the same as disabling it on this model: the
    // chat would silently pay for a reasoning pass before the first word.
    streamText(ASK_OPTIONS);
    expect(streamed[0].body.thinking).toEqual({ type: "disabled" });
    expect(streamed[0].body.output_config).toEqual({ effort: "low" });
    expect(streamed[0].body.max_tokens).toBe(4096);
    expect(streamed[0].body.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "Why is my heater loud?" }] },
    ]);
  });
});

describe("streamText delivers the answer", () => {
  it("yields the text deltas in order and nothing else", async () => {
    events = [
      { type: "message_start", message: {} },
      { type: "content_block_start", content_block: { type: "text" } },
      textEvent("Your water "),
      // A thinking delta is not visible text and must never reach the bubble.
      { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "hmm" } },
      textEvent("heater is 12."),
      { type: "content_block_stop", index: 0 },
      { type: "message_stop" },
    ];
    finalMessage = message("Your water heater is 12.");

    const { textDeltas } = streamText(ASK_OPTIONS);
    const seen: string[] = [];
    for await (const d of textDeltas) seen.push(d);
    expect(seen).toEqual(["Your water ", "heater is 12."]);
    expect(seen.join("")).toBe("Your water heater is 12.");
  });

  it("resolves the final text, stop reason, and usage", async () => {
    const { final } = streamText(ASK_OPTIONS);
    const result = await final;
    expect(result.text).toBe("Hello");
    expect(result.stopReason).toBe("end_turn");
    expect(result.usage).toEqual({
      inputTokens: 10,
      outputTokens: 4,
      cacheReadInputTokens: 900,
      cacheCreationInputTokens: 0,
    });
  });

  it("returns the same result shape generateText would for the same reply", async () => {
    const one = await generateText(ASK_OPTIONS);
    const two = await streamText(ASK_OPTIONS).final;
    expect(two).toEqual(one);
  });
});

describe("streamText fails the way the routes already handle", () => {
  it("throws EmptyPromptError SYNCHRONOUSLY, before opening a request", () => {
    // The routes rely on this: a throw before the response headers go out can
    // still be turned into a 400, one after them cannot.
    let caught: unknown = null;
    try {
      streamText({ ...ASK_OPTIONS, messages: [{ role: "user", text: "   " }] });
    } catch (e) {
      caught = e;
    }
    expect(isEmptyPromptError(caught)).toBe(true);
    expect(streamed).toHaveLength(0);
  });

  it("surfaces a rate limit from the stream as the same error class", async () => {
    failWith = new MockRateLimitError();
    const { textDeltas, final } = streamText(ASK_OPTIONS);
    let caught: unknown = null;
    try {
      for await (const _ of textDeltas) {
        /* the throw lands on the first read */
      }
    } catch (e) {
      caught = e;
    }
    expect(isRateLimitError(caught)).toBe(true);
    // ...and `final` rejects too, rather than hanging the route forever.
    await expect(final).rejects.toBeInstanceOf(MockRateLimitError);
  });

  it("treats an overload (529) as a rate limit, exactly as before", async () => {
    failWith = new MockAPIError(529, "overloaded");
    const { final } = streamText(ASK_OPTIONS);
    const caught = await final.catch((e) => e);
    expect(isRateLimitError(caught)).toBe(true);
  });
});
