import { NextRequest, NextResponse } from "next/server";
import { sameOriginGuard } from "@/lib/csrf";
import { createClient } from "@/lib/supabase/server";
import { getPlusTier } from "@/lib/subscription";
import { countAiUsage, overToolBurst, refundAiUsage } from "@/lib/aiUsage";
import { reasonToClientPayload } from "@/lib/aiReason";
import { readJsonBounded } from "@/lib/boundedBody";
import { labelFor, SYSTEM_TYPES } from "@/lib/constants";
import {
  generateJson,
  hasClaudeKey,
  isRateLimitError,
} from "@/lib/claude";

export const runtime = "nodejs";

// Cap the incoming base64 image so a caller can't push huge payloads at the
// paid vision model (cost/DoS). ~14M base64 chars ≈ 10MB of binary. Same cap
// as /api/extract-document.
const MAX_IMAGE_B64_CHARS = 14_000_000;
// Hard ceiling on the whole request body, in bytes, counted as the bytes
// arrive rather than trusted from Content-Length, which a chunked request
// never sends (src/lib/boundedBody.ts). Sits just above the image cap so a
// real scan still reaches the check above and gets its specific message.
const MAX_BODY_BYTES = 15_000_000;

// "Walk your home": read the data plate / model-and-serial label on ONE home
// system so the owner can replace its estimated details with the real thing.
// Same Claude vision as /api/extract-document, pinned to a small schema. This
// only ever returns a SUGGESTION - src/app/(app)/walkthrough/actions.ts is the
// only thing that writes to home_systems, and only after the owner confirms.
//
// Input:  { image: <base64, no data: prefix>, mime?: string, system_id: string }
// Output: { suggestion: { brand, model, serial, install_year } | null, reason? }
// (any field null if it isn't on the label - never invented).

// Structured output: the model is constrained to this shape server-side, so
// there is no "reply with only JSON" instruction to ignore and nothing to
// regex out of prose. Every field is nullable because a partly legible label
// is the normal case, and a missing field must stay missing, never guessed.
const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    brand: { type: ["string", "null"] },
    model: { type: ["string", "null"] },
    serial: { type: ["string", "null"] },
    install_year: { type: ["integer", "null"] },
  },
  required: ["brand", "model", "serial", "install_year"],
  additionalProperties: false,
};

type PlateFields = {
  brand: string | null;
  model: string | null;
  serial: string | null;
  install_year: number | null;
};

