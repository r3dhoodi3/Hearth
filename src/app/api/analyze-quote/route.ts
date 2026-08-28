import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getPlusTier } from "@/lib/subscription";
import { countAiUsage, addAiUsage, overToolBurst, refundAiUsage } from "@/lib/aiUsage";
import { reasonToClientPayload } from "@/lib/aiReason";
import { readJsonBounded } from "@/lib/boundedBody";
import { QUOTE_TASTE_PAYWALL } from "@/lib/freeAiTaste";
import { sendNotification } from "@/lib/notify";
import {
  runTranscribe,
  runDiagnose,
  notAQuoteDiagnosis,
  buildAnalysis,
  type Analysis,
} from "@/lib/quoteAnalysis";
import { hasClaudeKey } from "@/lib/claude";

export const runtime = "nodejs";

// Cap the incoming base64 image so a caller can't push huge payloads at the
// paid vision model (cost/DoS). ~14M base64 chars ≈ 10MB of binary.
const MAX_IMAGE_B64_CHARS = 14_000_000;
// And the same idea for PASTED text, which had no cap at all. A contractor's
// quote is a page or two; 60,000 characters is far more than any real one and
// still a hard ceiling on what one request can cost.
const MAX_TEXT_CHARS = 60_000;
// Hard ceiling on the whole request body, in bytes, enforced on the bytes
// that actually arrive (src/lib/boundedBody.ts). Sits just above the two caps
// above put together, so anything a real upload can legally contain still
// reaches the field checks and gets their specific message; this one only
// catches payloads that were never going to be accepted anyway.
const MAX_BODY_BYTES = 15_000_000;

// AI Quote Analyzer (Hearth Plus): a homeowner uploads a photo of a
// contractor's quote or pastes the text, and Hearth reads every line item,
// compares the total against typical costs, flags padded/vague/duplicated
// charges, and drafts a negotiation message. This is the "$150 instead of an
// $800 quote" feature competitors use as their headline save.
//
// GROUNDED TWO-STAGE PIPELINE (src/lib/quoteAnalysis.ts): stage 1 transcribes
// the quote verbatim (no judgment), stage 2 diagnoses it using ONLY that
// transcript, and every finding it returns must cite the exact verbatim line
// it came from, or the specific field the transcript checked and found
// absent. See that file's header for the full rationale and the latency
// budget (up to two sequential model calls now, instead of one).
//
// PERSISTENCE (migration 0098, quote_analyses): the whole pipeline below runs
// synchronously inside this POST handler, from auth through the final
// notification insert, before a response is ever sent. That means the
// analysis is written to the DB and the homeowner is notified even if they
// navigate away or close the tab mid-request: this handler never reads
// req.signal, so a client-side abort does not cancel the Node.js process
// running it (true on Vercel's Node runtime, which does not tie a function
// invocation's lifetime to the originating socket; if this route ever moves
// to an edge runtime that IS tied to request.signal, this guarantee would
// need re-checking). The pending row is what QuoteAnalyzer.tsx polls if the
// homeowner comes back before it finishes, and what GET below returns to
// restore the latest result on a fresh mount. If the homeowner stays on the
// page, the POST response delivers the finished result directly, so the
// notification path adds zero latency to that common case: the live request
// always resolves before the 30s notification-bell poll would ever fire.
//
// Input:  { image?: <base64, no data: prefix>, mime?: string, text?: string,
//           category?: string, filename?: string }
// Output: { analysis: Analysis | null, reason? }

