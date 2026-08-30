import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// src/lib/claude.ts imports "server-only" (throws outside a server component)
// and the Anthropic SDK (wants a real key and a real network). Both are
// stubbed so the REQUEST BUILDING runs for real, which is the point: this file
// pins which model every feature in Hearth actually calls, and what shape the
// request is in when it gets there.
vi.mock("server-only", () => ({}));

type Call = { body: any; options: any };
const created: Call[] = [];
const streamed: Call[] = [];

let finalMessage: any = null;
// Set to throw from the NEXT messages.create only, then cleared: that is how
// the structured-output fallback is exercised without a network.
let throwOnceFromCreate: unknown = null;

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

class MockAnthropic {
  static APIError = MockAPIError;
  static RateLimitError = MockRateLimitError;
  messages = {
    create: async (body: any, options: any) => {
      if (throwOnceFromCreate) {
        const err = throwOnceFromCreate;
        throwOnceFromCreate = null;
        throw err;
      }
      created.push({ body, options });
      return finalMessage;
    },
    stream: (body: any, options: any) => {
      streamed.push({ body, options });
      return {
        async *[Symbol.asyncIterator]() {
          /* nothing to replay: only the request shape matters here */
        },
        async finalMessage() {
          return finalMessage;
        },
      };
    },
  };
  constructor(_opts: unknown) {}
}

vi.mock("@anthropic-ai/sdk", () => ({ default: MockAnthropic }));

process.env.ANTHROPIC_API_KEY = "test-key";

const { MODEL, FAST_MODEL, ROUTES, streamText, generateText, generateJson } =
  await import("./claude");

const usage = {
  input_tokens: 10,
  output_tokens: 4,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};

beforeEach(() => {
  created.length = 0;
  streamed.length = 0;
  throwOnceFromCreate = null;
  finalMessage = {
    content: [{ type: "text", text: '{"ok":true}' }],
    stop_reason: "end_turn",
    usage,
  };
});

// ---------------------------------------------------------------------------
// The table itself
// ---------------------------------------------------------------------------

describe("the ROUTES table is the one place a model is chosen", () => {
  it("names a known model and a real output ceiling for every route", () => {
    const keys = Object.keys(ROUTES);
    expect(keys.length).toBeGreaterThan(0);
    for (const [key, row] of Object.entries(ROUTES)) {
      expect([MODEL, FAST_MODEL], `${key} model`).toContain(row.model);
      expect(row.maxTokens, `${key} maxTokens`).toBeGreaterThan(0);
    }
  });

  it("never sends Haiku a field it cannot take", () => {
    // Haiku 4.5 predates adaptive thinking and does not take the full effort
    // ladder. A field it rejects is a 400, which is a broken feature rather
    // than a slower one, so the table must not carry either for it.
    for (const [key, row] of Object.entries(ROUTES)) {
      if (row.model !== FAST_MODEL) continue;
      expect(row.effort, `${key} must not set effort on ${FAST_MODEL}`).toBeUndefined();
      expect(
        row.thinking,
        `${key} must not set thinking on ${FAST_MODEL}`
      ).toBeUndefined();
    }
  });

  it("keeps the two chats on the strong model", () => {
    // Where the answer IS the product, cost is not the deciding vote.
    expect(ROUTES.ask.model).toBe(MODEL);
    expect(ROUTES["pro-ask"].model).toBe(MODEL);
    // ...and keeps thinking explicitly OFF on both: omitting the field runs
    // adaptive thinking on this model, which is a full reasoning pass before
    // the first word of a chat somebody is watching a spinner for.
    expect(ROUTES.ask.thinking).toBe(false);
    expect(ROUTES["pro-ask"].thinking).toBe(false);
  });

  it("keeps the routes whose output nobody re-reads on the strong model", () => {
    // Each of these writes into a home record, a letter to an assessor, a
    // packet to an insurer, or a verdict on a contractor's price. A quiet
    // mistake there is invisible until it costs money.
    for (const key of [
      "extract-document",
      "ingest-inspection",
      "insurance-packet",
      "tax-appeal",
      "quote-transcribe",
      "quote-diagnose",
      "pro-compliance",
    ] as const) {
      expect(ROUTES[key].model, key).toBe(MODEL);
    }
  });
});

// ---------------------------------------------------------------------------
// Every call site is on the table
// ---------------------------------------------------------------------------

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith(".ts") && !full.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

const SRC = fileURLToPath(new URL("../", import.meta.url));

