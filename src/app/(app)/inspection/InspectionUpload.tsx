"use client";

import { useRef, useState, useTransition } from "react";
import Link from "next/link";
import { Search, FileText } from "lucide-react";
import { SYSTEM_TYPES, ISSUE_CATEGORIES, labelFor } from "@/lib/constants";
import { saveInspectionFindingsAction } from "./actions";
import AiNotice from "@/components/AiNotice";
import Lightbox from "@/components/Lightbox";
import ProgressBar, { useStagedProgress } from "@/components/ProgressBar";
import { fetchWithTimeout, isTimeoutError } from "@/lib/fetchWithTimeout";
import { FREE_TASTE_PAYWALL, tasteMeterLabel } from "@/lib/freeAiTaste";

type Mode = "photo" | "pdf" | "text";

// The honest steps /api/ingest-inspection runs: read the report pages, pull out
// the systems and issues it names, then organize them for the review checklist.
const INGEST_STAGES = [
  "Reading the report",
  "Finding systems and issues",
  "Organizing what it found",
];

// Cap the PDF before reading it into memory and POSTing it to the vision
// endpoint (cost/DoS + browser OOM). The API enforces the same ceiling; this
// is the friendly first line so a homeowner isn't left guessing. accept="" is
// only a hint, so the real check lives in onPickPdf.
const MAX_PDF_BYTES = 20 * 1024 * 1024; // 20MB

// Only these messages are ever shown from the API's JSON `error` field. The
// route hand-writes every one of them today, but nothing in the type system
// stops a future change (or an exception serialized into that field) from
// putting a stack trace or an internal code in there, and this component would
// print it to the homeowner verbatim. Anything not on this list falls back to
// the component's own plain-English copy. Keep in sync with the responses in
// src/app/api/ingest-inspection/route.ts.
const ALLOWED_API_ERRORS: RegExp[] = [
  /^Add a photo or PDF of the report, or paste its text\.$/,
  /^That's too much to read at once\. Send the PDF on its own, or fewer page photos\.$/,
  /^Please add at most \d+ pages at a time\.$/,
  /^One of those images is too large\.$/,
  /^Those photos add up to too much at once\. Add fewer pages, or use the PDF or paste option\.$/,
  /^That PDF is too large \(max 20MB\)\. Try the photos or paste option instead\.$/,
  /^Report text is too long\. Paste the findings and summary sections, or upload the PDF instead\.$/,
  /^That PDF has too many pages \(max \d+\)\. Please upload just the inspection report's pages\.$/,
];

// Returns the server's message only when it is one Hearth wrote, otherwise
// null so the caller uses its own fallback. Exported for
// InspectionUpload.errors.test.tsx, which covers both branches directly.
export function knownApiError(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const msg = raw.trim();
  return ALLOWED_API_ERRORS.some((re) => re.test(msg)) ? msg : null;
}

type ProposedSystem = {
  system_type: string;
  condition_rating: number | null;
  install_year: number | null;
  notes: string | null;
};

type ProposedIssue = {
  category: string;
  severity: string;
  description: string | null;
};

type IngestResult = {
  summary: string;
  systems: ProposedSystem[];
  issues: ProposedIssue[];
};

const CONDITION_LABEL: Record<number, string> = {
  5: "Excellent",
  4: "Good",
  3: "Fair",
  2: "Poor",
  1: "Needs immediate attention",
};

const SEVERITY_LABEL: Record<string, string> = {
  low: "Low",
  medium: "Medium",
  urgent: "Urgent",
};

const SEVERITY_STYLE: Record<string, string> = {
  low: "border-stone-200 bg-stone-50 text-stone-600 dark:border-white/10 dark:bg-stone-700 dark:text-stone-300",
  medium: "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/15 dark:text-amber-300",
  urgent: "border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200",
};

