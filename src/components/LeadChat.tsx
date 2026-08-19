"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Image as ImageIcon } from "lucide-react";
import { FilePreviewThumb } from "@/components/FilePreview";
import Lightbox from "@/components/Lightbox";
import InlineSpinner from "@/components/InlineSpinner";
import { createClient } from "@/lib/supabase/client";
import { censor } from "@/lib/censor";
import { extractQuote, formatUSD, dollarsToCents, formatUSDCents } from "@/lib/quotes";
import { imgSrc } from "@/lib/storage";
import type { QuoteLineItem, InvoiceLineItem } from "@/lib/database.types";

type Msg = {
  id: string;
  sender_role: string;
  body: string;
  created_at: string;
};

// A structured quote a pro composed and sent in this thread (lead_quotes).
type Quote = {
  id: string;
  contractor_id: string;
  total_cents: number;
  line_items: QuoteLineItem[];
  note: string | null;
  status: "sent" | "accepted" | "declined" | "withdrawn";
  created_at: string;
};

// An invoice a contractor sent in this thread (invoices).
type Invoice = {
  id: string;
  contractor_id: string;
  line_items: InvoiceLineItem[];
  subtotal_cents: number;
  total_cents: number;
  status: "sent" | "signed" | "void";
  signed_at: string | null;
  signed_by: string | null;
  signature_method: "in_app" | "in_person" | null;
  created_at: string;
};

// A quote, an invoice, or a message, merged into one feed and shown in
// created_at order.
type FeedItem =
  | { kind: "message"; created_at: string; data: Msg }
  | { kind: "quote"; created_at: string; data: Quote }
  | { kind: "invoice"; created_at: string; data: Invoice };

// The companion plain message a sent quote posts alongside itself (see
// sendQuoteAction). Its own rich card renders right next to it, so the old
// regex "Quoted $X" badge would just be noise here and is skipped for it.
const isQuoteCompanionBody = (body: string) => body.startsWith("Sent a quote:");

// Same idea as isQuoteCompanionBody, for the companion message a sent
// invoice posts alongside itself (see createInvoiceAction).
const isInvoiceCompanionBody = (body: string) => body.startsWith("Sent an invoice:");

// What a chat photo may actually be, mirroring PhotoUpload.tsx and the
// home-photos bucket's own allowed_mime_types (migration 0079). Both lists
// deliberately exclude image/svg+xml; see sendImage below.
const CHAT_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const MAX_CHAT_IMAGE_BYTES = 15 * 1024 * 1024; // 15MB, same as PhotoUpload

// System-message markers used to open/close a thread. They're stored as normal
// rows (sender_role = "system") so both sides see them with no schema change.
// A close marker starts with CLOSE_PREFIX and embeds who closed it + the reason.
const CLOSE_PREFIX = "Conversation closed";
const LEGACY_CLOSE = "Chat closed by the contractor.";
const REOPEN_BODY = "Conversation reopened.";
const isCloseMarker = (body: string) =>
  body.startsWith(CLOSE_PREFIX) || body === LEGACY_CLOSE;

// Quick reactions offered in the message menu.
const EMOJIS = ["👍", "❤️", "😂", "😮", "😢", "👎"];

// Client-side guard against an unbounded chat-flood insert (security audit
// finding #9): generous for any real message, but caps what a scripted/looped
// sender can push through a single insert. rate_limit_hit is service_role-only
// (see migration 0068), so it can't be called from this client component; the
// matching server-side length floor is the `messages_body_length` CHECK
// constraint added in migration 0086. A true per-user SEND RATE limit still
// needs this insert moved behind a server action - see that migration's header
// comment for the follow-up this defers.
const MAX_MESSAGE_LENGTH = 4000;

// Photo messages reuse the same text `body` column: an uploaded image is stored
// as "[img]<public-url>" so both sides can render it without a schema change.
const IMG_PREFIX = "[img]";
const imageUrl = (b: string) => b.slice(IMG_PREFIX.length);

// A photo message is only TRUSTED as an image if its URL points at our own
// Supabase storage bucket. Without this, a user could type a message like
// "[img]javascript:alert(document.cookie)" or "[img]https://tracker/x.gif" and
// have it rendered to the other party as a clickable link / auto-loading image
// in their session (stored XSS + IP/phishing). Anything that doesn't match
// falls through to plain, escaped-text rendering.
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const isSafeStorageUrl = (u: string) =>
  SUPABASE_URL !== "" &&
  u.startsWith(`${SUPABASE_URL}/storage/v1/object/`);
const isImageBody = (b: string) =>
  b.startsWith(IMG_PREFIX) && isSafeStorageUrl(imageUrl(b));

