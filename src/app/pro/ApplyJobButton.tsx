"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import InlineSpinner from "@/components/InlineSpinner";
import { applyToJobAction } from "./actions";
import { LEAD_TIER_FEES } from "@/lib/constants";
import {
  GHOST_PROTECTION_GUARANTEE,
  FIRST_APPLICATION_GUARANTEE,
  CREDIT_NOT_CASH_LINE,
} from "@/lib/guaranteeCopy";
import { fetchWithTimeout, isTimeoutError } from "@/lib/fetchWithTimeout";

// Submit button for the "Confirm and pay" form below. Needs its own
// component because useFormStatus only reports pending state inside a
// descendant of the <form> it belongs to, not the component rendering the
// form itself.
function ConfirmPayButton({ fee }: { fee: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className="btn-primary flex-1 text-sm">
      {pending && <InlineSpinner />}
      Confirm and pay {fee}
    </button>
  );
}

// Quick-apply starter templates: plain string substitution, no AI and no cost.
// They prefill the textarea so a pro can tap one, then personalize before
// sending. Kept short and generic on purpose: the pro's own message is what
// actually persuades a homeowner, these just remove the blank-page problem.
function quickApplyTemplates(category: string): { label: string; text: string }[] {
  return [
    {
      label: "Available this week",
      text: `Hi, I do ${category} work in your area and can take a look this week. A couple of questions first: `,
    },
    {
      label: "Can start right away",
      text: `Hi, I do ${category} work in your area and can start right away if you're ready. A couple of questions first: `,
    },
    {
      label: "Happy to give a free estimate",
      text: `Hi, I do ${category} work in your area and I'm happy to come give you a free estimate. A couple of questions first: `,
    },
    {
      label: "Done a lot of this nearby",
      text: `Hi, I've done a lot of ${category} work in your neighborhood and would be glad to help with yours too. A couple of questions first: `,
    },
    {
      label: "Happy to talk it through by phone",
      text: `Hi, I do ${category} work in your area. Happy to hop on a quick call first to talk through options if that's easier than typing. A couple of questions first: `,
    },
  ];
}

