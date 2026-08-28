import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { encodeDelta, encodeDone, ndjsonBody } from "@/lib/askStream";

// RED-TEAM A (2026-08-28): a client disconnect must not be reported to the
// producer as a model failure.
//
// THE BUG THIS PINS. Both chat routes wrap their model call in exactly this
// shape (src/app/api/ask/route.ts:594-630 and
// src/app/api/pro-ask/route.ts:490-513):
//
//   ndjsonBody(async (emit) => {
//     try {
//       for await (const delta of stream.textDeltas) emit(encodeDelta(delta));
//       emit(encodeDone({ answer: (await stream.final).text, ... }));
//     } catch (e) {
//       emit(encodeDone({ answer: await failedAnswer(e), ... }));   // <-- REFUNDS
//     }
//   })
//
// `failedAnswer` calls refundAskUsage / refundAiUsage. `emit` is
// `controller.enqueue`, and enqueue on a stream the client has cancelled
// throws `TypeError: Invalid state: Controller is already closed`. So the
// moment the browser goes away - a closed tab, a navigation, the client's own
// `reader.cancel()` in AskHearth.consumeStream's `finally`, or a deliberate
// AbortController - the producer takes the disconnect as a model failure and
// hands the question back.
//
// Read every delta, abort just before the terminal line, and you have the
// whole answer AND your daily question returned: Ask Hearth's 3/day free tier
// (and the trial's 8/day) becomes unlimited, bounded only by the 6/minute
// burst window, while Anthropic still bills every call in full.
//
// THE CONTRACT. `emit` after the consumer has gone away must be a no-op, not a
// throw, so the producer's catch stays reserved for real model failures. Fixing
// it here fixes both routes at once and needs no change to either.

async function cancelAfterFirstChunk(
  body: ReadableStream<Uint8Array>
): Promise<void> {
  const reader = body.getReader();
  await reader.read();
  await reader.cancel();
}

describe("red-team A: ndjsonBody and a client that hangs up", () => {
  it("does not surface a client disconnect to the producer as an error", async () => {
    let producerSawError: unknown = null;

    const body = ndjsonBody(async (emit) => {
      try {
        for (const word of ["Your ", "water ", "heater ", "is ", "old."]) {
          emit(encodeDelta(word));
          await new Promise((r) => setTimeout(r, 5));
        }
        emit(encodeDone({ answer: "Your water heater is old." }));
      } catch (e) {
        // In the routes this branch calls failedAnswer(), which refunds the
        // question. It must never be reached because the reader went away.
        producerSawError = e;
      }
    });

    await cancelAfterFirstChunk(body);
    await new Promise((r) => setTimeout(r, 100));

    expect(
      producerSawError,
      "a cancelled reader reached the producer's catch, which is the branch that refunds the question"
    ).toBeNull();
  });

  it("keeps emitting harmlessly after the consumer is gone", async () => {
    // The producer cannot know the reader left, so every remaining emit -
    // deltas AND the terminal line - has to be safe to call.
    const thrown: unknown[] = [];

    const body = ndjsonBody(async (emit) => {
      for (let i = 0; i < 6; i++) {
        try {
          emit(encodeDelta(`chunk ${i}`));
        } catch (e) {
          thrown.push(e);
        }
        await new Promise((r) => setTimeout(r, 5));
      }
      try {
        emit(encodeDone({ answer: "done" }));
      } catch (e) {
        thrown.push(e);
      }
    });

    await cancelAfterFirstChunk(body);
    await new Promise((r) => setTimeout(r, 120));

    expect(thrown, "emit threw after the client disconnected").toEqual([]);
  });

  it("still reports a REAL producer failure to the producer", async () => {
    // The other half of the contract: swallowing a disconnect must not swallow
    // a model error, or a genuinely failed answer would stop being refunded.
    let producerSawError: unknown = null;

    const body = ndjsonBody(async (emit) => {
      try {
        emit(encodeDelta("Your "));
        throw new Error("429 from the model");
      } catch (e) {
        producerSawError = e;
        emit(encodeDone({ answer: "Ask Hearth is busy right now." }));
      }
    });

    const reader = body.getReader();
    // Drain, so the consumer is still attached when the producer throws.
    for (;;) {
      const { done } = await reader.read();
      if (done) break;
    }

    expect(producerSawError).toBeInstanceOf(Error);
    expect((producerSawError as Error).message).toContain("429");
  });
});

// The abort check in each route's catch is a second, narrower version of the
// same policy, and it had the same hole in reverse: "a disconnect is not
// refunded, because the deltas already sent are the answer" is only true when
// deltas were actually sent. A client that hangs up (or a network that drops)
// BEFORE the first delta got nothing at all, and was still charged the
// question. Both routes now gate the no-refund early return on sentAny, so
// only a disconnect that delivered part of an answer keeps the charge.
//
// Source-text assertions: the routes are Next handlers with a Supabase session,
// rate limits and a live model call in front of the branch, so there is no
// harness that reaches it. This at least fails loudly if the gate is dropped.
const routeSrc = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("a disconnect before the first delta is refunded", () => {
  for (const rel of ["../app/api/ask/route.ts", "../app/api/pro-ask/route.ts"]) {
    it(`${rel} gates its no-refund early return on sentAny`, () => {
      const text = routeSrc(rel);
      expect(text).toContain("let sentAny = false;");
      expect(text).toContain("sentAny = true;");
      expect(text).toContain("if (req.signal.aborted && sentAny) return;");
      // The unqualified form charged for an answer nobody ever received.
      expect(text).not.toContain("if (req.signal.aborted) return;");
      // sentAny has to be set inside the delta loop, before the terminal line.
      expect(text.indexOf("sentAny = true;")).toBeLessThan(
        text.indexOf("if (req.signal.aborted && sentAny) return;")
      );
    });
  }
});
