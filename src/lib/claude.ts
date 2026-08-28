// Build-time guard: this module reads ANTHROPIC_API_KEY, so importing it from
// a Client Component must fail the build, not ship the key.
import "server-only";
import Anthropic from "@anthropic-ai/sdk";

// Every AI feature in Hearth runs on Anthropic Claude through the official
// SDK. There is exactly one model id here on purpose: the old Gemini call
// sites each carried their own four-model fallback ladder (free-tier quotas
// meant a 429 on one model had to fall through to the next), and because
// different requests could land on different models mid-conversation, answers
// visibly changed character between turns. One model, one voice.
export const MODEL = "claude-sonnet-5";

// Constructed lazily on first use, NOT at import time, matching the lazy
// Stripe client in src/lib/stripe.ts. A dev machine without the key can still
// render every page that never calls the model; the first real call throws a
// message that names the missing variable.
let client: Anthropic | null = null;

export function getClaude(): Anthropic {
  if (!client) {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) {
      throw new Error(
        "ANTHROPIC_API_KEY is not set. AI features are unavailable until it is added to the environment."
      );
    }
    // One retry, not the SDK's default two: these all run inside a request the
    // user is waiting on, and several callers abort at 30 to 90 seconds. A
    // single retry still covers a transient 429 or 529 without letting a slow
    // call stack up three full timeouts behind the caller's own deadline.
    client = new Anthropic({ apiKey: key, maxRetries: 1 });
  }
  return client;
}

// Cheap pre-check for the routes that degrade gracefully instead of erroring
// (the walkthrough data-plate scan, the job-description draft): they answer
// with reason "no_key" and let the owner type it in by hand.
export function hasClaudeKey(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

// The only image types the Messages API accepts. Anything else (a HEIC a
// browser mislabelled, an empty content-type off a storage download) is sent
// as JPEG, which is what the clients actually upload.
const IMAGE_MEDIA_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
] as const;
type ImageMediaType = (typeof IMAGE_MEDIA_TYPES)[number];

export function toImageMediaType(mime?: string | null): ImageMediaType | null {
  const m = (mime ?? "").split(";")[0].trim().toLowerCase();
  if (m === "image/jpg") return "image/jpeg";
  return (IMAGE_MEDIA_TYPES as readonly string[]).includes(m)
    ? (m as ImageMediaType)
    : null;
}

// What the FILE says it is, read off its first few bytes, ignoring whatever
// the client claimed. Returns null for anything that is not one of the four
// formats the Messages API accepts.
//
// This replaces a blanket "anything unrecognized is JPEG" fallback. That
// fallback was written for a real case (a HEIC a browser mislabelled) but it
// also meant a PDF, a video, or 3MB of random base64 was labelled image/jpeg
// and sent to the paid vision model, which then rejected it - after we had
// paid to upload it and spent the caller's usage on it. Sniffing costs a
// handful of bytes of base64 decoding and settles it before any request.
export function sniffImageMediaType(b64: string): ImageMediaType | null {
  // 24 base64 chars decode to 18 bytes, more than enough for every signature
  // below (WEBP's is the longest at 12).
  let head: Buffer;
  try {
    head = Buffer.from(b64.slice(0, 24), "base64");
  } catch {
    return null;
  }
  if (head.length < 4) return null;
  // JPEG: FF D8 FF
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff)
    return "image/jpeg";
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    head.length >= 8 &&
    head[0] === 0x89 &&
    head[1] === 0x50 &&
    head[2] === 0x4e &&
    head[3] === 0x47 &&
    head[4] === 0x0d &&
    head[5] === 0x0a &&
    head[6] === 0x1a &&
    head[7] === 0x0a
  )
    return "image/png";
  // GIF: "GIF87a" or "GIF89a"
  if (head.length >= 6 && head.subarray(0, 3).toString("latin1") === "GIF")
    return "image/gif";
  // WEBP: "RIFF" .... "WEBP"
  if (
    head.length >= 12 &&
    head.subarray(0, 4).toString("latin1") === "RIFF" &&
    head.subarray(8, 12).toString("latin1") === "WEBP"
  )
    return "image/webp";
  return null;
}

/**
 * The media type to send for an attachment: what the BYTES say it is, never
 * what the caller claimed. Null means "do not send this", and buildContent
 * then drops the block rather than paying to upload something the API is
 * going to refuse anyway.
 *
 * The declared mime is used for nothing but a sanity check: if the bytes do
 * not identify themselves as one of the four supported formats, no label on
 * the request can make them readable.
 */
