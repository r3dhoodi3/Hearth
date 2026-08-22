import { readFileSync } from "fs";
import { join } from "path";

// @vercel/og (used by next/og ImageResponse) auto-loads its default font by
// building a file: URL to a .ttf inside node_modules. On Windows that URL comes
// out malformed (".\\file:\\C:\\...") and fileURLToPath throws ERR_INVALID_URL,
// which 500s EVERY image card ("failed to pipe response: Invalid URL") in local
// dev. Reading the SAME bundled font's bytes ourselves and passing them to
// ImageResponse as an explicit `fonts` entry sidesteps the broken URL builder
// entirely. This is correct in production too (providing a font is always
// valid), so it fixes local Windows dev without changing prod behavior.
//
// Cached after the first successful read. Returns null if the file can't be
// found, in which case the caller omits `fonts` and lets @vercel/og fall back
// to its default loader (which works fine on Linux / Vercel).
let cached: Buffer | null | undefined;

export function ogFont(): Buffer | null {
  if (cached !== undefined) return cached;
  const candidates = [
    "node_modules/next/dist/compiled/@vercel/og/noto-sans-v27-latin-regular.ttf",
  ];
  for (const rel of candidates) {
    try {
      // turbopackIgnore: Next 16 builds with Turbopack, and its output tracer
      // cannot see that `rel` always points inside node_modules, so it would
      // otherwise trace and ship the WHOLE project (public/ included) as
      // server code. Opting out is safe: if the file is not in the deployed
      // bundle, readFileSync throws, we return null, and the caller falls
      // back to @vercel/og's default loader exactly as before.
      cached = readFileSync(join(/*turbopackIgnore: true*/ process.cwd(), rel));
      return cached;
    } catch {
      /* try the next candidate path */
    }
  }
  cached = null;
  return cached;
}

// Convenience: the `fonts` option for ImageResponse, or an empty object to
// spread when the font file wasn't found (so the caller stays a one-liner).
export function ogFontOption():
  | { fonts: { name: string; data: Buffer; weight: 400; style: "normal" }[] }
  | Record<string, never> {
  const data = ogFont();
  return data
    ? { fonts: [{ name: "Noto Sans", data, weight: 400, style: "normal" }] }
    : {};
}