// Messaging thread for a lead. Both the homeowner and the assigned contractor
// see the same thread (RLS enforces only those two can read/post). New
// messages, quotes, and invoices arrive over the realtime channel below; the
// poll is a slower safety net for that (dropped/missed realtime events) plus
// the only refresh path for reactions and read receipts, which aren't on the
// realtime channel. Coming back to the tab (visibilitychange) also re-loads
// immediately, so "Seen" and reactions still catch up fast in the common case.
//
// `embedded` renders the thread always-open and full-height (no toggle button),
// for use as the right-hand pane of the /pro/chats inbox.
export default function LeadChat({
  leadId,
  role,
  embedded = false,
  title,
  subtitle,
  jobTitle,
  contractorName,
  sendQuoteAction,
  withdrawQuoteAction,
  acceptQuoteAction,
  declineQuoteAction,
  createInvoiceAction,
  voidInvoiceAction,
  signInvoiceAction,
}: {
  leadId: string;
  role: "homeowner" | "contractor";
  embedded?: boolean;
  title?: string;
  subtitle?: string;
  // Short job label (e.g. "Plumbing"), used to prefill the first invoice line
  // item when a contractor opens the invoice composer.
  jobTitle?: string;
  // The pro's company name, used on every quote/invoice card ("Quote from
  // {company}") regardless of which side is viewing.
  contractorName?: string;
  sendQuoteAction?: (formData: FormData) => Promise<void>;
  withdrawQuoteAction?: (formData: FormData) => Promise<void>;
  acceptQuoteAction?: (formData: FormData) => Promise<void>;
  declineQuoteAction?: (formData: FormData) => Promise<void>;
  createInvoiceAction?: (formData: FormData) => Promise<void>;
  voidInvoiceAction?: (formData: FormData) => Promise<void>;
  signInvoiceAction?: (formData: FormData) => Promise<void>;
}) {
  const supabase = createClient();
  const router = useRouter();
  const [open, setOpen] = useState(embedded);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [quotes, setQuotes] = useState<Quote[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [showQuoteForm, setShowQuoteForm] = useState(false);
  const [quoteRows, setQuoteRows] = useState<
    { label: string; amount: string }[]
  >([{ label: "", amount: "" }]);
  const [quoteNote, setQuoteNote] = useState("");
  const [quoteBusy, setQuoteBusy] = useState(false);
  const [confirmWithdrawId, setConfirmWithdrawId] = useState<string | null>(
    null
  );
  const [showInvoiceForm, setShowInvoiceForm] = useState(false);
  const [invoiceRows, setInvoiceRows] = useState<
    { description: string; amount: string }[]
  >([{ description: "", amount: "" }]);
  const [invoiceBusy, setInvoiceBusy] = useState(false);
  const [confirmVoidId, setConfirmVoidId] = useState<string | null>(null);
  const [filtered, setFiltered] = useState(false);
  const [tooLong, setTooLong] = useState(false);
  const [reporting, setReporting] = useState(false);
  const [reportReason, setReportReason] = useState("");
  const [reported, setReported] = useState(false);
  const [confirmingClose, setConfirmingClose] = useState(false);
  // True the instant confirmClose runs, before the close system message has
  // round-tripped through load()/router.refresh(). Keeps the header showing
  // a plain "Conversation closed" line instead of falling back to "Finish
  // conversation" for the beat between the Yes/No confirm clearing and the
  // real `closed` state landing. Reset on reopen so a later close in the
  // same session shows its own line again.
  const [justClosed, setJustClosed] = useState(false);
  const [reactions, setReactions] = useState<
    Record<string, { emoji: string; user_id: string | null }[]>
  >({});
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmUnsendId, setConfirmUnsendId] = useState<string | null>(null);
  // Message whose action bar was opened by tap. Touch screens have no hover,
  // so on small screens a "…" button toggles the bar instead.
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [replyingTo, setReplyingTo] = useState<{ id: string; body: string } | null>(
    null
  );
  const [otherReadAt, setOtherReadAt] = useState<string | null>(null);
  const [failed, setFailed] = useState<{ tempId: string; body: string }[]>([]);
  // The photo just picked from the attach button, shown as a small preview
  // while it uploads (sendImage posts it as a message immediately - there's
  // no separate "attach then send" step to preview it in otherwise).
  const [pendingPhoto, setPendingPhoto] = useState<File | null>(null);
  // The full-size URL of a shared photo currently open in the Lightbox, or
  // null when closed. One shared piece of state for the whole thread, since
  // only one photo bubble can be enlarged at a time.
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const uidRef = useRef<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  async function load() {
    // If the fetch itself failed (network blip, Supabase down), keep whatever
    // is on screen instead of wiping the thread to empty; the realtime
    // subscription and the poll below both re-run load(), so the thread
    // heals itself once the connection is back.
    const { data, error: msgErr } = await supabase
      .from("messages")
      .select("id, sender_role, body, created_at")
      .eq("lead_id", leadId)
      .order("created_at", { ascending: true });
    if (!msgErr) setMessages(data ?? []);

    // Structured quotes sent in this thread. If the table isn't set up yet,
    // keep whatever's on screen (optimistic) instead of wiping it.
    const { data: quoteData, error: quoteErr } = await supabase
      .from("lead_quotes")
      .select("id, contractor_id, total_cents, line_items, note, status, created_at")
      .eq("lead_id", leadId)
      .order("created_at", { ascending: true });
    if (!quoteErr) setQuotes((quoteData ?? []) as unknown as Quote[]);

    // Invoices sent in this thread. Same "keep optimistic state if the table
    // isn't set up yet" behavior as the quotes fetch above.
    const { data: invoiceData, error: invoiceErr } = await supabase
      .from("invoices")
      .select(
        "id, contractor_id, line_items, subtotal_cents, total_cents, status, signed_at, signed_by, signature_method, created_at"
      )
      .eq("lead_id", leadId)
      .order("created_at", { ascending: true });
    if (!invoiceErr) setInvoices((invoiceData ?? []) as unknown as Invoice[]);

    // Reactions. If the table isn't set up yet, keep whatever's on screen
    // (optimistic) instead of wiping it.
    const { data: reacts, error: reactErr } = await supabase
      .from("message_reactions")
      .select("message_id, emoji, user_id")
      .eq("lead_id", leadId);
    if (!reactErr) {
      const map: Record<string, { emoji: string; user_id: string | null }[]> = {};
      for (const r of reacts ?? []) {
        (map[r.message_id] ??= []).push({ emoji: r.emoji, user_id: r.user_id });
      }
      setReactions(map);
    }

    // Read receipts: mark myself as having read this thread, then look up the
    // other side's last-read time. No-op if the lead_reads table isn't set up.
    // Skipped while the tab is hidden: this poll also runs from a background
    // tab, and advancing the receipt there shows the other side "Seen" for
    // messages nobody has looked at. The visibilitychange listener below
    // re-runs load() on return, so coming back marks the thread read promptly.
    if (typeof document === "undefined" || !document.hidden) {
      await supabase.from("lead_reads").upsert(
        { lead_id: leadId, role, read_at: new Date().toISOString() },
        { onConflict: "lead_id,role" }
      );
    }
    const { data: reads } = await supabase
      .from("lead_reads")
      .select("role, read_at")
      .eq("lead_id", leadId);
    const other = (reads ?? []).find((r: any) => r.role !== role);
    setOtherReadAt(other?.read_at ?? null);
  }

  useEffect(() => {
    if (!open) return;
    supabase.auth
      .getUser()
      .then(({ data }) => (uidRef.current = data.user?.id ?? null));
    load();

    // Realtime: push new messages, quote changes, and invoice changes
    // instantly (requires Realtime enabled on those tables in Supabase). It
    // does not cover message_reactions or lead_reads (read receipts), so the
    // poll below still does real work for those, just on a slower cadence.
    // The topic is unique per mount, not just per lead: supabase-js returns
    // the SAME already-subscribed channel instance for a repeated topic, and
    // a second .on() on an already-subscribed channel throws. That collision
    // is reachable via React dev StrictMode's mount-cleanup-remount (the
    // cleanup's removeChannel is async, so the remount can win the race), so
    // a random suffix isolates every instance instead of sharing one topic.
    let channel: ReturnType<typeof supabase.channel> | null = null;
    try {
      const topic = `lead-${leadId}-` + Math.random().toString(36).slice(2);
      channel = supabase
        .channel(topic)
        .on(
          "postgres_changes",
          {
            event: "INSERT",
            schema: "public",
            table: "messages",
            filter: `lead_id=eq.${leadId}`,
          },
          () => load()
        )
        .on(
          "postgres_changes",
          {
            event: "*",
            schema: "public",
            table: "lead_quotes",
            filter: `lead_id=eq.${leadId}`,
          },
          () => load()
        )
        .on(
          "postgres_changes",
          {
            event: "*",
            schema: "public",
            table: "invoices",
            filter: `lead_id=eq.${leadId}`,
          },
          () => load()
        )
        .subscribe();
    } catch {
      // Realtime is strictly best-effort: the poll/visibilitychange paths
      // below keep the thread working on their own, so a subscribe failure
      // here must never crash the chat.
      console.warn("LeadChat: realtime subscription failed, falling back to polling");
    }

    const t = setInterval(load, 45000);
    // Coming back to the tab marks the thread read right away (load() skips
    // the read-receipt write while the document is hidden).
    const onVisible = () => {
      if (!document.hidden) load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      if (channel) {
        try {
          supabase.removeChannel(channel);
        } catch {
          // Best-effort cleanup: nothing to do if this fails, the channel is
          // going away along with the component either way.
        }
      }
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVisible);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, leadId]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "nearest" });
  }, [messages]);

  // Close the tap-opened action bar on any tap outside it (or its "…"
  // toggle). Also disarms a pending "Unsend" confirm: without this, a touch
  // user could arm it, tap away without confirming, and have it still armed
  // (and one tap from deleting) the next time they reopen the action bar.
  useEffect(() => {
    if (!menuFor && !confirmUnsendId) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Element | null;
      if (!target?.closest("[data-msg-actions]")) {
        setMenuFor(null);
        setConfirmUnsendId(null);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [menuFor, confirmUnsendId]);

  // Belt-and-suspenders: an armed "Unsend" confirm also disarms itself after
  // a few seconds, so a stale confirm can never sit around long enough to
  // turn a later, unrelated tap into an instant delete.
  useEffect(() => {
    if (!confirmUnsendId) return;
    const t = setTimeout(() => setConfirmUnsendId(null), 4000);
    return () => clearTimeout(t);
  }, [confirmUnsendId]);

  // Closed if the most recent system marker is a "close" (not a "reopen").
  const closed = useMemo(() => {
    const sys = messages.filter((m) => m.sender_role === "system");
    return sys.length ? isCloseMarker(sys[sys.length - 1].body) : false;
  }, [messages]);

  // Which side closed it (only they may reopen).
  const closer = useMemo(() => {
    const sys = messages.filter((m) => m.sender_role === "system");
    if (!sys.length) return null;
    const last = sys[sys.length - 1].body;
    if (!isCloseMarker(last)) return null;
    if (last.includes("by the homeowner")) return "homeowner";
    if (last.includes("by the contractor") || last === LEGACY_CLOSE)
      return "contractor";
    return null;
  }, [messages]);
  const canReopen = closer === role;

  // The most recent message I sent (status shows only under this one).
  const lastMineId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].sender_role === role) return messages[i].id;
    }
    return null;
  }, [messages, role]);

  // Messages, quotes, and invoices merged into a single feed, oldest first, so
  // a card shows up right where it was sent relative to the surrounding chat.
  const feed = useMemo<FeedItem[]>(() => {
    const items: FeedItem[] = [
      ...messages.map((m) => ({
        kind: "message" as const,
        created_at: m.created_at,
        data: m,
      })),
      ...quotes.map((q) => ({
        kind: "quote" as const,
        created_at: q.created_at,
        data: q,
      })),
      ...invoices.map((i) => ({
        kind: "invoice" as const,
        created_at: i.created_at,
        data: i,
      })),
    ];
    items.sort((a, b) => a.created_at.localeCompare(b.created_at));
    return items;
  }, [messages, quotes, invoices]);

  // A price the conversation has already agreed on, used to prefill the
  // invoice composer so the pro isn't retyping something already settled.
  // An accepted structured quote (a real agreement) wins over a regex guess
  // off plain chat text, and the most recent one of either wins over older
  // ones. Companion messages are skipped, same as the inline "Quoted $X"
  // label below.
  const detectedInvoiceAmountCents = useMemo(() => {
    const accepted = quotes.filter((q) => q.status === "accepted");
    if (accepted.length) return accepted[accepted.length - 1].total_cents;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (
        m.sender_role === "contractor" &&
        !isImageBody(m.body) &&
        !isQuoteCompanionBody(m.body) &&
        !isInvoiceCompanionBody(m.body)
      ) {
        const q = extractQuote(m.body);
        if (q != null) return q * 100;
      }
    }
    return null;
  }, [quotes, messages]);

  async function ensureUid() {
    if (!uidRef.current) {
      const { data } = await supabase.auth.getUser();
      uidRef.current = data.user?.id ?? null;
    }
    return uidRef.current;
  }

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const text = body.trim();
    if (!text || closed) return;
    // Mask profanity before the message is stored; slurs also auto-report.
    const { clean, flagged, slur } = censor(text);
    setFiltered(flagged);
    const uid = await ensureUid();
    // When replying, prepend a short quote of the message being replied to.
    const snippet = replyingTo
      ? replyingTo.body.replace(/\n/g, " ").slice(0, 60) +
        (replyingTo.body.length > 60 ? "…" : "")
      : "";
    const finalBody = replyingTo ? `↩︎ ${snippet}\n${clean}` : clean;
    // Abuse guard (security audit finding #9): block an oversized message
    // client-side before it's ever sent, rather than letting it hit the DB's
    // length CHECK (migration 0086) and surface as a raw insert error. Checked
    // on the final stored body (reply-quote prefix included), not just the
    // typed text, so the combination can never sneak past the DB's own cap.
    if (finalBody.length > MAX_MESSAGE_LENGTH) {
      setTooLong(true);
      return;
    }
    setTooLong(false);
    setBusy(true);
    setBody("");
    setReplyingTo(null);

    // Optimistic: show the bubble the instant Send is pressed (dimmed via the
    // "temp-" id prefix, checked at render time below) instead of waiting on
    // the insert + full thread refetch. load() below replaces the whole
    // `messages` array wholesale from the DB once it resolves, which is what
    // actually reconciles the temp bubble with the real persisted row - no
    // separate matching step is needed. (A concurrent load() from the poll
    // or realtime channel firing between this line and the insert resolving
    // can briefly wholesale-replace `messages` without the temp bubble in
    // it, hiding it for a moment; it's cosmetic and self-heals on the next
    // load() once the real row exists, so it's not worth guarding against.)
    const tempId = `temp-${Date.now()}-${Math.round(Math.random() * 1000)}`;
    setMessages((prev) => [
      ...prev,
      { id: tempId, sender_role: role, body: finalBody, created_at: new Date().toISOString() },
    ]);

    try {
      const { data, error } = await supabase
        .from("messages")
        .insert({
          lead_id: leadId,
          sender_role: role,
          sender_id: uid,
          body: finalBody,
        })
        .select();
      if (error || !data || data.length === 0) throw new Error("send failed");
      if (slur) {
        await supabase.from("reports").insert({
          lead_id: leadId,
          reporter_id: uid,
          reporter_role: role,
          reason: "Auto-flagged by filter: slur / hate speech",
        });
      }
      setBusy(false);
      await load();
    } catch {
      // Couldn't deliver (bad connection, etc.) - roll back the optimistic
      // bubble and keep it as a failed message instead.
      setMessages((prev) => prev.filter((m) => m.id !== tempId));
      setBusy(false);
      setFailed((f) => [
        ...f,
        {
          tempId: `f${Date.now()}${Math.round(Math.random() * 1000)}`,
          body: finalBody,
        },
      ]);
    }
  }

  // Retry sending a message that failed.
  async function retryFailed(tempId: string, failedBody: string) {
    const uid = await ensureUid();
    setBusy(true);
    try {
      const { data, error } = await supabase
        .from("messages")
        .insert({
          lead_id: leadId,
          sender_role: role,
          sender_id: uid,
          body: failedBody,
        })
        .select();
      if (error || !data || data.length === 0) throw new Error("retry failed");
      setFailed((f) => f.filter((x) => x.tempId !== tempId));
      setBusy(false);
      load();
    } catch {
      setBusy(false);
    }
  }

  function deleteFailed(tempId: string) {
    setFailed((f) => f.filter((x) => x.tempId !== tempId));
  }

  // Upload an image to the home-photos bucket, then post it as a photo message.
  async function sendImage(file: File) {
    // Same checks as PhotoUpload.tsx, and for the same reason: a
    // `type.startsWith("image/")` test on its own lets image/svg+xml through,
    // which can carry a <script> and would then be served back off Hearth's
    // own storage origin to whoever opens the chat. SVG gets its own message
    // rather than a silent no-op, since "nothing happened" reads as a bug.
    // The bucket's allowed_mime_types (migration 0079) is the real backstop;
    // this stops the upload before it starts.
    if (file.type === "image/svg+xml") {
      setNotice(
        "SVG images aren't supported. Please send a PNG, JPEG, or WEBP photo."
      );
      setTimeout(() => setNotice(null), 5000);
      return;
    }
    // The file input accepts image/*, so a pick can still be a type the
    // bucket rejects (GIF, HEIC, AVIF, BMP). Name what works instead of a
    // bare return, which reads as "nothing happened" / a broken button.
    if (!CHAT_IMAGE_TYPES.has(file.type)) {
      setNotice("That image type isn't supported. Please send a PNG, JPEG, or WEBP photo.");
      setTimeout(() => setNotice(null), 5000);
      return;
    }
    if (file.size > MAX_CHAT_IMAGE_BYTES) {
      setNotice("That photo is too large. Please send one under 15MB.");
      setTimeout(() => setNotice(null), 5000);
      return;
    }
    setBusy(true);
    setPendingPhoto(file);
    try {
      const uid = await ensureUid();
      // Sanitize the derived extension to a safe charset so no ".." or path
      // fragment from a crafted filename can enter the storage key.
      const rawExt = file.name.split(".").pop()?.toLowerCase() ?? "";
      const ext = /^[a-z0-9]{1,5}$/.test(rawExt) ? rawExt : "jpg";
      const path = `chat/${leadId}/${crypto.randomUUID()}.${ext}`;
      const { error: upErr } = await supabase.storage
        .from("home-photos")
        .upload(path, file, { upsert: false });
      if (upErr) throw upErr;
      const { data: pub } = supabase.storage
        .from("home-photos")
        .getPublicUrl(path);
      const { error } = await supabase.from("messages").insert({
        lead_id: leadId,
        sender_role: role,
        sender_id: uid,
        body: `${IMG_PREFIX}${pub.publicUrl}`,
      });
      if (error) throw error;
      setBusy(false);
      setPendingPhoto(null);
      load();
    } catch {
      setBusy(false);
      setPendingPhoto(null);
      setNotice("Could not send the photo. Please try again.");
      setTimeout(() => setNotice(null), 5000);
    }
  }

  // Post a system marker to close or reopen the thread. Returns whether the
  // insert actually landed: confirmClose gates the visible "Conversation
  // closed" state on this, so a rejected insert or a network throw doesn't
  // leave that state showing (or busy stuck true) for something that never
  // happened.
  async function postSystem(text: string): Promise<boolean> {
    setBusy(true);
    try {
      const { error } = await supabase.from("messages").insert({
        lead_id: leadId,
        sender_role: "system",
        sender_id: await ensureUid(),
        body: text,
      });
      if (error) return false;
      load();
      return true;
    } catch {
      return false;
    } finally {
      setBusy(false);
    }
  }

  // Unsend (delete) one of your own messages. The DB policy only allows this
  // for your own messages within the last hour; we mirror that in the UI.
  async function unsend(id: string) {
    setConfirmUnsendId(null);
    setBusy(true);
    // Optimistic: hide the bubble immediately, restore it if the delete is
    // rejected. Restore just appends it back rather than reinserting at its
    // old index - the feed above always re-sorts by created_at, so position
    // in the `messages` array doesn't matter.
    const removedMsg = messages.find((m) => m.id === id) ?? null;
    setMessages((prev) => prev.filter((m) => m.id !== id));
    // .select() returns the deleted rows. If RLS blocked the delete (policy not
    // applied), it returns an empty array even though there's no error.
    const { data, error } = await supabase
      .from("messages")
      .delete()
      .eq("id", id)
      .select();
    setBusy(false);
    if (error || !data || data.length === 0) {
      // Dedupe the restore: a concurrent load() (poll / realtime / tab
      // refocus) can already have re-fetched this same still-existing
      // message (this is exactly the RLS-blocked-delete case above), so
      // appending it back unconditionally would add a second row with the
      // same id and show the bubble twice.
      if (removedMsg) {
        setMessages((prev) =>
          prev.some((m) => m.id === removedMsg.id) ? prev : [...prev, removedMsg]
        );
      }
      setNotice("Couldn't unsend. It isn't enabled in the database yet.");
      setTimeout(() => setNotice(null), 5000);
      return;
    }
    load();
  }

  // Toggle an emoji reaction on a message. Updates the UI immediately, then
  // persists to the DB (and syncs on the next load).
  async function react(messageId: string, emoji: string) {
    const uid = await ensureUid();
    if (!uid) return;
    const mineAlready = (reactions[messageId] ?? []).some(
      (r) => r.emoji === emoji && r.user_id === uid
    );

    // Optimistic update so the reaction shows the instant you tap it.
    setReactions((prev) => {
      const cur = prev[messageId] ?? [];
      const next = mineAlready
        ? cur.filter((r) => !(r.emoji === emoji && r.user_id === uid))
        : [...cur, { emoji, user_id: uid }];
      return { ...prev, [messageId]: next };
    });

    if (mineAlready) {
      await supabase
        .from("message_reactions")
        .delete()
        .eq("message_id", messageId)
        .eq("user_id", uid)
        .eq("emoji", emoji);
    } else {
      await supabase.from("message_reactions").insert({
        message_id: messageId,
        lead_id: leadId,
        user_id: uid,
        emoji,
      });
    }
    load();
  }

  async function copyText(text: string) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      /* clipboard unavailable */
    }
  }

  function startReply(m: Msg) {
    setMenuFor(null);
    setReplyingTo({ id: m.id, body: m.body });
    inputRef.current?.focus();
  }

  // Report a single (other person's) message for review.
  async function reportMessage(m: Msg) {
    setBusy(true);
    const { error } = await supabase.from("reports").insert({
      lead_id: leadId,
      reporter_id: await ensureUid(),
      reporter_role: role,
      reason: `Reported message: "${m.body.slice(0, 140)}"`,
    });
    setBusy(false);
    if (error) {
      // Leave the report affordance in place so the person can try again,
      // instead of claiming the report went through when the insert failed.
      setNotice("Couldn't report that message. Please try again.");
      setTimeout(() => setNotice(null), 4000);
      return;
    }
    setNotice("Message reported. Our team will review it.");
    setTimeout(() => setNotice(null), 4000);
  }

  // End the conversation (after confirmation). No reason is recorded. On the
  // homeowner side, this is the job-completion moment, so refresh the page
  // around this component too: the surrounding server page (e.g. /contractors,
  // /chats) re-fetches and its "Leave a review" prompt shows up right away
  // instead of waiting for the next manual reload.
  async function confirmClose() {
    setConfirmingClose(false);
    // justClosed only flips on a CONFIRMED insert (see postSystem's return
    // value): setting it eagerly would show "Conversation closed" - with no
    // Reopen, since canReopen only turns true from a real close marker - for
    // a close that silently failed or never reached the server.
    const ok = await postSystem(`${CLOSE_PREFIX} by the ${role}.`);
    if (!ok) {
      setNotice("Could not close the conversation. Please try again.");
      setTimeout(() => setNotice(null), 5000);
      return;
    }
    setJustClosed(true);
    router.refresh();
  }

  // Reopen a thread I closed. Clears justClosed so a later close in this
  // same session shows its own "Conversation closed" line again.
  function reopen() {
    setJustClosed(false);
    postSystem(REOPEN_BODY);
  }

  // Flag this conversation for the Hearth team to review.
  async function submitReport() {
    setBusy(true);
    await supabase.from("reports").insert({
      lead_id: leadId,
      reporter_id: await ensureUid(),
      reporter_role: role,
      reason: reportReason.trim() || null,
    });
    setBusy(false);
    setReporting(false);
    setReported(true);
  }

  // ---- Structured quote composer (pro side) --------------------------------

  function addQuoteRow() {
    setQuoteRows((rows) => [...rows, { label: "", amount: "" }]);
  }

  function removeQuoteRow(idx: number) {
    setQuoteRows((rows) => rows.filter((_, i) => i !== idx));
  }

  function updateQuoteRow(idx: number, field: "label" | "amount", value: string) {
    setQuoteRows((rows) =>
      rows.map((r, i) => (i === idx ? { ...r, [field]: value } : r))
    );
  }

  // Rows that will actually send: submitQuote and the server (sendQuoteAction)
  // both drop rows with a blank label or a non-positive amount, so the preview
  // must count exactly this set too.
  const validQuoteRows = quoteRows.filter(
    (r) => r.label.trim() !== "" && (dollarsToCents(r.amount) ?? 0) > 0
  );

  // Live preview only: the number actually saved is computed once, server
  // side, in sendQuoteAction. Uses the same dollarsToCents helper AND the same
  // row filter as submitQuote, so the two can never disagree.
  const quotePreviewCents = validQuoteRows.reduce(
    (sum, r) => sum + (dollarsToCents(r.amount) ?? 0),
    0
  );

  // A row with money but no label would be silently dropped on send. Block the
  // send and say so, instead of quietly quoting less than what is on screen.
  const hasUnlabeledAmount = quoteRows.some(
    (r) => r.label.trim() === "" && (dollarsToCents(r.amount) ?? 0) > 0
  );

  // Confirm a quote/invoice send actually landed by re-querying for a row id
  // that wasn't already known (see the comment in submitQuote/submitInvoice
  // below for why this is the only way to tell success from failure). Retried
  // once on its own query error, so a blip on this SELECT is not reported as
  // a failed send for an insert that actually succeeded.
  async function verifyNewRow(
    table: "lead_quotes" | "invoices",
    knownIds: Set<string>
  ): Promise<boolean> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const { data, error } = await supabase
        .from(table)
        .select("id")
        .eq("lead_id", leadId);
      if (!error) return (data ?? []).some((r) => !knownIds.has(r.id));
    }
    return false;
  }

  async function submitQuote(e: React.FormEvent) {
    e.preventDefault();
    if (!sendQuoteAction) return;
    const clean = validQuoteRows;
    if (clean.length === 0) return;
    setQuoteBusy(true);
    const fd = new FormData();
    fd.set("lead_id", leadId);
    fd.set("note", quoteNote);
    for (const r of clean) {
      fd.append("label", r.label.trim());
      fd.append("amount", r.amount);
    }
    // sendQuoteAction returns void on success AND on every failure path
    // (expired session, ownership check, insert error), so confirm the send by
    // looking for a quote row we did not already know about. Only a confirmed
    // send may close the composer and wipe what the pro typed.
    const knownIds = new Set(quotes.map((q) => q.id));
    let sent = false;
    try {
      await sendQuoteAction(fd);
      sent = await verifyNewRow("lead_quotes", knownIds);
    } catch {
      // Network blip or server-side throw: treated the same as a silent no-op.
      sent = false;
    } finally {
      setQuoteBusy(false);
    }
    if (sent) {
      setShowQuoteForm(false);
      setQuoteRows([{ label: "", amount: "" }]);
      setQuoteNote("");
    } else {
      // Keep the composer open with everything the pro typed intact.
      setNotice("The quote could not be sent. Please try again.");
      setTimeout(() => setNotice(null), 5000);
    }
    load();
  }

  async function withdrawQuote(quoteId: string) {
    if (!withdrawQuoteAction) return;
    setConfirmWithdrawId(null);
    setBusy(true);
    const fd = new FormData();
    fd.set("quote_id", quoteId);
    try {
      await withdrawQuoteAction(fd);
    } catch {
      setNotice("Could not withdraw the quote. Please try again.");
      setTimeout(() => setNotice(null), 5000);
    } finally {
      // A rejected server action must not leave `busy` stuck true: it gates
      // Send, Accept/Decline, Finish conversation, and more.
      setBusy(false);
    }
    load();
  }

  async function respondToQuote(
    quoteId: string,
    action: ((formData: FormData) => Promise<void>) | undefined
  ) {
    if (!action) return;
    setBusy(true);
    const fd = new FormData();
    fd.set("quote_id", quoteId);
    try {
      await action(fd);
    } catch {
      setNotice("Could not send. Please try again.");
      setTimeout(() => setNotice(null), 5000);
    } finally {
      setBusy(false);
    }
    load();
  }

  // ---- Invoice composer (contractor side) ----------------------------------

  function addInvoiceRow() {
    setInvoiceRows((rows) => [...rows, { description: "", amount: "" }]);
  }

  function removeInvoiceRow(idx: number) {
    setInvoiceRows((rows) => rows.filter((_, i) => i !== idx));
  }

  function updateInvoiceRow(
    idx: number,
    field: "description" | "amount",
    value: string
  ) {
    setInvoiceRows((rows) =>
      rows.map((r, i) => (i === idx ? { ...r, [field]: value } : r))
    );
  }

  // Opens the composer prefilled from whatever the conversation has already
  // surfaced (see detectedInvoiceAmountCents), so the pro is adjusting a
  // starting point rather than typing from scratch. Only prefills the first
  // time it's opened in this session: reopening after Cancel keeps whatever
  // the pro was mid-editing.
  function openInvoiceForm() {
    if (!showInvoiceForm) {
      setInvoiceRows([
        {
          description: jobTitle || "Work performed",
          amount:
            detectedInvoiceAmountCents != null
              ? String(detectedInvoiceAmountCents / 100)
              : "",
        },
      ]);
    }
    setShowQuoteForm(false);
    setShowInvoiceForm(true);
  }

  // Rows that will actually send: submitInvoice and the server
  // (createInvoiceAction) both drop rows with a blank description or a
  // non-positive amount, so the preview must count exactly this set too.
  const validInvoiceRows = invoiceRows.filter(
    (r) => r.description.trim() !== "" && (dollarsToCents(r.amount) ?? 0) > 0
  );

  const invoicePreviewCents = validInvoiceRows.reduce(
    (sum, r) => sum + (dollarsToCents(r.amount) ?? 0),
    0
  );

  const hasUnlabeledInvoiceAmount = invoiceRows.some(
    (r) => r.description.trim() === "" && (dollarsToCents(r.amount) ?? 0) > 0
  );

  async function submitInvoice(e: React.FormEvent) {
    e.preventDefault();
    if (!createInvoiceAction) return;
    const clean = validInvoiceRows;
    if (clean.length === 0) return;
    setInvoiceBusy(true);
    const fd = new FormData();
    fd.set("lead_id", leadId);
    for (const r of clean) {
      fd.append("description", r.description.trim());
      fd.append("amount", r.amount);
    }
    // createInvoiceAction returns void on success AND on every failure path,
    // so confirm the send by looking for an invoice row we did not already
    // know about, same trick submitQuote uses above.
    const knownIds = new Set(invoices.map((i) => i.id));
    let sent = false;
    try {
      await createInvoiceAction(fd);
      sent = await verifyNewRow("invoices", knownIds);
    } catch {
      sent = false;
    } finally {
      setInvoiceBusy(false);
    }
    if (sent) {
      setShowInvoiceForm(false);
      setInvoiceRows([{ description: "", amount: "" }]);
    } else {
      setNotice("The invoice could not be sent. Please try again.");
      setTimeout(() => setNotice(null), 5000);
    }
    load();
  }

  async function voidInvoice(invoiceId: string) {
    if (!voidInvoiceAction) return;
    setConfirmVoidId(null);
    setBusy(true);
    const fd = new FormData();
    fd.set("invoice_id", invoiceId);
    try {
      await voidInvoiceAction(fd);
    } catch {
      setNotice("Could not void the invoice. Please try again.");
      setTimeout(() => setNotice(null), 5000);
    } finally {
      setBusy(false);
    }
    load();
  }

  async function signInvoice(
    invoiceId: string,
    method: "in_app" | "in_person",
    typedName?: string
  ) {
    if (!signInvoiceAction) return;
    setBusy(true);
    const fd = new FormData();
    fd.set("invoice_id", invoiceId);
    fd.set("signature_method", method);
    if (method === "in_app") fd.set("signed_by", typedName ?? "");
    try {
      await signInvoiceAction(fd);
    } catch {
      setNotice("Could not sign the invoice. Please try again.");
      setTimeout(() => setNotice(null), 5000);
    } finally {
      setBusy(false);
    }
    load();
  }

  if (!embedded && !open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-sm font-medium text-bark-700 hover:underline"
      >
        Messages{messages.length ? ` (${messages.length})` : ""}
      </button>
    );
  }

  return (
    <div
      className={
        embedded
          ? "flex h-full flex-col"
          : "mt-2 rounded-lg border border-stone-200 bg-stone-50 p-3 dark:border-white/10 dark:bg-stone-800"
      }
    >
      {!embedded && (
        <div className="mb-2 flex items-center justify-between">
          <span className="text-xs font-medium uppercase tracking-wide text-stone-500 dark:text-stone-400">
            Messages
          </span>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="text-xs text-stone-500 hover:text-stone-600 dark:text-stone-400 dark:hover:text-stone-300"
          >
            Close
          </button>
        </div>
      )}

      {/* Conversation header: name on the left, end/reopen on the same line. */}
      {embedded && (
        <div className="mb-2 flex items-center justify-between gap-2 border-b border-stone-100 pb-2 dark:border-white/10">
          <div className="min-w-0">
            {title && (
              <p className="truncate font-semibold text-stone-900 dark:text-stone-100">{title}</p>
            )}
            {subtitle && (
              <p className="truncate text-xs text-stone-500 dark:text-stone-400">{subtitle}</p>
            )}
          </div>
          <div className="shrink-0">
            {closed || justClosed ? (
              canReopen ? (
                <button
                  type="button"
                  onClick={reopen}
                  disabled={busy}
                  className="text-xs font-medium text-bark-700 hover:underline disabled:opacity-50"
                >
                  Reopen
                </button>
              ) : (
                <span className="text-xs font-medium text-stone-500 dark:text-stone-400">
                  Conversation closed
                </span>
              )
            ) : confirmingClose ? (
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium text-stone-700 dark:text-stone-300">End?</span>
                <button
                  type="button"
                  onClick={confirmClose}
                  disabled={busy}
                  className="rounded-md bg-red-600 px-2 py-1 text-xs font-semibold text-white hover:bg-red-700 disabled:opacity-50"
                >
                  Yes
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmingClose(false)}
                  className="text-xs font-medium text-stone-900 hover:text-stone-600 dark:text-stone-100 dark:hover:text-stone-300"
                >
                  No
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmingClose(true)}
                disabled={busy}
                className="rounded-lg bg-red-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-700 disabled:opacity-50"
              >
                Finish conversation
              </button>
            )}
          </div>
        </div>
      )}

      <div
        className={
          embedded
            ? "flex-1 space-y-2 overflow-y-auto"
            : "max-h-48 space-y-2 overflow-y-auto"
        }
      >
        {feed.length === 0 ? (
          <p className="text-xs text-stone-500 dark:text-stone-400">No messages yet. Say hello.</p>
        ) : (
          feed.map((item) => {
            if (item.kind === "quote") {
              return (
                <QuoteCard
                  key={`q-${item.data.id}`}
                  quote={item.data}
                  role={role}
                  contractorName={contractorName}
                  busy={busy}
                  confirmWithdraw={confirmWithdrawId === item.data.id}
                  onAskWithdraw={() => setConfirmWithdrawId(item.data.id)}
                  onCancelWithdraw={() => setConfirmWithdrawId(null)}
                  onWithdraw={() => withdrawQuote(item.data.id)}
                  onAccept={
                    acceptQuoteAction
                      ? () => respondToQuote(item.data.id, acceptQuoteAction)
                      : undefined
                  }
                  onDecline={
                    declineQuoteAction
                      ? () => respondToQuote(item.data.id, declineQuoteAction)
                      : undefined
                  }
                />
              );
            }
            if (item.kind === "invoice") {
              return (
                <InvoiceCard
                  key={`i-${item.data.id}`}
                  invoice={item.data}
                  role={role}
                  contractorName={contractorName}
                  busy={busy}
                  confirmVoid={confirmVoidId === item.data.id}
                  onAskVoid={() => setConfirmVoidId(item.data.id)}
                  onCancelVoid={() => setConfirmVoidId(null)}
                  onVoid={() => voidInvoice(item.data.id)}
                  onSignInApp={
                    signInvoiceAction
                      ? (name) => signInvoice(item.data.id, "in_app", name)
                      : undefined
                  }
                  onSignInPerson={
                    signInvoiceAction
                      ? () => signInvoice(item.data.id, "in_person")
                      : undefined
                  }
                />
              );
            }
            const m = item.data;
            if (m.sender_role === "system") {
              return (
                <div key={m.id} className="flex justify-center">
                  <span className="rounded-full bg-stone-100 px-3 py-1 text-xs text-stone-500 dark:bg-stone-700 dark:text-stone-300">
                    {m.body}
                  </span>
                </div>
              );
            }
            const mine = m.sender_role === role;
            // A price the contractor stated gets labelled as a quote, so it is
            // easy to spot and compare in the thread. Skipped for a quote's own
            // companion message, which already gets a rich card above/below it.
            const quote =
              m.sender_role === "contractor" &&
              !isImageBody(m.body) &&
              !isQuoteCompanionBody(m.body) &&
              !isInvoiceCompanionBody(m.body)
                ? extractQuote(m.body)
                : null;
            // You can unsend your own messages for up to an hour.
            const recent =
              mine && Date.now() - new Date(m.created_at).getTime() < 3_600_000;
            // Aggregate reactions by emoji with counts.
            const chips = Object.entries(
              (reactions[m.id] ?? []).reduce(
                (acc, r) => {
                  acc[r.emoji] = (acc[r.emoji] || 0) + 1;
                  return acc;
                },
                {} as Record<string, number>
              )
            );
            return (
              <div
                key={m.id}
                className={`flex flex-col ${mine ? "items-end" : "items-start"}`}
              >
                {/* Wrapper hugs the bubble, so the hover area matches the text.
                    The action bar floats to the LEFT of the bubble. */}
                <div
                  className="group relative w-fit max-w-[80%]"
                  onMouseLeave={() => setConfirmUnsendId(null)}
                >
                  {/* Outer div is a transparent buffer (extra padding) so a
                      shaky cursor stays in the hover zone; inner pill is the UI.
                      On small screens hover doesn't exist, so the bar is
                      toggled by the "…" button instead and sits below the
                      bubble (wrapping if it needs to) rather than beside it. */}
                  <div
                    data-msg-actions
                    className={`absolute top-full z-20 min-w-[15rem] pt-1 md:top-1/2 md:min-w-0 md:-translate-y-1/2 md:px-2 md:py-3 ${
                      menuFor === m.id ? "block" : "hidden"
                    } md:hidden md:group-hover:block ${
                      mine ? "right-0 md:right-full" : "left-0 md:left-full"
                    }`}
                  >
                    <div className="flex flex-wrap items-center gap-2 whitespace-nowrap rounded-2xl border border-stone-200 bg-white px-3 py-1.5 shadow-md md:flex-nowrap md:rounded-full dark:border-white/10 dark:bg-stone-700">
                      {EMOJIS.map((e) => (
                        <button
                          key={e}
                          type="button"
                          onClick={() => react(m.id, e)}
                          className="text-base leading-none transition hover:scale-125"
                        >
                          {e}
                        </button>
                      ))}
                      <span className="mx-0.5 h-3 w-px bg-stone-200 dark:bg-white/10" />
                      <button
                        type="button"
                        onClick={() => startReply(m)}
                        className="px-1 text-xs text-stone-500 hover:text-bark-700 dark:text-stone-400 dark:hover:text-stone-300"
                      >
                        Reply
                      </button>
                      <button
                        type="button"
                        onClick={() => copyText(m.body)}
                        className="px-1 text-xs text-stone-500 hover:text-bark-700 dark:text-stone-400 dark:hover:text-stone-300"
                      >
                        Copy
                      </button>
                      {mine && recent && (
                        <button
                          type="button"
                          onClick={() =>
                            confirmUnsendId === m.id
                              ? unsend(m.id)
                              : setConfirmUnsendId(m.id)
                          }
                          disabled={busy}
                          className="px-1 text-xs font-semibold text-red-500 hover:text-red-700 disabled:opacity-50 dark:text-red-400 dark:hover:text-red-300"
                        >
                          {confirmUnsendId === m.id ? "Confirm?" : "Unsend"}
                        </button>
                      )}
                      {!mine && (
                        <button
                          type="button"
                          onClick={() => reportMessage(m)}
                          disabled={busy}
                          className="px-1 text-xs text-stone-500 hover:text-red-600 disabled:opacity-50 dark:text-stone-400 dark:hover:text-red-400"
                        >
                          Report
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Touch affordance: a small always-visible "…" beside the
                      bubble opens the action bar on screens with no hover.
                      Hidden on md+ where hovering the bubble does the job. */}
                  <button
                    type="button"
                    data-msg-actions
                    aria-label="Message actions"
                    aria-expanded={menuFor === m.id}
                    onClick={() =>
                      setMenuFor((cur) => (cur === m.id ? null : m.id))
                    }
                    className={`absolute top-1/2 -translate-y-1/2 rounded-full border border-stone-200 bg-white px-1.5 py-1 text-xs leading-none text-stone-500 shadow-sm dark:border-white/10 dark:bg-stone-700 dark:text-stone-400 md:hidden ${
                      mine ? "right-full mr-1.5" : "left-full ml-1.5"
                    }`}
                  >
                    …
                  </button>

                  {quote != null && (
                    <span className="mb-1 inline-flex items-center gap-1 rounded-full bg-bark-50 px-2 py-0.5 text-[10px] font-semibold text-bark-700 dark:bg-bark-700/40 dark:text-stone-300">
                      Quoted {formatUSD(quote)}
                    </span>
                  )}

                  {isImageBody(m.body) ? (
                    <button
                      type="button"
                      onClick={() =>
                        setLightboxSrc(imgSrc(imageUrl(m.body)) ?? null)
                      }
                      className="block cursor-zoom-in"
                      aria-label="View shared photo full size"
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={imgSrc(imageUrl(m.body)) ?? undefined}
                        alt="shared photo"
                        className="max-h-60 w-auto rounded-lg border border-stone-200 object-cover dark:border-white/10"
                      />
                    </button>
                  ) : (
                    <span
                      className={`block whitespace-pre-wrap break-words rounded-lg px-3 py-1.5 text-sm ${
                        mine
                          ? "bg-bark-600 text-white"
                          : "border border-stone-200 bg-white text-stone-700 dark:border-white/10 dark:bg-stone-700 dark:text-stone-200"
                      } ${m.id.startsWith("temp-") ? "opacity-60" : ""}`}
                    >
                      {m.body}
                    </span>
                  )}
                </div>

                {chips.length > 0 && (
                  <div className="mt-0.5 flex flex-wrap gap-1">
                    {chips.map(([emoji, count]) => (
                      <span
                        key={emoji}
                        className="rounded-full border border-stone-200 bg-white px-1.5 text-xs dark:border-white/10 dark:bg-stone-700"
                      >
                        {emoji} {count}
                      </span>
                    ))}
                  </div>
                )}

                {mine && m.id === lastMineId && (
                  <span className="mt-0.5 text-[10px] text-stone-500 dark:text-stone-400">
                    {otherReadAt && otherReadAt >= m.created_at
                      ? "Seen"
                      : "Delivered"}
                  </span>
                )}
              </div>
            );
          })
        )}

        {/* Messages that failed to send. */}
        {failed.map((f) => (
          <div key={f.tempId} className="flex flex-col items-end">
            <span className="block max-w-[80%] whitespace-pre-wrap break-words rounded-lg border border-red-300 bg-red-50 px-3 py-1.5 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
              {f.body}
            </span>
            <div className="mt-0.5 flex items-center gap-2 text-[10px]">
              <span className="text-red-500 dark:text-red-400">Not delivered</span>
              <button
                type="button"
                onClick={() => retryFailed(f.tempId, f.body)}
                disabled={busy}
                className="font-medium text-bark-700 hover:underline disabled:opacity-50 dark:text-stone-300"
              >
                Retry
              </button>
              <button
                type="button"
                onClick={() => deleteFailed(f.tempId)}
                className="font-medium text-stone-500 hover:text-red-600 dark:text-stone-400 dark:hover:text-red-400"
              >
                Delete
              </button>
            </div>
          </div>
        ))}
        <div ref={endRef} />
      </div>

      {notice && (
        <p className="mt-2 rounded-md bg-green-50 px-3 py-1.5 text-center text-xs text-green-700 dark:bg-green-950/40 dark:text-green-200">
          {notice}
        </p>
      )}

      {!closed && role === "contractor" && (sendQuoteAction || createInvoiceAction) && (
        <div className="mt-2">
          {showQuoteForm ? (
            <form
              onSubmit={submitQuote}
              className="space-y-2 rounded-lg border border-stone-200 bg-stone-50 p-3 dark:border-white/10 dark:bg-stone-800"
            >
              <p className="text-xs font-medium uppercase tracking-wide text-stone-500 dark:text-stone-400">
                Send a quote
              </p>
              {quoteRows.map((row, idx) => (
                <div key={idx} className="flex gap-2">
                  <input
                    className="input flex-1"
                    placeholder="Line item, e.g. Labor"
                    value={row.label}
                    onChange={(e) => updateQuoteRow(idx, "label", e.target.value)}
                  />
                  <input
                    className="input w-28"
                    placeholder="$0"
                    inputMode="decimal"
                    value={row.amount}
                    onChange={(e) => updateQuoteRow(idx, "amount", e.target.value)}
                  />
                  {quoteRows.length > 1 && (
                    <button
                      type="button"
                      onClick={() => removeQuoteRow(idx)}
                      className="-m-2 p-2 text-stone-500 hover:text-red-600 dark:text-stone-400 dark:hover:text-red-400"
                      aria-label="Remove line item"
                    >
                      ✕
                    </button>
                  )}
                </div>
              ))}
              <button
                type="button"
                onClick={addQuoteRow}
                className="text-xs font-medium text-bark-700 hover:underline"
              >
                + Add line item
              </button>
              <textarea
                value={quoteNote}
                onChange={(e) => setQuoteNote(e.target.value)}
                rows={2}
                maxLength={1000}
                placeholder="Note to the homeowner (optional)"
                className="input w-full text-sm"
              />
              {hasUnlabeledAmount && (
                <p className="text-xs text-amber-600 dark:text-amber-400">
                  Every line item with an amount needs a label, or it will
                  not be part of the quote.
                </p>
              )}
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-semibold text-stone-900 dark:text-stone-100">
                  Total: {formatUSDCents(quotePreviewCents)}
                </span>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setShowQuoteForm(false)}
                    className="btn-secondary text-sm"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={
                      quoteBusy || quotePreviewCents <= 0 || hasUnlabeledAmount
                    }
                    className="btn-primary text-sm disabled:opacity-50"
                  >
                    Send quote
                  </button>
                </div>
              </div>
            </form>
          ) : showInvoiceForm ? (
            <form
              onSubmit={submitInvoice}
              className="space-y-2 rounded-lg border border-stone-200 bg-stone-50 p-3 dark:border-white/10 dark:bg-stone-800"
            >
              <p className="text-xs font-medium uppercase tracking-wide text-stone-500 dark:text-stone-400">
                Create invoice from this chat
              </p>
              {invoiceRows.map((row, idx) => (
                <div key={idx} className="flex gap-2">
                  <input
                    className="input flex-1"
                    placeholder="Line item, e.g. Labor"
                    value={row.description}
                    onChange={(e) =>
                      updateInvoiceRow(idx, "description", e.target.value)
                    }
                  />
                  <input
                    className="input w-28"
                    placeholder="$0"
                    inputMode="decimal"
                    value={row.amount}
                    onChange={(e) =>
                      updateInvoiceRow(idx, "amount", e.target.value)
                    }
                  />
                  {invoiceRows.length > 1 && (
                    <button
                      type="button"
                      onClick={() => removeInvoiceRow(idx)}
                      className="-m-2 p-2 text-stone-500 hover:text-red-600 dark:text-stone-400 dark:hover:text-red-400"
                      aria-label="Remove line item"
                    >
                      ✕
                    </button>
                  )}
                </div>
              ))}
              <button
                type="button"
                onClick={addInvoiceRow}
                className="text-xs font-medium text-bark-700 hover:underline"
              >
                + Add line item
              </button>
              {hasUnlabeledInvoiceAmount && (
                <p className="text-xs text-amber-600 dark:text-amber-400">
                  Every line item with an amount needs a description, or it
                  will not be part of the invoice.
                </p>
              )}
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-semibold text-stone-900 dark:text-stone-100">
                  Total: {formatUSDCents(invoicePreviewCents)}
                </span>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setShowInvoiceForm(false)}
                    className="btn-secondary text-sm"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={
                      invoiceBusy ||
                      invoicePreviewCents <= 0 ||
                      hasUnlabeledInvoiceAmount
                    }
                    className="btn-primary text-sm disabled:opacity-50"
                  >
                    Send invoice
                  </button>
                </div>
              </div>
            </form>
          ) : (
            <div className="flex flex-wrap gap-3">
              {sendQuoteAction && (
                <button
                  type="button"
                  onClick={() => setShowQuoteForm(true)}
                  className="text-sm font-medium text-bark-700 hover:underline"
                >
                  Send a quote
                </button>
              )}
              {createInvoiceAction && (
                <button
                  type="button"
                  onClick={openInvoiceForm}
                  className="text-sm font-medium text-bark-700 hover:underline"
                >
                  Create invoice from this chat
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {closed ? (
        <p className="mt-2 rounded-lg bg-stone-100 px-3 py-2 text-center text-xs text-stone-500 dark:bg-stone-800 dark:text-stone-400">
          This conversation is finished.
          {canReopen
            ? " Reopen it above to send more messages."
            : " Only the person who ended it can reopen it."}
        </p>
      ) : (
        <div className="mt-2 space-y-2">
          {replyingTo && (
            <div className="flex items-center justify-between rounded-lg border-l-2 border-bark-500 bg-stone-50 px-2 py-1 text-xs text-stone-500 dark:bg-stone-800 dark:text-stone-400">
              <span className="truncate">
                ↩︎ {replyingTo.body.replace(/\n/g, " ").slice(0, 50)}
              </span>
              <button
                type="button"
                onClick={() => setReplyingTo(null)}
                className="-m-2 p-2 text-stone-500 hover:text-stone-700 dark:text-stone-400 dark:hover:text-stone-300"
              >
                ✕
              </button>
            </div>
          )}
          {pendingPhoto && (
            <div className="flex items-center gap-2">
              <FilePreviewThumb file={pendingPhoto} size="h-10 w-10" />
              <span className="text-xs text-stone-500 dark:text-stone-400">Sending photo…</span>
            </div>
          )}
          <form onSubmit={send} className="flex gap-2">
            <label
              title="Send a photo"
              className="flex cursor-pointer items-center rounded-lg border border-stone-200 px-3 text-stone-500 hover:border-bark-500 hover:text-bark-700 dark:border-white/10 dark:text-stone-400 dark:hover:text-stone-300"
            >
              <ImageIcon className="h-5 w-5" aria-hidden="true" />
              <input
                type="file"
                accept="image/*"
                className="hidden"
                disabled={busy}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) sendImage(f);
                  e.target.value = "";
                }}
              />
            </label>
            <input
              ref={inputRef}
              className="input"
              value={body}
              maxLength={MAX_MESSAGE_LENGTH}
              onChange={(e) => {
                setBody(e.target.value);
                if (filtered) setFiltered(false);
                if (tooLong) setTooLong(false);
              }}
              placeholder="Type a message…"
            />
            <button className="btn-primary" disabled={busy}>
              {busy && <InlineSpinner />}
              Send
            </button>
          </form>
          {filtered && (
            <p className="text-xs text-amber-600 dark:text-amber-400">
              Your message was filtered to keep the chat respectful.
            </p>
          )}
          {tooLong && (
            <p className="text-xs text-amber-600 dark:text-amber-400">
              That message is too long (max {MAX_MESSAGE_LENGTH.toLocaleString()} characters). Please shorten it.
            </p>
          )}
        </div>
      )}

      <div className="mt-2 border-t border-stone-100 pt-2 dark:border-white/10">
        {reported ? (
          <p className="text-xs text-stone-500 dark:text-stone-400">
            ✓ Reported. Our team will review this conversation.
          </p>
        ) : reporting ? (
          <div className="space-y-2">
            <textarea
              value={reportReason}
              onChange={(e) => setReportReason(e.target.value)}
              rows={2}
              placeholder="What's the problem? (optional)"
              className="input w-full text-sm"
            />
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={submitReport}
                disabled={busy}
                className="rounded-md bg-red-600 px-3 py-1 text-xs font-medium text-white disabled:opacity-50"
              >
                Submit report
              </button>
              <button
                type="button"
                onClick={() => setReporting(false)}
                className="text-xs text-stone-500 hover:text-stone-600 dark:text-stone-400 dark:hover:text-stone-300"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setReporting(true)}
            className="text-xs text-stone-500 hover:text-red-600 dark:text-stone-400 dark:hover:text-red-400"
          >
            Report chat
          </button>
        )}
      </div>

      <Lightbox
        src={lightboxSrc}
        alt="Shared photo"
        onClose={() => setLightboxSrc(null)}
      />
    </div>
  );
}

