// The one place that decides whether a file is allowed into Hearth.
//
// WHY IT EXISTS. Before this module, every upload path carried its own copy of
// the same three checks and none of them were real:
//   - the size cap lived in the browser (PhotoUpload.tsx, DocumentUpload.tsx,
//     LogoUpload.tsx, ProjectPhotoManager.tsx, PrepPhotoUpload.tsx and
//     ComplianceCard.tsx each declare their own MAX_BYTES), and a browser
//     check is a hint, not a control: the same request can be replayed with
//     any body at all,
//   - the type check read `File.type`, which is a string the CLIENT chose. A
//     .svg renamed to .png announces itself as image/png and passes,
//   - the allow-list itself was copied into seven files with four different
//     spellings, so tightening one never tightened the others.
// Supabase's own `allowed_mime_types` on the bucket does not close it either:
// it compares the request's Content-Type header, which is that same client
// claim.
//
// So this module answers the question from the BYTES. Magic numbers decide the
// type, the declared type only has to agree with them, the size cap is a
// number the server owns, and the returned object name is built here rather
// than from anything the user typed.
//
// Deliberately dependency-free (no server-only, no Supabase, no next/*), the
// same way src/lib/outboundGuards.ts and src/lib/boundedBody.ts are, so the
// rules can be unit-tested directly and the client components can share the
// exact allow-list the server enforces instead of drifting from it.

// ---------------------------------------------------------------------------
// 1. What each kind of upload is allowed to be
// ---------------------------------------------------------------------------

// The only content types Hearth ever stores. Anything else is refused, both
// because we have no use for it and because the list of formats a browser will
// happily execute when handed back (SVG, HTML, XML) is longer than the list it
// will merely render.
export const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export const DOCUMENT_TYPES = [...IMAGE_TYPES, "application/pdf"] as const;

export type AllowedType = (typeof DOCUMENT_TYPES)[number];

// One entry per upload surface. The byte caps match what the existing clients
// already tell the user, so nothing that works today starts failing; the point
// is that the number is now enforced somewhere the user cannot edit.
//
// "logo" is 5MB rather than 15 because that is what LogoUpload.tsx has always
// told pros, and because pro-logos is the one PUBLIC bucket: the smallest cap
// that still does the job is the right one there.
export const UPLOAD_KINDS = {
  photo: { maxBytes: 15 * 1024 * 1024, types: IMAGE_TYPES },
  document: { maxBytes: 15 * 1024 * 1024, types: DOCUMENT_TYPES },
  logo: { maxBytes: 5 * 1024 * 1024, types: IMAGE_TYPES },
  compliance: { maxBytes: 10 * 1024 * 1024, types: DOCUMENT_TYPES },
} as const;

export type UploadKind = keyof typeof UPLOAD_KINDS;

// The extension each accepted type is stored under. Never the one the user's
// filename carried: an object key is what the storage layer and the browser
// use to guess a content type on the way back out, so it is derived from what
// the bytes actually are.
const EXTENSION_FOR: Record<AllowedType, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "application/pdf": "pdf",
};

export function extensionFor(type: AllowedType): string {
  return EXTENSION_FOR[type];
}

// ---------------------------------------------------------------------------
// 2. Magic bytes
// ---------------------------------------------------------------------------

function startsWith(bytes: Uint8Array, sig: number[], at = 0): boolean {
  if (bytes.length < at + sig.length) return false;
  for (let i = 0; i < sig.length; i++) {
    if (bytes[at + i] !== sig[i]) return false;
  }
  return true;
}

// What the first bytes say the file is, ignoring entirely what anyone claimed.
// Returns null for a format we do not accept, INCLUDING formats we can
// recognise but refuse (SVG, GIF, HTML): the caller only needs "yes, and it is
// this" or "no".
//
// The recognised-but-refused cases are still detected rather than falling
// through to null-by-accident, because they are the ones worth naming in the
// error message and worth pinning in a test.
export type SniffResult =
  | { kind: "allowed"; type: AllowedType }
  | { kind: "refused"; label: string }
  | { kind: "unknown" };

