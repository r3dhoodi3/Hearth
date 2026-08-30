import { describe, expect, it } from "vitest";
import {
  checkUpload,
  findActivePdfTokens,
  normaliseFilename,
  scanForMalware,
  sniffFileType,
  stripImageMetadata,
  UPLOAD_KINDS,
} from "@/lib/uploadGuard";

// The guard's whole point is that it reads BYTES, so the fixtures here are real
// byte sequences rather than mocked File objects. Each one is the smallest
// thing that is genuinely the format in question.

function bytes(...parts: (number[] | string | Uint8Array)[]): Uint8Array {
  const flat: number[] = [];
  for (const part of parts) {
    if (typeof part === "string") {
      for (const ch of part) flat.push(ch.charCodeAt(0));
    } else {
      for (const b of part) flat.push(b);
    }
  }
  return Uint8Array.from(flat);
}

const JPEG_SOI = [0xff, 0xd8, 0xff, 0xe0];
const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

// A minimal but structurally real JPEG: SOI, an APP1/EXIF segment carrying a
// fake GPS payload, then SOS with two bytes of scan data, then EOI.
function jpegWithExif(trailing: number[] = []): Uint8Array {
  const exifPayload = "Exif\0\0GPSLatitude33.7";
  const segLen = exifPayload.length + 2;
  return bytes(
    [0xff, 0xd8],
    [0xff, 0xe1, (segLen >> 8) & 0xff, segLen & 0xff],
    exifPayload,
    [0xff, 0xda, 0x00, 0x02],
    [0x11, 0x22],
    [0xff, 0xd9],
    trailing
  );
}

// A minimal PNG: signature, IHDR, a tEXt comment, IEND, then anything appended.
function pngWithComment(trailing: number[] = []): Uint8Array {
  const chunk = (name: string, data: number[]) => [
    (data.length >> 24) & 0xff,
    (data.length >> 16) & 0xff,
    (data.length >> 8) & 0xff,
    data.length & 0xff,
    ...[...name].map((c) => c.charCodeAt(0)),
    ...data,
    0, 0, 0, 0, // CRC, not verified by the stripper
  ];
  return bytes(
    PNG_SIG,
    chunk("IHDR", [0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]),
    chunk("tEXt", [..."Comment:secret"].map((c) => c.charCodeAt(0))),
    chunk("IDAT", [0x78, 0x9c, 0x63, 0x00]),
    chunk("IEND", []),
    trailing
  );
}

describe("sniffFileType", () => {
  it("names the four accepted formats from their magic bytes", () => {
    expect(sniffFileType(bytes(JPEG_SOI))).toEqual({
      kind: "allowed",
      type: "image/jpeg",
    });
    expect(sniffFileType(bytes(PNG_SIG))).toEqual({
      kind: "allowed",
      type: "image/png",
    });
    expect(sniffFileType(bytes("RIFF", [0, 0, 0, 0], "WEBPVP8 "))).toEqual({
      kind: "allowed",
      type: "image/webp",
    });
    expect(sniffFileType(bytes("%PDF-1.7\n"))).toEqual({
      kind: "allowed",
      type: "application/pdf",
    });
  });

  it("recognises the formats it refuses, so the message can say which", () => {
    expect(sniffFileType(bytes("GIF89a"))).toEqual({
      kind: "refused",
      label: "GIF",
    });
    expect(sniffFileType(bytes('<svg xmlns="http://www.w3.org/2000/svg">'))).toEqual({
      kind: "refused",
      label: "SVG",
    });
    expect(sniffFileType(bytes("<!DOCTYPE html><script>alert(1)</script>"))).toEqual({
      kind: "refused",
      label: "HTML",
    });
    expect(sniffFileType(bytes([0, 0, 0, 0x18], "ftypheic"))).toEqual({
      kind: "refused",
      label: "HEIC",
    });
  });

  it("says unknown for anything else", () => {
    expect(sniffFileType(bytes("just some text"))).toEqual({ kind: "unknown" });
    expect(sniffFileType(new Uint8Array(0))).toEqual({ kind: "unknown" });
  });
});

