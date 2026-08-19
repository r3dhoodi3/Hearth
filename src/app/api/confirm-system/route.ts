import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { hasPlus } from "@/lib/subscription";
import { countAiUsage } from "@/lib/aiUsage";
import { labelFor, SYSTEM_TYPES } from "@/lib/constants";

export const runtime = "nodejs";

// Cap the incoming base64 image so a caller can't push huge payloads at the
// paid vision model (cost/DoS). ~14M base64 chars ≈ 10MB of binary. Same cap
// as /api/extract-document.
const MAX_IMAGE_B64_CHARS = 14_000_000;

// "Walk your home": read the data plate / model-and-serial label on ONE home
// system so the owner can replace its estimated details with the real thing.
// Same Gemini vision as /api/extract-document, pinned to a small schema. This
// only ever returns a SUGGESTION - src/app/(app)/walkthrough/actions.ts is the
// only thing that writes to home_systems, and only after the owner confirms.
//
// Input:  { image: <base64, no data: prefix>, mime?: string, system_id: string }
// Output: { suggestion: { brand, model, serial, install_year } | null, reason? }
// (any field null if it isn't on the label - never invented).

const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    brand: { type: "STRING" },
    model: { type: "STRING" },
    serial: { type: "STRING" },
    install_year: { type: "INTEGER" },
  },
};

const MODELS = [
  "gemini-2.5-flash",
  "gemini-flash-latest",
  "gemini-2.5-flash-lite",
  "gemini-2.0-flash",
];

export async function POST(req: NextRequest) {
  // Require a signed-in user. This is an authenticated feature; gating it here
  // (not just in middleware) stops anonymous abuse of the paid vision API.
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const image = typeof body.image === "string" ? body.image : "";
  const mime = typeof body.mime === "string" ? body.mime : "image/jpeg";
  const systemId = typeof body.system_id === "string" ? body.system_id : "";
  if (!image || !systemId) {
    return NextResponse.json(
      { error: "Missing image or system." },
      { status: 400 }
    );
  }
  if (image.length > MAX_IMAGE_B64_CHARS) {
    return NextResponse.json({ error: "Image too large." }, { status: 413 });
  }

  // Property-ownership guard: "home_systems owner all" (RLS, gated by
  // owns_property()) only lets this select return a row on a property the
  // caller owns or shares as an active household member. A miss here means
  // "not yours", not "doesn't exist", so we don't leak which.
  const { data: system } = await supabase
    .from("home_systems")
    .select("id, system_type")
    .eq("id", systemId)
    .maybeSingle();
  if (!system) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    // No key: the walkthrough still works, the owner just fills the form in
    // by hand instead of getting a suggestion.
    return NextResponse.json({ suggestion: null, reason: "no_key" });
  }

  // Same per-user daily cap as every other AI-backed route (shared ai_usage
  // table, src/lib/aiUsage.ts), so scanning systems can't be a side door
  // around the abuse limits on the paid model.
  const { overLimit } = await countAiUsage(user.id, await hasPlus());
  if (overLimit) {
    return NextResponse.json({ suggestion: null, reason: "rate_limited" });
  }

  const sysLabel = labelFor(SYSTEM_TYPES, system.system_type) || "home system";
  const instruction =
    `You are reading the data plate / model-and-serial label on a homeowner's ${sysLabel}. ` +
    "First, judge whether you can actually read the label. If the photo is too blurry, dark, cropped, glare covered, or low resolution to read, or it is clearly not a data plate or model-and-serial label (for example a selfie or an unrelated photo), do not guess: leave every field empty. If only part of the label is legible, read the fields you can and leave the rest empty rather than guessing at them. " +
    "Extract ONLY what is actually printed on the label - never guess or invent a value. Leave a field empty if it isn't shown. " +
    "Read brand and model exactly as printed. " +
    "For serial, read the serial number exactly as printed. " +
    "For install_year, use a manufacture date or install sticker if present (4-digit year only); if the label only shows a manufacture date code, decode it to a year if you're confident, otherwise leave it empty.";

  const requestBody = JSON.stringify({
    systemInstruction: { parts: [{ text: instruction }] },
    contents: [
      {
        role: "user",
        parts: [
          { text: "Read the fields off this data plate." },
          { inlineData: { mimeType: mime, data: image } },
        ],
      },
    ],
    generationConfig: {
      // Deterministic extraction: reading a data plate is not a creative task,
      // so keep the model from embellishing what it sees.
      temperature: 0,
      maxOutputTokens: 300,
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
        continue; // malformed - try the next model
      }
      const suggestion = normalize(parsed);
      // Nothing legible came off the label (unreadable photo or wrong subject):
      // surface it as a read failure so the owner gets the "couldn't read it,
      // fill in what you can" note instead of an empty form that looks like a
      // successful read. A partial read (any field present) still goes through.
      if (
        !suggestion.brand &&
        !suggestion.model &&
        !suggestion.serial &&
        suggestion.install_year == null
      ) {
        return NextResponse.json({ suggestion: null, reason: "unreadable" });
      }
      return NextResponse.json({ suggestion });
    } catch {
      // network error - try the next model
    }
  }

  return NextResponse.json({
    suggestion: null,
    reason: rateLimited ? "rate_limited" : "failed",
  });
}

// Coerce the model's output into clean, storable values. Anything off-spec
// (a bad year) becomes null rather than polluting the suggestion.
function normalize(raw: any) {
  const str = (v: any) => {
    const s = typeof v === "string" ? v.trim() : "";
    return s.length ? s : null;
  };
  // A system can't have been installed in the future, so bound the upper end
  // at this year (a +1 of slack), not a far-off 2100.
  const maxYear = new Date().getFullYear() + 1;
  const yearNum = Number(raw?.install_year);
  const install_year =
    Number.isInteger(yearNum) && yearNum >= 1700 && yearNum <= maxYear
      ? yearNum
      : null;

  return {
    brand: str(raw?.brand),
    model: str(raw?.model),
    serial: str(raw?.serial),
    install_year,
  };
}