export function sniffFileType(bytes: Uint8Array): SniffResult {
  // JPEG: FF D8 FF
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) {
    return { kind: "allowed", type: "image/jpeg" };
  }
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { kind: "allowed", type: "image/png" };
  }
  // WEBP: "RIFF" .... "WEBP"
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
      startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) {
    return { kind: "allowed", type: "image/webp" };
  }
  // PDF: "%PDF-"
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) {
    return { kind: "allowed", type: "application/pdf" };
  }
  // GIF: recognised so the message can say so. Not on any bucket's list.
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) {
    return { kind: "refused", label: "GIF" };
  }
  // HEIC/HEIF from an iPhone: "ftyp" at offset 4, brand heic/heix/mif1/msf1.
  // Named explicitly because it is the single most likely honest rejection: an
  // iPhone shooting in High Efficiency hands over a .heic and the user has no
  // idea why it failed.
  if (startsWith(bytes, [0x66, 0x74, 0x79, 0x70], 4)) {
    const brand = new TextDecoder("latin1").decode(bytes.subarray(8, 12));
    if (/^(heic|heix|hevc|heim|heis|hevm|mif1|msf1)$/.test(brand)) {
      return { kind: "refused", label: "HEIC" };
    }
  }
  // SVG and HTML: both are text that a browser will EXECUTE if it is ever
  // served back with the wrong content type, which is the whole reason the
  // declared type is not trusted. Sniffed over the first bytes only, after
  // skipping whitespace and a UTF-8 BOM.
  const head = new TextDecoder("latin1")
    .decode(bytes.subarray(0, 512))
    .replace(/^\ufeff/, "")
    .trimStart()
    .toLowerCase();
  if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) {
    return { kind: "refused", label: "SVG" };
  }
  if (head.startsWith("<!doctype html") || head.startsWith("<html")) {
    return { kind: "refused", label: "HTML" };
  }
  return { kind: "unknown" };
}

// ---------------------------------------------------------------------------
// 3. PDFs that want to do something
// ---------------------------------------------------------------------------

// A PDF is a container, not a picture. The tokens below are the ones that turn
// a document into something that acts on open: script bodies, an action fired
// at open time, per-page and per-field triggers, "run this file", and embedded
// attachments. None of them appear in an insurance certificate or a license
// scan, which is all Hearth ever accepts a PDF for, so their presence is
// treated as a refusal rather than something to sanitise.
//
// This is a coarse byte scan on purpose. A determined attacker can hide a name
// behind PDF's #-escapes or a compressed object stream, and defeating that
// needs a real parser. It is still worth having: it costs nothing, it stops
// every off-the-shelf malicious PDF, and it is the honest half of a control
// whose other half is a real malware scanner (see scanForMalware below).
const PDF_ACTIVE_TOKENS = [
  "/JavaScript",
  "/JS",
  "/OpenAction",
  "/AA",
  "/Launch",
  "/EmbeddedFile",
  "/RichMedia",
  "/XFA",
];

export function findActivePdfTokens(bytes: Uint8Array): string[] {
  const text = new TextDecoder("latin1").decode(bytes);
  return PDF_ACTIVE_TOKENS.filter((token) => text.includes(token));
}

// ---------------------------------------------------------------------------
// 4. Metadata and trailing-payload stripping
// ---------------------------------------------------------------------------