describe("no model call picks its own model", () => {
  const files = walk(SRC).filter((f) => {
    const text = readFileSync(f, "utf8");
    return (
      !f.replace(/\\/g, "/").endsWith("/lib/claude.ts") &&
      // Generics get in the way of a tidier pattern: generateJson is called as
      // generateJson<Record<string, unknown>>({ ... }) at most call sites.
      /\b(generateText|generateJson|streamText)[^(\n]*\(\{/.test(text)
    );
  });

  it("finds the call sites at all (a rename must not silently empty this)", () => {
    expect(files.length).toBeGreaterThanOrEqual(11);
  });

  it("passes a route key from the table, and no hand-rolled model id", () => {
    const known = new Set(Object.keys(ROUTES));
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      const routes = [...text.matchAll(/\broute: "([a-z-]+)"/g)].map((m) => m[1]);
      expect(routes.length, `${file} passes no route`).toBeGreaterThan(0);
      for (const r of routes) expect(known, `${file} -> ${r}`).toContain(r);
      // A model id typed at a call site is the thing the table exists to
      // prevent: it would be invisible to the cost table and to this test.
      expect(text, `${file} names a model directly`).not.toMatch(
        /model:\s*"claude-/
      );
    }
  });
});

// ---------------------------------------------------------------------------
// What actually goes on the wire
// ---------------------------------------------------------------------------

describe("the table decides the request", () => {
  it("puts a cheap route on the cheap model with no effort or thinking", async () => {
    await generateText({
      route: "draft-apply",
      system: "You draft apply messages.",
      prompt: "Draft it.",
    });
    expect(created[0].body.model).toBe(FAST_MODEL);
    expect(created[0].body.max_tokens).toBe(ROUTES["draft-apply"].maxTokens);
    expect(created[0].body.output_config).toBeUndefined();
    expect(created[0].body.thinking).toBeUndefined();
  });

  it("drops effort and thinking even when a caller passes them for Haiku", () => {
    // Defence in depth: a future call site that copies an option block from a
    // Sonnet route must not turn a working feature into a 400.
    streamText({
      route: "draft-job",
      system: "You draft jobs.",
      prompt: "Draft it.",
      effort: "high",
      thinking: true,
    });
    expect(streamed[0].body.model).toBe(FAST_MODEL);
    expect(streamed[0].body.output_config).toBeUndefined();
    expect(streamed[0].body.thinking).toBeUndefined();
  });

  it("keeps effort and thinking on the strong model", async () => {
    await generateText({
      route: "ask",
      system: "You are Hearth.",
      prompt: "Why is my heater loud?",
    });
    expect(created[0].body.model).toBe(MODEL);
    expect(created[0].body.thinking).toEqual({ type: "disabled" });
    expect(created[0].body.output_config).toEqual({ effort: "low" });
    expect(created[0].body.max_tokens).toBe(ROUTES.ask.maxTokens);
  });

  it("still honours an explicit override, so old call sites and tests hold", async () => {
    await generateText({
      system: "You are Hearth.",
      prompt: "Hi",
      maxTokens: 777,
      effort: "medium",
      thinking: false,
    });
    expect(created[0].body.model).toBe(MODEL);
    expect(created[0].body.max_tokens).toBe(777);
    expect(created[0].body.output_config).toEqual({ effort: "medium" });
  });

  it("caches the stable system block whichever model is answering", () => {
    // Caches are model-scoped, so the two models never share an entry - but
    // each still needs its own breakpoint, and it must sit at the end of the
    // STABLE text, never after the volatile tail.
    streamText({
      route: "pro-ask",
      system: "Stable prompt.",
      systemSuffix: "Volatile tail with a fresh nonce.",
      prompt: "How much is a lead?",
    });
    const system = streamed[0].body.system;
    expect(system[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(system[1].cache_control).toBeUndefined();
  });
});

describe("structured outputs survive a model that will not take them", () => {
  it("sends the schema on the cheap model", async () => {
    const res = await generateJson({
      route: "pro-tools",
      system: "You extract fields.",
      prompt: "Do it.",
      schema: { type: "object" },
    });
    expect(created[0].body.model).toBe(FAST_MODEL);
    expect(created[0].body.output_config.format).toEqual({
      type: "json_schema",
      schema: { type: "object" },
    });
    expect(res.data).toEqual({ ok: true });
  });

  // LAST, deliberately: the fallback is remembered for the life of the module,
  // so this test permanently changes what the ones after it would see.
  it("falls back to the strong model on a 400, and remembers", async () => {
    throwOnceFromCreate = new MockAPIError(400, "output_config.format not supported");
    const res = await generateJson({
      route: "pro-past-jobs",
      system: "You extract fields.",
      prompt: "Do it.",
      schema: { type: "object" },
    });
    // The caller still gets its parsed object: a rejected feature must not
    // become a failed request for the person waiting on it.
    expect(res.data).toEqual({ ok: true });
    expect(created).toHaveLength(1);
    expect(created[0].body.model).toBe(MODEL);
    expect(created[0].body.output_config.format).toBeDefined();

    // And the next call on that model goes straight to the fallback, so the
    // rejection costs one extra call per process rather than one per request.
    created.length = 0;
    await generateJson({
      route: "pro-tools",
      system: "You extract fields.",
      prompt: "Do it.",
      schema: { type: "object" },
    });
    expect(created[0].body.model).toBe(MODEL);
  });

  it("still throws anything that is not a 400", async () => {
    throwOnceFromCreate = new MockRateLimitError();
    await expect(
      generateJson({
        route: "extract-document",
        system: "You extract fields.",
        prompt: "Do it.",
        schema: { type: "object" },
      })
    ).rejects.toBeInstanceOf(MockRateLimitError);
  });
});
