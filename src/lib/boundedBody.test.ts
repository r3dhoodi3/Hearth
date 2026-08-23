import { describe, it, expect } from "vitest";
import { readJsonBounded } from "@/lib/boundedBody";

// Build a Request whose body is a ReadableStream we control, so a test can
// see exactly how many chunks the reader pulled and whether it cancelled.
// `declareLength` mirrors a chunked request: when false no Content-Length
// header is sent, which is the case the old header-only guard missed.
function streamingRequest(
  chunks: string[],
  opts: { declareLength?: boolean } = {}
) {
  const encoder = new TextEncoder();
  const encoded = chunks.map((c) => encoder.encode(c));
  const pulled: number[] = [];
  let cancelled = false;
  let i = 0;

  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= encoded.length) {
        controller.close();
        return;
      }
      pulled.push(i);
      controller.enqueue(encoded[i]);
      i += 1;
    },
    cancel() {
      cancelled = true;
    },
  });

  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.declareLength) {
    headers["content-length"] = String(
      encoded.reduce((n, c) => n + c.byteLength, 0)
    );
  }

  const req = new Request("http://localhost/api/test", {
    method: "POST",
    headers,
    body,
    // Node's fetch Request requires this for a stream body.
    duplex: "half",
  } as RequestInit & { duplex: "half" });

  return {
    req,
    chunkCount: () => pulled.length,
    wasCancelled: () => cancelled,
  };
}

describe("readJsonBounded", () => {
  it("parses a body under the limit", async () => {
    const { req } = streamingRequest(['{"question":', '"why is my', ' furnace loud?"}']);
    const result = await readJsonBounded(req, 1_000);
    expect(result).toEqual({ ok: true, data: { question: "why is my furnace loud?" } });
  });

  it("parses a body split across many chunks with no Content-Length", async () => {
    const payload = JSON.stringify({ text: "a".repeat(500) });
    const chunks = payload.match(/[\s\S]{1,17}/g) ?? [];
    const { req } = streamingRequest(chunks);
    const result = await readJsonBounded(req, 10_000);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.text).toBe("a".repeat(500));
  });

  it("refuses an over-limit chunked body with 413 and stops reading it", async () => {
    // 20 chunks of 1000 bytes with NO Content-Length: the header-only guard
    // saw 0 and let all 20KB through. The limit here is passed on chunk 3.
    const chunks = Array.from({ length: 20 }, () => "x".repeat(1000));
    const { req, chunkCount, wasCancelled } = streamingRequest(chunks);
    const result = await readJsonBounded(req, 2_500);
    expect(result).toEqual({ ok: false, status: 413 });
    // Read only as far as it had to: nowhere near all 20 chunks.
    expect(chunkCount()).toBe(3);
    expect(wasCancelled()).toBe(true);
  });

  it("refuses an oversized declared Content-Length without reading the body", async () => {
    // A hand-rolled stand-in rather than a real Request: undici's Request
    // pumps the first chunk out of a stream body while it constructs, which
    // would drown out the thing under test (that the HELPER never touches the
    // body once the header alone has failed).
    let touched = false;
    const req = {
      headers: new Headers({ "content-length": "5000" }),
      get body(): ReadableStream<Uint8Array> {
        touched = true;
        throw new Error("body must not be read after an oversized header");
      },
    } as unknown as Request;

    expect(await readJsonBounded(req, 1_000)).toEqual({ ok: false, status: 413 });
    expect(touched).toBe(false);
  });

  it("returns 400 on malformed JSON", async () => {
    const { req } = streamingRequest(['{"question": "unterminated']);
    expect(await readJsonBounded(req, 1_000)).toEqual({ ok: false, status: 400 });
  });

  it("treats an empty body as an empty object", async () => {
    const { req } = streamingRequest([]);
    expect(await readJsonBounded(req, 1_000)).toEqual({ ok: true, data: {} });
  });

  it("treats non-object JSON as an empty object, like the old catch(() => ({}))", async () => {
    const { req } = streamingRequest(["[1,2,3]"]);
    expect(await readJsonBounded(req, 1_000)).toEqual({ ok: true, data: {} });
  });

  it("accepts a body exactly at the limit", async () => {
    const payload = '{"a":"bb"}'; // 10 bytes
    const { req } = streamingRequest([payload]);
    expect(await readJsonBounded(req, 10)).toEqual({ ok: true, data: { a: "bb" } });
  });
});