// Re-encoding an image through a real decoder (sharp) is the thorough way to
// guarantee that what comes out is only pixels. sharp is NOT a dependency of
// this repo (see package.json) and adding a native module to the Vercel build
// is a bigger decision than this module should make on its own, so what is
// here instead is byte surgery that needs no dependency and covers the two
// things that actually matter:
//
//   1. EXIF. A phone photo carries GPS coordinates. A homeowner uploading a
//      picture of their water heater is publishing their address unless the
//      tags come off. AskHearth.tsx and InspectionUpload.tsx already re-encode
//      through a canvas, which drops EXIF; every other path did not.
//   2. Appended payloads. Every image format has a defined end. Bytes after it
//      are ignored by decoders and preserved by storage, which is how a
//      polyglot (a valid JPEG that is also a valid ZIP or HTML page) survives
//      a magic-byte check. Truncating at the real end removes them.
//
// If sharp is ever added, replace the body of stripImageMetadata with a
// sharp().rotate().toBuffer() call and keep the signature. Nothing else has to
// change.

// JPEG: keep the SOI marker and the segments a decoder needs; drop APP1..APPF
// (EXIF, XMP, embedded thumbnails, ICC is APP2 and goes too) and COM comments;
// stop at EOI so nothing appended survives.
function stripJpeg(bytes: Uint8Array): Uint8Array {
  const out: number[] = [0xff, 0xd8];
  let i = 2;
  while (i + 3 < bytes.length) {
    if (bytes[i] !== 0xff) break; // not a marker boundary: bail, keep the rest
    const marker = bytes[i + 1];
    if (marker === 0xd9) {
      out.push(0xff, 0xd9); // EOI: done, and anything after it is dropped
      return Uint8Array.from(out);
    }
    if (marker === 0xda) {
      // Start of scan. The compressed data that follows has no length field,
      // so from here to the end of the file is image data. Copy it, then trim
      // anything past the final EOI.
      let end = bytes.length;
      for (let j = bytes.length - 2; j >= i; j--) {
        if (bytes[j] === 0xff && bytes[j + 1] === 0xd9) {
          end = j + 2;
          break;
        }
      }
      for (let j = i; j < end; j++) out.push(bytes[j]);
      return Uint8Array.from(out);
    }
    const length = (bytes[i + 2] << 8) | bytes[i + 3];
    if (length < 2 || i + 2 + length > bytes.length) break;
    const isMetadata =
      (marker >= 0xe1 && marker <= 0xef) || marker === 0xfe; // APP1..APPF, COM
    if (!isMetadata) {
      for (let j = i; j < i + 2 + length; j++) out.push(bytes[j]);
    }
    i += 2 + length;
  }
  // Anything we could not walk cleanly is returned untouched rather than
  // corrupted: a file this function cannot parse has already passed the magic
  // check, and handing back a half-rebuilt image would be worse than handing
  // back the original.
  return bytes;
}

const PNG_KEEP_CHUNKS = new Set([
  "IHDR", "PLTE", "IDAT", "IEND", "tRNS", "gAMA", "cHRM", "sRGB", "sBIT", "pHYs",
]);

// PNG: keep the signature and the chunks a decoder needs; drop tEXt/zTXt/iTXt
// (comments), eXIf (GPS), and every other ancillary chunk; stop at IEND.
function stripPng(bytes: Uint8Array): Uint8Array {
  const sig = 8;
  const out: number[] = [];
  for (let j = 0; j < sig; j++) out.push(bytes[j]);
  let i = sig;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  while (i + 8 <= bytes.length) {
    const length = view.getUint32(i);
    const name = new TextDecoder("latin1").decode(bytes.subarray(i + 4, i + 8));
    const total = 12 + length; // length + type + data + crc
    if (length > bytes.length || i + total > bytes.length) return bytes;
    if (PNG_KEEP_CHUNKS.has(name)) {
      for (let j = i; j < i + total; j++) out.push(bytes[j]);
    }
    i += total;
    if (name === "IEND") return Uint8Array.from(out);
  }
  return bytes;
}