// Apply to an open job. Applying charges the per-category fee from the wallet,
// so it always takes an explicit confirmation first (and lets the pro add a note
// to the homeowner). If the wallet can't cover the fee, it points to billing.
export default function ApplyJobButton({
  leadId,
  fee,
  feeCents,
  canAfford,
  category,
  introPrice = false,
  billingHref = "/pro/billing",
}: {
  leadId: string;
  fee: string;
  // True when the price on this card is the one-time first big-ticket intro
  // (migration 0113), so the confirm step can say plainly that the next
  // big-ticket lead costs the normal price. Nothing gates on it - the DB
  // re-derives the real price under the wallet lock at charge time.
  introPrice?: boolean;
  // The displayed fee in cents, posted to the action so it can refuse to
  // charge when the live price has climbed above what this card showed
  // (e.g. the first big-ticket intro was consumed in another tab). Optional:
  // without it the action simply skips that guard.
  feeCents?: number;
  canAfford: boolean;
  // Job category label (already resolved via labelFor on the board), used to
  // personalize the quick-apply templates. Optional so nothing breaks if a
  // caller doesn't have it handy; the templates just fall back to "this".
  category?: string;
  // Billing link carrying job context (?need=&category=) so the deposit page
  // can say what the funds are for and preselect an amount that covers it.
  billingHref?: string;
}) {
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState("");
  const [drafting, setDrafting] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Prefill from a quick-apply template, then move the cursor to the end so
  // the pro can keep typing right where the template left off (never
  // auto-sends: this only touches the textarea's value). A hand-typed
  // message is never silently discarded: swapping between untouched
  // templates is free, but replacing custom text asks first.
  function applyTemplate(text: string) {
    const current = message.trim();
    const isTemplate = quickApplyTemplates(category || "this").some(
      (t) => t.text.trim() === current
    );
    if (current && !isTemplate) {
      const ok = window.confirm(
        "Replace the message you've written with this template?"
      );
      if (!ok) return;
    }
    setMessage(text);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.selectionStart = el.selectionEnd = text.length;
    });
  }

  // Ask the drafter route for a first-pass apply message and drop it into the
  // textarea, still fully editable. Errors show inline and never block typing
  // a message by hand.
  async function draftForMe() {
    setDrafting(true);
    setDraftError(null);
    try {
      // Timeout-guarded: a hung drafting call must not strand the button in
      // its busy state with no way to retry.
      const resp = await fetchWithTimeout("/api/draft-apply", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ leadId }),
      });
      if (resp.status === 401) {
        setDraftError("Please sign in and try again.");
        return;
      }
      const data = await resp.json().catch(() => ({}));
      if (data?.message) {
        setMessage(data.message as string);
      } else if (data?.reason === "rate_limited") {
        setDraftError(
          "You've hit today's drafting limit. It resets at midnight."
        );
      } else if (data?.reason === "busy") {
        // A burst window or an owner-wide ceiling, not this pro's own daily
        // allowance. Saying "you've hit today's limit" for it sent pros to
        // billing over a few seconds' wait. Copy comes from the server
        // (src/lib/aiReason.ts); the fallback covers an older reply.
        setDraftError(data?.error || "Give it a minute and try again.");
      } else if (data?.reason === "no_key") {
        setDraftError("Can't draft right now. Try again in a minute.");
      } else {
        setDraftError(
          data?.error || "Couldn't draft a message. Try writing your own."
        );
      }
    } catch (e) {
      setDraftError(
        isTimeoutError(e)
          ? "That took too long. Try again."
          : "Something went wrong. Please try again."
      );
    } finally {
      setDrafting(false);
    }
  }

  if (!canAfford) {
    return (
      <Link href={billingHref} className="btn-primary text-sm">
        Add funds to apply ({fee})
      </Link>
    );
  }

  if (!confirming) {
    return (
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className="btn-primary text-sm"
      >
        Apply · {fee}
      </button>
    );
  }

  return (
    <form
      action={applyToJobAction}
      className="space-y-2 rounded-lg border border-stone-200 bg-stone-50 p-3 dark:border-white/10 dark:bg-stone-900"
    >
      <input type="hidden" name="id" value={leadId} />
      {Number.isFinite(feeCents) && (
        <input type="hidden" name="fee_cents" value={feeCents} />
      )}
      <div className="flex flex-wrap gap-1.5">
        {quickApplyTemplates(category || "this").map((t) => (
          <button
            key={t.label}
            type="button"
            onClick={() => applyTemplate(t.text)}
            className="chip border border-stone-200 bg-white text-stone-600 hover:border-hearth-300 hover:text-hearth-700 dark:border-white/10 dark:bg-stone-800 dark:text-stone-300 dark:hover:border-hearth-400 dark:hover:text-hearth-300"
          >
            {t.label}
          </button>
        ))}
      </div>
      <textarea
        ref={textareaRef}
        name="message"
        rows={3}
        className="textarea w-full text-sm"
        placeholder="Add a note to the homeowner (optional)"
        value={message}
        onChange={(e) => setMessage(e.target.value)}
      />
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={draftForMe}
          disabled={drafting}
          className="text-xs font-medium text-hearth-700 hover:underline disabled:opacity-50"
        >
          {drafting ? "Drafting..." : "Draft it for me"}
        </button>
      </div>
      {/* Matches the app's toast styling (see ToastProvider.tsx) so this reads
          as an error, not a stray line of text. This form lives inside a client
          component that isn't rendered from a server action, so it can't use
          the flash-cookie toast; a styled inline card is the smallest honest
          stand-in. */}
      {draftError && (
        <div
          role="alert"
          className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs font-medium text-red-800 dark:border-red-500/30 dark:bg-red-500/15 dark:text-red-300"
        >
          <span className="flex-1">{draftError}</span>
          <button
            type="button"
            onClick={() => setDraftError(null)}
            aria-label="Dismiss"
            className="shrink-0 text-red-400 hover:text-red-600 dark:text-red-500 dark:hover:text-red-400"
          >
            ✕
          </button>
        </div>
      )}
      <p className="text-xs text-stone-500 dark:text-stone-400">
        Applying charges the {fee} lead fee from your wallet.{" "}
        {GHOST_PROTECTION_GUARANTEE} {FIRST_APPLICATION_GUARANTEE}{" "}
        {CREDIT_NOT_CASH_LINE}
      </p>
      {/* Said at the moment of the charge, not after it: the price on this
          card is a one-time thing, and a pro deciding whether to spend it
          deserves to know what the next one costs. LEAD_TIER_FEES.major is
          the same constant the board and the DB price from, so this line can
          never quote a number the wallet would not actually charge. */}
      {introPrice && (
        <p className="text-xs font-medium text-hearth-700 dark:text-hearth-300">
          This is your one-time first big-ticket price - after this apply,
          big-ticket leads are ${LEAD_TIER_FEES.major}.
        </p>
      )}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => setConfirming(false)}
          className="btn-secondary text-sm"
        >
          Cancel
        </button>
        <ConfirmPayButton fee={fee} />
      </div>
    </form>
  );
}
