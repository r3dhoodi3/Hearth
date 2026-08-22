import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { hasPlus } from "@/lib/subscription";
import { countAiUsage } from "@/lib/aiUsage";

export const runtime = "nodejs";

// Voice dictation fallback for the Ask Hearth mic button. Browsers without a
// working Web Speech service (Firefox has none; Brave, Electron shells, and
// some networks break Chrome's cloud speech) record audio locally and post it
// here, and Gemini turns it into a transcript. Kept behind the same auth and
// daily ai_usage cap as /api/ask so voice can't be a side door around the
// abuse limits on the paid model.
//
// Input:  { audio: <base64, no data: prefix>, mime?: string }
// Output: { text } on success (an empty string means no intelligible speech),
//         or { text: null, reason: "no_key" | "rate_limited" | "failed" }.

// Cap the incoming base64 audio so a caller can't push huge payloads at the
// paid model (cost/DoS). ~14M base64 chars ≈ 10MB of binary, far more than a
// 60-second voice memo produces.
const MAX_AUDIO_B64_CHARS = 14_000_000;

// Each free-tier model has its OWN daily quota, so cycle through them: if one
// is rate-limited (429), fall through to the next. All of these accept inline
// audio.
const MODELS = [
  "gemini-2.5-flash-lite",
  "gemini-2.5-flash",
  "gemini-flash-latest",
  "gemini-2.0-flash-lite",
];

export async function POST(req: NextRequest) {
  // Require a signed-in user before touching the paid model, same as /api/ask.
  const authClient = await createClient();
  const {
    data: { user },
  } = await authClient.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ text: null, reason: "no_key" });
  }

  const body = await req.json().catch(() => ({}));
  const audio = typeof body.audio === "string" ? body.audio : "";
  const mime =
    typeof body.mime === "string" && body.mime ? body.mime : "audio/webm";
  if (!audio) {
    return NextResponse.json({ error: "No audio." }, { status: 400 });
  }
  if (audio.length > MAX_AUDIO_B64_CHARS) {
    return NextResponse.json({ error: "Audio too large." }, { status: 413 });
  }

  // Same per-user daily cap as /api/ask, counted in the same ai_usage table
  // (migration 0024), so dictation shares the cap instead of bypassing it.
  // Fails open and resets at midnight; see src/lib/aiUsage.ts.
  const isPlus = await hasPlus();
  const { overLimit } = await countAiUsage(user.id, isPlus);
  if (overLimit) {
    return NextResponse.json({ text: null, reason: "rate_limited" });
  }

  const requestBody = JSON.stringify({
    contents: [
      {
        role: "user",
        parts: [
          {
            text:
              "Transcribe this audio exactly as spoken. Reply with ONLY the " +
              "transcript text, no quotes, no commentary. If there is no " +
              "intelligible speech, or the audio is too noisy, muffled, or " +
              "garbled to make out the words, reply with an empty string " +
              "rather than guessing at what was said.",
          },
          { inlineData: { mimeType: mime, data: audio } },
        ],
      },
    ],
    // Deterministic transcription: keep it from inventing words to fill gaps.
    generationConfig: { temperature: 0, maxOutputTokens: 800 },
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
        continue; // this model is out of quota; try the next
      }
      if (!resp.ok) continue;
      const data = await resp.json();
      const candidate = data?.candidates?.[0];
      const text = candidate?.content?.parts?.[0]?.text;
      if (typeof text === "string") {
        return NextResponse.json({ text: text.trim() });
      }
      // An empty transcript is a valid answer (silence): a finished candidate
      // with no text part means the model heard nothing intelligible. Only a
      // missing/blocked candidate means failure, so then try the next model.
      if (candidate?.finishReason === "STOP") {
        return NextResponse.json({ text: "" });
      }
    } catch {
      // Network error - try the next model.
    }
  }

  return NextResponse.json({
    text: null,
    reason: rateLimited ? "rate_limited" : "failed",
  });
}
