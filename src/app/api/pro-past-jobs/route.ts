import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getCurrentContractor } from "@/lib/contractor";
import { hasPlus, hasProPlan } from "@/lib/subscription";
import { countAiUsage } from "@/lib/aiUsage";
import { JOB_CATEGORIES } from "@/lib/constants";

export const runtime = "nodejs";

// Read the line items off a pro's OWN past invoice or quote so the estimate
// tool can ground future estimates in their real pricing history instead of a
// guess. Same Gemini vision pattern as /api/extract-document: a pinned JSON
// shape, never invented facts, model fallback on 429. The uploaded file is
// processed in memory for this one request and is NOT saved to storage; only
// the structured extraction below is kept.
//
// Input:  { image: <base64, no data: prefix>, mime?: string }
// Output: { job: <saved row> } | { job: null, reason: "no_key" | "rate_limited" | "failed" }

// Cap the incoming base64 file so a caller can't push huge payloads at the
// paid vision model (cost/DoS). ~14M base64 chars ≈ 10MB of binary, same cap
// as /api/extract-document.
const MAX_FILE_B64_CHARS = 14_000_000;

const JOB_CATEGORY_VALUES = JOB_CATEGORIES.map((c) => c.value);
const LINE_ITEM_CATEGORIES = ["labor", "materials", "equipment", "permit", "other"];
const DOC_TYPES = ["invoice", "quote", "estimate", "receipt", "other"];

// Upper bound on stored line items. maxOutputTokens already keeps the array
// small, but cap it defensively so a garbage read can't stuff the pricing
// history with hundreds of rows.
const MAX_LINE_ITEMS = 60;

// Gemini structured-output schema. Every monetary field is a STRING so the
// model copies what is printed rather than doing arithmetic on it.
const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    doc_type: { type: "STRING", enum: DOC_TYPES },
    job_type: { type: "STRING" },
    job_summary: { type: "STRING" },
    document_date: { type: "STRING" }, // YYYY-MM-DD, empty if not shown
    location: { type: "STRING" }, // city and state only
    line_items: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          label: { type: "STRING" },
          category: { type: "STRING", enum: LINE_ITEM_CATEGORIES },
          quantity: { type: "STRING" },
          unit_price: { type: "STRING" },
          line_total: { type: "STRING" },
        },
        required: ["label"],
      },
    },
    subtotal: { type: "STRING" },
    total: { type: "STRING" },
    currency: { type: "STRING" },
  },
  required: ["doc_type", "line_items"],
};

const MODELS = [
  "gemini-2.5-flash",
  "gemini-flash-latest",
  "gemini-2.5-flash-lite",
  "gemini-2.0-flash",
];