// WEBP: a RIFF container. Drop the EXIF and XMP chunks, rewrite the container
// length, and truncate anything past it.
function stripWebp(bytes: Uint8Array): Uint8Array {
  if (bytes.length < 12) return bytes;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const declared = view.getUint32(4, true) + 8;
  const end = Math.min(declared, bytes.length);
  const kept: number[] = [];
  let i = 12;
  while (i + 8 <= end) {
    const name = new TextDecoder("latin1").decode(bytes.subarray(i, i + 4));
    const size = view.getUint32(i + 4, true);
    const padded = size + (size % 2); // RIFF chunks are even-aligned
    const total = 8 + padded;
    if (i + total > end) break;
    if (name !== "EXIF" && name !== "XMP ") {
      for (let j = i; j < i + total; j++) kept.push(bytes[j]);
    }
    i += total;
  }
  const out = new Uint8Array(12 + kept.length);
  out.set(bytes.subarray(0, 12));
  out.set(Uint8Array.from(kept), 12);
  new DataView(out.buffer).setUint32(4, out.length - 8, true);
  return out;
}

// Returns bytes that are safe to store: same picture, no camera metadata, no
// trailing payload. Never throws; a file it cannot walk comes back unchanged.
export function stripImageMetadata(
  bytes: Uint8Array,
  type: AllowedType
): Uint8Array {
  try {
    if (type === "image/jpeg") return stripJpeg(bytes);
    if (type === "image/png") return stripPng(bytes);
    if (type === "image/webp") return stripWebp(bytes);
  } catch {
    // Deliberately silent: the only failure mode worth having here is "store
    // the original", which is exactly what today does.
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// 5. Filenames and object keys
// ---------------------------------------------------------------------------

// A user-supplied filename never becomes part of an object key. This exists
// for the places that DISPLAY the original name (the quote analyser records
// one) so the stored string cannot carry a path, a control character, or a
// second extension.
export function normaliseFilename(raw: unknown, fallback = "upload"): string {
  if (typeof raw !== "string") return fallback;
  const base = raw
    .split(/[\\/]/)
    .pop()!                                   // no directories
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, "") // no control characters
    .replace(/[^a-zA-Z0-9._ -]/g, "_")        // no shell or URL punctuation
    .replace(/^\.+/, "")                      // no leading dots
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return base || fallback;
}

// ---------------------------------------------------------------------------
// 6. Malware scanning: the hook, and the honest label
// ---------------------------------------------------------------------------

// TODAY THIS SCANS NOTHING, and says so. There is no ClamAV on Vercel: the
// runtime is short-lived, has no daemon, and a virus database is hundreds of
// megabytes that would have to be downloaded per cold start. The two realistic
// options and what each costs are written up in
// docs/BACKUPS-AND-RESTORE.md's sibling section in docs/ENVIRONMENTS.md; the
// short version is a scanning API (a key and a per-file call) or a Supabase
// Edge Function running ClamAV (no per-file cost, more to run).
//
// Turning it on later is meant to be one environment variable and one function
// body. Every upload path already awaits this and already refuses on
// "infected", so nothing else has to change when it starts returning something
// other than "unscanned".
export type ScanVerdict = "unscanned" | "clean" | "infected";

export async function scanForMalware(bytes: Uint8Array): Promise<ScanVerdict> {
  // Read at call time, not at module load: Vercel environment variables change
  // without a rebuild, and this must start working on the next request rather
  // than the next deploy, the same way OUTBOUND_DISABLED does.
  const provider = process.env.MALWARE_SCAN_PROVIDER;
  if (!provider) return "unscanned";
  // Intentionally not implemented yet. Returning "unscanned" rather than
  // "clean" means a half-configured provider can never be mistaken for a
  // passing scan.
  void bytes;
  return "unscanned";
}

// ---------------------------------------------------------------------------
// 7. The check itself
// ---------------------------------------------------------------------------

export type UploadRejection = {
  ok: false;
  /** Machine-readable, for tests and logs. */
  reason:
    | "empty"
    | "too_large"
    | "unrecognised"
    | "type_not_allowed"
    | "type_mismatch"
    | "active_pdf"
    | "infected";
  /** What to show the person who uploaded it. Plain, no jargon. */
  message: string;
  /** HTTP status the caller should answer with. */
  status: 400 | 413 | 415 | 422;
};

export type UploadAcceptance = {
  ok: true;
  /** The type the BYTES are, never the claimed one. */
  type: AllowedType;
  /** Extension derived from that type, for the object key. */
  extension: string;
  /** Bytes safe to store: metadata and trailing payloads removed. */
  bytes: Uint8Array;
  /** "unscanned" until a scanner is configured. Worth logging. */
  scan: ScanVerdict;
};

export type UploadVerdict = UploadAcceptance | UploadRejection;

export type CheckUploadInput = {
  bytes: Uint8Array;
  kind: UploadKind;
  /** The client's claim, e.g. File.type. Only used to catch disagreement. */
  declaredType?: string | null;
};

// The order matters and is the cheap-first order: size before parsing, magic
// bytes before any content scan, content scan before the (future) network call
// to a scanner.
export async function checkUpload(
  input: CheckUploadInput
): Promise<UploadVerdict> {
  const { bytes, kind } = input;
  const rules = UPLOAD_KINDS[kind];

  if (!bytes || bytes.length === 0) {
    return {
      ok: false,
      reason: "empty",
      status: 400,
      message: "That file was empty.",
    };
  }

  if (bytes.length > rules.maxBytes) {
    const mb = Math.round(rules.maxBytes / (1024 * 1024));
    return {
      ok: false,
      reason: "too_large",
      status: 413,
      message: `That file is too big. The limit is ${mb}MB.`,
    };
  }

  const sniffed = sniffFileType(bytes);
  if (sniffed.kind === "refused") {
    return {
      ok: false,
      reason: "type_not_allowed",
      status: 415,
      message:
        sniffed.label === "HEIC"
          ? "iPhone HEIC photos aren't supported yet. In Settings > Camera > Formats, pick Most Compatible, or take a screenshot of the photo and upload that."
          : `${sniffed.label} files aren't supported. Use a JPEG, PNG or WEBP.`,
    };
  }
  if (sniffed.kind === "unknown") {
    return {
      ok: false,
      reason: "unrecognised",
      status: 415,
      message: "That doesn't look like a photo or a PDF.",
    };
  }

  const allowed = (rules.types as readonly string[]).includes(sniffed.type);
  if (!allowed) {
    return {
      ok: false,
      reason: "type_not_allowed",
      status: 415,
      message:
        sniffed.type === "application/pdf"
          ? "PDFs aren't accepted here. Upload a photo instead."
          : "That file type isn't accepted here.",
    };
  }

  // The declared type does not decide anything, but a file whose claim and
  // whose bytes disagree is either broken or deliberate, and neither is worth
  // storing. Checked only when a claim was made at all.
  const declared = (input.declaredType || "").split(";")[0].trim().toLowerCase();
  if (declared && declared !== sniffed.type) {
    // image/jpg is a common browser-side spelling of image/jpeg and is not a
    // disagreement about what the file is.
    const normalised = declared === "image/jpg" ? "image/jpeg" : declared;
    if (normalised !== sniffed.type) {
      return {
        ok: false,
        reason: "type_mismatch",
        status: 415,
        message: "That file's contents don't match its name. Re-save it and try again.",
      };
    }
  }

  if (sniffed.type === "application/pdf") {
    const tokens = findActivePdfTokens(bytes);
    if (tokens.length > 0) {
      return {
        ok: false,
        reason: "active_pdf",
        status: 422,
        message:
          "That PDF contains embedded scripts or attachments, so it can't be uploaded. Print it to a new PDF, or upload a photo of it.",
      };
    }
  }

  const scan = await scanForMalware(bytes);
  if (scan === "infected") {
    return {
      ok: false,
      reason: "infected",
      status: 422,
      message: "That file didn't pass a virus check.",
    };
  }

  return {
    ok: true,
    type: sniffed.type,
    extension: extensionFor(sniffed.type),
    bytes:
      sniffed.type === "application/pdf"
        ? bytes
        : stripImageMetadata(bytes, sniffed.type),
    scan,
  };
}
