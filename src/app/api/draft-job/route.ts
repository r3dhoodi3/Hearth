import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { hasPlus } from "@/lib/subscription";
import { countAiUsage } from "@/lib/aiUsage";
import { JOB_CATEGORIES } from "@/lib/constants";
import { toObjectPath } from "@/lib/storage";
import { fetchWithTimeout, isTimeoutError } from "@/lib/fetchWithTimeout";

export const runtime = "nodejs";

// Post-a-job helper: the homeowner attaches a photo of the problem, and this
// drafts a plain-language description in THEIR voice for them to edit (never to
// originate) before they post. Same Gemini vision + model-fallback convention
// as /api/confirm-system, pinned to a small schema. The photo is already in the
// private home-photos bucket (PhotoUpload uploaded it and holds only its URL,
// not the raw File), so this takes the stored URL / object path, downloads the
// bytes through the CALLER'S session, and passes them to the model.
//
// Input:  { photo_url: <stored home-photos URL or bare object path> }
// Output: { description: string|null, category_guess: string|null,
//           severity_guess: string|null, reason?: string }
// description is null (with a reason) when the image can't be read or the AI
// limit/key blocks it - never a crash.

// 10MB of binary, matching the client-side cap in SystemCaptureCard so a photo
// that made it into the bucket stays well under the vision model's limits.
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

const MODELS = [
  "gemini-2.5-flash",
  "gemini-flash-latest",
  "gemini-2.5-flash-lite",
  "gemini-2.0-flash",
];

const SEVERITIES = ["low", "medium", "urgent"];

const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    description: { type: "STRING" },
    category_guess: { type: "STRING" },
    severity_guess: { type: "STRING" },
  },
  required: ["description"],
};

export async function POST(req: NextRequest) {
  // Authenticated feature: gating here (not just middleware) stops anonymous
  // abuse of the paid vision API, same as /api/confirm-system.
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const rawUrl = typeof body.photo_url === "string" ? body.photo_url : "";
  const path = toObjectPath(rawUrl);
  // Reject path traversal / absolute-ish inputs, same rule as /api/img.
  if (!path || path.includes("..") || path.startsWith("/")) {
    return NextResponse.json({ error: "Missing or bad photo." }, { status: 400 });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    // No key: the owner just types the description by hand, same graceful
    // degrade as the walkthrough's data-plate scan.
    return NextResponse.json({ description: null, reason: "no_key" });
  }

  // Same shared per-user daily cap as every other AI-backed route, so drafting
  // descriptions can't be a side door around the abuse limits on the paid
  // model.
  const { overLimit } = await countAiUsage(user.id, await hasPlus());
  if (overLimit) {
    return NextResponse.json({ description: null, reason: "rate_limited" });
  }

  // Download the photo through the caller's session: the home-photos bucket is
  // private and RLS only signs/serves objects on a property the caller owns or
  // shares, so this both fetches the bytes AND enforces that the photo is
  // theirs. A miss means "not yours or gone", not a crash.
  const { data: blob, error: dlErr } = await supabase.storage
    .from("home-photos")
    .download(path);
  if (dlErr || !blob) {
    return NextResponse.json({ description: null, reason: "not_found" });
  }

  const buf = Buffer.from(await blob.arrayBuffer());
  if (buf.byteLength > MAX_IMAGE_BYTES) {
    return NextResponse.json({ description: null, reason: "too_large" });
  }
  const image = buf.toString("base64");
  const mime = blob.type || "image/jpeg";

  const instruction =
    "You are helping a homeowner describe a home problem or project they want to hire a local pro for, based on one photo they just took of it. " +
    "Write the description in the homeowner's own plain voice, as if they are telling the pro what they see. " +
    "Describe only what is visible in the photo: what the thing is, where it is if that is clear, the rough size or extent, and any obvious signs such as a stain, crack, leak, rust, or wear. " +
    "Keep it to one to three short sentences. Do not diagnose the cause with certainty, do not promise what the fix is, and do not invent details that are not in the photo. " +
    "First, judge whether you can actually use the photo. If it is too blurry, dark, cropped, or low resolution to describe, or it is clearly not a home problem or project (for example a selfie, a screenshot, or an unrelated image), set description to an empty string rather than guessing at what it might show. " +
    "If you genuinely cannot tell what the photo shows, or it is too blurry or dark to describe, set description to an empty string. " +
    "Also guess the trade category and a rough severity when you can, and leave them empty when you are not sure. " +
    "For category_guess use exactly one of these values, or leave it empty: " +
    JOB_CATEGORIES.map((c) => c.value).join(", ") +
    ". For severity_guess use exactly one of low, medium, or urgent, or leave it empty. " +
    "Never use an em dash or a hyphen as a connector: use a comma, a colon, or a new sentence instead.";

  const requestBody = JSON.stringify({
    systemInstruction: { parts: [{ text: instruction }] },
    contents: [
      {
        role: "user",
        parts: [
          {
            text: "Describe what needs doing, in the homeowner's voice, based on this photo.",
          },
          { inlineData: { mimeType: mime, data: image } },
        ],
      },
    ],
    generationConfig: {
      maxOutputTokens: 300,
      responseMimeType: "application/json",
      responseSchema: RESPONSE_SCHEMA,
    },
  });

  let rateLimited = false;
  for (const model of MODELS) {
    try {
      const resp = await fetchWithTimeout(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-goog-api-key": apiKey,
          },
          body: requestBody,
        },
        30_000
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

      const description =
        typeof parsed?.description === "string" ? parsed.description.trim() : "";
      if (!description) {
        // The model could read the request but not the picture: tell the owner
        // plainly rather than dropping an empty draft into the box.
        return NextResponse.json({ description: null, reason: "unreadable" });
      }
      const catRaw =
        typeof parsed?.category_guess === "string" ? parsed.category_guess : "";
      const sevRaw =
        typeof parsed?.severity_guess === "string" ? parsed.severity_guess : "";
      return NextResponse.json({
        description,
        // Only echo a guess we can actually act on: an off-list value becomes
        // null rather than a category the picker can't select.
        category_guess: JOB_CATEGORIES.some((c) => c.value === catRaw)
          ? catRaw
          : null,
        severity_guess: SEVERITIES.includes(sevRaw) ? sevRaw : null,
      });
    } catch (e) {
      // A timeout or network error on one model just falls through to the next.
      if (isTimeoutError(e)) continue;
    }
  }

  return NextResponse.json({
    description: null,
    reason: rateLimited ? "rate_limited" : "failed",
  });
}
