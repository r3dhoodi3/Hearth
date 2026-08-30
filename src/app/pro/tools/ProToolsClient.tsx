"use client";

import { useState, useTransition } from "react";
import type { LucideIcon } from "lucide-react";
import {
  ClipboardList,
  ReceiptText,
  Mail,
  Star,
  BadgeDollarSign,
} from "lucide-react";
import { JOB_CATEGORIES, labelFor } from "@/lib/constants";
import type { ProPastJob } from "@/lib/database.types";
import Link from "next/link";
import AiNotice from "@/components/AiNotice";
import { PRO_TOOLS_PAYWALL, proDraftMeterLabel } from "@/lib/freeAiTaste";
import { fetchWithTimeout, isTimeoutError } from "@/lib/fetchWithTimeout";
import {
  deletePastJobAction,
  recordToolEditAction,
  sendDraftToLeadAction,
} from "./actions";

// The member-side AI back office: five tabs (estimate, invoice, follow-up,
// review response, overdue invoice reminder), each a small form that posts
// to /api/pro-tools and shows the generated document in a copyable block.
// Each tab keeps its own draft and result so switching tools mid-thought
// doesn't lose work.

type Tool = "estimate" | "invoice" | "followup" | "review_response" | "overdue";

const TABS: Array<{ id: Tool; icon: LucideIcon; label: string }> = [
  { id: "estimate", icon: ClipboardList, label: "Estimate" },
  { id: "invoice", icon: ReceiptText, label: "Invoice" },
  { id: "followup", icon: Mail, label: "Follow-up" },
  { id: "review_response", icon: Star, label: "Review response" },
  { id: "overdue", icon: BadgeDollarSign, label: "Invoice reminder" },
];

const SITUATIONS: Array<{ value: string; label: string }> = [
  { value: "no_reply", label: "Sent a quote, no reply yet" },
  { value: "review", label: "Job's done, ask for a review" },
  { value: "checkin", label: "Check in with a past customer" },
];

const OVERDUE_STAGE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "friendly", label: "Friendly reminder (about 2 weeks overdue)" },
  { value: "firm", label: "Firm notice (about a month overdue)" },
  { value: "final", label: "Final notice" },
];

// Read a File into base64 (no data: prefix) for the vision endpoints. Same
// helper as src/components/DocumentUpload.tsx.
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

const MAX_PAST_JOB_BYTES = 15 * 1024 * 1024; // 15MB, same cap as DocumentUpload

// One of this contractor's own leads, for the "Send to a lead" picker. A
// trimmed-down slice of ContractorLead (see src/lib/database.types.ts):
// just enough to label and sort each option.
type ToolsLead = {
  id: string;
  homeowner_name: string | null;
  category: string;
  status: string;
  created_at: string;
};

