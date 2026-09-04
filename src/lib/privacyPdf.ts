import { PDFDocument, PDFFont, PDFPage, StandardFonts } from "pdf-lib";
import type { Category, ExportPayload, ThirdParty } from "@/lib/privacy";

// =============================================================================
// OakTend - PDF rendering of the CCPA/CPRA "right to know" export.
//
// This is a second SERIALIZATION of the exact same payload the JSON export
// sends (collectUserData() in src/lib/privacy.ts is the one gather step both
// formats read from), not a second gather step. That's deliberate: the two
// formats must never be able to drift, so nothing in this file ever queries
// the database - it only walks the object it's handed and lays it out as
// text.
//
// Plain, no-decoration layout: black text on white pages, wrapped and
// paginated by hand because pdf-lib has no built-in flow layout. "Modest
// tables" for the row lists (properties, documents, messages, etc.) means a
// numbered entry per row with its fields underneath, not a fixed-width grid -
// the rows come from many different tables with different shapes, so a
// literal column grid would either truncate values or misalign across
// entries. Free text (message bodies, notes) is written in full; nothing here
// is truncated, because pagination handles overflow instead.
// =============================================================================

const PAGE_WIDTH = 612; // US Letter, points
const PAGE_HEIGHT = 792;
const MARGIN = 50;

// pdf-lib's StandardFonts (Helvetica/Helvetica-Bold) can only encode the
// WinAnsi (cp1252) character set. Real OakTend data routinely has characters
// outside it - emoji in a contractor name, a home-system note, a message, an
// issue description - and pdf-lib THROWS ("WinAnsi cannot encode ...")
// rather than skipping them. Every string in this file funnels through
// Writer.text(), so sanitizing there is the one place this has to be caught:
// unencodable characters are swapped for "?" instead of taking down the
// whole export. Results are cached per character since the same handful of
// emoji/symbols tend to repeat across a payload.
const encodableCache = new Map<string, boolean>();

function isEncodable(font: PDFFont, ch: string): boolean {
  try {
    font.widthOfTextAtSize(ch, 10);
    return true;
  } catch {
    return false;
  }
}

function sanitizeForFont(str: string, font: PDFFont): string {
  let out = "";
  for (const ch of str) {
    if (ch === "\n" || ch === "\t") {
      out += ch;
      continue;
    }
    const codePoint = ch.codePointAt(0) ?? 0;
    if (codePoint < 0x20) continue; // strip other control characters
    let ok = encodableCache.get(ch);
    if (ok === undefined) {
      ok = isEncodable(font, ch);
      encodableCache.set(ch, ok);
    }
    out += ok ? ch : "?";
  }
  return out;
}

function humanize(key: string): string {
  const s = key.replace(/_/g, " ");
  return s.length ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "(none)";
  if (typeof value === "string") return value === "" ? "(empty)" : value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return "(none)";
    if (value.every((v) => v === null || typeof v !== "object")) {
      return value.map((v) => (v === null ? "(none)" : String(v))).join(", ");
    }
    return JSON.stringify(value);
  }
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

// Greedy word wrap against a real font's measured width, with a hard
// character-level fallback for single tokens (long ids, urls) that don't fit
// a line on their own. Splits on existing newlines first so multi-paragraph
// fields (message bodies) keep their line breaks.
function wrapText(
  text: string,
  font: PDFFont,
  size: number,
  maxWidth: number
): string[] {
  const lines: string[] = [];
  for (const para of text.split("\n")) {
    if (para === "") {
      lines.push("");
      continue;
    }
    let current = "";
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const attempt = current ? `${current} ${word}` : word;
      if (font.widthOfTextAtSize(attempt, size) <= maxWidth) {
        current = attempt;
        continue;
      }
      if (current) lines.push(current);
      if (font.widthOfTextAtSize(word, size) <= maxWidth) {
        current = word;
        continue;
      }
      // Single word wider than the line: hard-break it by character.
      let chunk = "";
      for (const ch of word) {
        const test = chunk + ch;
        if (font.widthOfTextAtSize(test, size) > maxWidth && chunk) {
          lines.push(chunk);
          chunk = ch;
        } else {
          chunk = test;
        }
      }
      current = chunk;
    }
    if (current) lines.push(current);
  }
  return lines;
}

// Tiny flow-layout helper: tracks the current page and vertical cursor, and
// starts a fresh page whenever the next line would run past the bottom
// margin. Every drawing method goes through text(), so pagination only has
// to be correct in one place.
class Writer {
  doc: PDFDocument;
  regular: PDFFont;
  bold: PDFFont;
  page: PDFPage;
  y: number;
  readonly contentWidth = PAGE_WIDTH - MARGIN * 2;

  constructor(doc: PDFDocument, regular: PDFFont, bold: PDFFont) {
    this.doc = doc;
    this.regular = regular;
    this.bold = bold;
    this.page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    this.y = PAGE_HEIGHT - MARGIN;
  }

  private newPage(): void {
    this.page = this.doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    this.y = PAGE_HEIGHT - MARGIN;
  }

  private ensure(space: number): void {
    if (this.y - space < MARGIN) this.newPage();
  }

