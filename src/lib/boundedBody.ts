// Read a JSON request body with a HARD byte ceiling, enforced on the bytes
// that actually arrive rather than on what the caller claims.
//
// WHY this exists. The AI routes used to bound their bodies like this:
//
//   const declared = Number(req.headers.get("content-length") ?? 0);
//   if (declared > MAX) return 413;
//   const body = await req.json();
//
// Content-Length is a claim, and a chunked request does not make it at all.
// `Transfer-Encoding: chunked` with no Content-Length reads as 0, sails past
// the guard, and the whole payload is then buffered and JSON-parsed before a
// single limit says no. That is exactly the work the guard was there to
// avoid: memory and CPU spent on a request that was always going to be
// refused, on routes that sit in front of a paid model.
//
// So: keep the header check (it is free, and it turns an honest oversized
// request away without reading a byte), then read the stream ourselves and
// count. Past the ceiling we cancel the reader, which tears the request body
// down instead of politely draining megabytes we have already decided to
// throw away.
export type BoundedJsonResult =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; status: 413 | 400 };

export type BoundedBodyResult =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; status: 413 | 400 };

// The raw-bytes half of the same idea, for a body that is not JSON (a
// multipart upload, say). Same rules: the Content-Length claim is checked for
// free up front, then the actual bytes are counted as they arrive and the
// reader is cancelled the moment the ceiling is passed.
export async function readBodyBounded(
  req: Request,
  maxBytes: number
): Promise<BoundedBodyResult> {
  // The free check first: an honest client that declares an oversized body is
  // turned away without reading a byte of it.
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    return { ok: false, status: 413 };
  }

  const stream = req.body;
  if (!stream) return { ok: true, bytes: new Uint8Array(0) };

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        // Stop pulling. cancel() propagates back down the stream so the rest
        // of the payload is never read, let alone buffered.
        await reader.cancel().catch(() => {});
        return { ok: false, status: 413 };
      }
      chunks.push(value);
    }
  } catch {
    // A truncated or aborted upload is a bad request, not a server fault.
    await reader.cancel().catch(() => {});
    return { ok: false, status: 400 };
  }

  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes: joined };
}

// Non-object JSON (a bare array, string, or number) comes back as `{}` rather
// than a 400, matching what every caller here did before this helper existed:
// `await req.json().catch(() => ({}))` followed by `typeof body.foo ===` type
// guards, which read undefined off a non-object and fell into the route's own
// "you didn't send anything" 400. An EMPTY body is `{}` for the same reason.
// Only genuinely malformed JSON is a 400.
export async function readJsonBounded(
  req: Request,
  maxBytes: number
): Promise<BoundedJsonResult> {
  const bounded = await readBodyBounded(req, maxBytes);
  if (!bounded.ok) return bounded;
  const joined = bounded.bytes;

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: false }).decode(joined);
  } catch {
    return { ok: false, status: 400 };
  }
  if (!text.trim()) return { ok: true, data: {} };

  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: true, data: {} };
    }
    return { ok: true, data: parsed as Record<string, unknown> };
  } catch {
    return { ok: false, status: 400 };
  }
}
