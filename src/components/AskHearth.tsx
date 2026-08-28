"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { logIssueFromChat, setReminderFromChat } from "@/lib/ask-actions";
import VoiceButton from "@/components/VoiceButton";
import Markdown from "@/components/Markdown";
import AiNotice from "@/components/AiNotice";
import Lightbox from "@/components/Lightbox";
import InlineSpinner from "@/components/InlineSpinner";
import { track } from "@/lib/analytics";
import {
  fetchWithTimeout,
  isTimeoutError,
  readWithTimeout,
} from "@/lib/fetchWithTimeout";
import { NDJSON_CONTENT_TYPE, parseNdjsonChunk } from "@/lib/askStream";
import {
  ASK_PLUS_LINK,
  freeLockText,
  isFreeLocked,
  meterLabel,
  shouldShowMeter,
  type AskLink,
} from "@/lib/askLimits";

export type Msg = {
  role: "user" | "assistant";
  content: string;
  // Optional attached photo (downscaled JPEG, base64 without the data: prefix).
  image?: string;
  mime?: string;
  // When the message was sent (Date.now()); used to age messages out.
  ts?: number;
  // An optional in-app destination the server attached to this reply (today:
  // the /plus link on the daily-limit message). The bubble renders plain
  // markdown with no link support, so a URL sitting in `content` would be
  // dead text; this renders as a real tappable link underneath instead.
  link?: { href: string; label: string };
  // True when this assistant message is not the whole answer: the stream
  // ended (a network drop, a server recompile, an idle timeout) before the
  // terminal line arrived, and this is whatever text had already come in.
  // Persisted so a reload shows the partial answer instead of treating the
  // question as unanswered; a later UI could use this to say the answer was
  // cut short.
  partial?: boolean;
};
type Job = { category: string; timing: string; summary: string };

// Downscale a chosen photo to a small JPEG so it's cheap to send to the model
// and small enough to keep in localStorage.
async function downscaleImage(
  file: File,
  maxDim = 1024,
  quality = 0.7
): Promise<{ mime: string; data: string }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new window.Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      let { width, height } = img;
      if (width > maxDim || height > maxDim) {
        const scale = maxDim / Math.max(width, height);
        width = Math.round(width * scale);
        height = Math.round(height * scale);
      }
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) return reject(new Error("no canvas context"));
      ctx.drawImage(img, 0, 0, width, height);
      const dataUrl = canvas.toDataURL("image/jpeg", quality);
      resolve({ mime: "image/jpeg", data: dataUrl.split(",")[1] });
    };
    img.onerror = reject;
    img.src = url;
  });
}

// The assistant can append machine-readable [[TAG]]{...}[[/TAG]] blocks for
// actions (hire a pro, log an issue, set a reminder). Pull each out of the
// visible text and turn it into a button.
function extractBlock(
  content: string,
  tag: string
): { content: string; data: any } {
  const open = `[[${tag}]]`;
  const idx = content.indexOf(open);
  if (idx === -1) return { content, data: null };

  // Find the JSON payload by brace-matching from the first "{" after the tag.
  // This tolerates a missing or typo'd closing tag (e.g. [[/LOGISSGUE]]) AND a
  // fully UNCLOSED block, so raw {json} never leaks into the visible message.
  const after = content.slice(idx + open.length);
  const start = after.indexOf("{");
  let data: any = null;
  // Default: if we can't find a clean JSON object, strip from the tag to the
  // end of the message (the AI is told to put blocks at the very end).
  let consumedEnd = content.length;

  if (start !== -1) {
    let depth = 0;
    let end = -1;
    let inStr = false;
    let esc = false;
    for (let i = start; i < after.length; i++) {
      const ch = after[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') inStr = false;
      } else if (ch === '"') inStr = true;
      else if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end !== -1) {
      try {
        data = JSON.parse(after.slice(start, end + 1));
      } catch {
        /* ignore malformed block */
      }
      // Also swallow a trailing closing tag if one is present.
      const tail = after.slice(end + 1).match(/^\s*\[\[\/?[^\]]*\]\]/);
      consumedEnd = idx + open.length + end + 1 + (tail ? tail[0].length : 0);
    }
  }

  const cleaned = (content.slice(0, idx) + content.slice(consumedEnd)).trim();
  return { content: cleaned, data };
}

// Exported for its unit test (src/components/askParse.test.tsx). Nothing else
// imports it: the component is its only real caller.
export function parseAssistant(content: string): {
  text: string;
  job: Job | null;
  issue: any;
  reminder: any;
  options: string[] | null;
} {
  let text = content;
  let r = extractBlock(text, "POSTJOB");
  text = r.content;
  const job: Job | null = r.data
    ? {
        category: String(r.data.category ?? "other"),
        timing: String(r.data.timing ?? ""),
        summary: String(r.data.summary ?? ""),
      }
    : null;
  r = extractBlock(text, "LOGISSUE");
  text = r.content;
  const issue = r.data;
  r = extractBlock(text, "REMINDER");
  text = r.content;
  const reminder = r.data;
  // Tappable quick-reply options the assistant offers, so the homeowner rarely
  // has to type. Rendered as buttons under the message.
  r = extractBlock(text, "OPTIONS");
  text = r.content;
  const options: string[] | null = Array.isArray(r.data?.options)
    ? r.data.options.map((o: any) => String(o)).filter(Boolean).slice(0, 5)
    : null;
  // Safety net: strip any leftover machine block / stray bracket markers so the
  // user never sees raw [[...]] text.
  text = text
    .replace(/\[\[[A-Za-z/]+\]\][\s\S]*?\[\[\/?[^\]]*\]\]/g, "")
    .replace(/\[\[\/?[^\]]*\]\]/g, "")
    // And an UNTERMINATED opener at the very end: "[[OPTI", or "[[OPTIONS"
    // with the closing brackets never generated. Both rules above need a "]]"
    // to match, so a reply cut off mid-tag (max_tokens, a dropped stream) left
    // the raw fragment sitting in the bubble. The lookahead makes this fire
    // only when no "]]" follows, so a well-formed block is never touched.
    .replace(/\[\[(?:(?!\]\])[\s\S])*$/, "")
    .trim();
  return { text, job, issue, reminder, options };
}

function jobHref(job: Job): string {
  const params = new URLSearchParams();
  if (job.category) params.set("category", job.category);
  if (job.timing) params.set("timing", job.timing);
  if (job.summary) params.set("desc", job.summary);
  return `/contractors?${params.toString()}`;
}

// A button that runs a server action once, then shows a confirmation.
function ActionButton({
  label,
  doneLabel,
  onApply,
}: {
  label: string;
  doneLabel: string;
  onApply: () => Promise<void>;
}) {
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  if (done)
    return (
      <span className="inline-block text-xs font-medium text-green-600 dark:text-green-400">
        {doneLabel}
      </span>
    );
  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setFailed(false);
          try {
            await onApply();
            setDone(true);
          } catch {
            setFailed(true);
            setBusy(false);
          }
        }}
        className="btn-primary px-3 py-1.5 text-xs"
      >
        {busy ? "…" : failed ? "Try again" : label}
      </button>
      {failed && (
        <span className="text-xs text-red-600 dark:text-red-400">Didn&apos;t save</span>
      )}
    </span>
  );
}

// When the AI wants to BOTH log an issue to the home record AND post a job, it's
// one intent for the homeowner - so it's one button: log the issue, then go
// straight to the prefilled job posting.
function LogAndPostButton({ job, issue }: { job: Job; issue: any }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        // Log it to the home record first; even if that hiccups, still let them
        // post the job rather than blocking on it.
        try {
          await logIssueFromChat(issue);
        } catch {
          /* ignore - proceed to post */
        }
        track("post_job_from_chat", { category: job.category });
        router.push(jobHref(job));
      }}
      className="btn-primary px-3 py-1.5 text-xs"
    >
      {busy ? "…" : "Log & post this job"}
    </button>
  );
}