export function imageMediaTypeFor(img: ClaudeImage): ImageMediaType | null {
  return sniffImageMediaType(img.data);
}

// A base64 attachment, with no "data:" prefix. `mime` is advisory: it gets
// normalized to something the API accepts.
export type ClaudeImage = { data: string; mime?: string | null };
export type ClaudeDocument = { data: string };

// One conversation turn. Text and attachments are both optional so a turn can
// be a bare photo; a turn with neither is dropped before the request is built.
export type ClaudeMessage = {
  role: "user" | "assistant";
  text?: string;
  images?: ClaudeImage[];
  documents?: ClaudeDocument[];
};

export type ClaudeEffort = "low" | "medium" | "high" | "xhigh" | "max";

export type ClaudeUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
};

export type ClaudeResult = {
  text: string;
  stopReason: Anthropic.StopReason | null;
  usage: ClaudeUsage;
};

export type GenerateTextOptions = {
  /**
   * The stable system prompt. This is the part that gets the cache
   * breakpoint, so it must be byte-identical from one request to the next.
   */
  system?: string;
  /**
   * The volatile tail of the system prompt, rendered immediately after
   * `system` as a second block, AFTER the cache breakpoint.
   *
   * This exists because of one specific trap. Both chat routes end their
   * system prompt with a wrapUntrusted() block (the home details, the pro's
   * open leads), and wrapUntrusted mints a fresh random nonce on every call,
   * by design, so a user cannot forge a boundary marker. That nonce made the
   * whole system prompt a different string every request: the cache was
   * rewritten every turn and never once read, which is strictly WORSE than no
   * caching, since a write costs 1.25x and a read costs 0.1x.
   *
   * Splitting fixes it without touching the nonce or rewording a single line
   * of the product's prompt. Caching is a prefix match, so a breakpoint at the
   * end of `system` keeps reading even though everything after it changed.
   * The model sees the identical text either way; only where the breakpoint
   * sits changes.
   */
  systemSuffix?: string;
  /** Conversation history. Use this OR `prompt`, not both. */
  messages?: ClaudeMessage[];
  /** Shorthand for a single user turn. */
  prompt?: string;
  /** Attachments for the single user turn (or appended to the last user turn). */
  images?: ClaudeImage[];
  documents?: ClaudeDocument[];
  maxTokens?: number;
  /**
   * Reasoning budget. Pass "low" for the cheap mechanical routes (a data-plate
   * read, a one-line rewrite) and leave it off where the default is fine.
   */
  effort?: ClaudeEffort;
  /**
   * Extended thinking, as a THREE-state switch:
   *
   *   true      -> adaptive thinking, for work where reasoning earns its cost:
   *                document extraction, quote analysis, compliance review.
   *   false     -> thinking explicitly OFF (generateText only).
   *   undefined -> send nothing, and let the model decide.
   *
   * The third state is the trap, and it is why `false` exists at all:
   * claude-sonnet-5 runs ADAPTIVE THINKING WHEN `thinking` IS OMITTED. Every
   * caller that "left thinking off" by simply not passing the option was in
   * fact paying for a reasoning pass on every request. That is fine for the
   * batch routes and wrong for the two chat routes, where a homeowner is
   * watching a spinner: those pass `thinking: false` and get the reply
   * straight away. NOTE that generateJson still only acts on `true` (nothing
   * passes it `false`), so an explicit disable there is a no-op today.
   *
   * NOTE: there is deliberately no `temperature` option. The Gemini call sites
   * this replaced pinned temperature 0 or 0.4; claude-sonnet-5 rejects the
   * parameter outright ("`temperature` is deprecated for this model", 400).
   * Determinism on the extraction routes now comes from structured outputs and
   * the prompt, not from a sampling knob.
   */
  thinking?: boolean;
  /**
   * Put a cache breakpoint on the system prompt. On by default. Prompts under
   * the model's minimum cacheable prefix simply don't cache, with no error.
   */
  cacheSystem?: boolean;
  timeoutMs?: number;
  /**
   * Cancel the request when the caller goes away. Honored by streamText only
   * (nothing needs it on the non-streaming path yet).
   *
   * The two chat routes pass `req.signal`. Without it, a homeowner who closes
   * the tab mid-answer leaves the model call running to completion and
   * Anthropic bills the whole reply for text nobody will ever read - and,
   * because ndjsonBody now drops every write after a disconnect, that spend
   * would have been completely invisible. Node's fetch aborts the underlying
   * HTTP request, so the tokens stop being generated rather than merely being
   * ignored.
   */
  signal?: AbortSignal;
  /** Name used in the debug cost log. */
  label?: string;
};

