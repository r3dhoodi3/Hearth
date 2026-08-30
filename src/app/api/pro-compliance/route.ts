import { NextRequest, NextResponse } from "next/server";
import { sameOriginGuard } from "@/lib/csrf";
import { createClient } from "@/lib/supabase/server";
import { getCurrentContractor } from "@/lib/contractor";
import { hasPlus } from "@/lib/subscription";
import { countAiUsage, refundAiUsage } from "@/lib/aiUsage";
import {
  reasonToClientPayload,
  type AiClientReason,
} from "@/lib/aiReason";
import { readBodyBounded } from "@/lib/boundedBody";
import { checkUpload, extensionFor } from "@/lib/uploadGuard";
import { generateJson, hasClaudeKey } from "@/lib/claude";

export const runtime = "nodejs";

// Compliance calendar upload: a pro uploads their contractor license or
// certificate of insurance once, and Hearth reads the expiration date off it
// with the same vision model /api/extract-document uses. Reading a date off
// a document is not verification. Nothing here claims the license or policy
// itself was checked: license_verified_status (migration 0037) is untouched,
// and the UI is expected to say "on file", never "verified".
//
// POST multipart/form-data:
//   kind         "license" | "insurance"          (required)
//   file         the document image or PDF          (optional if only
//                submitting a manual date correction for an already
//                uploaded document)
//   manual_expires_on  "YYYY-MM-DD"                (optional, overrides
//                whatever the vision call reads, and is the only way to set
//                a date when extraction could not read one)
//
// Output: { ok: true, expires_on, issuer, needs_manual_date, skip_reason,
//            manual_reason, doc_path }
//       | { error: string }
// skip_reason / manual_reason are non-null only when the vision read never
// ran at all (a PDF, or a counter refusal), so the client can say which.

const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10MB, matches extract-document's cap
// Hard ceiling on the whole multipart body. MAX_FILE_BYTES above is checked
// only AFTER req.formData() has already buffered and decoded everything, and
// the Content-Length that used to be the only other bound is a claim a
// chunked request never makes. This is counted on the bytes that actually
// arrive, with a megabyte of headroom over the file cap for the multipart
// envelope and the other fields. See src/lib/boundedBody.ts.
const MAX_BODY_BYTES = 11 * 1024 * 1024;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// The allow-list used to live here as a hand-kept copy of the pro-docs
// bucket's allowed_mime_types. It now lives in src/lib/uploadGuard.ts
// (UPLOAD_KINDS.compliance), which every upload path shares, so tightening it
// tightens all of them at once.

// Structured output: the model is constrained to this shape server-side. The
// optional fields are nullable rather than omitted, since "no expiration date
// is printed" is the case this route most has to get right: plausibleExpiry()
// below still rejects anything that is not a real, believable date.
const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    doc_kind: {
      type: "string",
      enum: ["license", "insurance", "other"],
    },
    holder_matches_hint: { type: ["string", "null"] },
    expires_on: { type: ["string", "null"] }, // YYYY-MM-DD, null if unreadable
    issuer: { type: ["string", "null"] }, // state board or insurance carrier
  },
  required: ["doc_kind", "holder_matches_hint", "expires_on", "issuer"],
  additionalProperties: false,
};

type ComplianceFields = {
  doc_kind: string;
  holder_matches_hint: string | null;
  expires_on: string | null;
  issuer: string | null;
};

function str(v: FormDataEntryValue | null): string {
  return typeof v === "string" ? v.trim() : "";
}

// Why the vision read was skipped, when it was. The route already returned
// needs_manual_date, but that one boolean covered three different situations
// and the client rendered the same sentence for all of them: "Hearth couldn't
// read a date off that document." For a PDF nothing ever looked at, and for a
// pro who is simply over their daily AI cap, that sentence is false and sends
// them off to retake a photo that was fine.
type SkipReason = "not_an_image" | AiClientReason | null;

const SKIP_COPY: Record<NonNullable<SkipReason>, string> = {
  not_an_image: "Hearth only reads dates off photos, not PDFs. Enter it:",
  rate_limited: "You've hit today's AI limit. Enter the date:",
  busy: "Hearth's AI is busy right now. Enter the date:",
  unavailable: "Hearth couldn't read this one just now. Enter the date:",
};