  text(
    str: string,
    opts: {
      size?: number;
      font?: PDFFont;
      gapAfter?: number;
      indent?: number;
    } = {}
  ): void {
    const size = opts.size ?? 9.5;
    const font = opts.font ?? this.regular;
    const gapAfter = opts.gapAfter ?? 4;
    const indent = opts.indent ?? 0;
    const lineHeight = size * 1.35;
    const safeStr = sanitizeForFont(str, font);
    const lines = wrapText(safeStr, font, size, this.contentWidth - indent);

    for (const line of lines) {
      this.ensure(lineHeight);
      if (line) {
        this.page.drawText(line, {
          x: MARGIN + indent,
          y: this.y - size,
          size,
          font,
        });
      }
      this.y -= lineHeight;
    }
    this.y -= gapAfter;
  }

  spacer(amount: number): void {
    this.ensure(amount);
    this.y -= amount;
  }

  heading1(str: string): void {
    this.ensure(28);
    this.text(str, { size: 20, font: this.bold, gapAfter: 10 });
  }

  heading2(str: string): void {
    this.spacer(8);
    this.ensure(22);
    this.text(str, { size: 13.5, font: this.bold, gapAfter: 8 });
  }

  heading3(str: string): void {
    this.ensure(18);
    this.text(str, { size: 11, font: this.bold, gapAfter: 5 });
  }

  para(str: string): void {
    this.text(str, { size: 9.5, font: this.regular, gapAfter: 6 });
  }

  kv(label: string, value: unknown, indent = 10): void {
    this.text(`${label}: ${formatValue(value)}`, {
      size: 9,
      indent,
      gapAfter: 2,
    });
  }
}

// Renders one section of the payload (e.g. the object under "home" or
// "account_activity"): each key is either an array of rows from one table
// (rendered as numbered entries with their fields underneath), a single
// nested object (rendered as key/value pairs), or a bare scalar.
function renderSectionBody(w: Writer, obj: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(obj)) {
    if (Array.isArray(value)) {
      w.heading3(`${humanize(key)} (${value.length})`);
      if (value.length === 0) {
        w.para("(none)");
        continue;
      }
      value.forEach((item, i) => {
        w.text(`${i + 1}.`, { size: 9.5, font: w.bold, gapAfter: 2, indent: 6 });
        if (item && typeof item === "object" && !Array.isArray(item)) {
          for (const [k, v] of Object.entries(item as Record<string, unknown>)) {
            w.kv(humanize(k), v, 16);
          }
        } else {
          w.text(formatValue(item), { size: 9, indent: 16, gapAfter: 2 });
        }
        w.spacer(4);
      });
    } else if (value && typeof value === "object") {
      w.heading3(humanize(key));
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        w.kv(humanize(k), v, 10);
      }
    } else {
      w.kv(humanize(key), value, 0);
    }
  }
}

// Builds the full "Your OakTend data" PDF from the same payload the JSON
// export serializes. Same data, no more and no less - just laid out to read.
export async function buildExportPdf(payload: ExportPayload): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle("Your OakTend data");
  doc.setProducer("OakTend");
  doc.setCreator("OakTend");

  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const w = new Writer(doc, regular, bold);

  const meta = (payload.export_metadata ?? {}) as {
    generated_at?: string;
    about?: string;
    categories_of_personal_information_collected?: Category[];
    third_parties_disclosed_to?: ThirdParty[];
    sold_or_shared_for_cross_context_behavioral_advertising?: boolean;
  };

  w.heading1("Your OakTend data");
  const generatedAt = meta.generated_at ? new Date(meta.generated_at) : new Date();
  w.para(
    `Exported ${generatedAt.toLocaleString("en-US", {
      dateStyle: "long",
      timeStyle: "short",
    })}`
  );
  if (meta.about) w.para(meta.about);

  w.heading2("What we collect and why");
  for (const c of meta.categories_of_personal_information_collected ?? []) {
    w.heading3(`${c.category}${c.sensitive ? " (sensitive)" : ""}`);
    w.kv("Examples", c.examples);
    w.kv("Where it comes from", c.source);
    w.kv("Why we use it", c.purpose);
  }

  w.heading2("Who else sees your information");
  for (const t of meta.third_parties_disclosed_to ?? []) {
    w.heading3(`${t.name} - ${t.role}`);
    w.para(t.receives);
  }
  w.para(
    `Sold or shared for cross-context behavioral advertising: ${
      meta.sold_or_shared_for_cross_context_behavioral_advertising ? "Yes" : "No"
    }`
  );

  // Everything else in the payload, one heading per top-level category, in
  // the order collectUserData() builds them (account, home, marketplace,
  // account_activity, pro).
  for (const [sectionKey, sectionValue] of Object.entries(payload)) {
    if (sectionKey === "export_metadata") continue;
    w.heading2(humanize(sectionKey));
    if (sectionValue === null || sectionValue === undefined) {
      w.para(
        sectionKey === "pro"
          ? "Not applicable: this account has no contractor listing."
          : "(none)"
      );
      continue;
    }
    if (typeof sectionValue === "object" && !Array.isArray(sectionValue)) {
      renderSectionBody(w, sectionValue as Record<string, unknown>);
    } else {
      w.para(formatValue(sectionValue));
    }
  }

  return doc.save();
}