export type GenerateJsonOptions<T> = Omit<GenerateTextOptions, "prompt"> & {
  prompt?: string;
  /**
   * A JSON Schema object describing the reply. The model is constrained to it
   * server-side (structured outputs), so there is no JSON-in-prose to regex
   * out of the text and no "reply with only JSON" instruction to ignore.
   */
  schema: Record<string, unknown>;
};

export type ClaudeJsonResult<T> = ClaudeResult & { data: T | null };

// Debug-level cost log. Not console.log: this fires on every AI request and
// should stay out of normal server output. Run with DEBUG unset to silence it.
function logUsage(label: string, usage: Anthropic.Usage) {
  console.debug(
    `[claude] ${label} model=${MODEL} in=${usage.input_tokens} out=${usage.output_tokens} ` +
      `cache_read=${usage.cache_read_input_tokens ?? 0} cache_write=${usage.cache_creation_input_tokens ?? 0}`
  );
}

function toUsage(usage: Anthropic.Usage): ClaudeUsage {
  return {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
    cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
  };
}

function buildContent(m: ClaudeMessage): Anthropic.ContentBlockParam[] {
  const blocks: Anthropic.ContentBlockParam[] = [];
  if (m.text && m.text.trim()) blocks.push({ type: "text", text: m.text });
  for (const img of m.images ?? []) {
    if (!img?.data) continue;
    // Bytes decide. Anything that is not really a JPEG, PNG, GIF, or WEBP is
    // dropped here rather than uploaded and rejected at the other end.
    const mediaType = imageMediaTypeFor(img);
    if (!mediaType) continue;
    blocks.push({
      type: "image",
      source: {
        type: "base64",
        media_type: mediaType,
        data: img.data,
      },
    });
  }
  for (const doc of m.documents ?? []) {
    if (!doc?.data) continue;
    blocks.push({
      type: "document",
      source: {
        type: "base64",
        media_type: "application/pdf",
        data: doc.data,
      },
    });
  }
  return blocks;
}

function buildMessages(opts: GenerateTextOptions): Anthropic.MessageParam[] {
  const turns: ClaudeMessage[] = opts.messages?.length
    ? [...opts.messages]
    : [{ role: "user", text: opts.prompt ?? "" }];

  // Single-shot callers pass their attachments alongside the prompt; hang them
  // off the last user turn.
  if (opts.images?.length || opts.documents?.length) {
    for (let i = turns.length - 1; i >= 0; i--) {
      if (turns[i].role === "user") {
        turns[i] = {
          ...turns[i],
          images: [...(turns[i].images ?? []), ...(opts.images ?? [])],
          documents: [...(turns[i].documents ?? []), ...(opts.documents ?? [])],
        };
        break;
      }
    }
  }

  const built: Anthropic.MessageParam[] = [];
  for (const t of turns) {
    const content = buildContent(t);
    if (!content.length) continue;
    built.push({ role: t.role, content });
  }

  // The first message must be a user turn, and there must be at least one.
  // A leading assistant turn is the chat's canned greeting, so drop it.
  while (built.length && built[0].role !== "user") built.shift();
  // A TRAILING assistant turn would be an assistant prefill, which this model
  // rejects with a 400. The chat clients always end their history with the
  // question just asked, so this only ever fires on a malformed request.
  while (built.length && built[built.length - 1].role !== "user") built.pop();
  // NOTHING TO SEND. This used to push a single empty text block, which the
  // API rejects with a 400 ("text content blocks must be non-empty") - and the
  // caller had already spent the user's question by then. An empty list is the
  // honest answer; generateText/generateJson turn it into EmptyPromptError
  // before any request goes out, so no quota is burned on a call that could
  // never have succeeded.
  return built;
}

/**
 * Thrown instead of calling the API when there is literally nothing to send:
 * no text, no image, no document on any turn. Its own class so a caller can
 * tell "the request was malformed" apart from "the model failed", and refund
 * or 400 accordingly rather than charging for a call that never happened.
 */
export class EmptyPromptError extends Error {
  constructor() {
    super("Nothing to send to the model: every message was empty.");
    this.name = "EmptyPromptError";
  }
}

export function isEmptyPromptError(e: unknown): boolean {
  return e instanceof EmptyPromptError;
}

// Shared by generateText and generateJson: build the turns, and refuse to
// spend a request on an empty one.
function requireMessages(opts: GenerateTextOptions): Anthropic.MessageParam[] {
  const messages = buildMessages(opts);
  if (!messages.length) throw new EmptyPromptError();
  return messages;
}