describe("checkUpload size cap", () => {
  it("refuses an oversize file with 413 and the limit in the message", async () => {
    const oversize = new Uint8Array(UPLOAD_KINDS.logo.maxBytes + 1);
    oversize.set(JPEG_SOI);
    const verdict = await checkUpload({ bytes: oversize, kind: "logo" });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toBe("too_large");
    expect(verdict.status).toBe(413);
    expect(verdict.message).toContain("5MB");
  });

  // The cap is per kind, so the same file can be fine on one surface and too
  // big on another. This is what makes the 5MB logo rule real rather than a
  // number the browser was asked to respect.
  it("uses the per-kind cap, not one global number", async () => {
    const sixMb = new Uint8Array(6 * 1024 * 1024);
    sixMb.set(JPEG_SOI);
    expect((await checkUpload({ bytes: sixMb, kind: "logo" })).ok).toBe(false);
    expect((await checkUpload({ bytes: sixMb, kind: "photo" })).ok).toBe(true);
  });

  it("refuses an empty file", async () => {
    const verdict = await checkUpload({ bytes: new Uint8Array(0), kind: "photo" });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe("empty");
  });
});

describe("checkUpload magic bytes", () => {
  // The headline case: an SVG renamed to .png and announced as image/png. The
  // client-side allow-list every upload component carries would pass this.
  it("refuses an SVG that claims to be a PNG", async () => {
    const verdict = await checkUpload({
      bytes: bytes('<svg onload="fetch(\'//evil\')"></svg>'),
      kind: "photo",
      declaredType: "image/png",
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toBe("type_not_allowed");
    expect(verdict.status).toBe(415);
    expect(verdict.message).toContain("SVG");
  });

  it("refuses a file whose bytes and declared type disagree", async () => {
    const verdict = await checkUpload({
      bytes: bytes(PNG_SIG),
      kind: "photo",
      declaredType: "application/pdf",
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe("type_mismatch");
  });

  it("treats image/jpg as image/jpeg rather than a disagreement", async () => {
    const verdict = await checkUpload({
      bytes: jpegWithExif(),
      kind: "photo",
      declaredType: "image/jpg",
    });
    expect(verdict.ok).toBe(true);
  });

  it("refuses a PDF on a photo-only surface", async () => {
    const verdict = await checkUpload({
      bytes: bytes("%PDF-1.4\n%%EOF"),
      kind: "logo",
      declaredType: "application/pdf",
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe("type_not_allowed");
  });

  it("names HEIC specifically, because that is the honest iPhone rejection", async () => {
    const verdict = await checkUpload({
      bytes: bytes([0, 0, 0, 0x18], "ftypheic", [0, 0, 0, 0]),
      kind: "photo",
      declaredType: "image/heic",
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.message).toContain("Most Compatible");
  });
});

describe("checkUpload PDFs", () => {
  it("accepts a plain PDF", async () => {
    const verdict = await checkUpload({
      bytes: bytes("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF"),
      kind: "compliance",
      declaredType: "application/pdf",
    });
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.extension).toBe("pdf");
  });

  it("refuses a PDF carrying /JavaScript", async () => {
    const verdict = await checkUpload({
      bytes: bytes(
        "%PDF-1.4\n1 0 obj\n<< /S /JavaScript /JS (app.alert('hi')) >>\nendobj\n%%EOF"
      ),
      kind: "compliance",
      declaredType: "application/pdf",
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toBe("active_pdf");
    expect(verdict.status).toBe(422);
  });

  it("refuses a PDF with an /OpenAction or an embedded file", async () => {
    for (const token of ["/OpenAction 2 0 R", "/EmbeddedFile", "/Launch"]) {
      const verdict = await checkUpload({
        bytes: bytes(`%PDF-1.4\n<< ${token} >>\n%%EOF`),
        kind: "document",
      });
      expect(verdict.ok, token).toBe(false);
      if (!verdict.ok) expect(verdict.reason).toBe("active_pdf");
    }
  });

  it("findActivePdfTokens lists every token it found", () => {
    expect(
      findActivePdfTokens(bytes("%PDF-1.4 /OpenAction /JavaScript /JS"))
    ).toEqual(expect.arrayContaining(["/JavaScript", "/JS", "/OpenAction"]));
    expect(findActivePdfTokens(bytes("%PDF-1.4 /Type /Catalog"))).toEqual([]);
  });
});

describe("checkUpload accepts good files", () => {
  it("accepts a JPEG and reports the type from the bytes", async () => {
    const verdict = await checkUpload({
      bytes: jpegWithExif(),
      kind: "photo",
      declaredType: "image/jpeg",
    });
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.type).toBe("image/jpeg");
    expect(verdict.extension).toBe("jpg");
    expect(verdict.scan).toBe("unscanned");
  });

  it("accepts a PNG", async () => {
    const verdict = await checkUpload({
      bytes: pngWithComment(),
      kind: "photo",
      declaredType: "image/png",
    });
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.extension).toBe("png");
  });
});

describe("stripImageMetadata", () => {
  // GPS in EXIF is a home address. This is the check that it comes off.
  it("removes the EXIF segment from a JPEG", () => {
    const original = jpegWithExif();
    const cleaned = stripImageMetadata(original, "image/jpeg");
    const text = new TextDecoder("latin1").decode(cleaned);
    expect(text).not.toContain("GPSLatitude");
    expect(cleaned.length).toBeLessThan(original.length);
    // Still a JPEG, still ends where a JPEG ends.
    expect(Array.from(cleaned.subarray(0, 2))).toEqual([0xff, 0xd8]);
    expect(Array.from(cleaned.subarray(-2))).toEqual([0xff, 0xd9]);
  });

  it("drops bytes appended after a JPEG's end marker", () => {
    const polyglot = jpegWithExif([...Buffer.from("PK\u0003\u0004payload")]);
    const cleaned = stripImageMetadata(polyglot, "image/jpeg");
    expect(new TextDecoder("latin1").decode(cleaned)).not.toContain("payload");
  });

  it("removes PNG text chunks and anything after IEND", () => {
    const original = pngWithComment([...Buffer.from("trailing-payload")]);
    const cleaned = stripImageMetadata(original, "image/png");
    const text = new TextDecoder("latin1").decode(cleaned);
    expect(text).not.toContain("secret");
    expect(text).not.toContain("trailing-payload");
    expect(text).toContain("IHDR");
    expect(text).toContain("IDAT");
    expect(text).toContain("IEND");
  });

  it("returns bytes it cannot parse untouched rather than corrupting them", () => {
    const odd = bytes(JPEG_SOI.slice(0, 2), [0x01, 0x02, 0x03]);
    expect(Array.from(stripImageMetadata(odd, "image/jpeg"))).toEqual(
      Array.from(odd)
    );
  });

  it("is applied by checkUpload on the accepted bytes", async () => {
    const verdict = await checkUpload({
      bytes: jpegWithExif(),
      kind: "photo",
      declaredType: "image/jpeg",
    });
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(new TextDecoder("latin1").decode(verdict.bytes)).not.toContain(
      "GPSLatitude"
    );
  });
});

describe("normaliseFilename", () => {
  it("keeps only a base name, with no path and no punctuation that travels", () => {
    expect(normaliseFilename("../../etc/passwd")).toBe("passwd");
    expect(normaliseFilename("C:\\Users\\me\\Quote #1.pdf")).toBe("Quote _1.pdf");
    expect(normaliseFilename(".hidden")).toBe("hidden");
    expect(normaliseFilename("")).toBe("upload");
    expect(normaliseFilename(null)).toBe("upload");
    expect(normaliseFilename(42)).toBe("upload");
  });

  it("strips control characters and bounds the length", () => {
    expect(normaliseFilename("bill\r\n\u0000.pdf")).toBe("bill.pdf");
    expect(normaliseFilename("a".repeat(400)).length).toBe(120);
  });
});

describe("scanForMalware", () => {
  // The honest label. It must never be "clean", because nothing scanned it.
  it("returns unscanned while no provider is configured", async () => {
    expect(await scanForMalware(bytes(JPEG_SOI))).toBe("unscanned");
  });
});