// Downscale a report page to a JPEG that keeps text legible but stays small
// enough that several pages fit under hosting request-size limits (a raw
// phone photo alone can blow past them). Returns base64 without the prefix.
function toBase64(file: File, maxDim = 1600, quality = 0.8): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      const ctx = canvas.getContext("2d");
      if (!ctx) return reject(new Error("no canvas"));
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL("image/jpeg", quality);
      resolve(dataUrl.includes(",") ? dataUrl.split(",")[1] : dataUrl);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("unreadable image"));
    };
    img.src = url;
  });
}

// Read a PDF straight to base64 (no canvas rescaling: a PDF isn't a raster we
// can downsize, and the model reads the file's own pages). Returns base64
// without the data: prefix, which is the shape src/lib/claude.ts passes
// through as a document block.
function pdfToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const res = typeof reader.result === "string" ? reader.result : "";
      resolve(res.includes(",") ? res.split(",")[1] : res);
    };
    reader.onerror = () => reject(new Error("unreadable pdf"));
    reader.readAsDataURL(file);
  });
}

// Add an inspection report an owner already has: photos of its pages or
// pasted text go to Hearth, which proposes systems and issues. Nothing is
// saved until the owner reviews the checklist and confirms.
//
// `freeReadsLeft` is the meter: how many of the 1 lifetime free report reads
// this account has left (src/lib/freeAiTaste.ts). Null for a Plus or trialing
// member, and null when the counter could not be read, and in both cases no
// meter and no door is shown. At zero the "Read this report" button becomes
// the Plus door carrying the SAME sentence /api/ingest-inspection would have
// sent, so the refusal is never a surprise and never arrives cold.
export default function InspectionUpload({
  freeReadsLeft = null,
}: {
  freeReadsLeft?: number | null;
}) {
  const [mode, setMode] = useState<Mode>("photo");
  const [images, setImages] = useState<string[]>([]);
  const [previews, setPreviews] = useState<string[]>([]);
  const [pdf, setPdf] = useState<string | null>(null);
  const [pdfName, setPdfName] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [phase, setPhase] = useState<"idle" | "working" | "review" | "done">("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<IngestResult | null>(null);
  const [systemsChecked, setSystemsChecked] = useState<boolean[]>([]);
  const [issuesChecked, setIssuesChecked] = useState<boolean[]>([]);
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const [saving, startSave] = useTransition();
  // Lets the "Cancel" button below abort an in-flight read and lets the
  // catch block tell a homeowner-initiated cancel apart from a real failure
  // (so cancelling doesn't also flash an error message).
  const abortRef = useRef<AbortController | null>(null);
  const cancelledRef = useRef(false);
  // The live meter, seeded from the server and spent here as reads succeed, so
  // the count stays honest without a page refresh. Null means "no meter"
  // (Plus, or the counter could not be read).
  const [readsLeft, setReadsLeft] = useState<number | null>(freeReadsLeft);
  // Set when the server refuses (HTTP 402). Belt and braces behind the meter,
  // for the tab that was already open when the free read was spent elsewhere.
  const [locked, setLocked] = useState(false);
  const doorShowing = locked || readsLeft === 0;
  // A PDF is a bigger read for the model than a few photos, so pace the stage
  // labels a little slower for it.
  const progress = useStagedProgress(INGEST_STAGES, mode === "pdf" ? 32000 : 22000);

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const input = e.target;
    const files = Array.from(input.files ?? []);
    input.value = ""; // allow re-picking the same files
    if (!files.length) return;

    // Guard the size before reading into memory and POSTing to the vision
    // endpoint (cost/DoS + browser OOM). accept="" is only a hint.
    const MAX_BYTES = 15 * 1024 * 1024; // 15MB
    if (files.some((f) => f.size > MAX_BYTES)) {
      setError("One of those photos is too large (max 15MB each). Try smaller photos.");
      return;
    }

    setError(null);
    const newB64 = await Promise.all(files.map((f) => toBase64(f)));
    const newPreviews = files.map((f) => URL.createObjectURL(f));
    setImages((prev) => [...prev, ...newB64]);
    setPreviews((prev) => [...prev, ...newPreviews]);
  }

  function removeImage(i: number) {
    setImages((prev) => prev.filter((_, idx) => idx !== i));
    setPreviews((prev) => prev.filter((_, idx) => idx !== i));
  }

  async function onPickPdf(e: React.ChangeEvent<HTMLInputElement>) {
    const input = e.target;
    const file = input.files?.[0];
    input.value = ""; // allow re-picking the same file
    if (!file) return;

    if (file.size > MAX_PDF_BYTES) {
      setError(
        "That PDF is too large (max 20MB). Try the photos or paste option for a big report instead."
      );
      return;
    }

    setError(null);
    try {
      const b64 = await pdfToBase64(file);
      setPdf(b64);
      setPdfName(file.name);
    } catch {
      setError("We couldn't read that PDF. Try the photo or paste option instead.");
    }
  }

  function removePdf() {
    setPdf(null);
    setPdfName(null);
  }

  async function ingest() {
    if (mode === "photo" && images.length === 0) {
      setError("Add at least one photo of the report first.");
      return;
    }
    if (mode === "pdf" && !pdf) {
      setError("Choose the report PDF first.");
      return;
    }
    if (mode === "text" && !text.trim()) {
      setError("Paste the report text first.");
      return;
    }

    setPhase("working");
    setError(null);
    setResult(null);
    cancelledRef.current = false;
    progress.start();
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const resp = await fetchWithTimeout(
        "/api/ingest-inspection",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            images: mode === "photo" ? images : undefined,
            pdf: mode === "pdf" ? pdf : undefined,
            text: mode === "text" ? text : undefined,
          }),
          signal: controller.signal,
        },
        // A multi-page PDF is a bigger read for the model than a handful of
        // photos, so give it more headroom before the client gives up.
        mode === "pdf" ? 180_000 : 120_000
      );
      abortRef.current = null;

      if (resp.status === 401) {
        setPhase("idle");
        setError("Please sign in and try again.");
        return;
      }

      // Out of free reads. No red error line: this is not something the owner
      // got wrong, so the door below carries the message instead.
      if (resp.status === 402) {
        setPhase("idle");
        setReadsLeft(0);
        setLocked(true);
        setError(null);
        return;
      }

      const data = await resp.json().catch(() => ({}));
      if (data?.result) {
        const found = data.result as IngestResult;
        setResult(found);
        setSystemsChecked(found.systems.map(() => true));
        setIssuesChecked(found.issues.map(() => true));
        // A real read landed, so the free read is gone. A failed read is
        // refunded server side, so the meter only moves on a real result.
        setReadsLeft((n) => (n === null ? null : Math.max(0, n - 1)));
        setPhase("review");
      } else if (data?.reason === "rate_limited") {
        setPhase("idle");
        setError("Hearth has hit today's free usage limit. Please try again later.");
      } else if (data?.reason === "no_key") {
        setPhase("idle");
        setError("Report reading isn't set up yet.");
      } else {
        setPhase("idle");
        setError(
          knownApiError(data?.error) ||
            (mode === "pdf"
              ? "We couldn't read that PDF. Try the photo or paste option instead."
              : "Couldn't read that report. Try clearer photos or paste the text instead.")
        );
      }
    } catch (e) {
      abortRef.current = null;
      // Cancel already reset the phase and left no error - don't overwrite
      // that with a failure message for an abort the homeowner asked for.
      if (cancelledRef.current) {
        cancelledRef.current = false;
        return;
      }
      setPhase("idle");
      setError(
        isTimeoutError(e)
          ? "That took too long. Try again."
          : "Something went wrong. Please try again."
      );
    } finally {
      progress.finish();
    }
  }

  // Lets the homeowner back out of "Reading the report..." instead of being
  // stuck waiting on a hung request with no escape.
  function cancelIngest() {
    cancelledRef.current = true;
    abortRef.current?.abort();
    abortRef.current = null;
    setPhase("idle");
    setError(null);
  }

  function confirmAndSave(formData: FormData) {
    startSave(async () => {
      const res = await saveInspectionFindingsAction(formData);
      // Only celebrate when something was actually added. Otherwise stay on the
      // review step and tell the truth about why nothing landed.
      if (res.ok && res.added > 0) {
        setPhase("done");
        setImages([]);
        setPreviews([]);
        setPdf(null);
        setPdfName(null);
        setText("");
        setResult(null);
        return;
      }
      if (!res.ok && res.reason === "error") {
        setError(res.message);
      } else if (!res.ok && res.reason === "nothing_selected") {
        setError("Nothing was selected. Check at least one item to add.");
      } else {
        setError("Those items are already in your home, so nothing was added.");
      }
    });
  }

  function startOver() {
    setPhase("idle");
    setResult(null);
    setError(null);
  }

  if (phase === "done") {
    return (
      <div className="space-y-3">
        <p className="rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-800 dark:border-green-900 dark:bg-green-950/40 dark:text-green-200">
          Added to your home. Check your systems and issues to see what&apos;s new.
        </p>
        <button type="button" className="btn-secondary" onClick={startOver}>
          Add another report
        </button>
      </div>
    );
  }

  if (phase === "review" && result) {
    const confirmedSystems = JSON.stringify(
      result.systems.filter((_, i) => systemsChecked[i])
    );
    const confirmedIssues = JSON.stringify(
      result.issues.filter((_, i) => issuesChecked[i])
    );

    return (
      <form action={confirmAndSave} className="space-y-4">
        <input type="hidden" name="systems_json" value={confirmedSystems} />
        <input type="hidden" name="issues_json" value={confirmedIssues} />

        {result.summary && (
          <p className="rounded-lg bg-stone-50 p-3 text-sm text-stone-600 dark:bg-stone-900 dark:text-stone-300">
            {result.summary}
          </p>
        )}

        {/* Sits above the checkboxes on purpose: the checkboxes ARE the human
            review step, so the label needs to be read before them. */}
        <AiNotice detail="A model read your report, so it can miss things or read a number wrong. Uncheck anything that's off, nothing is saved to your home until you confirm." />

        {result.systems.length > 0 && (
          <div>
            <h3 className="mb-2 text-sm font-medium text-stone-900 dark:text-stone-100">
              Systems found
            </h3>
            <ul className="space-y-2">
              {result.systems.map((s, i) => (
                <li
                  key={i}
                  className="flex items-start gap-3 rounded-lg border border-stone-200 p-3 dark:border-white/10"
                >
                  <input
                    type="checkbox"
                    checked={systemsChecked[i] ?? true}
                    onChange={(e) =>
                      setSystemsChecked((prev) => {
                        const next = [...prev];
                        next[i] = e.target.checked;
                        return next;
                      })
                    }
                    className="mt-1"
                  />
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-stone-800 dark:text-stone-200">
                      {labelFor(SYSTEM_TYPES, s.system_type)}
                      {s.condition_rating ? (
                        <span className="ml-2 text-xs font-normal text-stone-500 dark:text-stone-400">
                          {CONDITION_LABEL[s.condition_rating] ?? ""} (
                          {s.condition_rating}/5)
                        </span>
                      ) : null}
                      {s.install_year ? (
                        <span className="ml-2 text-xs font-normal text-stone-500 dark:text-stone-400">
                          Installed {s.install_year}
                        </span>
                      ) : null}
                    </p>
                    {s.notes && (
                      <p className="text-xs text-stone-500 dark:text-stone-400">{s.notes}</p>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}

        {result.issues.length > 0 && (
          <div>
            <h3 className="mb-2 text-sm font-medium text-stone-900 dark:text-stone-100">
              Issues found
            </h3>
            <ul className="space-y-2">
              {result.issues.map((iss, i) => (
                <li
                  key={i}
                  className="flex items-start gap-3 rounded-lg border border-stone-200 p-3 dark:border-white/10"
                >
                  <input
                    type="checkbox"
                    checked={issuesChecked[i] ?? true}
                    onChange={(e) =>
                      setIssuesChecked((prev) => {
                        const next = [...prev];
                        next[i] = e.target.checked;
                        return next;
                      })
                    }
                    className="mt-1"
                  />
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-stone-800 dark:text-stone-200">
                      {labelFor(ISSUE_CATEGORIES, iss.category)}
                      <span
                        className={`ml-2 rounded-full border px-2 py-0.5 text-xs font-normal ${
                          SEVERITY_STYLE[iss.severity] ?? SEVERITY_STYLE.low
                        }`}
                      >
                        {SEVERITY_LABEL[iss.severity] ?? iss.severity}
                      </span>
                    </p>
                    {iss.description && (
                      <p className="text-xs text-stone-500 dark:text-stone-400">{iss.description}</p>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}

        {result.systems.length === 0 && result.issues.length === 0 && (
          <p className="text-sm text-stone-500 dark:text-stone-400">
            Hearth couldn&apos;t find any specific systems or issues in that
            report.
          </p>
        )}

        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

        <div className="flex gap-3">
          <button type="button" className="btn-secondary" onClick={startOver}>
            Cancel
          </button>
          <button type="submit" disabled={saving} className="btn-primary flex-1">
            {saving ? "Saving…" : "Add to my home"}
          </button>
        </div>
      </form>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => {
            setMode("photo");
            setError(null);
          }}
          className={mode === "photo" ? "btn-primary" : "btn-secondary"}
        >
          Upload photos
        </button>
        <button
          type="button"
          onClick={() => {
            setMode("pdf");
            setError(null);
          }}
          className={mode === "pdf" ? "btn-primary" : "btn-secondary"}
        >
          Upload a PDF
        </button>
        <button
          type="button"
          onClick={() => {
            setMode("text");
            setError(null);
          }}
          className={mode === "text" ? "btn-primary" : "btn-secondary"}
        >
          Paste the text
        </button>
      </div>

      {mode === "photo" ? (
        <div>
          <label className="flex cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed border-stone-200 px-4 py-8 text-center hover:border-bark-500 hover:bg-bark-50 dark:border-stone-700 dark:hover:bg-bark-700/30">
            <Search className="h-8 w-8 text-stone-400 dark:text-stone-500" aria-hidden="true" />
            <span className="text-sm font-medium text-stone-700 dark:text-stone-300">
              {previews.length ? "Add more pages" : "Upload photos of the inspection report"}
            </span>
            <span className="text-xs text-stone-500 dark:text-stone-400">
              You can add every page as its own photo
            </span>
            <input
              type="file"
              accept="image/*"
              multiple
              onChange={onPick}
              disabled={phase === "working"}
              className="hidden"
            />
          </label>
          {previews.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {previews.map((src, i) => (
                <div key={i} className="relative">
                  <button
                    type="button"
                    onClick={() => setLightboxSrc(src)}
                    className="block cursor-zoom-in"
                    aria-label={`View report page ${i + 1} full size`}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={src}
                      alt={`Report page ${i + 1}`}
                      className="h-20 w-20 rounded-lg border border-stone-200 object-cover dark:border-white/10"
                    />
                  </button>
                  <button
                    type="button"
                    onClick={() => removeImage(i)}
                    className="absolute -right-1 -top-1 rounded-full bg-stone-800 px-1.5 text-xs text-white"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
          <Lightbox
            src={lightboxSrc}
            alt="Inspection report page"
            onClose={() => setLightboxSrc(null)}
          />
        </div>
      ) : mode === "pdf" ? (
        <div>
          <label className="flex cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed border-stone-200 px-4 py-8 text-center hover:border-bark-500 hover:bg-bark-50 dark:border-stone-700 dark:hover:bg-bark-700/30">
            <FileText className="h-8 w-8 text-stone-400 dark:text-stone-500" aria-hidden="true" />
            <span className="text-sm font-medium text-stone-700 dark:text-stone-300">
              {pdfName ? "Choose a different PDF" : "Upload the inspection report PDF"}
            </span>
            <span className="text-xs text-stone-500 dark:text-stone-400">
              The whole report as one PDF, up to 20MB
            </span>
            <input
              type="file"
              accept="application/pdf,.pdf"
              onChange={onPickPdf}
              disabled={phase === "working"}
              className="hidden"
            />
          </label>
          {pdfName && (
            <div className="mt-3 flex items-center gap-2 rounded-lg border border-stone-200 p-3 dark:border-white/10">
              <FileText className="h-5 w-5 shrink-0 text-stone-400 dark:text-stone-500" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate text-sm text-stone-700 dark:text-stone-300">
                {pdfName}
              </span>
              <button
                type="button"
                onClick={removePdf}
                className="shrink-0 rounded-full bg-stone-800 px-1.5 text-xs text-white"
                aria-label="Remove PDF"
              >
                ×
              </button>
            </div>
          )}
        </div>
      ) : (
        <div>
          <label className="label">Report text</label>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={6}
            placeholder="Paste the findings from the inspection report here"
            className="input"
          />
        </div>
      )}

      {/* In-context data note on the surface where the owner decides to upload:
          the report goes to Anthropic's API to be read, and Anthropic's paid
          API terms mean it isn't training data. Same fact as the privacy page,
          compressed to one sentence. */}
      <p className="text-xs text-stone-500 dark:text-stone-400">
        Your report is sent to our AI provider, Anthropic, to be read. Under its
        paid API terms it is not used to train their models.{" "}
        <Link
          href="/ai-disclosure"
          className="underline decoration-dotted hover:text-stone-600 max-sm:inline-flex max-sm:min-h-11 max-sm:items-center dark:hover:text-stone-300"
        >
          How Hearth uses AI
        </Link>
      </p>

      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

      {/* THE DOOR, in place of the button once the free read is gone, carrying
          the same sentence the route sends so the refusal is never cold. */}
      {doorShowing ? (
        <div className="space-y-3 rounded-lg border border-bark-100 bg-bark-50 p-4 text-center dark:border-bark-700 dark:bg-bark-700/40">
          <p className="text-sm text-bark-700 dark:text-stone-300">
            {FREE_TASTE_PAYWALL.inspection.message}
          </p>
          <Link
            href={FREE_TASTE_PAYWALL.inspection.link}
            className="btn-primary inline-block"
          >
            Get Hearth Plus
          </Link>
        </div>
      ) : (
        <>
          {/* THE METER, stated before the tap rather than after the wall.
              Plus and trialing members get null and see nothing here. */}
          {readsLeft !== null && readsLeft > 0 && (
            <p className="text-xs text-stone-500 dark:text-stone-400">
              {tasteMeterLabel("inspection", readsLeft)}. Plus reads every
              report you add.
            </p>
          )}
          <button
            type="button"
            onClick={ingest}
            disabled={phase === "working"}
            className="btn-primary w-full"
          >
            {phase === "working" ? "Reading the report…" : "Read this report"}
          </button>
        </>
      )}
      {phase === "working" && (
        <>
          <ProgressBar
            value={progress.value}
            stages={INGEST_STAGES}
            stageIndex={progress.stageIndex}
            ariaLabel="Reading your inspection report"
          />
          <button
            type="button"
            onClick={cancelIngest}
            className="block w-full text-center text-sm text-stone-500 hover:text-stone-700 dark:text-stone-400 dark:hover:text-stone-300"
          >
            Cancel
          </button>
        </>
      )}
    </div>
  );
}