const STATUS_LABEL: Record<Quote["status"], string> = {
  sent: "Sent",
  accepted: "Accepted",
  declined: "Declined",
  withdrawn: "Withdrawn",
};

const STATUS_PILL_CLASS: Record<Quote["status"], string> = {
  sent: "bg-bark-50 text-bark-700 dark:bg-bark-700/40 dark:text-stone-300",
  accepted: "bg-green-100 text-green-700 dark:bg-green-950/40 dark:text-green-200",
  declined: "bg-stone-200 text-stone-600 dark:bg-stone-700 dark:text-stone-300",
  withdrawn: "bg-stone-200 text-stone-500 dark:bg-stone-700 dark:text-stone-400",
};

// A structured quote, rendered inline in the thread wherever it falls by
// created_at. Homeowner gets Accept/Decline on a 'sent' quote, the pro who
// sent it gets Withdraw. Accepting only ever flips this row's status: it
// never touches choose_applicant or any money logic.
function QuoteCard({
  quote,
  role,
  contractorName,
  busy,
  confirmWithdraw,
  onAskWithdraw,
  onCancelWithdraw,
  onWithdraw,
  onAccept,
  onDecline,
}: {
  quote: Quote;
  role: "homeowner" | "contractor";
  contractorName?: string;
  busy: boolean;
  confirmWithdraw: boolean;
  onAskWithdraw: () => void;
  onCancelWithdraw: () => void;
  onWithdraw: () => void;
  onAccept?: () => void;
  onDecline?: () => void;
}) {
  const mine = role === "contractor";
  return (
    <div className={`flex ${mine ? "justify-end" : "justify-start"}`}>
      <div className="w-full max-w-[85%] rounded-lg border border-stone-200 bg-white p-3 shadow-sm dark:border-white/10 dark:bg-stone-800">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-semibold text-stone-900 dark:text-stone-100">
            Quote from {contractorName || "your pro"}
          </p>
          <span
            className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${STATUS_PILL_CLASS[quote.status]}`}
          >
            {STATUS_LABEL[quote.status]}
          </span>
        </div>

        <ul className="mt-2 space-y-1">
          {quote.line_items.map((li, idx) => (
            <li
              key={idx}
              className="flex items-center justify-between text-sm text-stone-600 dark:text-stone-300"
            >
              <span className="truncate pr-2">{li.label}</span>
              <span className="shrink-0">{formatUSDCents(li.amount_cents)}</span>
            </li>
          ))}
        </ul>

        <div className="mt-2 flex items-center justify-between border-t border-stone-100 pt-2 dark:border-white/10">
          <span className="text-sm font-semibold text-stone-900 dark:text-stone-100">Total</span>
          <span className="text-sm font-semibold text-stone-900 dark:text-stone-100">
            {formatUSDCents(quote.total_cents)}
          </span>
        </div>

        {quote.note && (
          <p className="mt-2 whitespace-pre-wrap text-xs text-stone-500 dark:text-stone-400">
            {quote.note}
          </p>
        )}

        {role === "homeowner" && quote.status === "sent" && (onAccept || onDecline) && (
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={onAccept}
              disabled={busy}
              className="btn-primary flex-1 text-sm disabled:opacity-50"
            >
              Accept
            </button>
            <button
              type="button"
              onClick={onDecline}
              disabled={busy}
              className="btn-secondary flex-1 text-sm disabled:opacity-50"
            >
              Decline
            </button>
          </div>
        )}

        {role === "homeowner" && quote.status === "accepted" && (
          <p className="mt-3 rounded-md bg-green-50 px-2 py-1.5 text-xs text-green-700 dark:bg-green-950/40 dark:text-green-200">
            Quote accepted. Head to your{" "}
            <Link href="/contractors" className="font-medium underline">
              Contractors page
            </Link>{" "}
            to keep this job moving.
          </p>
        )}

        {role === "contractor" && quote.status === "sent" && (
          <div className="mt-3 flex justify-end">
            {confirmWithdraw ? (
              <div className="flex items-center gap-2">
                <span className="text-xs text-stone-500 dark:text-stone-400">Withdraw this quote?</span>
                <button
                  type="button"
                  onClick={onWithdraw}
                  disabled={busy}
                  className="text-xs font-semibold text-red-600 hover:text-red-700 disabled:opacity-50 dark:text-red-400 dark:hover:text-red-300"
                >
                  Confirm
                </button>
                <button
                  type="button"
                  onClick={onCancelWithdraw}
                  className="text-xs text-stone-500 hover:text-stone-600 dark:text-stone-400 dark:hover:text-stone-300"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={onAskWithdraw}
                disabled={busy}
                className="text-xs font-medium text-stone-500 hover:text-red-600 disabled:opacity-50 dark:text-stone-400 dark:hover:text-red-400"
              >
                Withdraw
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

const INVOICE_STATUS_LABEL: Record<Invoice["status"], string> = {
  sent: "Sent",
  signed: "Signed",
  void: "Void",
};

const INVOICE_STATUS_PILL_CLASS: Record<Invoice["status"], string> = {
  sent: "bg-bark-50 text-bark-700 dark:bg-bark-700/40 dark:text-stone-300",
  signed: "bg-green-100 text-green-700 dark:bg-green-950/40 dark:text-green-200",
  void: "bg-stone-200 text-stone-500 dark:bg-stone-700 dark:text-stone-400",
};

// An invoice, rendered inline in the thread wherever it falls by created_at.
// Homeowner gets "Sign invoice" on a 'sent' invoice (in-app typed acceptance
// or a plain "mark as signed in person"), the pro who sent it gets Void.
// Signing only ever flips this row's status and records who/when/how: it
// never touches money/payout logic.
function InvoiceCard({
  invoice,
  role,
  contractorName,
  busy,
  confirmVoid,
  onAskVoid,
  onCancelVoid,
  onVoid,
  onSignInApp,
  onSignInPerson,
}: {
  invoice: Invoice;
  role: "homeowner" | "contractor";
  contractorName?: string;
  busy: boolean;
  confirmVoid: boolean;
  onAskVoid: () => void;
  onCancelVoid: () => void;
  onVoid: () => void;
  onSignInApp?: (typedName: string) => void;
  onSignInPerson?: () => void;
}) {
  const mine = role === "contractor";
  // Local, per-card UI state: which sign step (if any) is showing, and the
  // name the homeowner has typed so far. Doesn't need to live in the parent
  // thread state since nothing else on the page depends on it.
  const [signStep, setSignStep] = useState<
    "closed" | "in_app" | "in_person"
  >("closed");
  const [typedName, setTypedName] = useState("");

  return (
    <div className={`flex ${mine ? "justify-end" : "justify-start"}`}>
      <div className="w-full max-w-[85%] rounded-lg border border-stone-200 bg-white p-3 shadow-sm dark:border-white/10 dark:bg-stone-800">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-semibold text-stone-900 dark:text-stone-100">
            Invoice from {contractorName || "your pro"}
          </p>
          <span
            className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${INVOICE_STATUS_PILL_CLASS[invoice.status]}`}
          >
            {INVOICE_STATUS_LABEL[invoice.status]}
          </span>
        </div>

        <ul className="mt-2 space-y-1">
          {invoice.line_items.map((li, idx) => (
            <li
              key={idx}
              className="flex items-center justify-between text-sm text-stone-600 dark:text-stone-300"
            >
              <span className="truncate pr-2">{li.description}</span>
              <span className="shrink-0">{formatUSDCents(li.amount_cents)}</span>
            </li>
          ))}
        </ul>

        <div className="mt-2 flex items-center justify-between border-t border-stone-100 pt-2 dark:border-white/10">
          <span className="text-sm font-semibold text-stone-900 dark:text-stone-100">Total</span>
          <span className="text-sm font-semibold text-stone-900 dark:text-stone-100">
            {formatUSDCents(invoice.total_cents)}
          </span>
        </div>

        {role === "homeowner" &&
          invoice.status === "sent" &&
          (onSignInApp || onSignInPerson) && (
            <div className="mt-3">
              {signStep === "in_app" ? (
                <div className="space-y-2 rounded-md bg-stone-50 p-2 dark:bg-stone-700">
                  <label className="block text-xs text-stone-500 dark:text-stone-400">
                    Type your full name to sign
                  </label>
                  <input
                    className="input w-full text-sm"
                    value={typedName}
                    onChange={(e) => setTypedName(e.target.value)}
                    placeholder="Full name"
                    autoFocus
                  />
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setSignStep("closed");
                        setTypedName("");
                      }}
                      className="btn-secondary flex-1 text-sm"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={() => onSignInApp?.(typedName.trim())}
                      disabled={busy || typedName.trim() === ""}
                      className="btn-primary flex-1 text-sm disabled:opacity-50"
                    >
                      Confirm signature
                    </button>
                  </div>
                </div>
              ) : signStep === "in_person" ? (
                <div className="flex items-center gap-2 rounded-md bg-stone-50 p-2 dark:bg-stone-700">
                  <span className="text-xs text-stone-600 dark:text-stone-300">
                    Mark this invoice as signed in person?
                  </span>
                  <button
                    type="button"
                    onClick={() => onSignInPerson?.()}
                    disabled={busy}
                    className="text-xs font-semibold text-bark-700 hover:text-bark-700 disabled:opacity-50 dark:text-stone-300 dark:hover:text-stone-300"
                  >
                    Confirm
                  </button>
                  <button
                    type="button"
                    onClick={() => setSignStep("closed")}
                    className="text-xs text-stone-500 hover:text-stone-600 dark:text-stone-400 dark:hover:text-stone-300"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <div className="flex gap-2">
                  {onSignInApp && (
                    <button
                      type="button"
                      onClick={() => setSignStep("in_app")}
                      disabled={busy}
                      className="btn-primary flex-1 text-sm disabled:opacity-50"
                    >
                      Sign invoice
                    </button>
                  )}
                  {onSignInPerson && (
                    <button
                      type="button"
                      onClick={() => setSignStep("in_person")}
                      disabled={busy}
                      className="btn-secondary flex-1 text-sm disabled:opacity-50"
                    >
                      Mark as signed in person
                    </button>
                  )}
                </div>
              )}
            </div>
          )}

        {invoice.status === "signed" && (
          <p className="mt-3 rounded-md bg-green-50 px-2 py-1.5 text-xs text-green-700 dark:bg-green-950/40 dark:text-green-200">
            Signed by {invoice.signed_by}
            {invoice.signed_at &&
              ` on ${new Date(invoice.signed_at).toLocaleDateString()}`}{" "}
            ({invoice.signature_method === "in_person" ? "in person" : "in app"})
          </p>
        )}

        {invoice.status === "void" && (
          <p className="mt-3 rounded-md bg-stone-100 px-2 py-1.5 text-xs text-stone-500 dark:bg-stone-700 dark:text-stone-400">
            This invoice was voided.
          </p>
        )}

        {role === "contractor" && invoice.status === "sent" && (
          <div className="mt-3 flex justify-end">
            {confirmVoid ? (
              <div className="flex items-center gap-2">
                <span className="text-xs text-stone-500 dark:text-stone-400">Void this invoice?</span>
                <button
                  type="button"
                  onClick={onVoid}
                  disabled={busy}
                  className="text-xs font-semibold text-red-600 hover:text-red-700 disabled:opacity-50 dark:text-red-400 dark:hover:text-red-300"
                >
                  Confirm
                </button>
                <button
                  type="button"
                  onClick={onCancelVoid}
                  className="text-xs text-stone-500 hover:text-stone-600 dark:text-stone-400 dark:hover:text-stone-300"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={onAskVoid}
                disabled={busy}
                className="text-xs font-medium text-stone-500 hover:text-red-600 disabled:opacity-50 dark:text-stone-400 dark:hover:text-red-400"
              >
                Void
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
