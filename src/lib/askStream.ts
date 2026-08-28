// The wire format the two Ask Hearth chat routes use to stream an answer, and
// the line splitter the client reads it back with. Pure and dependency-free on
// purpose: both halves are unit tested in src/lib/askStream.test.ts, and the
// module is imported by a server route AND by a client component, so it must
// not pull in anything server-only.
//
// WHY NDJSON rather than Server-Sent Events. The client already speaks fetch
// (it needs POST with a JSON body, which EventSource cannot do), so SSE would
// have bought a second framing dialect and nothing else. One JSON object per
// line is the whole protocol:
//
//   {"delta":"Your water "}
//   {"delta":"heater is "}
//   {"done":true,"answer":"Your water heater is 12 years old.","freeRemaining":2,"freeLimit":3}
//
// Zero or more delta lines, then EXACTLY one terminal line. The terminal line
// carries the same fields the old single-shot JSON body carried, and its
// `answer` is authoritative: the client shows it verbatim rather than trusting
// its own concatenation of the deltas. That also means a failure part-way
// through the model call needs no separate error channel - the route refunds
// the question and sends the failure line as `answer`, and the client renders
// it the same way it renders a good answer.

/** The content type that tells the client this response is a stream. */
export const NDJSON_CONTENT_TYPE = "application/x-ndjson";

/**
 * Response headers for a streamed answer.
 *
 * `x-accel-buffering: no` and `no-transform` are the two that matter in
 * production: a proxy that buffers the body would hold every delta until the
 * response ended, which is exactly the ten-second wait streaming exists to
 * remove. They are advisory (a proxy is free to ignore them) but they are what
 * nginx and friends look for.
 */
export const NDJSON_HEADERS: Record<string, string> = {
  "content-type": `${NDJSON_CONTENT_TYPE}; charset=utf-8`,
  "cache-control": "no-cache, no-store, no-transform",
  "x-accel-buffering": "no",
};

/** The terminal line's payload, minus the `done` flag itself. */
export type AskDonePayload = {
  answer: string;
  freeRemaining?: number | null;
  freeLimit?: number | null;
  // "free" | "trialing" | "paid", alongside freeRemaining/freeLimit above.
  // The two allowances look identical on the wire (a number and a ceiling),
  // so this is what lets the client tell a Plus trial member apart from a
  // free one. See getPlusTier in src/lib/subscription.ts.
  askTier?: string;
};

/**
 * One chunk of answer text, as a line. JSON.stringify escapes any newline
 * inside the delta, so a line break in the answer can never be mistaken for
 * the end of a line of protocol.
 */
export function encodeDelta(text: string): string {
  return `${JSON.stringify({ delta: text })}\n`;
}

/** The single terminal line. Nothing follows it. */
export function encodeDone(payload: AskDonePayload): string {
  return `${JSON.stringify({ done: true, ...payload })}\n`;
}

/**
 * Split a freshly read chunk into whole lines, carrying the incomplete tail
 * forward.
 *
 * A TCP read boundary lands wherever it likes, so a single delta can arrive as
 * `{"delta":"wa` and `ter heater"}\n` in two chunks. Feed each chunk in with
 * the previous call's `rest` and this hands back only the lines that are
 * actually complete. Blank lines are dropped, so a trailing newline at the end
 * of the stream produces nothing.
 */
export function parseNdjsonChunk(
  buffer: string,
  chunk: string
): { lines: string[]; rest: string } {
  const combined = buffer + chunk;
  const parts = combined.split("\n");
  // The last element is whatever came after the final newline: either "" (the
  // chunk ended on a line boundary) or a partial line to keep for next time.
  const rest = parts.pop() ?? "";
  return { lines: parts.filter((l) => l.trim() !== ""), rest };
}

/**
 * Wrap an async producer as a byte stream of NDJSON lines.
 *
 * The producer writes lines with `emit` and the stream closes when it
 * resolves. It is expected to handle its own failures and emit a terminal line
 * saying so: a producer that throws closes the stream with an error, which the
 * client can only report as a dropped connection.
 *
 * A CLIENT DISCONNECT IS NOT A MODEL FAILURE, and that is what `gone` is for.
 * `emit` used to be a bare `controller.enqueue`, which throws
 * "Invalid state: Controller is already closed" the moment the consumer
 * cancels. Both chat routes call `emit` inside a `try` whose `catch` REFUNDS
 * the question (failedAnswer -> refundAskUsage / refundAiUsage), so every
 * closed tab, navigation, idle-timeout `reader.cancel()`, or deliberate abort
 * read as "the model failed" and handed the daily question back - while the
 * deltas already delivered were the whole answer. Read every delta, abort
 * before the terminal line, repeat: the free tier stops existing.
 *
 * So: once the consumer is gone, every later `emit` is a silent no-op, the
 * producer runs to its natural end against a dead stream, and NOTHING is
 * refunded. That is the deliberate policy - the answer was delivered, so the
 * question is spent. A real producer throw still reaches `controller.error`,
 * which is what keeps a genuine 429 refundable (see the control case in
 * src/lib/redteamA.askStreamDisconnect.test.ts).
 */
export function ndjsonBody(
  produce: (emit: (line: string) => void) => Promise<void>
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  // True once the consumer has hung up: set by cancel(), and also by a failed
  // enqueue, because a stream can reach the closed state without cancel()
  // firing on this object.
  let gone = false;
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        await produce((line) => {
          if (gone) return;
          try {
            controller.enqueue(encoder.encode(line));
          } catch {
            // The consumer left. Not a model failure, and not the producer's
            // problem: swallow it and let every later line drop too.
            gone = true;
          }
        });
      } catch (e) {
        // A real producer failure. Only worth reporting if anyone is still
        // listening; erroring an already-cancelled stream throws again.
        if (!gone) {
          try {
            controller.error(e);
          } catch {
            /* already closed */
          }
        }
        return;
      }
      if (!gone) {
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
    cancel() {
      gone = true;
    },
  });
}