function buildSystem(
  opts: GenerateTextOptions
): Anthropic.TextBlockParam[] | undefined {
  if (!opts.system && !opts.systemSuffix) return undefined;
  const cache = opts.cacheSystem ?? true;
  const blocks: Anthropic.TextBlockParam[] = [];
  if (opts.system) {
    blocks.push({
      type: "text",
      text: opts.system,
      // The breakpoint goes here, at the end of the STABLE part, never at the
      // end of the whole prompt: a marker after a volatile tail writes a fresh
      // cache entry every request and reads none of them.
      //
      // ttl "1h" rather than the default 5 minutes, because Hearth's traffic
      // shape is gaps, not bursts: a homeowner asks a question, goes to look
      // at the water heater, and comes back ten minutes later. At 5 minutes
      // that second question paid full price for a prefix we had already
      // written. The trade is a 2x write instead of 1.25x, which needs three
      // requests against one entry to pay off instead of two - comfortably met
      // by a real chat session, and by the tool routes whose system prompt is
      // byte-identical for every user who runs them.
      ...(cache
        ? { cache_control: { type: "ephemeral" as const, ttl: "1h" as const } }
        : {}),
    });
  }
  if (opts.systemSuffix) {
    blocks.push({ type: "text", text: opts.systemSuffix });
  }
  return blocks;
}

function textOf(content: Anthropic.ContentBlock[]): string {
  return content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
}

/**
 * True when the call failed because Anthropic throttled us (429) or is
 * overloaded (529). The routes that degrade gracefully report this separately
 * from a generic failure, the way they used to report a Gemini 429.
 */
export function isRateLimitError(e: unknown): boolean {
  return (
    e instanceof Anthropic.RateLimitError ||
    (e instanceof Anthropic.APIError && e.status === 529)
  );
}

/**
 * Plain-English reason a reply came back unusable, or null when it is fine.
 * Callers surface this instead of a raw stop_reason or an empty bubble.
 */
export function claudeFailureMessage(
  stopReason: Anthropic.StopReason | null,
  text: string
): string | null {
  if (stopReason === "refusal") {
    return "I can't help with that one. Try asking about your home instead.";
  }
  if (!text) {
    if (stopReason === "max_tokens") {
      return "That answer got too long to finish. Try asking for a shorter version.";
    }
    return "Sorry, I couldn't generate an answer. Please try again.";
  }
  return null;
}

/**
 * The request body, built once and shared by generateText and streamText.
 *
 * Both paths MUST send byte-identical requests. They do not just answer the
 * same question, they answer it against the same prompt cache: a system block
 * whose cache_control sat in a different place, or a `thinking` field one path
 * omitted, would be a different prefix and would quietly halve the cache hit
 * rate of whichever route streamed. One builder, no chance to drift.
 *
 * Throws EmptyPromptError (via requireMessages) before any request goes out,
 * so a caller that streams gets that failure synchronously, in the same shape
 * the non-streaming path has always thrown it.
 */
function buildTextRequest(
  opts: GenerateTextOptions
): Anthropic.MessageCreateParamsNonStreaming {
  const system = buildSystem(opts);
  const messages = requireMessages(opts);
  return {
    model: MODEL,
    max_tokens: opts.maxTokens ?? 4096,
    ...(system ? { system } : {}),
    messages,
    // Three-state, see the `thinking` doc above: omitting the field is NOT
    // the same as disabling it on this model.
    ...(opts.thinking === true
      ? { thinking: { type: "adaptive" as const } }
      : opts.thinking === false
        ? { thinking: { type: "disabled" as const } }
        : {}),
    ...(opts.effort ? { output_config: { effort: opts.effort } } : {}),
  };
}

/**
 * One non-streaming Claude call, returning the reply text plus the two things
 * every caller has to check: why it stopped, and what it cost.
 *
 * `text` is empty on a refusal or an empty completion; `stopReason` says
 * which. A truncated reply (stop_reason "max_tokens") still returns the
 * partial text, because a partial answer beats an apology.
 */
export async function generateText(
  opts: GenerateTextOptions
): Promise<ClaudeResult> {
  const res = await getClaude().messages.create(
    buildTextRequest(opts),
    opts.timeoutMs ? { timeout: opts.timeoutMs } : undefined
  );

  logUsage(opts.label ?? "generateText", res.usage);
  return {
    text: textOf(res.content),
    stopReason: res.stop_reason,
    usage: toUsage(res.usage),
  };
}