// Sanity-bound a printed expiry date. DATE_RE only checks the shape, so a
// vision misread like "2205-01-01" or an impossible "2026-13-40" can still
// pass it. Reject anything that is not a real calendar date or falls outside
// a plausible window for a license or insurance document, so a bad read
// becomes a "type the date" prompt instead of a confidently wrong date on the
// pro's compliance calendar.
function plausibleExpiry(dateStr: string): boolean {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (
    dt.getUTCFullYear() !== y ||
    dt.getUTCMonth() !== m - 1 ||
    dt.getUTCDate() !== d
  ) {
    return false; // not a real calendar date (for example month 13, day 40)
  }
  const nowYear = new Date().getUTCFullYear();
  return y >= nowYear - 30 && y <= nowYear + 30;
}

async function extractExpiry(
  kind: "license" | "insurance",
  base64: string,
  mime: string,
  userId: string
): Promise<{ expires_on: string | null; issuer: string | null } | null> {
  if (!hasClaudeKey()) return null;

  const today = new Date().toISOString().slice(0, 10);
  const docLabel =
    kind === "license"
      ? "a contractor/trade license issued by a state or local licensing board"
      : "a certificate of insurance (COI) for a contracting business";
  const instruction =
    `You are reading ${docLabel}. Extract ONLY what is printed on it: never guess or invent a date. ` +
    "expires_on is the expiration or renewal date, as YYYY-MM-DD, omitted entirely if no expiration date is printed or legible. " +
    "issuer is the state licensing board name for a license, or the insurance carrier name for a COI, omitted if not shown. " +
    "holder_matches_hint is a short note only if the named holder looks like a completely different business than expected, otherwise omit it. " +
    `Today's date is ${today}.`;

  try {
    // Reading one date and one issuer name off a certificate: mechanical, so
    // low effort. Everything the model returns is still bounds-checked below.
    const { data: parsed } = await generateJson<ComplianceFields>({
      system: instruction,
      prompt: "Extract the fields from this document.",
      ...(mime.toLowerCase().startsWith("application/pdf")
        ? { documents: [{ data: base64 }] }
        : { images: [{ data: base64, mime }] }),
      schema: RESPONSE_SCHEMA,
      maxTokens: 1024,
      effort: "low",
      timeoutMs: 60_000,
      label: "pro-compliance",
    });
    if (!parsed) return null;

    const expiresRaw =
      typeof parsed.expires_on === "string" ? parsed.expires_on.trim() : "";
    const issuerRaw =
      typeof parsed.issuer === "string" ? parsed.issuer.trim() : "";
    return {
      expires_on:
        DATE_RE.test(expiresRaw) && plausibleExpiry(expiresRaw)
          ? expiresRaw
          : null,
      issuer: issuerRaw || null,
    };
  } catch {
    // Throttled, timed out, or refused: the pro types the date in by hand,
    // which is the same path an unreadable document already takes. The pro
    // was already charged one of today's usages by the countAiUsage call at
    // the call site, and a thrown model call never read a date, so hand it
    // back rather than spending their allowance on a request that failed.
    await refundAiUsage(userId);
    return null;
  }
}

