// fetch with a hard timeout, for the long-running AI endpoints (extract,
// analyze, transcribe, ask, ingest). Without this a hung serverless call
// strands the UI on "Reading the document..." forever with no escape.
// Callers should catch, check isTimeoutError(), and offer a retry path that
// re-enables the form.
export class FetchTimeoutError extends Error {
  constructor(ms: number) {
    super(`Request timed out after ${ms}ms`);
    this.name = "FetchTimeoutError";
  }
}

export function isTimeoutError(e: unknown): e is FetchTimeoutError {
  return e instanceof FetchTimeoutError;
}

/**
 * One read from a streaming response body, under an IDLE budget.
 *
 * fetchWithTimeout guards a single number: how long the whole request may
 * take. That is the right guard for a request that answers once, and the wrong
 * one for a streamed answer, where the total time is legitimately open-ended
 * and what actually signals a dead connection is silence. So a streaming
 * caller splits the budget in two: fetchWithTimeout covers time-to-headers,
 * and this covers the gap between chunks after that.
 *
 * Throws the same FetchTimeoutError, so isTimeoutError() still tells a caller
 * "this timed out" rather than "this broke". The caller should cancel the
 * reader afterwards: losing the race does not stop the underlying read.
 */
export async function readWithTimeout<T>(
  reader: { read(): Promise<ReadableStreamReadResult<T>> },
  timeoutMs = 30_000
): Promise<ReadableStreamReadResult<T>> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new FetchTimeoutError(timeoutMs)),
          timeoutMs
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs = 90_000
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  // Honor a caller-supplied signal (e.g. a Cancel button) alongside the timer.
  const upstream = init.signal;
  let onUpstreamAbort: (() => void) | null = null;
  if (upstream) {
    if (upstream.aborted) controller.abort();
    else {
      onUpstreamAbort = () => controller.abort();
      upstream.addEventListener("abort", onUpstreamAbort, { once: true });
    }
  }

  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (e) {
    // Distinguish "timer fired" from "caller cancelled": only the former
    // becomes a FetchTimeoutError.
    if (controller.signal.aborted && !(upstream && upstream.aborted)) {
      throw new FetchTimeoutError(timeoutMs);
    }
    throw e;
  } finally {
    clearTimeout(timer);
    // {once:true} already self-removes once the listener fires; this covers
    // the normal-completion path, where it never fires and would otherwise
    // linger on the caller's signal for the rest of its life.
    if (upstream && onUpstreamAbort) {
      upstream.removeEventListener("abort", onUpstreamAbort);
    }
  }
}
