// Legacy cookie migration, remove after 2026-12-31. Server-only sibling of
// src/lib/legacyStorage.ts: a renamed cookie is read under its new name
// first, falling back to the pre-rename name so a browser that has not made
// a new request since the rename keeps a working session/flag instead of
// silently losing it.
//
// Dependency-free on purpose: this is called from src/middleware.ts, which
// runs on the Edge runtime, so it must not import "server-only", next/headers,
// or anything else that only exists in a Node request handler. Any cookie jar
// that exposes a plain `get(name)` works here - NextRequest.cookies,
// NextResponse.cookies, and the next/headers cookies() jar all do.
import { legacyKey } from "@/lib/legacyStorage";

export type ReadableCookieJar = {
  get(name: string): { value: string } | undefined;
};

export function readLegacyCookie(
  cookies: ReadableCookieJar,
  name: string
): string | undefined {
  return cookies.get(name)?.value ?? cookies.get(legacyKey(name))?.value;
}
