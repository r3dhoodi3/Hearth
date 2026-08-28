import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getPlusTier } from "@/lib/subscription";
import { countAiUsage, overToolBurst, refundAiUsage } from "@/lib/aiUsage";
import { reasonToClientPayload } from "@/lib/aiReason";
import { readJsonBounded } from "@/lib/boundedBody";
import { JOB_CATEGORIES } from "@/lib/constants";
import { toObjectPath } from "@/lib/storage";
import { generateJson, hasClaudeKey, isRateLimitError } from "@/lib/claude";

export const runtime = "nodejs";

// Post-a-job helper: the homeowner attaches a photo of the problem, and this
// drafts a plain-language description in THEIR voice for them to edit (never to
// originate) before they post. Same Claude vision convention as
// /api/confirm-system, pinned to a small schema. The photo is already in the
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
// Hard ceiling on the REQUEST body, which carries no image at all: just a
// storage path. Half a megabyte is already absurdly generous for one URL, and
// it is counted on the bytes that actually arrive rather than trusted from
// Content-Length, which a chunked request never sends. See
// src/lib/boundedBody.ts.
const MAX_BODY_BYTES = 512_000;

const SEVERITIES = ["low", "medium", "urgent"];

// Structured output: the model is constrained to this shape server-side.
// description is a plain string so "" can still mean "I could not read the
// photo", which is the signal the unreadable branch below keys off.
const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    description: { type: "string" },
    category_guess: { type: "string" },
    severity_guess: { type: "string" },
  },
  required: ["description", "category_guess", "severity_guess"],
  additionalProperties: false,
};

type JobDraft = {
  description: string;
  category_guess: string;
  severity_guess: string;
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

  // BURST PRE-CHECK, in front of the body read. The authoritative burst check
  // lives inside countAiUsage below, which deliberately runs after the photo
  // ownership download - so until now NOTHING rate limited this route before
  // it parsed a body and hit storage. One indexed row read on the same window
  // countAiUsage will bump, so nothing is double counted; the ordering it
  // guards (ownership BEFORE the counter) is untouched.
  if (await overToolBurst(user.id)) {
    return NextResponse.json({
      description: null,
      ...reasonToClientPayload("user_burst"),
    });
  }

  const parsedBody = await readJsonBounded(req, MAX_BODY_BYTES);
  if (!parsedBody.ok) {
    return parsedBody.status === 413
      ? NextResponse.json({ description: null, reason: "too_large" })
      : NextResponse.json(
          { error: "Missing or bad photo." },
          { status: 400 }
        );
  }
  const body = parsedBody.data;
  const rawUrl = typeof body.photo_url === "string" ? body.photo_url : "";
  const path = toObjectPath(rawUrl);
  // Reject path traversal / absolute-ish inputs, same rule as /api/img.
  if (!path || path.includes("..") || path.startsWith("/")) {
    return NextResponse.json({ error: "Missing or bad photo." }, { status: 400 });
  }

  if (!hasClaudeKey()) {
    // No key: the owner just types the description by hand, same graceful
    // degrade as the walkthrough's data-plate scan.
    return NextResponse.json({ description: null, reason: "no_key" });
  }

  // Download the photo through the caller's session: the home-photos bucket is
  // private and RLS only signs/serves objects on a property the caller owns or
  // shares, so this both fetches the bytes AND enforces that the photo is
  // theirs. A miss means "not yours or gone", not a crash.
  //
  // ORDER: this runs BEFORE the usage cap on purpose. Counting first meant a
  // caller poking at paths that are not theirs, or at photos that are simply
  // gone, spent a real AI usage every time and could burn a homeowner's whole
  // daily budget without a single model call ever happening. Nothing paid
  // happens in here, so it is the cheap check and belongs in front.
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

  // Same shared per-user daily cap as every other AI-backed route, so drafting
  // descriptions can't be a side door around the abuse limits on the paid
  // model. Counted only once the photo is confirmed to exist and to be theirs.
  const { overLimit, reason } = await countAiUsage(user.id, await getPlusTier());
  if (overLimit) {
    // One mapping for every counter refusal, so a burst window reads as "give
    // it a minute" instead of "you are out for the day". See
    // src/lib/aiReason.ts.
    return NextResponse.json({
      description: null,
      ...reasonToClientPayload(reason),
    });
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

  try {
    // Describing what is visible in a photo is mechanical, so run it at low
    // effort. 30s timeout, matching the fetchWithTimeout this replaced.
    const { data: parsed } = await generateJson<JobDraft>({
      system: instruction,
      prompt:
        "Describe what needs doing, in the homeowner's voice, based on this photo.",
      images: [{ data: image, mime }],
      schema: RESPONSE_SCHEMA,
      maxTokens: 1024,
      effort: "low",
      timeoutMs: 30_000,
      label: "draft-job",
    });
    if (!parsed) {
      return NextResponse.json({ description: null, reason: "failed" });
    }

    const description =
      typeof parsed.description === "string" ? parsed.description.trim() : "";
    if (!description) {
      // The model could read the request but not the picture: tell the owner
      // plainly rather than dropping an empty draft into the box.
      return NextResponse.json({ description: null, reason: "unreadable" });
    }
    const catRaw =
      typeof parsed.category_guess === "string" ? parsed.category_guess : "";
    const sevRaw =
      typeof parsed.severity_guess === "string" ? parsed.severity_guess : "";
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
    // The owner was already charged one of today's usages above; a thrown
    // model call never produced a draft, so hand it back rather than spending
    // their allowance on a request that failed before it reached them.
    await refundAiUsage(user.id);
    return NextResponse.json({
      description: null,
      reason: isRateLimitError(e) ? "rate_limited" : "failed",
    });
  }
}