export async function POST(req: NextRequest) {
  // CSRF, second lock. The session cookie is SameSite=Lax and this body is
  // JSON, so a cross-site page cannot get a signed-in request here today;
  // this refuses one outright rather than depending on those defaults.
  // src/lib/csrf.ts only rejects on positive cross-site evidence.
  const crossSite = sameOriginGuard(req);
  if (crossSite) return crossSite;

  // Require a signed-in user. This is an authenticated feature; gating it here
  // (not just in middleware) stops anonymous abuse of the paid vision API.
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // BURST PRE-CHECK, in front of the body read. The authoritative burst check
  // lives inside countAiUsage below and only runs after the body has been
  // buffered and parsed, so a flood got megabytes of base64 read before any
  // rate limit said no. One indexed row read on the same window countAiUsage
  // will bump, so nothing is double counted, and the refusal is the same one.
  if (await overToolBurst(user.id)) {
    return NextResponse.json({
      suggestion: null,
      ...reasonToClientPayload("user_burst"),
    });
  }

  const parsedBody = await readJsonBounded(req, MAX_BODY_BYTES);
  if (!parsedBody.ok) {
    return parsedBody.status === 413
      ? NextResponse.json({ error: "Image too large." }, { status: 413 })
      : NextResponse.json(
          { error: "Missing image or system." },
          { status: 400 }
        );
  }
  const body = parsedBody.data;
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

  if (!hasClaudeKey()) {
    // No key: the walkthrough still works, the owner just fills the form in
    // by hand instead of getting a suggestion.
    return NextResponse.json({ suggestion: null, reason: "no_key" });
  }

  // Same per-user daily cap as every other AI-backed route (shared ai_usage
  // table, src/lib/aiUsage.ts), so scanning systems can't be a side door
  // around the abuse limits on the paid model.
  //
  // BURST OFF, and this is the one route where that is correct. The tool burst
  // limit is 10 requests per 5 minutes (AI_TOOL_BURST_LIMIT), sized for
  // one-off document scans that nobody makes ten of by hand. The walkthrough
  // is the opposite shape by design: the owner walks their house photographing
  // one data plate per system, back to back, and a home with a dozen systems
  // is an ordinary one - up to 16 captures in a single sitting. Under the
  // shared burst window that owner is refused on the 11th plate, mid-walk,
  // with no explanation that makes sense to them ("slow down" while they are
  // walking as fast as a person walks). The burst limit exists to stop a
  // script, and it kept catching the feature instead.
  //
  // What still holds the line: the DAILY cap (25 free / 250 Plus) bounds the
  // whole day's spend, the owner-wide breaker and the hourly ceiling both
  // still run, each capture must name a system_id this caller owns (checked
  // above, through RLS), and the body is bounded before any of it. A script
  // pointed here can go faster than a person, but it cannot go past the same
  // daily budget every other tool route shares, which is the limit that
  // actually costs money.
  //
  // The overToolBurst pre-check at the top of this route is left in place on
  // purpose: it is a non-counting READ of the same window, so it still refuses
  // cheaply once some OTHER tool route has already burst-limited this caller,
  // and it never bumps the counter itself.
  const { overLimit, reason } = await countAiUsage(user.id, await getPlusTier(), {
    burst: false,
  });
  if (overLimit) {
    return NextResponse.json({
      suggestion: null,
      ...reasonToClientPayload(reason),
    });
  }

  const sysLabel = labelFor(SYSTEM_TYPES, system.system_type) || "home system";
  const instruction =
    `You are reading the data plate / model-and-serial label on a homeowner's ${sysLabel}. ` +
    "First, judge whether you can actually read the label. If the photo is too blurry, dark, cropped, glare covered, or low resolution to read, or it is clearly not a data plate or model-and-serial label (for example a selfie or an unrelated photo), do not guess: leave every field empty. If only part of the label is legible, read the fields you can and leave the rest empty rather than guessing at them. " +
    "Extract ONLY what is actually printed on the label - never guess or invent a value. Leave a field empty if it isn't shown. " +
    "Read brand and model exactly as printed. " +
    "For serial, read the serial number exactly as printed. " +
    "For install_year, use a manufacture date or install sticker if present (4-digit year only); if the label only shows a manufacture date code, decode it to a year if you're confident, otherwise leave it empty.";

  try {
    // Reading a data plate is mechanical transcription, not a judgement call,
    // so run it at low effort: the schema does the shaping and the prompt does
    // the rest.
    const { data: parsed } = await generateJson<PlateFields>({
      system: instruction,
      prompt: "Read the fields off this data plate.",
      images: [{ data: image, mime }],
      schema: RESPONSE_SCHEMA,
      // Model, ceiling and effort come from ROUTES in src/lib/claude.ts, so
      // the cost of every AI feature is one table to read. A data plate is
      // read back to the homeowner on screen before it is saved, which is why
      // this one runs on the cheap model.
      route: "confirm-system",
      label: "confirm-system",
    });
    if (!parsed) {
      return NextResponse.json({ suggestion: null, reason: "failed" });
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
  } catch (e) {
    // The owner was already charged one of today's usages above; a thrown
    // model call never produced a suggestion, so hand it back rather than
    // spending their allowance on a request that failed before it reached
    // them.
    await refundAiUsage(user.id);
    return NextResponse.json({
      suggestion: null,
      reason: isRateLimitError(e) ? "rate_limited" : "failed",
    });
  }
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