export async function POST(req: NextRequest) {
  // Require a signed-in user before touching the paid vision model.
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // BURST PRE-CHECK, in front of the body read and in front of the free-credit
  // claim below. countAiUsage runs the authoritative burst check, but it runs
  // AFTER the body has been buffered and parsed, so a flood got its megabytes
  // read before anything said no. This is a single indexed row read on the
  // same window countAiUsage will bump, so nothing is double counted. Same
  // response as the real refusal below. See overToolBurst in src/lib/aiUsage.
  if (await overToolBurst(user.id)) {
    return NextResponse.json({
      analysis: null,
      ...reasonToClientPayload("user_burst"),
    });
  }

  // The quote analyzer is a Hearth Plus feature, but every homeowner gets
  // exactly one free check as a taste. A non-Plus user with an unused credit
  // (users.free_quote_used_at is null) claims it ATOMICALLY up front: a
  // conditional update that only matches while the column is still null, so
  // N parallel requests can't each pass a read-then-check and farm extra free
  // analyses. Only the one request that wins the claim proceeds; the rest get
  // the same 403 as before. If this request never produces an analysis, the
  // claim is refunded below so a blurry photo still doesn't burn the credit.
  // The tier, not the boolean: the free-taste claim below only cares whether
  // this is a free account, but the daily ceiling further down gives a trial
  // its own, smaller budget - see PlusTier in src/lib/subscription.ts.
  const tier = await getPlusTier();
  const isPlus = tier !== "free";
  let claimedFreeCredit = false;
  if (!isPlus) {
    try {
      const admin = createAdminClient();
      const { data: claimed, error } = await admin
        .from("users")
        .update({ free_quote_used_at: new Date().toISOString() })
        .eq("id", user.id)
        .is("free_quote_used_at", null)
        .select("id");
      if (error) throw error;
      claimedFreeCredit = !!claimed && claimed.length > 0;
    } catch {
      // Column missing (migration 0027 not run yet) or write failed: fall
      // back to the old Plus-only behavior so nothing breaks.
      claimedFreeCredit = false;
    }
    if (!claimedFreeCredit) {
      // The refusal carries the SAME sentence QuoteAnalyzer renders in place
      // of the form, so the cold path and the warm path say the same fair
      // thing. `error: "plus_required"` stays for any older client.
      return NextResponse.json(
        {
          error: "plus_required",
          message: QUOTE_TASTE_PAYWALL.message,
          link: QUOTE_TASTE_PAYWALL.link,
        },
        { status: 403 }
      );
    }
  }

  // Hand the claim back on any path that never delivers an analysis (missing
  // key, bad input, over the daily cap, every model failed), preserving the
  // promise that only a successful analysis spends the free check.
  // Best-effort: if the refund itself fails, the credit stays spent.
  const refundFreeCredit = async () => {
    if (!claimedFreeCredit) return;
    try {
      const admin = createAdminClient();
      await admin
        .from("users")
        .update({ free_quote_used_at: null })
        .eq("id", user.id);
    } catch {
      // ignore, the analysis outcome still goes back to the user
    }
  };

  if (!hasClaudeKey()) {
    await refundFreeCredit();
    return NextResponse.json({ analysis: null, reason: "no_key" });
  }

  // Hard byte ceiling on the body itself, counted as the bytes arrive rather
  // than trusted from Content-Length (which a chunked request never sends).
  // Sized just above what the field caps below already allow, so a real
  // upload still gets the route's own specific message rather than this one.
  const parsedBody = await readJsonBounded(req, MAX_BODY_BYTES);
  if (!parsedBody.ok) {
    await refundFreeCredit();
    return parsedBody.status === 413
      ? NextResponse.json({ error: "Image too large." }, { status: 413 })
      : NextResponse.json(
          { error: "Add a photo of the quote or paste its text." },
          { status: 400 }
        );
  }
  const body = parsedBody.data;
  const image = typeof body.image === "string" ? body.image : "";
  const mime = typeof body.mime === "string" ? body.mime : "image/jpeg";
  // Pasted quote text, CAPPED. This was the cheapest way to push a large paid
  // request at Hearth: the image had a size cap and the text had none, and a
  // single send was measured at over 57,000 input tokens. Sliced rather than
  // refused because a real quote never comes close to this, so anything past
  // it is padding, not line items.
  const text =
    typeof body.text === "string"
      ? body.text.trim().slice(0, MAX_TEXT_CHARS)
      : "";
  const category = typeof body.category === "string" && body.category ? body.category : null;
  // Display-only label for the saved row (e.g. "roof-quote.jpg"), never used
  // to identify or re-fetch anything: the photo itself is never stored.
  const filename =
    typeof body.filename === "string" && body.filename.trim()
      ? body.filename.trim().slice(0, 200)
      : null;

  if (!image && !text) {
    await refundFreeCredit();
    return NextResponse.json(
      { error: "Add a photo of the quote or paste its text." },
      { status: 400 }
    );
  }
  if (image.length > MAX_IMAGE_B64_CHARS) {
    await refundFreeCredit();
    return NextResponse.json({ error: "Image too large." }, { status: 413 });
  }

  // Same per-user daily cap as /api/ask (same ai_usage table and limits), so
  // the quote analyzer can't be a side door around the abuse limits on the
  // paid model. Counted exactly once here for the whole two-stage pipeline
  // below, however many model calls it ends up making.
  const { overLimit, reason: limitReason } = await countAiUsage(
    user.id,
    tier
  );
  if (overLimit) {
    await refundFreeCredit();
    // One mapping for every counter refusal, so a burst window reads as "give
    // it a minute" instead of "you are out for the day". See
    // src/lib/aiReason.ts.
    return NextResponse.json({
      analysis: null,
      ...reasonToClientPayload(limitReason),
    });
  }

  // From here on the request is committed to an actual analysis attempt, so
  // it gets a durable row: pending until the pipeline below finishes one way
  // or the other. Written with the service-role client since quote_analyses
  // has no client insert policy (migration 0098).
  const admin = createAdminClient();
  const { data: row, error: insertErr } = await admin
    .from("quote_analyses")
    .insert({ user_id: user.id, status: "pending", quote_filename: filename })
    .select("id")
    .single();
  if (insertErr) {
    console.error("analyze-quote: quote_analyses insert failed:", insertErr.message ?? insertErr);
  }
  const rowId = row?.id ?? null;

  const finish = async (
    outcome:
      | { ok: true; analysis: Analysis }
      | { ok: false; reason: "rate_limited" | "failed" }
  ) => {
    if (!rowId) return; // migration not applied yet: degrade to the old, unsaved behavior
    if (outcome.ok) {
      await admin
        .from("quote_analyses")
        .update({
          status: "done",
          findings: outcome.analysis as any,
          finished_at: new Date().toISOString(),
        })
        .eq("id", rowId);
      // In-app only (per product decision): no email/SMS for this. Best
      // effort, never blocks the response the homeowner is waiting on.
      await sendNotification(admin, {
        userId: user.id,
        kind: "quote_analysis",
        title: "Your quote analysis is ready",
        body: outcome.analysis.overall || undefined,
        url: "/quote-check",
      }).catch(() => {});
    } else {
      await admin
        .from("quote_analyses")
        .update({
          status: "failed",
          error: outcome.reason,
          finished_at: new Date().toISOString(),
        })
        .eq("id", rowId);
    }
  };

  // STAGE 1: transcribe the quote into a faithful, verbatim JSON record.
  // Nothing evaluative happens here.
  const {
    transcript,
    rateLimited: t1RateLimited,
    threw: t1Threw,
  } = await runTranscribe({
    image,
    mime,
    text,
    category,
  });
  if (!transcript) {
    await refundFreeCredit();
    // The countAiUsage call above already charged one of today's usages for
    // this whole two-stage pipeline. A THROWN model call never produced a
    // transcript, so hand that usage back; a normal no-result (the model ran
    // and simply couldn't read the document) is not a failure of the model
    // call and keeps the charge, same as every other route's "failed" path.
    if (t1Threw) await refundAiUsage(user.id);
    const reason = t1RateLimited ? "rate_limited" : "failed";
    await finish({ ok: false, reason });
    return NextResponse.json({ analysis: null, reason });
  }

  // Stage 1 couldn't confirm this is actually a quote: nothing to diagnose,
  // so skip stage 2 rather than spend a second model call on it.
  if (!transcript.is_quote) {
    const analysis = buildAnalysis(transcript, notAQuoteDiagnosis(transcript));
    await finish({ ok: true, analysis });
    return NextResponse.json({ analysis });
  }

  // Honest fan-out counting: stage 1 was already covered by the single
  // countAiUsage call above, but stage 2 is a SECOND paid model call, so count
  // it too. Only reached when the document is actually a quote (the non-quote
  // path returns above without a stage-2 call), so this never over-counts.
  // Best-effort per-user bump; the gating decision is already made.
  await addAiUsage(user.id, 1);

  // STAGE 2: diagnose using ONLY the stage-1 transcript above, never the raw
  // photo or pasted text again, so every finding traces back to a verbatim
  // line (isEvidenceGrounded in quoteAnalysis.ts enforces this in code, not
  // just via the prompt).
  const {
    diagnosis,
    rateLimited: t2RateLimited,
    threw: t2Threw,
  } = await runDiagnose(transcript, { category });
  if (!diagnosis) {
    await refundFreeCredit();
    // Stage 2 was charged via the addAiUsage(user.id, 1) fan-out bump just
    // above. Same rule as stage 1: only a THROWN call hands the usage back.
    if (t2Threw) await refundAiUsage(user.id);
    const reason = t2RateLimited ? "rate_limited" : "failed";
    await finish({ ok: false, reason });
    return NextResponse.json({ analysis: null, reason });
  }

  const analysis = buildAnalysis(transcript, diagnosis);
  await finish({ ok: true, analysis });
  return NextResponse.json({ analysis });
}

// Restores the signed-in homeowner's latest analysis: used on mount (so a
// finished result survives navigating away and back) and polled while
// status is still "pending" (so an analysis started before a navigation, or
// on another tab, is picked up once it finishes). RLS on quote_analyses
// already scopes rows to their owner; the .eq below is just belt and
// suspenders, and lets a broken/missing RLS policy fail closed to "no rows"
// rather than open.
export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data, error } = await supabase
    .from("quote_analyses")
    .select("id, status, quote_filename, findings, error, created_at, finished_at")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    // quote_analyses migration (0098) not applied yet, or some other read
    // failure: degrade to "nothing saved" rather than error the page.
    return NextResponse.json({ latest: null });
  }

  return NextResponse.json({ latest: data ?? null });
}
