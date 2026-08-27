"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ReceiptText } from "lucide-react";
import { JOB_CATEGORIES } from "@/lib/constants";
import AiNotice from "@/components/AiNotice";
import ProgressBar, { useStagedProgress } from "@/components/ProgressBar";
import { fetchWithTimeout, isTimeoutError } from "@/lib/fetchWithTimeout";

// The honest steps the two-stage analyze pipeline actually runs through:
// transcribe the quote, check its numbers against typical local costs, then
// write the plain-language breakdown and negotiation script.
const ANALYZE_STAGES = [
  "Reading your quote",
  "Comparing against local pricing",
  "Writing the breakdown",
];

type Verdict = "fair" | "high" | "low" | "unclear";
type Severity = "red_flag" | "ask" | "ok";

type LineItem = {
  label: string;
  amount: string | null;
  note: string | null;
};

// A single grounded finding from the diagnose stage: `evidence` is either the
// exact verbatim line it's citing, or "not mentioned in the quote" for an
// absence finding. See src/lib/quoteAnalysis.ts for how that's enforced.
type Finding = {
  text: string;
  evidence: string;
  severity: Severity;
};

type Analysis = {
  verdict: Verdict;
  total: string | null;
  summary: string;
  overall: string;
  line_items: LineItem[];
  red_flags: Finding[];
  missing: Finding[];
  negotiation: string;
};

// The row shape /api/analyze-quote's GET returns (migration 0098).
type SavedRow = {
  status: "pending" | "done" | "failed";
  quote_filename: string | null;
  findings: Analysis | null;
  error: string | null;
  created_at: string;
  finished_at: string | null;
};

type Mode = "photo" | "text";

const VERDICT_STYLE: Record<Verdict, { label: string; classes: string }> = {
  fair: { label: "Looks fair", classes: "border-green-200 bg-green-50 text-green-700 dark:border-green-900 dark:bg-green-950/40 dark:text-green-200" },
  low: { label: "Looks low", classes: "border-bark-100 bg-bark-50 text-bark-700 dark:border-bark-700 dark:bg-bark-700/40 dark:text-stone-300" },
  high: { label: "Looks high", classes: "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/15 dark:text-amber-300" },
  unclear: { label: "Not enough info", classes: "border-stone-200 bg-stone-100 text-stone-600 dark:border-white/10 dark:bg-stone-700 dark:text-stone-300" },
};

// One color per severity, red reserved for a real red_flag so it can't be
// confused with the merely-ambiguous "ask" items, green/neutral for "ok" so
// a clean bill of health reads as good news, not as another warning.
const SEVERITY_STYLE: Record<Severity, string> = {
  red_flag: "border-red-200 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300",
  ask: "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/15 dark:text-amber-300",
  ok: "border-green-200 bg-green-50 text-green-700 dark:border-green-900 dark:bg-green-950/40 dark:text-green-200",
};
const SEVERITY_LABEL: Record<Severity, string> = {
  red_flag: "Red flag",
  ask: "Worth asking",
  ok: "Looks standard",
};

// Read a File into base64 (no data: prefix) for the vision endpoint.
function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const res = String(reader.result || "");
      resolve(res.includes(",") ? res.split(",")[1] : res);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// One finding, in either the "Findings" list or the "What's missing" list:
// the claim, a small severity chip, and the verbatim evidence it's grounded
// in (or "not mentioned in the quote" for an absence). Every finding the
// route sends has already passed the code-level grounding check in
// src/lib/quoteAnalysis.ts, so this is purely a rendering concern.
function FindingBody({ f }: { f: Finding }) {
  return (
    <>
      <div className="flex items-start justify-between gap-3">
        <span>{f.text}</span>
        <span className="shrink-0 rounded-full bg-white/60 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide dark:bg-black/20">
          {SEVERITY_LABEL[f.severity]}
        </span>
      </div>
      <p className="mt-1 text-xs italic text-stone-500 dark:text-stone-400">
        &quot;{f.evidence}&quot;
      </p>
    </>
  );
}