export default function ProToolsClient({
  initialPastJobs,
  categories,
  leads,
  initialDraftsLeft = null,
}: {
  initialPastJobs: ProPastJob[];
  categories: string[];
  leads: ToolsLead[];
  // Free drafts remaining for a NON-member (migration 0145). Null for a Pro
  // member, who sees no meter at all: they are bounded only by the shared
  // daily ceiling, exactly as before.
  initialDraftsLeft?: number | null;
}) {
  const [tool, setTool] = useState<Tool>("estimate");

  // The meter counts down in front of the pro rather than surprising them
  // afterwards. Server-rendered starting value, decremented locally on each
  // draft that actually comes back, so the number on screen matches what the
  // next tap will cost without a round trip to re-read it.
  const [draftsLeft, setDraftsLeft] = useState<number | null>(initialDraftsLeft);
  // Set when the server says the free drafts are gone (402). Replaces the
  // generic error line with the wall and its one link, the same sentence
  // src/lib/freeAiTaste.ts sends.
  const [paywalled, setPaywalled] = useState(false);

  // Show only the trades this pro actually lists on their profile, so the
  // dropdown isn't a wall of every category on Hearth. If they haven't
  // picked any yet, fall back to the full list so the tool still works.
  const cats = categories.length
    ? JOB_CATEGORIES.filter((c) => categories.includes(c.value))
    : JOB_CATEGORIES;

  // Estimate fields
  const [estDescription, setEstDescription] = useState("");
  const [estCategory, setEstCategory] = useState("");
  const [estPrice, setEstPrice] = useState("");
  const [estMaterials, setEstMaterials] = useState("");

  // Invoice fields
  const [invDescription, setInvDescription] = useState("");
  const [invAmount, setInvAmount] = useState("");
  const [invWorkDone, setInvWorkDone] = useState("");

  // Follow-up fields
  const [fuSituation, setFuSituation] = useState("no_reply");
  const [fuContext, setFuContext] = useState("");

  // Review response fields
  const [rrReviewText, setRrReviewText] = useState("");
  const [rrRating, setRrRating] = useState("");
  const [rrStory, setRrStory] = useState("");

  // Overdue invoice ladder fields
  const [odStage, setOdStage] = useState("friendly");
  const [odAmount, setOdAmount] = useState("");
  const [odOverdue, setOdOverdue] = useState("");
  const [odJob, setOdJob] = useState("");
  const [odContext, setOdContext] = useState("");

  // Per-tool results, so switching tabs doesn't wipe a draft you just made.
  // `results` is the AI's original text for that tool, kept untouched so we
  // can tell whether the pro changed anything; `drafts` is the editable copy
  // shown in the textarea, seeded from `results` on every fresh generate()
  // and free to diverge from it as the pro types.
  const [results, setResults] = useState<Record<Tool, string | null>>({
    estimate: null,
    invoice: null,
    followup: null,
    review_response: null,
    overdue: null,
  });
  const [drafts, setDrafts] = useState<Record<Tool, string | null>>({
    estimate: null,
    invoice: null,
    followup: null,
    review_response: null,
    overdue: null,
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // "Send to a lead" picker on a finished draft. Transient UI state tied to
  // whatever draft is currently on screen, so it resets on tab switch and on
  // every fresh generate(), same as `copied` above.
  const [sendPickerOpen, setSendPickerOpen] = useState(false);
  const [selectedLeadId, setSelectedLeadId] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);

  // Your past jobs: upload state, saved rows, and the pending remove.
  const [pastJobs, setPastJobs] = useState<ProPastJob[]>(initialPastJobs);
  const [pjBusy, setPjBusy] = useState(false);
  const [pjError, setPjError] = useState<string | null>(null);
  const [pjRemovingId, setPjRemovingId] = useState<string | null>(null);
  const [, startRemoveTransition] = useTransition();

  async function onPickPastJob(e: React.ChangeEvent<HTMLInputElement>) {
    const input = e.target;
    const file = input.files?.[0];
    input.value = ""; // allow re-picking the same file
    if (!file) return;

    if (file.size > MAX_PAST_JOB_BYTES) {
      setPjError("That file is too large (max 15MB). Try a smaller photo or PDF.");
      return;
    }

    setPjBusy(true);
    setPjError(null);

    try {
      const b64 = await toBase64(file);
      // Timeout-guarded: a hung extract call must not strand the picker in
      // its busy state with no way to retry.
      const resp = await fetchWithTimeout("/api/pro-past-jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ image: b64, mime: file.type || "image/jpeg" }),
      });

      if (resp.status === 401) {
        setPjError("Please sign in and try again.");
        return;
      }
      if (resp.status === 403) {
        setPjError("This tool is part of the Hearth Pro membership.");
        return;
      }

      const data = await resp.json().catch(() => ({}));
      if (data?.job) {
        setPastJobs((jobs) => [data.job, ...jobs]);
      } else if (data?.reason === "locked") {
        // The business is not verified yet; copy comes from the server.
        setPjError(data?.error || "Drafting opens once your business is verified.");
      } else if (data?.reason === "rate_limited") {
        setPjError("You've hit today's drafting limit. It resets at midnight.");
      } else if (data?.reason === "no_key") {
        setPjError("Can't draft right now. Try again in a minute.");
      } else {
        setPjError(
          "Couldn't read that document. Try a clearer photo, a PDF, or a different file."
        );
      }
    } catch (e) {
      setPjError(
        isTimeoutError(e)
          ? "That took too long. Try again."
          : "Something went wrong. Please try again."
      );
    } finally {
      setPjBusy(false);
    }
  }

  function removePastJob(id: string) {
    setPjRemovingId(id);
    const formData = new FormData();
    formData.set("id", id);
    startRemoveTransition(async () => {
      await deletePastJobAction(formData);
      setPastJobs((jobs) => jobs.filter((j) => j.id !== id));
      setPjRemovingId(null);
    });
  }

  function switchTool(next: Tool) {
    setTool(next);
    setError(null);
    setCopied(false);
    setSendPickerOpen(false);
    setSendError(null);
    setSentTo(null);
  }

  async function generate() {
    let payload: Record<string, string>;
    if (tool === "estimate") {
      if (!estDescription.trim()) {
        setError("Describe the job first.");
        return;
      }
      payload = {
        tool,
        description: estDescription,
        category: estCategory,
        price: estPrice,
        materials: estMaterials,
      };
    } else if (tool === "invoice") {
      if (!invDescription.trim()) {
        setError("Describe the job first.");
        return;
      }
      if (!invAmount.trim()) {
        setError("Enter the amount due.");
        return;
      }
      payload = {
        tool,
        description: invDescription,
        amount: invAmount,
        workDone: invWorkDone,
      };
    } else if (tool === "followup") {
      payload = { tool, situation: fuSituation, context: fuContext };
    } else if (tool === "review_response") {
      if (!rrReviewText.trim()) {
        setError("Paste the review first.");
        return;
      }
      payload = {
        tool,
        reviewText: rrReviewText,
        rating: rrRating,
        story: rrStory,
      };
    } else {
      if (!odAmount.trim()) {
        setError("Enter the amount owed.");
        return;
      }
      if (!odOverdue.trim()) {
        setError("Say how long it's been overdue.");
        return;
      }
      if (!odJob.trim()) {
        setError("Describe the job first.");
        return;
      }
      payload = {
        tool,
        stage: odStage,
        amount: odAmount,
        overdue: odOverdue,
        job: odJob,
        context: odContext,
      };
    }

    setLoading(true);
    setError(null);
    setCopied(false);
    setSendPickerOpen(false);
    setSendError(null);
    setSentTo(null);
    setResults((r) => ({ ...r, [tool]: null }));
    setDrafts((d) => ({ ...d, [tool]: null }));

    try {
      // Timeout-guarded: a hung drafting call must not strand the tool in
      // its loading state with no way to retry.
      const resp = await fetchWithTimeout("/api/pro-tools", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (resp.status === 401) {
        setError("Please sign in and try again.");
        return;
      }
      if (resp.status === 403) {
        setError("This tool is part of the Hearth Pro membership.");
        return;
      }
      // Free drafts spent. Not an error the pro did anything wrong with, so it
      // renders as the wall below rather than a red line.
      if (resp.status === 402) {
        setDraftsLeft(0);
        setPaywalled(true);
        return;
      }

      const data = await resp.json().catch(() => ({}));
      if (typeof data?.result === "string" && data.result) {
        setResults((r) => ({ ...r, [tool]: data.result }));
        setDrafts((d) => ({ ...d, [tool]: data.result }));
        // One draft delivered, one off the meter. Only on a real document: a
        // failed call is refunded server-side, so the counter must not move.
        setDraftsLeft((n) => (n === null ? null : Math.max(0, n - 1)));
      } else if (data?.reason === "locked") {
        // The business is not verified yet; copy comes from the server.
        setError(data?.error || "Drafting opens once your business is verified.");
      } else if (data?.reason === "rate_limited") {
        setError("You've hit today's drafting limit. It resets at midnight.");
      } else if (data?.reason === "no_key") {
        setError("Can't draft right now. Try again in a minute.");
      } else {
        setError(data?.error || "Couldn't write that draft. Please try again.");
      }
    } catch (e) {
      setError(
        isTimeoutError(e)
          ? "That took too long. Try again."
          : "Something went wrong. Please try again."
      );
    } finally {
      setLoading(false);
    }
  }

  const result = results[tool]; // the AI's original text, untouched
  const draft = drafts[tool]; // the editable text on screen: what gets copied and sent

  // The "remember my edits" write path (see recordToolEditAction and
  // migration 0063 pro_tool_edits). Fires after a successful copy or send,
  // and only when the text that went out is actually different from what the
  // AI first wrote: an unedited draft teaches the model nothing, so nothing
  // is stored for it. Fire-and-forget: this is background learning, never
  // something a pro needs to wait on or gets an error toast for.
  function rememberEditIfAny() {
    if (!result || !draft) return;
    if (draft === result) return;
    const fd = new FormData();
    fd.set("tool", tool);
    fd.set("original_text", result);
    fd.set("edited_text", draft);
    recordToolEditAction(fd).catch(() => {
      /* best effort: the pro's edit was already sent/copied either way */
    });
  }

  async function copyResult() {
    if (!draft) return;
    try {
      await navigator.clipboard.writeText(draft);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      rememberEditIfAny();
    } catch {
      /* clipboard unavailable */
    }
  }

  // Opens the picker and, the first time, defaults the selection to the most
  // recent lead (leads arrives sorted newest-first from the server).
  function openSendPicker() {
    setSentTo(null);
    setSendError(null);
    if (!selectedLeadId && leads.length) setSelectedLeadId(leads[0].id);
    setSendPickerOpen(true);
  }

  // Posts the current draft's plain text into the picked lead's thread via
  // sendDraftToLeadAction. Unlike sendQuoteAction/createInvoiceAction, this
  // action returns a real { ok, error } result, so success or failure here is
  // never guessed: "Sent to [name]" only shows once the server confirms it.
  async function confirmSend() {
    if (!draft || !selectedLeadId) return;
    setSending(true);
    setSendError(null);
    const fd = new FormData();
    fd.set("lead_id", selectedLeadId);
    fd.set("body", draft);
    try {
      const res = await sendDraftToLeadAction(fd);
      if (res.ok) {
        setSentTo(res.homeownerName ?? "the homeowner");
        setSendPickerOpen(false);
        rememberEditIfAny();
      } else {
        setSendError(res.error || "Couldn't send it. Please try again.");
      }
    } catch {
      setSendError("Something went wrong. Please try again.");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="space-y-5">
      <div className="-mx-1 flex gap-2 overflow-x-auto px-1">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => switchTool(t.id)}
            className={`shrink-0 whitespace-nowrap ${
              tool === t.id ? "btn-primary" : "btn-secondary"
            }`}
          >
            <t.icon className="h-4 w-4" aria-hidden="true" /> {t.label}
          </button>
        ))}
      </div>

      <div className="card-hero space-y-4">
        {tool === "estimate" && (
          <>
            <p className="text-sm text-stone-600 dark:text-stone-300">
              Describe the job the way you&apos;d explain it over the phone. You
              get back a written estimate with a scope, line items, and terms.
            </p>
            <div>
              <label className="label">The job, in your words</label>
              <textarea
                value={estDescription}
                onChange={(e) => setEstDescription(e.target.value)}
                rows={4}
                placeholder="Tear out the old 40-gallon water heater in the garage, haul it away, install a new 50-gallon gas unit, new supply lines and expansion tank, bring the venting up to code"
                className="input"
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className="label">Job category (optional)</label>
                <select
                  value={estCategory}
                  onChange={(e) => setEstCategory(e.target.value)}
                  className="input"
                >
                  <option value="">- pick one -</option>
                  {cats.map((c) => (
                    <option key={c.value} value={c.value}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="label">Your price (optional)</label>
                <input
                  type="text"
                  value={estPrice}
                  onChange={(e) => setEstPrice(e.target.value)}
                  placeholder="$1,850 all-in"
                  className="input"
                />
              </div>
            </div>
            <div>
              <label className="label">Materials notes (optional)</label>
              <textarea
                value={estMaterials}
                onChange={(e) => setEstMaterials(e.target.value)}
                rows={2}
                placeholder="Rheem 50-gal, about $650 in materials"
                className="input"
              />
            </div>

            <div className="rounded-xl border border-stone-200 bg-stone-50 p-4 dark:border-white/10 dark:bg-stone-800">
              <h3 className="text-sm font-medium text-stone-900 dark:text-stone-100">
                Your past jobs
              </h3>
              <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
                We read the line items off your old invoices and quotes to
                help ballpark future jobs like them. Customer names and
                contact details are never saved. Nothing is sent to anyone
                until you review it.
              </p>

              {pastJobs.length < 3 && (
                <p className="mt-2 text-xs text-stone-500 dark:text-stone-400">
                  {pastJobs.length === 0
                    ? "With none on file yet, this tool prices only from what you type above."
                    : "Upload more jobs of a given type and its suggestions get better for that type."}
                </p>
              )}

              <label className="mt-3 flex cursor-pointer items-center justify-center gap-2 rounded-lg border-2 border-dashed border-stone-200 px-4 py-3 text-center hover:border-hearth-300 hover:bg-hearth-100 dark:border-stone-700 dark:hover:border-hearth-400 dark:hover:bg-hearth-900/40">
                <span className="text-sm font-medium text-stone-700 dark:text-stone-300">
                  {pjBusy
                    ? "Reading your document…"
                    : "Upload a past invoice or quote"}
                </span>
                <input
                  type="file"
                  accept="image/*,application/pdf"
                  onChange={onPickPastJob}
                  disabled={pjBusy}
                  className="hidden"
                />
              </label>

              {pjError && (
                <p className="mt-2 text-xs text-red-600 dark:text-red-400">{pjError}</p>
              )}

              {pastJobs.length > 0 && (
                <ul className="mt-3 space-y-2">
                  {pastJobs.map((job) => {
                    const known = JOB_CATEGORIES.find(
                      (c) => c.value === job.job_type
                    );
                    const typeLabel = known
                      ? known.label
                      : job.job_type || "Past job";
                    const parts = [
                      typeLabel,
                      job.document_date,
                      job.total,
                    ].filter(Boolean) as string[];
                    return (
                      <li
                        key={job.id}
                        className="flex items-start justify-between gap-3 rounded-lg border border-stone-200 bg-white px-3 py-2 dark:border-white/10 dark:bg-stone-800"
                      >
                        <div>
                          <p className="text-sm font-medium text-stone-800 dark:text-stone-200">
                            {parts.join(" · ")}
                          </p>
                          {job.job_summary && (
                            <p className="mt-0.5 text-xs text-stone-500 dark:text-stone-400">
                              {job.job_summary}
                            </p>
                          )}
                        </div>
                        <button
                          type="button"
                          onClick={() => removePastJob(job.id)}
                          disabled={pjRemovingId === job.id}
                          // Phone only: 16px tall, and it deletes a past job.
                          className="shrink-0 text-xs font-medium text-stone-500 hover:text-red-600 max-sm:inline-flex max-sm:min-h-11 max-sm:items-center max-sm:text-sm dark:text-stone-400 dark:hover:text-red-400"
                        >
                          {pjRemovingId === job.id ? "Removing…" : "Remove"}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </>
        )}

        {tool === "invoice" && (
          <>
            <p className="text-sm text-stone-600 dark:text-stone-300">
              A couple of lines about the finished job and the amount due. You
              get back clean invoice text with a work summary and payment note.
            </p>
            <div>
              <label className="label">The job, in your words</label>
              <textarea
                value={invDescription}
                onChange={(e) => setInvDescription(e.target.value)}
                rows={3}
                placeholder="Replaced the water heater at the Hendersons' place on Maple St, finished Tuesday"
                className="input"
              />
            </div>
            <div>
              <label className="label">Amount due</label>
              <input
                type="text"
                value={invAmount}
                onChange={(e) => setInvAmount(e.target.value)}
                placeholder="$1,450"
                className="input"
              />
            </div>
            <div>
              <label className="label">What was done (optional)</label>
              <textarea
                value={invWorkDone}
                onChange={(e) => setInvWorkDone(e.target.value)}
                rows={2}
                placeholder="New 50-gal unit, new supply lines, hauled away the old one, tested everything"
                className="input"
              />
            </div>
          </>
        )}

        {tool === "followup" && (
          <>
            <p className="text-sm text-stone-600 dark:text-stone-300">
              Pick the situation and add any details worth mentioning. You get
              back a short message ready to send as a text or email.
            </p>
            <div>
              <label className="label">Situation</label>
              <select
                value={fuSituation}
                onChange={(e) => setFuSituation(e.target.value)}
                className="input"
              >
                {SITUATIONS.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label">Details (optional)</label>
              <textarea
                value={fuContext}
                onChange={(e) => setFuContext(e.target.value)}
                rows={3}
                placeholder="Quoted them $1,850 for a water heater swap last Thursday, seemed interested but haven't heard back"
                className="input"
              />
            </div>
          </>
        )}

        {tool === "review_response" && (
          <>
            <p className="text-sm text-stone-600 dark:text-stone-300">
              Paste the review and add a rating or context if you have them.
              You get back a professional response you can copy and post.
            </p>
            <div>
              <label className="label">The review</label>
              <textarea
                value={rrReviewText}
                onChange={(e) => setRrReviewText(e.target.value)}
                rows={4}
                placeholder="Paste the customer's review here"
                className="input"
              />
            </div>
            <div>
              <label className="label">Star rating (optional)</label>
              <select
                value={rrRating}
                onChange={(e) => setRrRating(e.target.value)}
                className="input"
              >
                <option value="">Not given</option>
                <option value="1">1 star</option>
                <option value="2">2 stars</option>
                <option value="3">3 stars</option>
                <option value="4">4 stars</option>
                <option value="5">5 stars</option>
              </select>
            </div>
            <div>
              <label className="label">Your side of the story (optional)</label>
              <textarea
                value={rrStory}
                onChange={(e) => setRrStory(e.target.value)}
                rows={2}
                placeholder="What actually happened, for your own context"
                className="input"
              />
            </div>
          </>
        )}

        {tool === "overdue" && (
          <>
            <p className="text-sm text-stone-600 dark:text-stone-300">
              Pick the stage and fill in the details. You get back a short
              reminder message ready to send.
            </p>
            <div>
              <label className="label">Stage</label>
              <select
                value={odStage}
                onChange={(e) => setOdStage(e.target.value)}
                className="input"
              >
                {OVERDUE_STAGE_OPTIONS.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className="label">Amount owed</label>
                <input
                  type="text"
                  value={odAmount}
                  onChange={(e) => setOdAmount(e.target.value)}
                  placeholder="$1,450"
                  className="input"
                />
              </div>
              <div>
                <label className="label">How overdue</label>
                <input
                  type="text"
                  value={odOverdue}
                  onChange={(e) => setOdOverdue(e.target.value)}
                  placeholder="About 2 weeks"
                  className="input"
                />
              </div>
            </div>
            <div>
              <label className="label">What the job was</label>
              <input
                type="text"
                value={odJob}
                onChange={(e) => setOdJob(e.target.value)}
                placeholder="Water heater replacement at the Hendersons' place"
                className="input"
              />
            </div>
            <div>
              <label className="label">Context (optional)</label>
              <textarea
                value={odContext}
                onChange={(e) => setOdContext(e.target.value)}
                rows={2}
                placeholder="Already sent one reminder last week, no reply yet"
                className="input"
              />
            </div>
          </>
        )}

        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

        {paywalled ? (
          // The wall, in place of the button: a plain statement of what was
          // used up and what Pro adds, with the one door out. Never a cold
          // 402, never a disabled button with no explanation.
          <div className="rounded-lg border border-hearth-200 bg-hearth-50 p-3 dark:border-hearth-500/30 dark:bg-hearth-500/15">
            <p className="text-sm text-hearth-800 dark:text-hearth-200">
              {PRO_TOOLS_PAYWALL.message}
            </p>
            <Link
              href={PRO_TOOLS_PAYWALL.link}
              className="btn-primary mt-3 inline-block text-sm"
            >
              See Hearth Pro
            </Link>
          </div>
        ) : (
          <>
            {/* The meter goes in FRONT of the button, never after the fact:
                a non-member should know what a tap costs before making it. */}
            {draftsLeft !== null && (
              <p className="text-xs text-stone-500 dark:text-stone-400">
                {proDraftMeterLabel(draftsLeft)}
              </p>
            )}
            <button
              type="button"
              onClick={generate}
              disabled={loading}
              className="btn-primary w-full"
            >
              {loading ? "Writing your draft…" : "Write it for me"}
            </button>
          </>
        )}
      </div>

      {result && (
        <div className="card space-y-2">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-sm font-medium text-stone-900 dark:text-stone-100">Your draft</h2>
            <button
              type="button"
              onClick={copyResult}
              // Phone only: 16px tall before.
              className="shrink-0 text-xs font-medium text-hearth-700 hover:text-hearth-800 max-sm:inline-flex max-sm:min-h-11 max-sm:items-center max-sm:text-sm dark:text-hearth-300 dark:hover:text-hearth-200"
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          {/* Editable, seeded from the AI's text: read it, tweak the wording
              if you want, and Copy/Send both act on what's in this box. */}
          <textarea
            value={draft ?? ""}
            onChange={(e) =>
              setDrafts((d) => ({ ...d, [tool]: e.target.value }))
            }
            rows={10}
            className="w-full whitespace-pre-wrap rounded-lg border border-stone-200 bg-stone-50 px-3 py-3 text-sm text-stone-700 focus:border-hearth-500 focus:outline-none focus:ring-1 focus:ring-hearth-500 dark:border-white/10 dark:bg-stone-900 dark:text-stone-100 dark:focus:border-hearth-400 dark:focus:ring-hearth-400"
          />
          <AiNotice detail="This is a starting point: read it over and edit anything before you send or post it, because it goes out under your name." />

          {/* "Send to a lead" lives at the bottom of the draft, after the
              text and the Copy button, so the flow reads top to bottom: read
              the draft, edit it if you want, then send. Green marks it as
              the one button here that actually delivers something to a real
              customer, distinct from the brown Copy/Write buttons above. */}
          <div className="flex justify-end">
            <button
              type="button"
              onClick={
                sendPickerOpen ? () => setSendPickerOpen(false) : openSendPicker
              }
              className="btn bg-green-600 text-white shadow-card hover:bg-green-700 hover:shadow-lift focus-visible:ring-green-500 dark:bg-green-700 dark:hover:bg-green-600 dark:focus-visible:ring-green-400"
            >
              Send to a lead
            </button>
          </div>

          {sendPickerOpen && (
            <div className="space-y-2 rounded-lg border border-stone-200 bg-stone-50 p-3 dark:border-white/10 dark:bg-stone-800">
              {leads.length === 0 ? (
                <p className="text-xs text-stone-500 dark:text-stone-400">
                  No active leads yet. Once a homeowner picks you for a job,
                  you&apos;ll be able to send drafts straight into that chat.
                </p>
              ) : (
                <>
                  <label className="label">Send to</label>
                  <select
                    value={selectedLeadId}
                    onChange={(e) => setSelectedLeadId(e.target.value)}
                    className="input"
                  >
                    {leads.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.homeowner_name || "Homeowner"} ·{" "}
                        {labelFor(JOB_CATEGORIES, l.category)}
                      </option>
                    ))}
                  </select>
                  {sendError && (
                    <p className="text-xs text-red-600 dark:text-red-400">{sendError}</p>
                  )}
                  <div className="flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => setSendPickerOpen(false)}
                      className="btn-secondary text-sm"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={confirmSend}
                      disabled={sending || !selectedLeadId}
                      className="btn bg-green-600 text-white shadow-card hover:bg-green-700 hover:shadow-lift focus-visible:ring-green-500 text-sm disabled:opacity-50 dark:bg-green-700 dark:hover:bg-green-600 dark:focus-visible:ring-green-400"
                    >
                      {sending ? "Sending…" : "Send"}
                    </button>
                  </div>
                </>
              )}
            </div>
          )}

          {sentTo && (
            <p className="rounded-md bg-green-50 px-3 py-1.5 text-xs text-green-700 dark:bg-green-500/15 dark:text-green-300">
              Sent to {sentTo}.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