/**
 * A streaming call in flight: the text as it arrives, and the whole reply once
 * it has.
 *
 * `textDeltas` yields the model's visible text in the order it is generated,
 * nothing else (thinking blocks and tool blocks are not text and never appear
 * here). `final` resolves with exactly what generateText would have returned
 * for the same options, so a caller can stream for the feel of it and still
 * make its real decision on the finished text.
 */
export type ClaudeStream = {
  textDeltas: AsyncIterable<string>;
  final: Promise<ClaudeResult>;
};

/**
 * The same call as generateText, delivered as it is written.
 *
 * This exists for the two chat routes, where the homeowner or the pro is
 * watching an empty bubble: a 150-word answer takes about ten seconds to
 * generate in full, and roughly one second to start. Nothing about the request
 * changes (see buildTextRequest), so the answer, the cost, and the cache
 * behaviour are identical - only the delivery differs.
 *
 * DELIBERATELY NOT ASYNC. EmptyPromptError has to be thrown before the API
 * call, and a caller that has already sent response headers cannot turn a
 * throw back into a 400. Being synchronous up to the point the request opens
 * lets a route call this first, keep its existing catch for that case, and
 * only then commit to a streamed response.
 *
 * Errors after that point (a 429, a dropped connection, a timeout) surface
 * from BOTH `textDeltas` and `final`, as the same error classes the
 * non-streaming path throws, so isRateLimitError still answers correctly.
 */
export function streamText(opts: GenerateTextOptions): ClaudeStream {
  const request = buildTextRequest(opts);
  // The SDK's per-request options (node_modules/@anthropic-ai/sdk/internal/
  // request-options.d.ts): `timeout` as before, plus `signal`, which is
  // forwarded straight to fetch. Built conditionally so a call with neither
  // still passes `undefined` and stays byte-identical to what generateText
  // sends - see the request-parity test in src/lib/claude.stream.test.ts.
  const requestOptions: { timeout?: number; signal?: AbortSignal } = {};
  if (opts.timeoutMs) requestOptions.timeout = opts.timeoutMs;
  if (opts.signal) requestOptions.signal = opts.signal;
  const stream = getClaude().messages.stream(
    request,
    Object.keys(requestOptions).length > 0 ? requestOptions : undefined
  );

  const final = stream.finalMessage().then((msg) => {
    // Same cost line as the non-streaming path, on the same label, so the two
    // are indistinguishable in the logs.
    logUsage(opts.label ?? "streamText", msg.usage);
    return {
      text: textOf(msg.content),
      stopReason: msg.stop_reason,
      usage: toUsage(msg.usage),
    };
  });
  // A caller that gives up part-way through (the browser navigated away) never
  // awaits `final`, and an unawaited rejected promise takes the whole Node
  // process down. The rejection still reaches whoever does await it: this only
  // marks it as handled.
  final.catch(() => {});

  async function* textDeltas(): AsyncGenerator<string> {
    for await (const event of stream) {
      if (
        event.type === "content_block_delta" &&
        event.delta.type === "text_delta" &&
        event.delta.text
      ) {
        yield event.delta.text;
      }
    }
  }

  return { textDeltas: textDeltas(), final };
}

/**
 * Same call, constrained to a JSON Schema with structured outputs. `data` is
 * the parsed object, or null when the model refused, ran out of output budget
 * mid-object, or returned nothing.
 */
export async function generateJson<T>(
  opts: GenerateJsonOptions<T>
): Promise<ClaudeJsonResult<T>> {
  const system = buildSystem(opts);
  const messages = requireMessages(opts);
  const res = await getClaude().messages.create(
    {
      model: MODEL,
      max_tokens: opts.maxTokens ?? 4096,
      ...(system ? { system } : {}),
      messages,
      ...(opts.thinking ? { thinking: { type: "adaptive" as const } } : {}),
      output_config: {
        ...(opts.effort ? { effort: opts.effort } : {}),
        format: { type: "json_schema", schema: opts.schema },
      },
    },
    opts.timeoutMs ? { timeout: opts.timeoutMs } : undefined
  );

  logUsage(opts.label ?? "generateJson", res.usage);
  const text = textOf(res.content);
  let data: T | null = null;
  if (text) {
    try {
      data = JSON.parse(text) as T;
    } catch {
      // Structured outputs should make this unreachable; a truncated reply
      // (max_tokens mid-object) is the one way it happens. Null, not a throw:
      // every caller already has a "couldn't read it" path.
      data = null;
    }
  }
  return {
    data,
    text,
    stopReason: res.stop_reason,
    usage: toUsage(res.usage),
  };
}