function MessageActions({
  job,
  issue,
  reminder,
}: {
  job: Job | null;
  issue: any;
  reminder: any;
}) {
  if (!job && !issue && !reminder) return null;
  // Both at once -> a single combined button.
  const combined = job && issue;
  return (
    <div className="mt-1 flex flex-wrap gap-2">
      {combined ? (
        <LogAndPostButton job={job} issue={issue} />
      ) : (
        <>
          {job && (
            <Link
              href={jobHref(job)}
              onClick={() =>
                track("post_job_from_chat", { category: job.category })
              }
              className="btn-primary flex-col gap-0.5 py-2 leading-tight"
            >
              <span className="text-sm font-semibold">
                Get 3 free quotes
              </span>
              <span className="text-[11px] font-normal text-bark-100">
                License-checked local pros compete for your job
              </span>
            </Link>
          )}
          {issue && (
            <ActionButton
              label="Log to home record"
              doneLabel="✓ Logged to home record"
              onApply={() => logIssueFromChat(issue)}
            />
          )}
        </>
      )}
      {reminder && (
        <ActionButton
          label="Set a reminder"
          doneLabel="✓ Reminder set"
          onApply={() => setReminderFromChat(reminder)}
        />
      )}
    </div>
  );
}

// What the waiting pill says, in order, a step every WAIT_STEP_MS. A single
// frozen "Thinking…" for fifteen seconds reads as a page that has stopped
// working; naming the actual stages makes the same wait feel attended to. It
// is not a progress bar and never pretends to be one: these are the three
// things the request really does, not a percentage anyone can act on.
const WAIT_STEPS = [
  "Thinking…",
  "Checking your home details…",
  "Writing…",
] as const;
const WAIT_STEP_MS = 3000;
// After this long, say out loud that a long wait is normal, so nobody sits
// wondering whether it has hung.
const WAIT_SLOW_MS = 8000;

function WaitingPill() {
  const [step, setStep] = useState(0);
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const cycle = setInterval(
      () => setStep((s) => (s + 1) % WAIT_STEPS.length),
      WAIT_STEP_MS
    );
    const slowTimer = setTimeout(() => setSlow(true), WAIT_SLOW_MS);
    return () => {
      clearInterval(cycle);
      clearTimeout(slowTimer);
    };
  }, []);
  return (
    <div className="flex flex-col items-start gap-1">
      {/* aria-live so a screen reader hears the wait start, but "polite" and
          on the wrapper so the three-second relabel doesn't interrupt. */}
      <span
        aria-live="polite"
        className="rounded-lg border border-stone-200 bg-white px-3 py-1.5 text-sm text-stone-500 dark:border-white/10 dark:bg-stone-700 dark:text-stone-400"
      >
        {WAIT_STEPS[step]}
      </span>
      {slow && (
        <span className="px-1 text-xs text-stone-500 dark:text-stone-400">
          This can take up to a minute.
        </span>
      )}
    </div>
  );
}

// One shared conversation kept in localStorage: it survives reloads, and
// messages age out per the retention setting below (default: 24 hours), pruned
// by each message's own timestamp on load. Keys are namespaced per user id
// (e.g. "hearth_ask_chat:<uuid>") so chats can't leak between accounts on a
// shared device; the bare legacy keys are only used while the id loads. The
// key BASES are props so a separate mount (e.g. the pro copilot) stores its
// own conversation without colliding with the homeowner chat.
const DEFAULT_STORAGE_KEY = "hearth_ask_chat";
const DEFAULT_RETENTION_KEY = "hearth_ask_retention";
const SYNC_EVENT = "hearth:ask-updated";
// Remembered answer to "which plan is this viewer on?", written from the
// server's own verdict on every reply (see the meter fields below: freeLimit,
// freeRemaining, askTier). It drives things that both have to be decided
// BEFORE a reply has ever arrived, so there is nothing else to go on: the
// free-allowance hint under an empty composer, the trial-aware meter copy,
// and whether the photo-attach button shows a Plus tag and answers a tap
// with the lock message instead of the file picker. Never a gate on the
// actual question: the server is the only authority on the allowance and the
// photo lock, and this is only ever allowed to HIDE a hint or head off a tap
// that would be refused anyway, never to grant or refuse one itself.
const DEFAULT_PLAN_KEY = "hearth_ask_plan";

type Retention = "24h" | "2w" | "1m" | "never";
const RETENTION_MS: Record<Retention, number> = {
  "24h": 24 * 60 * 60 * 1000,
  "2w": 14 * 24 * 60 * 60 * 1000,
  "1m": 30 * 24 * 60 * 60 * 1000,
  never: Infinity,
};
// Even on "never", cap the history so localStorage can't bloat.
const MAX_MESSAGES = 200;
// STREAMING BUDGETS, in two halves, because one number cannot describe a
// streamed answer. The first covers everything up to the response headers:
// auth, the rate limits, the home-context queries, and opening the model call.
// The second is the gap BETWEEN chunks once text is flowing, which is the only
// thing that actually tells a dead connection apart from a long answer. A
// single 90-second whole-request budget would either kill a healthy long
// answer or wait a minute and a half on a socket that died after one word.
const HEADERS_TIMEOUT_MS = 45_000;
const STREAM_IDLE_TIMEOUT_MS = 30_000;
// How often the growing bubble is allowed to re-render. A 200-token answer
// arrives as a couple of hundred deltas; painting each one is a couple of
// hundred React renders (with a markdown parse each) for text nobody can read
// that fast. At 60ms the text still appears to flow and the work drops by
// more than an order of magnitude.
const STREAM_PAINT_MS = 60;
// How close to the bottom of the chat counts as "following along". Inside
// this, a streamed answer keeps scrolling into view; outside it, the reader
// has deliberately scrolled up and is left alone.
const STICK_TO_BOTTOM_PX = 80;

// How many of those messages actually go to the server. The routes already
// slice to the same number before building the request, so anything past this
// is bytes uploaded (with any attached photos, on a phone connection) purely
// to be thrown away on arrival. Kept identical to MAX_HISTORY_MESSAGES in
// src/app/api/ask/route.ts and src/app/api/pro-ask/route.ts.
const MAX_SENT_MESSAGES = 40;

// The conversation as it is ON DISK right now, pruned to the given window.
// Read straight from localStorage rather than from React state, because the
// two disagree for one commit every time the storage key changes (the effect
// that reads the new key has run, its setMessages has not landed yet) - and
// that is exactly the commit the one-shot initialQuestion fires in.
function readStoredMessages(key: string, retention: Retention): Msg[] {
  try {
    const raw = localStorage.getItem(key);
    const parsed = raw ? JSON.parse(raw) : null;
    return Array.isArray(parsed) ? prune(parsed, retention) : [];
  } catch {
    return [];
  }
}

function loadRetention(key: string): Retention {
  try {
    const r = localStorage.getItem(key);
    if (r === "24h" || r === "2w" || r === "1m" || r === "never") return r;
  } catch {
    /* ignore */
  }
  return "24h";
}

// Drop messages older than the retention window (by their own timestamp, so
// history rolls off gradually), then cap the count. Messages without a
// timestamp (the greeting) are kept.
function prune(msgs: Msg[], retention: Retention): Msg[] {
  const cutoff = Date.now() - RETENTION_MS[retention];
  const kept =
    retention === "never"
      ? msgs
      : msgs.filter((m) => !m.ts || m.ts >= cutoff);
  return kept.slice(-MAX_MESSAGES);
}
// ---------------------------------------------------------------------------
// Pure conversation helpers. Exported for their unit test
// (src/components/askState.test.tsx); the component is their only real caller.
// ---------------------------------------------------------------------------

/** The newest thing the owner said, or null if they haven't said anything. */
export function lastUserMessage(msgs: Msg[]): Msg | null {
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === "user") return msgs[i];
  }
  return null;
}

