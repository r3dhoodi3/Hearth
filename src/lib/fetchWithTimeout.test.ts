import { describe, expect, it } from "vitest";
import { isTimeoutError, readWithTimeout } from "./fetchWithTimeout";

// The IDLE half of the streaming budget. fetchWithTimeout covers time to
// headers; this covers the gap between chunks after that, because a streamed
// answer has no honest total duration to cap - a long answer and a dead socket
// look identical to a whole-request timer.

describe("readWithTimeout", () => {
  it("passes a chunk straight through when one arrives in time", async () => {
    const reader = { read: async () => ({ done: false, value: "hello" }) };
    await expect(readWithTimeout(reader, 50)).resolves.toEqual({
      done: false,
      value: "hello",
    });
  });

  it("passes the end of the stream through too", async () => {
    const reader = {
      read: async () => ({ done: true, value: undefined }) as const,
    };
    const out = await readWithTimeout(reader, 50);
    expect(out.done).toBe(true);
  });

  it("throws a timeout when the connection goes quiet", async () => {
    // Never resolves: the socket is open and nothing is coming.
    const reader = { read: () => new Promise<never>(() => {}) };
    const caught = await readWithTimeout(reader, 20).catch((e) => e);
    // The same error class fetchWithTimeout throws, so the chat can keep one
    // "that took too long" path rather than growing a second one.
    expect(isTimeoutError(caught)).toBe(true);
  });

  it("does not fire once the read has already won the race", async () => {
    const reader = {
      read: () =>
        new Promise<{ done: boolean; value: string }>((resolve) =>
          setTimeout(() => resolve({ done: false, value: "late" }), 10)
        ),
    };
    const out = await readWithTimeout(reader, 60);
    expect(out).toEqual({ done: false, value: "late" });
    // The timer is cleared in a finally, so nothing rejects afterwards; if it
    // were not, this wait would surface an unhandled rejection.
    await new Promise((r) => setTimeout(r, 80));
  });
});