export async function POST(req: NextRequest) {
  // CSRF, second lock. The session cookie is SameSite=Lax and this body is
  // JSON, so a cross-site page cannot get a signed-in request here today;
  // this refuses one outright rather than depending on those defaults.
  // src/lib/csrf.ts only rejects on positive cross-site evidence.
  const crossSite = sameOriginGuard(req);
  if (crossSite) return crossSite;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const contractor = await getCurrentContractor();
  if (!contractor) {
    return NextResponse.json({ error: "Not a contractor" }, { status: 403 });
  }

  // Read the upload under a hard byte ceiling BEFORE handing it to the
  // multipart parser, then parse the bytes we kept. Note the burst limit is
  // deliberately NOT hoisted in front of this the way it is on the JSON tool
  // routes: this endpoint also saves a hand-typed expiry date, which never
  // touches the model, and refusing that because the pro's AI burst window is
  // full would break a path that costs nothing. The AI branch below still
  // goes through countAiUsage, which runs the real burst check.
  const bounded = await readBodyBounded(req, MAX_BODY_BYTES);
  if (!bounded.ok) {
    return bounded.status === 413
      ? NextResponse.json({ error: "File too large." }, { status: 413 })
      : NextResponse.json({ error: "Bad request." }, { status: 400 });
  }
  // .buffer, not the view: readBodyBounded allocates the array at exactly the
  // byte count it read, so the two are the same bytes, and ArrayBuffer is what
  // BodyInit actually accepts.
  const form = await new Response(bounded.bytes.buffer as ArrayBuffer, {
    headers: { "content-type": req.headers.get("content-type") ?? "" },
  })
    .formData()
    .catch(() => null);
  if (!form) {
    return NextResponse.json({ error: "Bad request." }, { status: 400 });
  }

  const kindRaw = str(form.get("kind"));
  if (kindRaw !== "license" && kindRaw !== "insurance") {
    return NextResponse.json(
      { error: "kind must be 'license' or 'insurance'." },
      { status: 400 }
    );
  }
  const kind = kindRaw as "license" | "insurance";

  const manualRaw = str(form.get("manual_expires_on"));
  const manualExpiresOn = DATE_RE.test(manualRaw) ? manualRaw : null;
  if (manualRaw && !manualExpiresOn) {
    return NextResponse.json(
      { error: "manual_expires_on must be YYYY-MM-DD." },
      { status: 400 }
    );
  }

  const file = form.get("file");
  const hasFile = file instanceof File && file.size > 0;

  if (!hasFile && !manualExpiresOn) {
    return NextResponse.json(
      { error: "Provide a file, a manual date, or both." },
      { status: 400 }
    );
  }

  let expiresOn: string | null = manualExpiresOn;
  let issuer: string | null = null;
  let docPath: string | null = null;
  // Why extraction never ran, when it never ran. null means it ran (and either
  // read a date or genuinely could not). The client pairs this with
  // needs_manual_date to say something true above the date field instead of
  // always blaming the document. See SKIP_COPY below.
  let skipReason: SkipReason = null;

  if (hasFile) {
    const uploadedFile = file as File;
    if (uploadedFile.size > MAX_FILE_BYTES) {
      return NextResponse.json({ error: "File too large." }, { status: 413 });
    }
    const rawBytes = new Uint8Array(await uploadedFile.arrayBuffer());

    // THE FILE IS DECIDED BY ITS BYTES, NOT BY WHAT IT CLAIMS TO BE.
    // src/lib/uploadGuard.ts sniffs the magic number, refuses anything that is
    // not one of the four types the pro-docs bucket allows, refuses a PDF that
    // carries /JavaScript or /OpenAction, and hands back image bytes with EXIF
    // and any appended payload removed. This replaces the old "trust
    // file.type, and store an unrecognised one as octet-stream" handling:
    // storing a crafted file inertly still stored it, and the pro's own signed
    // GET would hand it back.
    const verdict = await checkUpload({
      bytes: rawBytes,
      kind: "compliance",
      declaredType: uploadedFile.type || null,
    });
    if (!verdict.ok) {
      return NextResponse.json(
        { error: verdict.message },
        { status: verdict.status }
      );
    }
    const mime = verdict.type;
    const bytes = verdict.bytes;

    // Upload first through the caller's own session, so storage RLS (the
    // pro-docs owner policies from migration 0051) is the only gate: no
    // service role, no manual ownership check needed here.
    //
    // The extension comes from the sniffed type, not from the name the pro's
    // file happened to carry, and the random suffix replaces Date.now(): two
    // uploads inside the same millisecond used to collide on the key and the
    // second one failed under upsert: false.
    const ext = extensionFor(mime);
    docPath = `${contractor.id}/${kind}-${crypto.randomUUID()}.${ext}`;
    const { error: uploadError } = await supabase.storage
      .from("pro-docs")
      .upload(docPath, bytes, { contentType: mime, upsert: false });
    if (uploadError) {
      return NextResponse.json(
        { error: "Couldn't store the document. Is the pro-docs bucket set up?" },
        { status: 500 }
      );
    }

    // Vision extraction, counted against the same shared AI cap as every
    // other model-backed route so it can't be a side door around it.
    //
    // COUNTED LAST, and only when a model call is actually going to happen.
    // countAiUsage was previously called before the mime check, so uploading a
    // PDF spent one of the pro's daily AI usages on a branch that never sends
    // anything to the model: the route stores the PDF, skips vision because
    // the model only reads images, and the pro is charged for it anyway. Ten
    // PDFs and a free-tier pro is locked out of extraction for the day having
    // never used it once. The mime and manual-date checks are free, so they go
    // first and the counter only moves for a real call.
    const isImage = mime.startsWith("image/");
    if (!manualExpiresOn && isImage) {
      const { overLimit, reason } = await countAiUsage(user.id, await hasPlus());
      if (overLimit) {
        // Refused by a counter, not by an unreadable document. Classified by
        // the same shared mapper the other ten tool routes use, so a burst
        // window says "busy" here too instead of claiming the pro is out for
        // the day. Only the classification is borrowed: the sentence has to
        // end in "enter the date", which is what this card asks for next.
        skipReason = reasonToClientPayload(reason).reason;
      } else {
        const base64 = Buffer.from(bytes).toString("base64");
        const extracted = await extractExpiry(kind, base64, mime, user.id);
        if (extracted) {
          expiresOn = extracted.expires_on;
          issuer = extracted.issuer;
        }
      }
    } else if (!manualExpiresOn && !isImage) {
      // PDFs (and anything stored as octet-stream) are kept but never sent to
      // vision here: the model only reads images. Nothing is counted for it,
      // and the pro is told WHY they are being asked to type the date rather
      // than being shown the generic "couldn't read a date" line, which reads
      // as "your document is bad" for a document nothing ever looked at.
      skipReason = "not_an_image";
    }
  }

  // Persist onto the contractors row. Casts: these are migration 0051
  // columns, not regenerated into database.types.ts here.
  const fields: Record<string, unknown> = {};
  if (kind === "license") {
    if (docPath) fields.license_doc_path = docPath;
    if (expiresOn) fields.license_expires = expiresOn;
  } else {
    if (docPath) fields.insurance_doc_path = docPath;
    if (expiresOn) fields.insurance_expires = expiresOn;
    // Only fill insurance_carrier when it's currently empty and vision read
    // one: never overwrite what the pro already entered on /pro/profile.
    if (issuer && !(contractor as any).insurance_carrier) {
      fields.insurance_carrier = issuer;
    }
  }

  if (Object.keys(fields).length > 0) {
    const { error: updateError } = await (supabase.from("contractors") as any)
      .update(fields)
      .eq("id", contractor.id);
    if (updateError) {
      return NextResponse.json(
        { error: "Document saved, but the details couldn't be updated." },
        { status: 500 }
      );
    }
  }

  return NextResponse.json({
    ok: true,
    expires_on: expiresOn,
    issuer,
    needs_manual_date: hasFile && !expiresOn,
    // Machine-readable, plus the sentence to show. Both null when extraction
    // actually ran, in which case the client's existing "couldn't read a date"
    // line is the true one.
    skip_reason: skipReason,
    manual_reason: skipReason ? SKIP_COPY[skipReason] : null,
    doc_path: docPath,
  });
}

// Serve a stored document back to its own owner. Mirrors /api/img: signs a
// short-lived URL using the caller's own session, so the pro-docs owner
// policies (migration 0051) are the only gate, and redirects to it. /api/img
// itself is hardcoded to the home-photos bucket, so this route gets its own
// minimal, owner-checked GET rather than trying to generalize that one.
export async function GET(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const path = req.nextUrl.searchParams.get("path") ?? "";
  if (!path || path.includes("..") || path.startsWith("/")) {
    return NextResponse.json({ error: "Bad path" }, { status: 400 });
  }

  const { data, error } = await supabase.storage
    .from("pro-docs")
    .createSignedUrl(path, 60 * 10); // 10 minutes

  if (error || !data?.signedUrl) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const res = NextResponse.redirect(data.signedUrl);
  // Same pattern as /api/img: 480s < the signed URL's 600s TTL, so a cached
  // redirect can never outlive the URL it points to. "private" keeps this
  // out of any shared/CDN cache.
  res.headers.set("Cache-Control", "private, max-age=480");
  return res;
}