/**
 * Is `question` already the newest thing this conversation asked?
 *
 * This is the guard on the one-shot `initialQuestion` (the /ask page's `?q=`,
 * a question forwarded from elsewhere in the app). Without it, a reload or a
 * Back with the query still on the URL re-asks a question that is already
 * answered on screen: a second identical bubble, a second paid call, and one
 * of three daily free questions spent on nothing.
 */
export function alreadyAsked(msgs: Msg[], question: string): boolean {
  const q = question.trim();
  if (!q) return false;
  return lastUserMessage(msgs)?.content.trim() === q;
}

/**
 * True when the conversation ends on a question that never got an answer.
 *
 * That is what a reload mid-request leaves behind: the user turn was written
 * to localStorage the moment it was sent, the reply was still in flight, and
 * nothing on the next page load knows the request is gone. Left alone it sits
 * there forever with no answer, no error, and no way to try again.
 */
export function isUnanswered(msgs: Msg[]): boolean {
  const last = msgs[msgs.length - 1];
  return !!last && last.role === "user";
}

const DEFAULT_GREETING =
  "Hi, I'm Hearth. If you have any questions about your home, feel free to ask.";
const DEFAULT_HEADING_TITLE = "Ask Hearth";
// Names itself as AI explicitly, not just "assistant": California's bot
// disclosure law (B&P 17940-17943) wants this clear and conspicuous, and
// persistent rather than only in the first message. This heading renders
// every time the chat is open (both the compact card and the dock), so it
// does that job; AiNotice under the composer below repeats it near the input
// itself. The pro copilot passes its own headingSubtitle override (see
// src/app/pro/layout.tsx), so this default only ever reaches homeowners.
const DEFAULT_HEADING_SUBTITLE =
  "Your home AI assistant. Answers use your systems, ages, and any issues.";
const DEFAULT_DISCLAIMER =
  "Hearth's cost figures are ballpark estimates. Confirm with a local pro before you commit.";

