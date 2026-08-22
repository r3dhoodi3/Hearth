import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getCurrentContractor } from "@/lib/contractor";
import { hasPlus } from "@/lib/subscription";
import { countAiUsage } from "@/lib/aiUsage";

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
// Output: { ok: true, expires_on, issuer, needs_manual_date, doc_path }
//       | { error: string }

const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10MB, matches extract-document's cap
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Exactly what the pro-docs bucket's own allowed_mime_types permits
// (supabase/migrations/0081_storage_mime_limits.sql). Kept in sync by hand
// because the bucket config lives in SQL; anything not on this list is stored
// as application/octet-stream rather than under the type the client claimed.
const ALLOWED_UPLOAD_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "application/pdf",
]);

const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    doc_kind: {
      type: "STRING",
      enum: ["license", "insurance", "other"],
    },
    holder_matches_hint: { type: "STRING" },
    expires_on: { type: "STRING" }, // YYYY-MM-DD, or omitted if unreadable
    issuer: { type: "STRING" }, // state board or insurance carrier name
  },
  required: ["doc_kind"],
};

const MODELS = [
  "gemini-2.5-flash",
  "gemini-flash-latest",
  "gemini-2.5-flash-lite",
  "gemini-2.0-flash",
];

function str(v: FormDataEntryValue | null): string {
  return typeof v === "string" ? v.trim() : "";
}

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
  mime: string
): Promise<{ expires_on: string | null; issuer: string | null } | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;

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

  const requestBody = JSON.stringify({
    systemInstruction: { parts: [{ text: instruction }] },
    contents: [
      {
        role: "user",
        parts: [
          { text: "Extract the fields from this document." },
          { inlineData: { mimeType: mime, data: base64 } },
        ],
      },
    ],
    generationConfig: {
      maxOutputTokens: 300,
      responseMimeType: "application/json",
      responseSchema: RESPONSE_SCHEMA,
    },
  });

  for (const model of MODELS) {
    try {
      const resp = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-goog-api-key": apiKey,
          },
          body: requestBody,
        }
      );
      if (resp.status === 429) continue;
      if (!resp.ok) continue;
      const data = await resp.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) continue;

      let parsed: any;
      try {
        parsed = JSON.parse(text);
      } catch {
        continue;
      }
      const expiresRaw =
        typeof parsed?.expires_on === "string" ? parsed.expires_on.trim() : "";
      const issuerRaw =
        typeof parsed?.issuer === "string" ? parsed.issuer.trim() : "";
      return {
        expires_on:
          DATE_RE.test(expiresRaw) && plausibleExpiry(expiresRaw)
            ? expiresRaw
            : null,
        issuer: issuerRaw || null,
      };
    } catch {
      // Network error: try the next model.
    }
  }
  return null;
}

export async function POST(req: NextRequest) {
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

  const form = await req.formData().catch(() => null);
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

  if (hasFile) {
    const uploadedFile = file as File;
    if (uploadedFile.size > MAX_FILE_BYTES) {
      return NextResponse.json({ error: "File too large." }, { status: 413 });
    }
    // The client's file.type is a claim, not a fact, and it used to be passed
    // straight through as the stored object's contentType - which is what a
    // browser trusts when the file is fetched back. Anything outside the list
    // the pro-docs bucket itself allows (migration 0079) is stored as an inert
    // octet-stream instead, so a mislabeled or crafted upload can never be
    // served back as something a browser will render or execute.
    const claimedMime = uploadedFile.type || "";
    const mime = ALLOWED_UPLOAD_TYPES.has(claimedMime)
      ? claimedMime
      : "application/octet-stream";
    const bytes = new Uint8Array(await uploadedFile.arrayBuffer());

    // Upload first through the caller's own session, so storage RLS (the
    // pro-docs owner policies from migration 0051) is the only gate: no
    // service role, no manual ownership check needed here.
    const rawExt = (uploadedFile.name.split(".").pop() || "").toLowerCase();
    const ext = /^[a-z0-9]{1,5}$/.test(rawExt) ? rawExt : "bin";
    docPath = `${contractor.id}/${kind}-${Date.now()}.${ext}`;
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
    // other Gemini-backed route so it can't be a side door around it.
    if (!manualExpiresOn) {
      const { overLimit } = await countAiUsage(user.id, await hasPlus());
      if (!overLimit) {
        const isImage = mime.startsWith("image/");
        if (isImage) {
          const base64 = Buffer.from(bytes).toString("base64");
          const extracted = await extractExpiry(kind, base64, mime);
          if (extracted) {
            expiresOn = extracted.expires_on;
            issuer = extracted.issuer;
          }
        }
        // PDFs are stored but not sent to vision here: the model only reads
        // images. A pro who uploads a PDF simply gets the "type the date"
        // prompt, same as an unreadable photo.
      }
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