// The homeowner's advocate: hand over a photo of a contractor's quote (or its
// text), and Hearth reads every line, checks it against typical costs, calls
// out padding or vague charges, and writes a negotiation message for them.
// `freeTaste` means a non-Plus user is spending their one free check, so a
// successful result gets a compact Plus upsell under it.
//
// PERSISTENCE (migration 0098): the analysis itself is saved server-side by
// /api/analyze-quote, not in this component's state, so it survives leaving
// the page. On mount this fetches the homeowner's latest saved analysis; if
// it's still "pending" (started here or on another tab, not yet finished) it
// polls every 5s until it resolves. A finished result restores exactly as if
// the analysis had just completed.
export default function QuoteAnalyzer({
  freeTaste = false,
}: {
  freeTaste?: boolean;
}) {
  const [mode, setMode] = useState<Mode>("photo");
  const [preview, setPreview] = useState<string | null>(null);
  const [image, setImage] = useState<string | null>(null);
  const [mime, setMime] = useState<string>("image/jpeg");
  const [fileName, setFileName] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [category, setCategory] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Analysis | null>(null);
  const [copied, setCopied] = useState(false);
  const [copyFallback, setCopyFallback] = useState(false);
  const negotiationRef = useRef<HTMLParagraphElement>(null);
  // Drives the progress bar shown while analyze() is in flight. The pipeline is
  // a couple of sequential model calls, so budget ~22s for the label pacing.
  const progress = useStagedProgress(ANALYZE_STAGES, 22000);

  // Restore state: whether the initial "load the latest saved analysis" fetch
  // is still in flight, the "when did we analyze this" / "what was it called"
  // line shown above a result, whether a saved analysis is still pending
  // (started by this mount or a previous one) with no result to show yet, and
  // the reason text if the last saved attempt failed with nothing to show.
  const [restoring, setRestoring] = useState(true);
  const [resultMeta, setResultMeta] = useState<{ analyzedAt: string; filename: string | null } | null>(null);
  const [pendingRemote, setPendingRemote] = useState(false);
  const [failedRemote, setFailedRemote] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  function stopPolling() {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }

  function applyLatest(latest: SavedRow | null) {
    if (!latest) return;
    if (latest.status === "done" && latest.findings) {
      setResult(latest.findings);
      setResultMeta({
        analyzedAt: latest.finished_at ?? latest.created_at,
        filename: latest.quote_filename,
      });
      setPendingRemote(false);
      setFailedRemote(null);
      stopPolling();
    } else if (latest.status === "pending") {
      setPendingRemote(true);
      setFailedRemote(null);
      startPolling();
    } else if (latest.status === "failed") {
      setPendingRemote(false);
      setFailedRemote(latest.error || "failed");
      stopPolling();
    }
  }

  function startPolling() {
    stopPolling();
    // Modest interval: this is a "did it finish yet" check, not a live feed,
    // and the common case (staying on the page) never touches this path at
    // all, the POST response below already delivers the result directly.
    pollRef.current = setInterval(async () => {
      try {
        // The 15s timeout is longer than the 5s tick, so up to 3 of these
        // GETs can be in flight at once when the server is slow. That's
        // fine: it's an idempotent status read, and the timeout still
        // bounds how many can pile up.
        const resp = await fetchWithTimeout("/api/analyze-quote", {}, 15_000);
        const data = await resp.json().catch(() => ({}));
        applyLatest(data?.latest ?? null);
      } catch {
        // transient network hiccup: keep polling, the next tick tries again
      }
    }, 5000);
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Short timeout: if this restore check hangs, `restoring` would stay
        // true forever and the upload form would never appear.
        const resp = await fetchWithTimeout("/api/analyze-quote", {}, 15_000);
        const data = await resp.json().catch(() => ({}));
        if (!cancelled) applyLatest(data?.latest ?? null);
      } catch {
        // No saved analysis to restore: fall through to the empty upload form.
      } finally {
        if (!cancelled) setRestoring(false);
      }
    })();
    return () => {
      cancelled = true;
      stopPolling();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Homeowner corrections to the "what's missing" list. The AI's read isn't
  // final: sometimes the pro just forgot to write something down, or the
  // homeowner knows it's covered. `coveredMissing` holds indexes into
  // result.missing the homeowner confirmed are covered, and `addedCovered`
  // holds things the quote includes that the analyzer didn't catch. These
  // edits are client-only state, same as before: they last exactly as long
  // as this result is showing, and don't get saved server-side.
  const [coveredMissing, setCoveredMissing] = useState<Set<number>>(new Set());
  const [addedCovered, setAddedCovered] = useState<string[]>([]);
  const [addDraft, setAddDraft] = useState("");
  const [showAdd, setShowAdd] = useState(false);

  function clearEdits() {
    setCoveredMissing(new Set());
    setAddedCovered([]);
    setAddDraft("");
    setShowAdd(false);
  }

  function markCovered(i: number) {
    setCoveredMissing((prev) => {
      const next = new Set(prev);
      next.add(i);
      return next;
    });
  }

  function unmarkCovered(i: number) {
    setCoveredMissing((prev) => {
      const next = new Set(prev);
      next.delete(i);
      return next;
    });
  }

  function addCoveredItem() {
    const value = addDraft.trim();
    if (!value) return;
    setAddedCovered((prev) => [...prev, value]);
    setAddDraft("");
  }

  function removeAdded(i: number) {
    setAddedCovered((prev) => prev.filter((_, j) => j !== i));
  }

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const input = e.target;
    const file = input.files?.[0];
    input.value = ""; // allow re-picking the same file
    if (!file) return;

    // Guard the size before we read it into memory and POST it to the vision
    // endpoint (cost/DoS + browser OOM).
    const MAX_BYTES = 15 * 1024 * 1024; // 15MB
    if (file.size > MAX_BYTES) {
      setError("That photo is too large (max 15MB). Try a smaller photo.");
      return;
    }

    setError(null);
    setResult(null);
    setMime(file.type || "image/jpeg");
    setFileName(file.name || null);
    const b64 = await toBase64(file);
    setImage(b64);
    setPreview(URL.createObjectURL(file));
  }

  function reset() {
    setResult(null);
    setError(null);
    clearEdits();
  }

  // Leaves the current result (if any) behind and shows an empty upload form
  // for a new analysis. Does not delete the saved row this result came from,
  // running a new analysis is what replaces it as the "latest" one.
  function startNew() {
    setResult(null);
    setResultMeta(null);
    setFailedRemote(null);
    setPendingRemote(false);
    stopPolling();
    clearEdits();
    setError(null);
    setPreview(null);
    setImage(null);
    setText("");
    setFileName(null);
  }

  async function analyze() {
    if (mode === "photo" && !image) {
      setError("Add a photo of the quote first.");
      return;
    }
    if (mode === "text" && !text.trim()) {
      setError("Paste the quote text first.");
      return;
    }

    setLoading(true);
    setError(null);
    setResult(null);
    setFailedRemote(null);
    setPendingRemote(false);
    stopPolling();
    setCopyFallback(false);
    setCopied(false);
    clearEdits();
    progress.start();

    try {
      // Longer than the single-call default: the route now runs a grounded
      // two-stage pipeline (transcribe, then diagnose), up to two sequential
      // model calls instead of one, each with its own model fallback chain.
      // See src/app/api/analyze-quote/route.ts for the latency budget.
      const resp = await fetchWithTimeout(
        "/api/analyze-quote",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            image: mode === "photo" ? image : undefined,
            mime: mode === "photo" ? mime : undefined,
            text: mode === "text" ? text : undefined,
            category: category || undefined,
            filename: mode === "photo" ? fileName ?? undefined : undefined,
          }),
        },
        150_000
      );

      if (resp.status === 401) {
        setError("Please sign in and try again.");
        return;
      }
      if (resp.status === 403) {
        setError("This feature is part of Hearth Plus.");
        return;
      }

      const data = await resp.json().catch(() => ({}));
      if (data?.analysis) {
        setResult(data.analysis as Analysis);
        setResultMeta({
          analyzedAt: new Date().toISOString(),
          filename: mode === "photo" ? fileName : null,
        });
      } else if (data?.reason === "rate_limited") {
        setError("Hearth has hit today's free usage limit. Please try again later.");
      } else if (data?.reason === "busy") {
        // Not this homeowner's allowance: a burst window or an owner-wide
        // ceiling. Nothing to buy and nothing to fix, so say how long instead
        // of pointing at a limit they have not hit. The server sends the exact
        // sentence (src/lib/aiReason.ts); the fallback covers an older reply.
        setError(data?.error || "Hearth's AI is busy right now. Try again in a few minutes.");
      } else if (data?.reason === "no_key") {
        setError("The quote analyzer isn't set up yet.");
      } else {
        setError(data?.error || "Couldn't read that quote. Try a clearer photo or paste the text instead.");
      }
    } catch (e) {
      setError(
        isTimeoutError(e)
          ? "That took too long. Try again."
          : "Something went wrong. Please try again."
      );
    } finally {
      progress.finish();
      setLoading(false);
    }
  }

  async function copyNegotiation() {
    if (!result?.negotiation) return;
    setCopyFallback(false);
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(result.negotiation);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
        return;
      } catch {
        /* fall through to the selection fallback below */
      }
    }
    // Clipboard API missing or blocked (some browsers require a permission or
    // a secure context): select the visible negotiation text instead of
    // silently doing nothing, so the homeowner can still copy it by hand.
    const node = negotiationRef.current;
    if (node && window.getSelection) {
      const range = document.createRange();
      range.selectNodeContents(node);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    }
    setCopyFallback(true);
  }

  const verdictStyle = result ? VERDICT_STYLE[result.verdict] : null;
  const editCount = coveredMissing.size + addedCovered.length;
  // Whether anything above "looks standard" was actually found, drives the
  // overall banner's color: green when the quote came back clean, amber when
  // there's a red flag or a question worth asking.
  const hasConcern = result
    ? [...result.red_flags, ...result.missing].some((f) => f.severity !== "ok")
    : false;

  if (restoring) {
    return (
      <div className="card">
        <p className="text-sm text-stone-500 dark:text-stone-400">Loading…</p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {pendingRemote && !loading && (
        <div className="card space-y-2 text-center">
          <svg
            className="mx-auto h-5 w-5 animate-spin text-bark-600 dark:text-bark-300"
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden="true"
          >
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12H4z" />
          </svg>
          <p className="text-sm text-stone-700 dark:text-stone-300">Still reading your last quote…</p>
          <p className="text-xs text-stone-500 dark:text-stone-400">
            You can leave this page. We&apos;ll notify you when it&apos;s ready.
          </p>
        </div>
      )}

      {failedRemote && !result && (
        <p className="text-sm text-red-600 dark:text-red-400">
          {failedRemote === "rate_limited"
            ? "Hearth hit today's usage limit while analyzing your last quote. Try again below."
            : "Couldn't finish analyzing your last quote. Try again below."}
        </p>
      )}

      <div className="card space-y-4">
        {/* Two toggle buttons, not role="tab": we don't implement the tab
            keyboard contract (arrow keys move between tabs), so aria-pressed
            is the honest description of what these are. The ids also give
            the two panels below something stable to point at. */}
        <div className="flex gap-2">
          <button
            type="button"
            id="quote-mode-photo"
            onClick={() => {
              setMode("photo");
              reset();
            }}
            disabled={loading}
            aria-disabled={loading}
            aria-pressed={mode === "photo"}
            aria-controls="quote-input-photo"
            className={mode === "photo" ? "btn-primary" : "btn-secondary"}
          >
            Upload a photo
          </button>
          <button
            type="button"
            id="quote-mode-text"
            onClick={() => {
              setMode("text");
              reset();
            }}
            disabled={loading}
            aria-disabled={loading}
            aria-pressed={mode === "text"}
            aria-controls="quote-input-text"
            className={mode === "text" ? "btn-primary" : "btn-secondary"}
          >
            Paste the text
          </button>
        </div>

        {/* Both panels stay mounted, the inactive one `hidden`, so the ids the
            buttons' aria-controls point at always exist - a dangling
            aria-controls is worse than none. role="group" is what makes
            aria-labelledby apply: on a bare div the label is ignored. */}
        <div
          id="quote-input-photo"
          role="group"
          aria-labelledby="quote-mode-photo"
          hidden={mode !== "photo"}
        >
          <label
            className={`flex flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed border-stone-200 px-4 py-8 text-center dark:border-white/10 ${
              loading
                ? "cursor-not-allowed opacity-60"
                : "cursor-pointer hover:border-bark-500 hover:bg-bark-50"
            }`}
            aria-disabled={loading}
          >
            <ReceiptText className="h-8 w-8 text-stone-400 dark:text-stone-500" aria-hidden="true" />
            <span className="text-sm font-medium text-stone-700 dark:text-stone-300">
              {preview ? "Use a different photo" : "Take or upload a photo of the quote"}
            </span>
            <span className="text-xs text-stone-500 dark:text-stone-400">
              A clear photo of every line item and the total works best
            </span>
            <input
              type="file"
              accept="image/*"
              onChange={onPick}
              disabled={loading}
              className="hidden"
            />
          </label>
          {preview && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={preview}
              alt="Quote preview"
              className="mt-3 max-h-48 rounded-lg border border-stone-200 object-contain dark:border-white/10"
            />
          )}
        </div>

        <div
          id="quote-input-text"
          role="group"
          aria-labelledby="quote-mode-text"
          hidden={mode !== "text"}
        >
          <label className="label" htmlFor="quote-text">
            Quote text
          </label>
          <textarea
            id="quote-text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={6}
            placeholder="Paste the line items and total from the quote here"
            disabled={loading}
            aria-disabled={loading}
            aria-busy={loading}
            className="input"
          />
        </div>

        <p className="text-xs text-stone-500 dark:text-stone-400">
          Heads up: your quote is sent to our AI provider, Anthropic, to be
          read. Under its paid API terms it is not used to train their models.
          It can be wrong, so treat the read as a second opinion, not a verdict.
          {" "}
          <Link
            href="/ai-disclosure"
            className="underline decoration-dotted hover:text-stone-600 dark:hover:text-stone-300"
          >
            How Hearth uses AI
          </Link>
        </p>

        <div>
          <label className="label">Job category (optional)</label>
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="input"
          >
            <option value="">- not sure -</option>
            {JOB_CATEGORIES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </div>

        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

        <button
          type="button"
          onClick={analyze}
          disabled={loading}
          aria-disabled={loading}
          aria-busy={loading}
          className="btn-primary w-full"
        >
          {loading && (
            // currentColor rather than a literal stone shade: this button is
            // btn-primary (bark background, white text), so the spinner needs
            // to inherit that white to actually read against it, not the
            // gray that would work on a plain surface. Makes clear the
            // disabled state is working, not stuck.
            <svg
              className="h-4 w-4 animate-spin"
              viewBox="0 0 24 24"
              fill="none"
              aria-hidden="true"
            >
              <circle
                className="opacity-25"
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="4"
              />
              <path
                className="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12H4z"
              />
            </svg>
          )}
          {loading ? "Reading the quote…" : "Analyze this quote"}
        </button>
        {loading && (
          <>
            <ProgressBar
              value={progress.value}
              stages={ANALYZE_STAGES}
              stageIndex={progress.stageIndex}
              ariaLabel="Analyzing your quote"
            />
            <p className="text-center text-xs text-stone-500 dark:text-stone-400">
              You can leave this page. We&apos;ll notify you when it&apos;s ready.
            </p>
          </>
        )}
      </div>

      {result && (
        <div className="card space-y-5">
          {resultMeta && (
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-stone-500 dark:text-stone-400">
              <span>
                Analyzed {new Date(resultMeta.analyzedAt).toLocaleString()}
                {resultMeta.filename ? ` · ${resultMeta.filename}` : ""}
              </span>
              <button
                type="button"
                onClick={startNew}
                className="font-medium text-bark-700 hover:underline dark:text-stone-300"
              >
                Analyze another quote
              </button>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-3">
            {verdictStyle && (
              <span
                className={`rounded-full border px-3 py-1 text-sm font-medium ${verdictStyle.classes}`}
              >
                {verdictStyle.label}
              </span>
            )}
            {result.total && (
              <span className="text-sm text-stone-500 dark:text-stone-400">
                Total on quote: <span className="font-medium text-stone-800 dark:text-stone-200">{result.total}</span>
              </span>
            )}
          </div>

          {/* The plain-language headline read, always present: "nothing
              concerning here" is a valid, expected verdict, not just the
              absence of a red_flags section. */}
          {result.overall && (
            <p
              className={`rounded-lg border px-3 py-2 text-sm font-medium ${
                hasConcern
                  ? "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/15 dark:text-amber-300"
                  : "border-green-200 bg-green-50 text-green-700 dark:border-green-900 dark:bg-green-950/40 dark:text-green-200"
              }`}
            >
              {result.overall}
            </p>
          )}

          <p className="text-sm text-stone-700 dark:text-stone-300">{result.summary}</p>

          {/* Same honest caveat Ask Hearth carries under its answers: this is an
              AI read, not a professional appraisal. Shared component so the
              wording can't drift from the other AI surfaces. */}
          <AiNotice detail="This whole read, including the verdict and the total, came from the model. Confirm with a licensed pro before you decide." />

          {/* Honesty about homeowner edits: we don't re-run the model, so we
              annotate instead of pretending the verdict recomputed itself. */}
          {editCount > 0 && (
            <p className="rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-xs text-green-800 dark:border-green-900 dark:bg-green-950/40 dark:text-green-200">
              After your edits:{" "}
              {[
                coveredMissing.size > 0
                  ? `you marked ${coveredMissing.size} of ${result.missing.length} missing ${
                      result.missing.length === 1 ? "item" : "items"
                    } as covered`
                  : null,
                addedCovered.length > 0
                  ? `you added ${addedCovered.length} ${
                      addedCovered.length === 1 ? "item" : "items"
                    } the quote includes`
                  : null,
              ]
                .filter(Boolean)
                .join(" and ")}
              . The verdict above is Hearth&apos;s original read of the quote,
              before your edits.
            </p>
          )}

          {result.line_items.length > 0 && (
            <div>
              <h2 className="mb-2 text-sm font-medium text-stone-900 dark:text-stone-100">Line items</h2>
              <ul className="space-y-2">
                {result.line_items.map((li, i) => (
                  <li
                    key={i}
                    className="rounded-lg border border-stone-200 bg-stone-50 px-3 py-2 text-sm dark:border-white/10 dark:bg-stone-800"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-stone-800 dark:text-stone-200">{li.label}</span>
                      {li.amount && (
                        <span className="font-medium text-stone-800 dark:text-stone-200">{li.amount}</span>
                      )}
                    </div>
                    {li.note && <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">{li.note}</p>}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {result.red_flags.length > 0 && (
            <div>
              <h2 className="mb-2 text-sm font-medium text-stone-900 dark:text-stone-100">Findings</h2>
              <ul className="space-y-1.5">
                {result.red_flags.map((f, i) => (
                  <li
                    key={i}
                    className={`rounded-lg border px-3 py-2 text-sm ${SEVERITY_STYLE[f.severity]}`}
                  >
                    <FindingBody f={f} />
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* "What's missing", but correctable: the AI's read isn't final.
              Each item carries a small "It's covered" action that moves it to
              a homeowner-confirmed covered list (with undo), and a small
              input lets the homeowner add something the analyzer missed. */}
          <div>
            {result.missing.length > 0 && (
              <>
                <h2 className="mb-2 text-sm font-medium text-stone-900 dark:text-stone-100">What&apos;s missing</h2>
                {result.missing.some((_, i) => !coveredMissing.has(i)) ? (
                  <ul className="space-y-1.5">
                    {result.missing.map((item, i) =>
                      coveredMissing.has(i) ? null : (
                        <li
                          key={i}
                          className={`rounded-lg border px-3 py-2 text-sm ${SEVERITY_STYLE[item.severity]}`}
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <FindingBody f={item} />
                            </div>
                            <button
                              type="button"
                              onClick={() => markCovered(i)}
                              className="shrink-0 text-xs font-medium underline-offset-2 hover:underline"
                            >
                              It&apos;s covered
                            </button>
                          </div>
                        </li>
                      )
                    )}
                  </ul>
                ) : (
                  <p className="text-sm text-stone-500 dark:text-stone-400">
                    Nothing left here, you&apos;ve marked everything as covered.
                  </p>
                )}
              </>
            )}

            {(coveredMissing.size > 0 || addedCovered.length > 0) && (
              <div className="mt-3">
                <h3 className="mb-2 text-xs font-medium text-stone-500 dark:text-stone-400">
                  Covered, per you
                </h3>
                <ul className="space-y-1.5">
                  {result.missing.map((item, i) =>
                    coveredMissing.has(i) ? (
                      <li
                        key={`covered-${i}`}
                        className="flex items-start justify-between gap-3 rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800 dark:border-green-900 dark:bg-green-950/40 dark:text-green-200"
                      >
                        <span>
                          {item.text}{" "}
                          <span className="text-xs text-green-700 dark:text-green-300">
                            (you confirmed)
                          </span>
                        </span>
                        <button
                          type="button"
                          onClick={() => unmarkCovered(i)}
                          className="shrink-0 text-xs font-medium text-green-700 hover:text-green-800 dark:text-green-300 dark:hover:text-green-200"
                        >
                          Undo
                        </button>
                      </li>
                    ) : null
                  )}
                  {addedCovered.map((item, i) => (
                    <li
                      key={`added-${i}`}
                      className="flex items-start justify-between gap-3 rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800 dark:border-green-900 dark:bg-green-950/40 dark:text-green-200"
                    >
                      <span>
                        {item}{" "}
                        <span className="text-xs text-green-700 dark:text-green-300">(you added)</span>
                      </span>
                      <button
                        type="button"
                        onClick={() => removeAdded(i)}
                        className="shrink-0 text-xs font-medium text-green-700 hover:text-green-800 dark:text-green-300 dark:hover:text-green-200"
                      >
                        Undo
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="mt-3">
              {showAdd ? (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    addCoveredItem();
                  }}
                  className="flex items-center gap-2"
                >
                  <input
                    type="text"
                    value={addDraft}
                    onChange={(e) => setAddDraft(e.target.value)}
                    placeholder="e.g. warranty was agreed over the phone"
                    className="input flex-1"
                    autoFocus
                  />
                  <button type="submit" className="btn-secondary shrink-0">
                    Add
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setShowAdd(false);
                      setAddDraft("");
                    }}
                    className="shrink-0 text-xs font-medium text-stone-500 hover:text-stone-700 dark:text-stone-400 dark:hover:text-stone-300"
                  >
                    Cancel
                  </button>
                </form>
              ) : (
                <button
                  type="button"
                  onClick={() => setShowAdd(true)}
                  className="text-xs font-medium text-bark-700 hover:text-bark-700 dark:text-stone-300 dark:hover:text-stone-300"
                >
                  + Add something the quote includes
                </button>
              )}
            </div>
          </div>

          {result.negotiation && (
            <div>
              <div className="mb-2 flex items-center justify-between">
                <h2 className="text-sm font-medium text-stone-900 dark:text-stone-100">Negotiation script</h2>
                <button
                  type="button"
                  onClick={copyNegotiation}
                  className="text-xs font-medium text-bark-700 hover:text-bark-700 dark:text-stone-300 dark:hover:text-stone-300"
                >
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>
              <p
                ref={negotiationRef}
                className="whitespace-pre-wrap rounded-lg border border-stone-200 bg-white px-3 py-3 text-sm text-stone-700 dark:border-white/10 dark:bg-stone-800 dark:text-stone-300"
              >
                {result.negotiation}
              </p>
              {copyFallback && (
                <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
                  Couldn&apos;t copy automatically, so the text above is selected: press Ctrl+C (or Cmd+C) to copy it.
                </p>
              )}
            </div>
          )}

          <Link href="/contractors" className="btn-primary block text-center">
            Get more quotes to compare
          </Link>
        </div>
      )}

      {result && freeTaste && (
        <div className="card space-y-3 border-bark-100 bg-bark-50 text-center dark:border-bark-700 dark:bg-bark-700/40">
          <p className="text-sm text-bark-700 dark:text-stone-300">
            That was your free check. Get every quote checked with Hearth Plus,
            $4.99/mo, or start weekly with 3 free days.
          </p>
          <Link href="/plus?reason=quote" className="btn-primary inline-block">
            Get Hearth Plus
          </Link>
        </div>
      )}
    </div>
  );
}