// `fill` = take the full height of its container (the Messages pane); otherwise
// it renders as a compact card (Home / Learn). `suggestions` are starter
// questions shown as chips until the owner asks something. `greeting` is an
// optional personalized opener (e.g. referencing their systems/issues).
// `initialQuestion` is a question handed to a freshly mounted instance (the
// dock opening in response to "hearth:ask-question"); it is submitted once.
export default function AskHearth({
  fill = false,
  suggestions,
  greeting,
  initialQuestion,
  replaceUrlAfterInitial,
  endpoint = "/api/ask",
  storageKeyBase = DEFAULT_STORAGE_KEY,
  retentionKeyBase = DEFAULT_RETENTION_KEY,
  headingTitle = DEFAULT_HEADING_TITLE,
  headingSubtitle = DEFAULT_HEADING_SUBTITLE,
  disclaimer = DEFAULT_DISCLAIMER,
}: {
  fill?: boolean;
  suggestions?: string[];
  greeting?: string;
  initialQuestion?: string;
  // Where to rewrite the address bar to once `initialQuestion` has been dealt
  // with. The /ask page passes "/ask" so its ?q= is dropped from history: with
  // the query still on the URL, a reload or a Back into the page mounts a
  // fresh chat that reads the same q and asks it AGAIN, spending another of
  // three daily questions on a question already answered on screen. A plain
  // string rather than a callback because the page handing it over is a
  // server component.
  replaceUrlAfterInitial?: string;
  // Which API to talk to and where to keep the conversation. Defaults keep the
  // homeowner "Ask Hearth" behavior identical; the pro copilot overrides them.
  endpoint?: string;
  storageKeyBase?: string;
  retentionKeyBase?: string;
  headingTitle?: string;
  headingSubtitle?: string;
  disclaimer?: string;
}) {
  // Local aliases so the per-user namespacing and legacy migration below read
  // exactly as before, just off the prop bases.
  const STORAGE_KEY = storageKeyBase;
  const RETENTION_KEY = retentionKeyBase;
  const GREETING: Msg = {
    role: "assistant",
    content: greeting || DEFAULT_GREETING,
  };
  const [messages, setMessages] = useState<Msg[]>([GREETING]);
  const [retention, setRetention] = useState<Retention>("24h");
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [pendingImage, setPendingImage] = useState<{
    mime: string;
    data: string;
  } | null>(null);
  const [imageError, setImageError] = useState(false);
  // The data: URL of an attached photo currently open in the Lightbox, or
  // null when closed. Built on demand from the base64 message data since
  // messages only ever store the raw base64, not a ready-to-use URL.
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  // Free-tier daily allowance, reported by the server on each reply (null for
  // members, who never see a count). Deliberately not persisted: it is a
  // read of right now, and a stale number from yesterday would be a lie.
  const [freeLeft, setFreeLeft] = useState<number | null>(null);
  const [freeLimit, setFreeLimit] = useState<number | null>(null);
  // The upsell destination the server last handed us (the daily-limit reply,
  // or a photo lock). Kept so the locked bar and the photo hint can point
  // somewhere real even on the turn that spends the last question, which is a
  // normal answer with no link attached.
  const [lockLink, setLockLink] = useState<AskLink | null>(null);
  // True when the reply sitting at the bottom of the conversation IS the
  // over-limit message. The bar then drops its own line and shows just the
  // button, rather than repeating the sentence the bubble above already says.
  const [lockEcho, setLockEcho] = useState(false);
  // A free account tried to send a photo. The camera stays enabled (only the
  // server knows the plan), so this one-line hint is how they learn why the
  // photo bounced. Lives in component state, so it clears when the panel is
  // closed and the chat unmounts.
  const [photoLocked, setPhotoLocked] = useState(false);
  // What the server said about this viewer's plan the LAST time it answered
  // them: "unknown" until a reply has ever arrived on this device, "trial"
  // for a Plus trial member (own smaller daily allowance, photos included),
  // "free" for the uncapped-in-name-only free tier, "plus" for a paid member.
  const [knownPlan, setKnownPlan] = useState<
    "unknown" | "free" | "trial" | "plus"
  >("unknown");
  const endRef = useRef<HTMLDivElement>(null);
  // The chat's own scroll box (the compact card's and the dock's are the same
  // element in two layouts). Read only to answer "is the reader still at the
  // bottom?" while an answer streams in.
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const submitRef = useRef<(t: string) => void>(() => {});
  // Synchronous "a question is already in flight" latch. See submit().
  const sendingRef = useRef(false);
  // The conversation as of RIGHT NOW, readable from a callback without going
  // through a render. submit() builds its optimistic append off this rather
  // than off the `messages` closure it was created with: a storage re-read can
  // land between the render that created the handler and the tap that runs it,
  // and appending to a stale list either loses the turn or repeats one.
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  // Which account's chat this is. Until the id loads (or if it can't), fall
  // back to the legacy shared keys so nothing breaks.
  const [userId, setUserId] = useState<string | null>(null);
  const [userReady, setUserReady] = useState(false);
  const storageKey = userId ? `${STORAGE_KEY}:${userId}` : STORAGE_KEY;
  const retentionKey = userId ? `${RETENTION_KEY}:${userId}` : RETENTION_KEY;
  const planKey = userId ? `${DEFAULT_PLAN_KEY}:${userId}` : DEFAULT_PLAN_KEY;

  // Resolve the signed-in user once, and migrate any legacy shared-key chat to
  // the per-user key (then remove the legacy key so the next account on this
  // device can't see it).
  useEffect(() => {
    let cancelled = false;
    createClient()
      .auth.getUser()
      .then(({ data: { user } }) => {
        if (cancelled) return;
        if (user) {
          try {
            const chatKey = `${STORAGE_KEY}:${user.id}`;
            const legacyChat = localStorage.getItem(STORAGE_KEY);
            if (legacyChat !== null) {
              if (localStorage.getItem(chatKey) === null) {
                localStorage.setItem(chatKey, legacyChat);
              }
              localStorage.removeItem(STORAGE_KEY);
            }
            const retKey = `${RETENTION_KEY}:${user.id}`;
            const legacyRet = localStorage.getItem(RETENTION_KEY);
            if (legacyRet !== null) {
              if (localStorage.getItem(retKey) === null) {
                localStorage.setItem(retKey, legacyRet);
              }
              localStorage.removeItem(RETENTION_KEY);
            }
          } catch {
            /* ignore */
          }
          setUserId(user.id);
        }
        setUserReady(true);
      })
      .catch(() => {
        if (!cancelled) setUserReady(true); // stay on the legacy keys
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load the conversation on mount (and again once the per-user key resolves),
  // prune anything older than the retention window, and sync with other
  // instances on this page (dock + Messages).
  useEffect(() => {
    function read() {
      const r = loadRetention(retentionKey);
      setRetention(r);
      // A QUESTION IN FLIGHT OWNS THE CONVERSATION. This effect re-runs the
      // moment the per-user storage key resolves, which on a fast tap is
      // AFTER the owner has already sent something: re-reading then replaced
      // the live list with whatever was on disk under the other key and the
      // question they just asked vanished off the screen mid-wait. The
      // in-flight submit persists the authoritative list when it finishes, so
      // standing down here costs nothing.
      if (sendingRef.current) return;
      try {
        const raw = localStorage.getItem(storageKey);
        const parsed = raw ? JSON.parse(raw) : null;
        const pruned = Array.isArray(parsed) ? prune(parsed, r) : [];
        if (Array.isArray(parsed) && pruned.length !== parsed.length) {
          localStorage.setItem(storageKey, JSON.stringify(pruned));
        }
        const next = pruned.length ? pruned : [GREETING];
        // Keep the ref in step immediately: submit() reads it, and a tap can
        // land before this setMessages has rendered.
        messagesRef.current = next;
        setMessages(next);
      } catch {
        /* ignore */
      }
      try {
        const p = localStorage.getItem(planKey);
        setKnownPlan(
          p === "free" || p === "trial" || p === "plus" ? p : "unknown"
        );
      } catch {
        /* ignore */
      }
    }
    function onSync(e: Event) {
      // Ignore updates for a different key (e.g. another instance already on
      // the per-user key while this one is still on the legacy key).
      const k = (e as CustomEvent).detail?.key;
      if (typeof k === "string" && k !== storageKey) return;
      read();
    }
    read();
    window.addEventListener(SYNC_EVENT, onSync);
    return () => window.removeEventListener(SYNC_EVENT, onSync);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey, retentionKey, planKey]);

  // Set the conversation everywhere it is read from: React state for the
  // render, and the ref the send handler builds its optimistic append off.
  // Always use this, never a bare setMessages, or the two drift for a commit
  // and a tap landing in that window appends to the wrong list.
  function applyMessages(msgs: Msg[]) {
    messagesRef.current = msgs;
    setMessages(msgs);
  }

  // Remember the server's verdict on this viewer's plan. Only ever read to
  // decide whether to show the free-allowance hint under an empty composer.
  //
  // HOMEOWNER CHAT ONLY. The pro copilot's endpoint never sends an allowance,
  // which on this side of the fence means "member" - and the pro and the
  // homeowner are frequently the same browser. Writing the pro copilot's
  // silence into the shared key would mark a free homeowner as a member and
  // quietly delete a line of copy they should have seen.
  function rememberPlan(plan: "free" | "trial" | "plus") {
    if (endpoint !== "/api/ask") return;
    setKnownPlan(plan);
    try {
      localStorage.setItem(planKey, plan);
    } catch {
      /* ignore */
    }
  }

  // Save the conversation and notify other open instances on this page. Only on
  // real user turns, so loading a saved chat can't overwrite it.
  function persist(msgs: Msg[]) {
    try {
      localStorage.setItem(storageKey, JSON.stringify(prune(msgs, retention)));
    } catch {
      /* ignore */
    }
    window.dispatchEvent(
      new CustomEvent(SYNC_EVENT, { detail: { key: storageKey } })
    );
  }

  function clearChat() {
    applyMessages([GREETING]);
    try {
      localStorage.removeItem(storageKey);
    } catch {
      /* ignore */
    }
    window.dispatchEvent(
      new CustomEvent(SYNC_EVENT, { detail: { key: storageKey } })
    );
  }

  // Save the new window and apply it right away; other instances pick it up
  // via the sync event.
  function changeRetention(r: Retention) {
    setRetention(r);
    try {
      localStorage.setItem(retentionKey, r);
      const pruned = prune(messages, r);
      applyMessages(pruned.length ? pruned : [GREETING]);
      localStorage.setItem(storageKey, JSON.stringify(pruned));
    } catch {
      /* ignore */
    }
    window.dispatchEvent(
      new CustomEvent(SYNC_EVENT, { detail: { key: storageKey } })
    );
  }

  // How many messages the last scroll ran for, so a growing bubble (same
  // count, more text) can be told apart from a new turn.
  const scrolledAtRef = useRef(messages.length);
  useEffect(() => {
    // A NEW TURN always brings the view to it, exactly as it always has. A
    // bubble that is merely getting longer - a reply streaming in - only
    // follows when the reader is already at the bottom: this effect now fires
    // many times per answer, and dragging someone back down every 60ms while
    // they are scrolled up re-reading something makes the chat unusable.
    const newTurn = messages.length !== scrolledAtRef.current;
    scrolledAtRef.current = messages.length;
    if (!newTurn) {
      const box = scrollRef.current;
      if (
        box &&
        box.scrollHeight - box.scrollTop - box.clientHeight > STICK_TO_BOTTOM_PX
      ) {
        return;
      }
    }
    // Scroll to the newest message, but only within the chat's own scroll
    // container (block: nearest) - never the page.
    endRef.current?.scrollIntoView({ block: "nearest" });
  }, [messages, loading]);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    submit(input.trim());
  }

  // The two things every reply shape carries, read in ONE place so the plain
  // JSON body and the streamed terminal line can never drift on how they are
  // interpreted.
  function readLink(data: any): AskLink | null {
    return data?.link?.href && data?.link?.label
      ? { href: String(data.link.href), label: String(data.link.label) }
      : null;
  }

  // Quiet daily-allowance meter for free users. The server only sends these
  // fields when the viewer is on the free tier, so a member (and the pro
  // copilot, whose endpoint never sends them) sees no count at all. A refused
  // request carries no allowance either, so leave the last known numbers alone
  // rather than blanking the meter on a 429.
  function applyAllowance(data: any, ok: boolean, link: AskLink | null) {
    if (typeof data?.freeLimit === "number") {
      setFreeLimit(data.freeLimit);
      setFreeLeft(
        typeof data.freeRemaining === "number" ? data.freeRemaining : null
      );
      // An over-limit reply (the only answer that arrives with a link) has
      // just said this in a bubble, so the bar below stays quiet.
      setLockEcho(data.freeRemaining === 0 && !!link);
      // The server sends the same freeLimit/freeRemaining shape to both free
      // and trialing homeowners (see askTier in src/app/api/ask/route.ts);
      // askTier is the only field that tells them apart, so it decides which
      // plan gets remembered rather than the two both landing on "free".
      rememberPlan(data.askTier === "trialing" ? "trial" : "free");
    } else if (ok) {
      setFreeLeft(null);
      setFreeLimit(null);
      // No allowance on a successful answer means a member (or the pro
      // copilot, whose endpoint never sends one). Remembered so the free
      // hint under the composer never greets a paying member with a pitch
      // for something they already bought.
      rememberPlan("plus");
    }
  }

  /**
   * Read a streamed answer into ONE assistant bubble that fills in as it
   * arrives. See src/lib/askStream.ts for the line format.
   *
   * `base` is the conversation including the question just asked; the bubble
   * is appended to it and rewritten in place, so however many deltas arrive,
   * the reply is a single message and never a second one.
   *
   * Nothing here is persisted until the terminal line lands. A half-written
   * answer saved to localStorage would come back after a reload looking like
   * a finished one, and the reader would have no way to tell.
   */
  async function consumeStream(
    body: ReadableStream<Uint8Array>,
    base: Msg[],
    question: string
  ) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    // One timestamp for the whole reply, so re-rendering the bubble never
    // moves it inside the retention window.
    const ts = Date.now();
    let buffer = "";
    let streamed = "";
    let settled = false;

    const withContent = (
      content: string,
      link?: AskLink | null,
      partial?: boolean
    ): Msg[] => [
      ...base,
      {
        role: "assistant",
        content,
        ts,
        ...(link ? { link } : {}),
        ...(partial ? { partial: true } : {}),
      },
    ];
    // The empty placeholder goes up immediately: the bubble appearing IS the
    // signal that the answer has started.
    applyMessages(withContent(""));

    // Repaint at most every STREAM_PAINT_MS. Trailing edge, so the last delta
    // before a pause still lands even if nothing follows it for a while.
    let paintTimer: ReturnType<typeof setTimeout> | null = null;
    const paint = () => {
      if (paintTimer) {
        clearTimeout(paintTimer);
        paintTimer = null;
      }
      applyMessages(withContent(streamed));
    };
    const schedulePaint = () => {
      if (paintTimer) return;
      paintTimer = setTimeout(paint, STREAM_PAINT_MS);
    };

    try {
      while (!settled) {
        // The IDLE budget, not a whole-request one: a long answer is allowed
        // to take as long as it takes, silence is not. See readWithTimeout.
        const { done, value } = await readWithTimeout(
          reader,
          STREAM_IDLE_TIMEOUT_MS
        );
        if (done) break;
        const chunk = parseNdjsonChunk(
          buffer,
          decoder.decode(value, { stream: true })
        );
        buffer = chunk.rest;
        for (const line of chunk.lines) {
          let data: any = null;
          try {
            data = JSON.parse(line);
          } catch {
            continue; // a line we can't read is not worth failing the answer
          }
          if (typeof data?.delta === "string") {
            streamed += data.delta;
            schedulePaint();
            continue;
          }
          if (data?.done) {
            const link = readLink(data);
            if (link) setLockLink(link);
            applyAllowance(data, true, link);
            // The server's `answer` is authoritative over the deltas stitched
            // together here: it is the same text, and on a failure part-way
            // through it is the failure line instead.
            const answer =
              typeof data.answer === "string" && data.answer
                ? data.answer
                : streamed;
            paint(); // cancels any pending repaint before the final write
            const updated = withContent(answer, link);
            applyMessages(updated);
            persist(updated);
            settled = true;
            break;
          }
        }
      }
      // The body ended without a terminal line: the connection dropped
      // part-way through. Handled as a failure below, with whatever text
      // arrived kept.
      if (!settled) throw new Error("The answer ended before it finished.");
    } catch (e) {
      // Keep what arrived if there is anything worth keeping: half an answer
      // the reader has already started reading beats losing it to a "No
      // answer came back" orphan on the next reload. Persist it once, marked
      // partial, as the real assistant turn - the conversation then ends on
      // an assistant message like any other, so the orphan check below (which
      // only fires when the newest message is a user turn) never flags it.
      const salvaged = streamed.trim();
      if (salvaged) {
        const updated = withContent(salvaged, null, true);
        applyMessages(updated);
        persist(updated);
      } else {
        // Nothing worth keeping arrived: same apology the non-streaming path
        // gives, shown on screen but NOT persisted. The user's question stays
        // the newest saved message, so a reload still treats it as
        // unanswered and offers Retry / Delete, and the question goes back in
        // the composer so asking again is one tap rather than typing it all
        // out.
        const updated = withContent(
          isTimeoutError(e)
            ? "That took too long. Try again."
            : "Something went wrong, try again."
        );
        applyMessages(updated);
        setInput(question);
      }
    } finally {
      if (paintTimer) clearTimeout(paintTimer);
      // Losing the idle race does not stop the pending read, and a reader left
      // open holds the connection.
      reader.cancel().catch(() => {});
    }
  }

  // `imageOverride` is only for the retry button below, which re-sends a
  // question whose photo is already in the conversation rather than in the
  // composer. Everything else leaves it off and the pending attachment is used.
  async function submit(
    text: string,
    imageOverride?: { mime: string; data: string } | null
  ) {
    // Hold on to what was sent (and to the conversation as it stood before
    // this turn) so a request the server refuses outright can put the question
    // and its photo straight back in the composer instead of eating them.
    const sentImage = imageOverride ?? pendingImage;
    if ((!text && !sentImage) || loading || sendingRef.current) return;
    // Claim the turn synchronously. `loading` is state, so two events landing
    // in the same tick (Enter and the Send button, a double tap, an option
    // button tapped twice) both read it as false and fire two requests: the
    // reported "message sent twice, no reply". A ref flips immediately.
    sendingRef.current = true;
    // THE REF, not the `messages` closure this handler was built with. Those
    // two are the same 99% of the time and differ in exactly the case that
    // hurts: a storage re-read (the per-user key resolving, another instance
    // on this page saving) landing between render and tap. Appending to the
    // stale copy replays turns that are already in the conversation, which is
    // how one question ends up on screen as two identical bubbles.
    const before = messagesRef.current;
    const userMsg: Msg = {
      role: "user",
      content: text || (sentImage ? "Here's a photo - what is this?" : ""),
      ts: Date.now(),
      ...(sentImage ? { image: sentImage.data, mime: sentImage.mime } : {}),
    };
    const next = [...before, userMsg];
    applyMessages(next);
    persist(next);
    setInput("");
    setPendingImage(null);
    setLoading(true);
    try {
      const res = await fetchWithTimeout(
        endpoint,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          // Drop the leading canned greeting before sending history to the
          // model, then send only the tail the server is going to keep anyway.
          // A month-old conversation on "never" retention is up to 200
          // messages, and uploading the 160 the route immediately slices off
          // is pure cost on a phone connection - worse when some carry photos.
          body: JSON.stringify({
            messages: next
              .filter((m, i) => !(i === 0 && m.role === "assistant"))
              .slice(-MAX_SENT_MESSAGES),
          }),
        },
        // TIME TO HEADERS ONLY. Everything after the headers is guarded by the
        // per-chunk idle budget inside consumeStream, because a streamed
        // answer has no meaningful total duration to cap.
        HEADERS_TIMEOUT_MS
      );

      // A STREAMED ANSWER, or the old single JSON body? Every pre-model
      // refusal (not signed in, out of questions, photo locked, too big) is
      // still a plain JSON reply with its own status code; only an answer that
      // reached the model streams. The content type is the only branch.
      if (
        res.body &&
        (res.headers.get("content-type") ?? "").includes(NDJSON_CONTENT_TYPE)
      ) {
        await consumeStream(res.body, next, text);
        return;
      }

      // Burst (429) and busy (503) replies carry their own plain-English
      // answer, so parse the body whatever the status is and only fall back to
      // a generic line if there is no JSON at all.
      const data = await res.json().catch(() => null);
      const answer: string =
        typeof data?.answer === "string"
          ? data.answer
          : typeof data?.error === "string"
            ? data.error
            : "Something went wrong.";
      const link = readLink(data);
      if (link) setLockLink(link);
      const reply: Msg = {
        role: "assistant",
        content: answer,
        ts: Date.now(),
        ...(link ? { link } : {}),
      };

      // Photo lock: a free account attached a photo. Nothing was asked and
      // nothing was counted, so drop the user turn back into the composer,
      // photo and all, and leave the meter exactly where it was. Also
      // remember the plan as free (a no-op for endpoints other than
      // /api/ask - see rememberPlan) so the attach button carries the Plus
      // tag from here on and this never has to happen again.
      if (data?.locked) {
        const updated: Msg[] = [...before, reply];
        applyMessages(updated);
        persist(updated);
        setInput(text);
        setPendingImage(sentImage);
        setPhotoLocked(true);
        rememberPlan("free");
        return;
      }

      applyAllowance(data, res.ok, link);

      // A rejected request (429/503) never reached the model, so hand the
      // typed question back rather than making them retype it.
      if (!res.ok) setInput(text);

      const updated: Msg[] = [...next, reply];
      applyMessages(updated);
      persist(updated);
    } catch (e) {
      // Timeout gets its own honest message; either way the question goes back
      // in the composer, so retrying is one tap on Send rather than typing it
      // all again.
      const updated: Msg[] = [
        ...next,
        {
          role: "assistant",
          content: isTimeoutError(e)
            ? "That took too long. Try again."
            : "Something went wrong, try again.",
          ts: Date.now(),
        },
      ];
      applyMessages(updated);
      persist(updated);
      setInput(text);
    } finally {
      sendingRef.current = false;
      setLoading(false);
    }
  }
  submitRef.current = submit;

  // Answer questions fired from elsewhere in the app (Learn's "Maintenance
  // basics" cards, the forecast plan button). Every mounted instance listens;
  // the first one to see the event claims it via a flag on the event object
  // (listeners run synchronously in registration order), so when two instances
  // exist (Learn's inline box + the dock) exactly one submits.
  useEffect(() => {
    function onAsk(e: Event) {
      if ((e as any).__hearthHandled) return;
      (e as any).__hearthHandled = true;
      const q = (e as CustomEvent).detail;
      if (typeof q === "string") submitRef.current(q);
    }
    window.addEventListener("hearth:ask-question", onAsk);
    return () => window.removeEventListener("hearth:ask-question", onAsk);
  }, []);

  // Submit a question handed in by the dock when it opened for an event that
  // fired while it was closed. Wait until the per-user storage key and saved
  // conversation have loaded (userReady + a timeout past this commit) so the
  // submit can't clobber the stored history, and guard with a ref so it fires
  // exactly once.
  const initialSentRef = useRef(false);
  const router = useRouter();
  useEffect(() => {
    if (!initialQuestion || !userReady || initialSentRef.current) return;
    initialSentRef.current = true;
    // ALREADY ASKED? If the newest thing in the stored conversation is this
    // exact question, this mount is a reload or a Back with ?q= still on the
    // URL rather than a new request. Answering it a second time costs another
    // paid call and a free question, and posts a duplicate of the bubble
    // already on screen.
    //
    // Read from DISK, not from React state. `userReady` flips in the same
    // commit that changes the storage key, so the effect that re-reads the
    // conversation under the new key has run but its setMessages has not
    // landed: state (and the ref that tracks it) still holds the previous
    // key's list, which is usually empty. Checking that copy answers "no, go
    // ahead and ask" for a question sitting right there in the saved history,
    // which is precisely the duplicate this guard exists to stop.
    const stored = readStoredMessages(
      storageKey,
      loadRetention(retentionKey)
    );
    const already =
      alreadyAsked(stored, initialQuestion) ||
      alreadyAsked(messagesRef.current, initialQuestion);
    const t = already
      ? null
      : setTimeout(() => submitRef.current(initialQuestion), 0);
    // Drop the query either way: it has now been either answered or
    // recognized as already answered, and leaving it on the URL is what makes
    // the next reload ask again.
    if (replaceUrlAfterInitial) router.replace(replaceUrlAfterInitial);
    return () => {
      if (t) clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialQuestion, userReady, replaceUrlAfterInitial]);

  // A QUESTION THAT NEVER GOT AN ANSWER. Reloading or closing the tab while a
  // reply is in flight leaves the user turn in the saved conversation with
  // nothing after it: no answer, no error, and nothing on the next visit that
  // knows the request died with the old page. These two put it back in the
  // owner's hands.
  function retryLastQuestion() {
    const msgs = messagesRef.current;
    const last = msgs[msgs.length - 1];
    if (!last || last.role !== "user" || loading || sendingRef.current) return;
    // Take the orphan turn out first, then send it again: submit() appends its
    // own copy, so leaving this one in place would put the same question on
    // screen twice. Its photo, if it had one, rides along.
    const trimmed = msgs.slice(0, -1);
    applyMessages(trimmed);
    persist(trimmed);
    submit(
      last.content,
      last.image ? { mime: last.mime ?? "image/jpeg", data: last.image } : null
    );
  }

  function deleteLastQuestion() {
    const msgs = messagesRef.current;
    const last = msgs[msgs.length - 1];
    if (!last || last.role !== "user" || loading || sendingRef.current) return;
    const trimmed = msgs.slice(0, -1);
    applyMessages(trimmed.length ? trimmed : [GREETING]);
    persist(trimmed.length ? trimmed : [GREETING]);
  }

  async function onPickImage(file: File) {
    setImageError(false);
    try {
      setPendingImage(await downscaleImage(file));
    } catch {
      // Couldn't read/shrink the image (corrupt, unsupported, too big) - tell
      // the homeowner instead of silently dropping it.
      setImageError(true);
    }
  }

  // Out of free questions for today: the input row becomes a locked bar, and
  // anything that would fire another question stands down with it. Only ever
  // true for free homeowners, since only they get an allowance from the
  // server.
  const atFreeLimit = isFreeLocked(freeLeft, freeLimit);
  const plusLink = lockLink ?? ASK_PLUS_LINK;

  // A free homeowner on the /api/ask chat: say so on the button itself,
  // before the tap, instead of letting them pick a photo only to be refused
  // after the upload. "unknown" (first turn, nothing remembered yet) keeps
  // today's behavior - open the picker - so a member is never blocked on a
  // guess; the pro copilot never gates photos, so this stays off there too.
  // A trial member keeps photos (that is what the trial is for, see
  // src/app/api/ask/route.ts), so only "free" gates the button.
  const photoGate = endpoint === "/api/ask" && knownPlan === "free";

  // The conversation ends on a question with no reply, and nothing is in
  // flight: the request it belonged to died with a previous page load. The
  // last bubble gets a retry / delete row instead of sitting there forever.
  const unanswered = !loading && isUnanswered(messages);

  // The waiting pill belongs only in the gap BEFORE the first words arrive.
  // Once the reply bubble exists and is filling in, the text is its own
  // progress indicator and a "Thinking…" pill underneath it reads as a second,
  // stuck request. Same test either way: is the newest message still the
  // question?
  const waiting = loading && isUnanswered(messages);

  // Has this conversation had a turn yet? Drives the free-allowance hint,
  // which is a "before you start" line and stands down the moment the meter
  // has real numbers to show.
  const hasAsked = messages.some((m) => m.role === "user");
  // Quiet line under an empty composer telling a free homeowner what they get.
  // Homeowner chat only (the pro copilot has no daily allowance and talks to a
  // different endpoint), only until the first answer arrives (at which point
  // the meter above takes over and says something truer: the actual count
  // left today), and only for "free" - a trial member already gets 8 a day
  // and photos, and this hint's pitch for Plus makes no sense to someone
  // already on the trial. The numbers match ASK_DAILY_FREE and ASK_DAILY_PLUS
  // in src/lib/aiUsage.ts, which is server-only and cannot be imported here.
  const showFreeHint =
    endpoint === "/api/ask" &&
    !hasAsked &&
    !loading &&
    !atFreeLimit &&
    freeLimit === null &&
    knownPlan === "free";

  // One message bubble (text + optional photo + action buttons).
  function bubble(m: Msg, i: number, isLast = false) {
    // This bubble is the reply currently filling in. Its markdown is caught
    // mid-token ("**Getting ready for winter" with no closing "**" yet), which
    // the renderer would otherwise show as raw asterisks for a paint or two -
    // see closeOpenMarks in Markdown.tsx. Same renderer as a finished reply,
    // just told the text is not finished.
    const streaming = isLast && loading && m.role === "assistant";
    const parsed =
      m.role === "assistant"
        ? parseAssistant(m.content)
        : {
            text: m.content,
            job: null,
            issue: null,
            reminder: null,
            options: null as string[] | null,
          };
    return (
      <div
        key={i}
        className={`flex flex-col ${
          m.role === "user" ? "items-end" : "items-start"
        }`}
      >
        {m.image && (
          <button
            type="button"
            onClick={() =>
              setLightboxSrc(`data:${m.mime ?? "image/jpeg"};base64,${m.image}`)
            }
            className="mb-1 block cursor-zoom-in"
            aria-label="View attached photo full size"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={`data:${m.mime ?? "image/jpeg"};base64,${m.image}`}
              alt="attached"
              className="max-h-48 rounded-lg border border-stone-200 object-cover dark:border-white/10"
            />
          </button>
        )}
        {parsed.text && (
          <span
            className={`block max-w-[85%] break-words rounded-lg px-3 py-1.5 text-sm ${
              m.role === "user"
                ? "whitespace-pre-wrap bg-bark-600 text-white"
                : "border border-stone-200 bg-white text-stone-700 dark:border-white/10 dark:bg-stone-700 dark:text-stone-200"
            }`}
          >
            {m.role === "assistant" ? (
              <Markdown text={parsed.text} partial={streaming} />
            ) : (
              parsed.text
            )}
          </span>
        )}
        {/* A question whose answer never arrived (the page was reloaded or
            closed mid-request). Say so plainly and give them the two things
            they'd want: ask it again, or get rid of it. */}
        {m.role === "user" && isLast && unanswered && (
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <span className="text-xs text-stone-500 dark:text-stone-400">
              That took too long. Try asking again.
            </span>
            <button
              type="button"
              onClick={retryLastQuestion}
              disabled={atFreeLimit}
              className="rounded-full border border-bark-500 px-3 py-1 text-xs font-medium text-bark-700 hover:bg-bark-50 disabled:opacity-50 max-sm:inline-flex max-sm:min-h-11 max-sm:items-center max-sm:px-4 dark:border-bark-700 dark:text-stone-300 dark:hover:bg-stone-700"
            >
              Retry
            </button>
            <button
              type="button"
              onClick={deleteLastQuestion}
              className="px-1 py-1 text-xs text-stone-500 hover:text-red-600 max-sm:inline-flex max-sm:min-h-11 max-sm:items-center max-sm:px-3 dark:text-stone-400 dark:hover:text-red-400"
            >
              Delete
            </button>
          </div>
        )}
        {/* The locked bar under the composer carries this exact link when the
            reply that lands is the over-limit message, so the bubble drops its
            own copy rather than stacking two identical calls to action. */}
        {m.link && !(isLast && atFreeLimit && lockEcho) && (
          <Link
            href={m.link.href}
            className="mt-1 text-sm font-medium text-bark-700 hover:underline dark:text-stone-300"
          >
            {m.link.label} &rarr;
          </Link>
        )}
        {/* Not while this bubble is still being written: a POSTJOB block whose
            JSON has closed but whose reply has not would pop a "Get 3 free
            quotes" card up mid-sentence, on an answer that may still change.
            On the last message during a load there is nothing to show anyway
            (a user turn has no actions), so this costs nothing elsewhere. */}
        {!(isLast && loading) && (
          <MessageActions
            job={parsed.job}
            issue={parsed.issue}
            reminder={parsed.reminder}
          />
        )}
        {/* Tappable quick-reply options, shown on the latest reply so the
            homeowner can drill down without typing. */}
        {parsed.options && isLast && !loading && (
          <div className="mt-2 flex flex-wrap gap-2">
            {parsed.options
              // Drop any "Other" the model added; we always add our own below.
              .filter((opt) => !/^(other|something else)\b/i.test(opt.trim()))
              .map((opt) => (
                <button
                  key={opt}
                  type="button"
                  onClick={() => submit(opt)}
                  disabled={loading || atFreeLimit || !userReady}
                  className="rounded-full border border-bark-500 bg-white px-3 py-2 text-xs font-medium text-bark-700 hover:bg-bark-50 disabled:opacity-50 dark:border-bark-700 dark:bg-stone-800 dark:text-stone-300 dark:hover:bg-stone-700"
                >
                  {opt}
                </button>
              ))}
            {/* Always let them type their own answer instead of picking. */}
            <button
              type="button"
              onClick={() => inputRef.current?.focus()}
              className="rounded-full border border-stone-200 bg-white px-3 py-2 text-xs font-medium text-stone-500 hover:bg-stone-50 dark:border-white/10 dark:bg-stone-700 dark:text-stone-400 dark:hover:bg-stone-600"
            >
              Other (type)
            </button>
          </div>
        )}
      </div>
    );
  }

  // Retention control: which of the compact card and dock views renders it
  // depends on `fill` (see below) - kept as one element so the two views
  // can't drift on wording or options.
  const retentionControl = (
    <p className="text-xs text-stone-500 dark:text-stone-400">
      {retention === "never" ? "Chats clear: " : "Chats clear after "}
      <select
        value={retention}
        onChange={(e) => changeRetention(e.target.value as Retention)}
        aria-label="How long chats are kept"
        // min-h-10 + wider padding gives this a real 40px tap target on a
        // phone, where it was 59x28 and sat right next to Clear. Both are
        // reset at sm so the desktop row renders exactly as it did before.
        className="min-h-10 cursor-pointer appearance-none rounded border-0 bg-transparent px-2 py-1.5 text-xs text-stone-500 underline decoration-dotted hover:text-stone-600 focus:outline-none dark:text-stone-400 dark:hover:text-stone-300 sm:min-h-0 sm:px-1"
      >
        <option value="24h">24 hours</option>
        <option value="2w">2 weeks</option>
        <option value="1m">1 month</option>
        <option value="never">never</option>
      </select>
    </p>
  );

  // Shared between the plain attach control and the gated one below, so the
  // two can never drift on which icon they show.
  const photoIcon = (
    <svg
      viewBox="0 0 24 24"
      className="h-5 w-5"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="8.5" cy="8.5" r="1.5" />
      <path d="M21 15l-5-5L5 21" />
    </svg>
  );

  // The input row: photo attach + text + send. Shared by both views.
  const composer = (
    <div>
      {pendingImage && (
        <div className="mb-2 inline-flex items-center gap-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={`data:${pendingImage.mime};base64,${pendingImage.data}`}
            alt="attachment preview"
            className="h-12 w-12 rounded object-cover"
          />
          <button
            type="button"
            onClick={() => setPendingImage(null)}
            className="text-xs text-stone-500 hover:text-red-600 dark:text-stone-400 dark:hover:text-red-400"
          >
            Remove
          </button>
        </div>
      )}
      {imageError && (
        <p className="mb-2 text-xs text-red-600 dark:text-red-400">
          Couldn&apos;t attach that image. Try a different photo.
        </p>
      )}
      {/* The camera button stays enabled for everyone - only the server can
          actually refuse a photo. This is the one line that explains why:
          reached either by the Plus-gated button above (known free, before
          any upload) or by the server's own locked reply (unknown plan,
          after one). */}
      {photoLocked && !atFreeLimit && (
        <p className="mb-2 text-xs text-stone-500 dark:text-stone-400">
          Photos need Hearth Plus.{" "}
          <Link
            href={plusLink.href}
            className="font-medium text-bark-700 underline dark:text-stone-300"
          >
            {plusLink.label}
          </Link>
        </p>
      )}
      {atFreeLimit ? (
        <div className="flex flex-col items-start gap-2 rounded-lg border border-stone-200 bg-stone-50 px-3 py-2 dark:border-white/10 dark:bg-stone-700/40 sm:flex-row sm:items-center">
          {/* Stacked on a phone: side by side, the sentence was squeezed into a
              four-line column next to the button. */}
          {!lockEcho && (
            <p className="min-w-0 flex-1 text-xs text-stone-600 dark:text-stone-300">
              {freeLockText(freeLimit)}
            </p>
          )}
          <Link
            href={plusLink.href}
            className="btn-primary shrink-0 px-3 py-1.5 text-xs"
          >
            {plusLink.label}
          </Link>
        </div>
      ) : (
        <form onSubmit={send} className="flex gap-2">
          {photoGate ? (
            // Free plan, known before the tap: say so on the button instead
            // of opening the picker and refusing the photo after the upload.
            // A real, enabled button that explains - never a disabled one
            // with no reason given.
            <button
              type="button"
              aria-label="Attach a photo, requires Hearth Plus"
              title="Attach a photo (Hearth Plus)"
              onClick={() => setPhotoLocked(true)}
              className="flex items-center gap-1 rounded-lg border border-stone-200 px-2 text-stone-500 hover:border-bark-500 hover:text-bark-700 dark:border-white/10 dark:text-stone-400 dark:hover:text-stone-300"
            >
              {photoIcon}
              {/* Matches the dashboard's Plus chip (see ToolsMenu.tsx). The
                  button's aria-label already says "requires Hearth Plus", so
                  this is aria-hidden rather than repeating it for a reader. */}
              <span
                aria-hidden="true"
                className="rounded bg-bark-100 px-1.5 text-[11px] font-medium text-bark-700 dark:bg-bark-700 dark:text-stone-300"
              >
                Plus
              </span>
            </button>
          ) : (
            <label
              title="Attach a photo"
              className="flex cursor-pointer items-center rounded-lg border border-stone-200 px-2 text-stone-500 hover:border-bark-500 hover:text-bark-700 dark:border-white/10 dark:text-stone-400 dark:hover:text-stone-300"
            >
              {photoIcon}
              <span className="sr-only">Attach a photo</span>
              <input
                type="file"
                accept="image/*"
                className="hidden"
                disabled={loading}
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  if (f) await onPickImage(f);
                  e.target.value = "";
                }}
              />
            </label>
          )}
          <VoiceButton
            disabled={loading}
            onText={(t) =>
              setInput((prev) => (prev ? `${prev} ${t}` : t))
            }
          />
          <input
            ref={inputRef}
            className="input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            // Short enough to fit a 390px phone: the old "Ask, speak, or attach
            // a photo…" was clipped mid-word there, and the mic and camera
            // buttons sitting right next to the field already say the rest.
            placeholder="Ask anything"
          />
          {/* `!userReady` is a sub-second gate on a freshly loaded page: until
              the signed-in user resolves, this chat is still reading the
              LEGACY storage key and does not yet know which account's saved
              conversation it is appending to. A send inside that window built
              its turn on an empty list and then wrote that over the real
              history under the per-user key, silently wiping the
              conversation. Nobody types and sends inside 400ms of a page
              load, so this costs nothing and closes the hole. */}
          <button className="btn-primary" disabled={loading || !userReady}>
            {loading && <InlineSpinner />}
            {fill ? "Send" : "Ask"}
          </button>
        </form>
      )}
      {/* One shared AI label across every generated surface, carrying the
          per-surface caveat as its `detail` so this is a single line of fine
          print rather than two stacked paragraphs. */}
      {/* Quiet allowance meter, free homeowners only (they are the only ones
          the server sends a limit to). With three questions a day every one of
          them counts, so it shows from the first reply on; at zero the locked
          bar above says it instead. */}
      {shouldShowMeter(freeLeft, freeLimit) && (
        <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
          {knownPlan === "trial"
            ? // Trial-aware copy: same numbers as meterLabel, but naming the
              // trial rather than reading as a permanent free allowance.
              `${freeLeft} of ${freeLimit} question${
                freeLimit === 1 ? "" : "s"
              } left today on your trial`
            : meterLabel(freeLeft as number, freeLimit as number)}
        </p>
      )}
      {/* Before the first question there is no meter to show, and finding out
          the allowance by running into it is a bad way to learn it. One quiet
          line, then it hands over to the meter for good. */}
      {showFreeHint && (
        <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
          3 free questions a day. Plus gives you 15 and photo answers.
        </p>
      )}
      <AiNotice detail={disclaimer} size="xxs" className="mt-1" />
      {/* In the dock (fill), this control moves to the header instead - */}
      {/* down here it sat below the whole conversation, off-screen until */}
      {/* scrolled to. The compact card has no such scroll, so it stays put. */}
      {!fill && <div className="mt-0.5">{retentionControl}</div>}
    </div>
  );

  // Learn's assistant: a bounded, SCROLLABLE conversation (follow-ups stay
  // visible), with starter chips and a clear button at the bottom.
  if (!fill) {
    // Drop the canned greeting here - the suggestions are the starting point.
    const displayed = messages.filter(
      (m, i) => !(i === 0 && m.role === "assistant")
    );
    const hasConversation = displayed.length > 0;
    return (
      <div className="card border-bark-100 bg-bark-50 dark:border-bark-700 dark:bg-bark-700/20">
        <p className="text-sm font-semibold text-bark-700 dark:text-stone-300">{headingTitle}</p>
        <p className="text-xs text-bark-700 dark:text-stone-300">{headingSubtitle}</p>

        {(hasConversation || loading) && (
          <div
            ref={scrollRef}
            className="mt-3 max-h-80 space-y-2 overflow-y-auto rounded-lg border border-stone-200 bg-white p-3 dark:border-white/10 dark:bg-stone-800"
          >
            {displayed.map((m, i) => bubble(m, i, i === displayed.length - 1))}
            {waiting && (
              <div className="flex justify-start">
                <WaitingPill />
              </div>
            )}
            <div ref={endRef} />
          </div>
        )}

        {suggestions && suggestions.length > 0 && !hasConversation && (
          <div className="mt-3 flex flex-wrap gap-2">
            {suggestions.map((q) => (
              <button
                key={q}
                type="button"
                onClick={() => submit(q)}
                disabled={loading || atFreeLimit || !userReady}
                className="rounded-full border border-bark-100 bg-white px-3 py-1 text-xs text-bark-700 hover:border-bark-500 disabled:opacity-50 max-sm:inline-flex max-sm:min-h-11 max-sm:items-center max-sm:px-4 dark:border-bark-700 dark:bg-stone-800 dark:text-stone-300"
              >
                {q}
              </button>
            ))}
          </div>
        )}

        <div className="mt-3">{composer}</div>

        {hasConversation && (
          <div className="mt-2 text-center">
            <button
              type="button"
              onClick={clearChat}
              className="text-sm font-medium text-stone-500 hover:text-red-600 dark:text-stone-400 dark:hover:text-red-400"
            >
              Clear conversation
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-start justify-between gap-2 pb-2">
        <div>
          <p className="text-sm font-semibold text-bark-700 dark:text-stone-300">{headingTitle}</p>
          <p className="text-xs text-bark-700 dark:text-stone-300">{headingSubtitle}</p>
        </div>
        {/* Surfaced here (next to Clear) instead of only below the input: */}
        {/* the dock is short and scrollable, and buried at the bottom it */}
        {/* was easy to never see. */}
        <div className="flex shrink-0 flex-col items-end gap-1">
          {retentionControl}
          <button
            type="button"
            onClick={clearChat}
            // Same treatment as the retention control above it: a 30x16 hit
            // area on a phone, one gesture away from wiping the conversation,
            // is too easy to hit by accident and too hard to hit on purpose.
            // A button centers its own label, so min-h alone does it. Reset at
            // sm so the desktop dock header is unchanged.
            className="min-h-10 px-2 text-xs text-stone-500 hover:text-stone-700 dark:text-stone-400 dark:hover:text-stone-300 sm:min-h-0 sm:px-0"
          >
            Clear
          </button>
        </div>
      </div>

      <div ref={scrollRef} className="flex-1 space-y-2 overflow-y-auto py-2">
        {messages.map((m, i) => bubble(m, i, i === messages.length - 1))}
        {waiting && (
          <div className="flex justify-start">
            <WaitingPill />
          </div>
        )}
        <div ref={endRef} />
      </div>

      <div className="mt-2">{composer}</div>

      <Lightbox
        src={lightboxSrc}
        alt="Attached photo"
        onClose={() => setLightboxSrc(null)}
      />
    </div>
  );
}