export async function POST(req: NextRequest) {
  // Require a signed-in contractor before touching the paid model, same
  // resolution order as /api/pro-tools.
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
  if (!(await hasProPlan())) {
    return NextResponse.json({ error: "pro_required" }, { status: 403 });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ job: null, reason: "no_key" });
  }

  const body = await req.json().catch(() => ({}));
  const image = typeof body.image === "string" ? body.image : "";
  const mime = typeof body.mime === "string" ? body.mime : "image/jpeg";
  if (!image) {
    return NextResponse.json({ error: "No file." }, { status: 400 });
  }
  if (image.length > MAX_FILE_B64_CHARS) {
    return NextResponse.json({ error: "File too large." }, { status: 413 });
  }

  // Same per-user daily cap as the other AI routes (the shared ai_usage
  // table), so this can't be a side door around the abuse limits on the paid
  // model. Fails open. isPlus reflects the caller's real entitlement (same
  // check as /api/draft-apply) rather than always granting the higher cap.
  const higherTier = (await hasPlus()) || (await hasProPlan());
  const { overLimit } = await countAiUsage(user.id, higherTier);
  if (overLimit) {
    return NextResponse.json({ job: null, reason: "rate_limited" });
  }

  const instruction =
    "You are reading a single document a contractor uploaded from their own business records: it may be a past INVOICE, QUOTE, ESTIMATE, or RECEIPT for a job they did. " +
    "Extract ONLY what is actually printed on it, never guess or invent a number, date, or word that is not shown. Leave a field empty if it isn't on the document. " +
    "PRIVACY INSTRUCTION, follow this exactly: never extract or return the customer's or client's name, street address, email address, or phone number, even if they appear on the document. If the document shows them, omit them entirely from every field. " +
    "job_summary must describe the WORK that was done, one plain sentence, never the customer. " +
    "job_type: pick the single best match from this list of trade categories if one clearly fits: " +
    JOB_CATEGORY_VALUES.join(", ") +
    ". If none fit well, write a short free text label for the work instead. " +
    "document_date: the date printed on the document, as YYYY-MM-DD, or empty if no date is shown. " +
    "location: city and state only if shown (for example 'Austin, TX'), never a street address. Leave empty if only a street address is shown. " +
    "line_items: list each labeled line as printed. category is your best guess at labor, materials, equipment, permit, or other. quantity, unit_price, and line_total must be copied exactly as printed as strings (keep the currency symbol if printed); leave a field empty rather than computing or correcting it. " +
    "subtotal and total: copied exactly as printed as strings. Never recompute or correct the document's arithmetic, even if it looks wrong. " +
    "currency: the currency the amounts are in (for example 'USD'), or empty if unclear.";

  const requestBody = JSON.stringify({
    systemInstruction: { parts: [{ text: instruction }] },
    contents: [
      {
        role: "user",
        parts: [
          { text: "Extract the fields from this past job document." },
          { inlineData: { mimeType: mime, data: image } },
        ],
      },
    ],
    generationConfig: {
      maxOutputTokens: 1200,
      responseMimeType: "application/json",
      responseSchema: RESPONSE_SCHEMA,
    },
  });

  let rateLimited = false;
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
      if (resp.status === 429) {
        rateLimited = true;
        continue;
      }
      if (!resp.ok) continue;
      const data = await resp.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) continue;

      let parsed: any;
      try {
        parsed = JSON.parse(text);
      } catch {
        continue; // malformed, try the next model
      }

      const row = normalize(parsed, contractor.id);
      const { data: saved, error } = await supabase
        .from("pro_past_jobs")
        .insert(row)
        .select("*")
        .single();
      if (error || !saved) {
        return NextResponse.json({ job: null, reason: "failed" });
      }
      return NextResponse.json({ job: saved });
    } catch {
      // network error, try the next model
    }
  }

  return NextResponse.json({
    job: null,
    reason: rateLimited ? "rate_limited" : "failed",
  });
}

// Coerce the model's output into clean, storable values. Anything off-spec (a
// bad date, an unknown category) becomes null rather than polluting the
// pro's pricing history. Nothing here is invented: a missing field stays null.
// Real-calendar-date and plausible-window check for the printed document date
// (see the call site in normalize for why the shape regex alone isn't enough).
function plausibleDocDate(dateStr: string): boolean {
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
  return y >= nowYear - 30 && y <= nowYear + 1;
}

function normalize(raw: any, contractorId: string) {
  const str = (v: any) => {
    const s = typeof v === "string" ? v.trim() : "";
    return s.length ? s : null;
  };

  const docTypeRaw = str(raw?.doc_type);
  const doc_type =
    docTypeRaw && DOC_TYPES.includes(docTypeRaw) ? docTypeRaw : "invoice";

  // The shape regex still passes a misread like "2205-06-01" or an impossible
  // "2024-13-40", so reject any value that is not a real calendar date or
  // falls outside a plausible window for a past job document, rather than
  // letting a bad read pollute the pro's pricing history and, through it, the
  // estimate tool's reference lines.
  const dateRaw = str(raw?.document_date);
  const document_date =
    dateRaw && /^\d{4}-\d{2}-\d{2}$/.test(dateRaw) && plausibleDocDate(dateRaw)
      ? dateRaw
      : null;

  // Defense in depth on top of the prompt: a location that starts with a
  // house number reads as a street address, so drop it rather than store it.
  const locationRaw = str(raw?.location);
  const location =
    locationRaw && !/^\d/.test(locationRaw) ? locationRaw : null;

  const line_items = Array.isArray(raw?.line_items)
    ? raw.line_items
        .map((li: any) => {
          const label = str(li?.label);
          if (!label) return null;
          const categoryRaw = str(li?.category);
          const category =
            categoryRaw && LINE_ITEM_CATEGORIES.includes(categoryRaw)
              ? categoryRaw
              : "other";
          return {
            label,
            category,
            quantity: str(li?.quantity),
            unit_price: str(li?.unit_price),
            line_total: str(li?.line_total),
          };
        })
        .filter(Boolean)
        .slice(0, MAX_LINE_ITEMS)
    : [];

  return {
    contractor_id: contractorId,
    doc_type,
    job_type: str(raw?.job_type),
    job_summary: str(raw?.job_summary),
    document_date,
    location,
    line_items,
    subtotal: str(raw?.subtotal),
    total: str(raw?.total),
    currency: str(raw?.currency) ?? "USD",
  };
}
