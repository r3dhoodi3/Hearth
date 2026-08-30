"use client";

import Link from "next/link";
import { markPushMoment } from "@/lib/pushPrompt";
import { useEffect, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import { Sparkles } from "lucide-react";
import InlineSpinner from "@/components/InlineSpinner";
import { applyToJobAction } from "./actions";
import {
  readComposeDraft,
  saveComposeDraftDebounced,
  clearComposeDraft,
} from "@/lib/proComposeDraft";
import { LEAD_TIER_FEES } from "@/lib/constants";
import type { LeadDiscountKind } from "@/lib/leadPricing";
import {
  ghostProtectionGuaranteeRich,
  firstApplicationGuaranteeRich,
  creditNotCashLineRich,
} from "@/lib/guaranteeCopy";
import { fetchWithTimeout, isTimeoutError } from "@/lib/fetchWithTimeout";

// Submit button for the "Confirm and pay" form below. Needs its own
// component because useFormStatus only reports pending state inside a
// descendant of the <form> it belongs to, not the component rendering the
// form itself.
function ConfirmPayButton({ fee }: { fee: string }) {
  const { pending } = useFormStatus();
    // A pro paying for a lead is exactly the moment the push prompt is allowed
    // to appear: they now have money on a job and want to know the second the
    // homeowner replies. markPushMoment only stamps localStorage; the prompt
    // itself decides whether to ask (see src/lib/pushPrompt.ts). Fired on the
    // tap rather than on a success callback because this is a plain server-
    // action form with no client success state - a rare failed charge means at
    // worst one prompt shown a moment early.
  return (
    <button
      type="submit"
      disabled={pending}
      onClick={() => markPushMoment()}
      className="btn-primary flex-1 text-sm"
    >
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
  baseFee = null,
  discountKind = null,
  memberQuoteStr = null,
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
  // Pre-markdown fee, already money()-formatted, shown struck through above
  // the confirm price when a member or aging discount (or the intro price)
  // applies. Null when the card is charging the plain base fee.
  baseFee?: string | null;
  // Which single discount priced this card (migration 0149) - never two at
  // once. Drives the "Pro" chip and the " with Pro" suffix on the confirm
  // price; null renders neither.
  discountKind?: LeadDiscountKind;
  // "Pro members pay $X", already money()-formatted, for a NON-member on a
  // lead where membership would actually beat the price shown. Null hides
  // the quiet line entirely - see memberQuoteStr in
  // src/app/pro/leads/page.tsx for why it is sometimes null even for a
  // non-member (membership would not have helped THIS lead).
  memberQuoteStr?: string | null;
  // Billing link carrying job context (?need=&category=) so the deposit page
  // can say what the funds are for and preselect an amount that covers it.
  billingHref?: string;
}) {
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState("");
  const [drafting, setDrafting] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Autosave (CR5#4): a dropped signal or a backgrounded app on a job site
  // must not lose a note a pro already typed. Restored once on mount, saved
  // debounced as the textarea below changes, cleared once the form actually
  // submits (near the confirm form's onSubmit).
  useEffect(() => {
    const draft = readComposeDraft("apply", leadId);
    if (draft) setMessage((current) => (current ? current : draft));
  }, [leadId]);

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
      } else if (data?.reason === "locked") {
        // The business is not verified yet; copy comes from the server.
        setDraftError(
          data?.error || "Drafting opens once your business is verified."
        );
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
      // The draft's job is done the moment this submits (CR5#4 autosave).
      onSubmit={() => clearComposeDraft("apply", leadId)}
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
            // Phone only: .chip is py-0.5 text-xs, about 20px tall, and
            // these chips fill the application message.
            className="chip border border-stone-200 bg-white text-stone-600 hover:border-hearth-300 hover:text-hearth-700 max-sm:min-h-11 max-sm:px-3 max-sm:text-sm dark:border-white/10 dark:bg-stone-800 dark:text-stone-300 dark:hover:border-hearth-400 dark:hover:text-hearth-300"
          >
            {t.label}
          </button>
        ))}
      </div>
      {/* Phone only: a full-width, clearly-labelled button above the message
          box replaces the old small text link below it - a pro skimming the
          confirm card on a phone kept missing that AI drafting existed at
          all. Desktop keeps the original small link in its original spot
          (rendered again below the textarea), unchanged apart from the
          clearer label. */}
      <button
        type="button"
        onClick={draftForMe}
        disabled={drafting}
        className="btn-secondary w-full sm:hidden max-sm:min-h-11 max-sm:text-base"
      >
        <Sparkles className="h-4 w-4" aria-hidden="true" />
        {drafting ? "Drafting..." : "Draft a message for me"}
      </button>
      <textarea
        ref={textareaRef}
        name="message"
        rows={3}
        // Phone only: grows past the old cramped 3-row/14px box to at least
        // 6 rows at 16px with roomier line spacing so a drafted message can
        // be read without zooming. No text-sm override here (unlike before)
        // lets .textarea's own text-base apply below sm; sm:text-sm in that
        // same class keeps the desktop box byte-identical.
        className="textarea w-full max-sm:min-h-40 max-sm:leading-relaxed"
        placeholder="Add a note to the homeowner (optional)"
        value={message}
        onChange={(e) => {
          setMessage(e.target.value);
          saveComposeDraftDebounced("apply", leadId, e.target.value);
        }}
      />
      <div className="flex flex-wrap items-center gap-2 max-sm:hidden">
        <button
          type="button"
          onClick={draftForMe}
          disabled={drafting}
          className="text-xs font-medium text-hearth-700 hover:underline disabled:opacity-50 max-sm:inline-flex max-sm:min-h-11 max-sm:items-center max-sm:text-sm"
        >
          {drafting ? "Drafting..." : "Draft a message for me"}
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
            // Phone only: a bare ~20px glyph is how you clear this error.
            className="shrink-0 text-red-400 hover:text-red-600 max-sm:flex max-sm:h-11 max-sm:w-11 max-sm:items-center max-sm:justify-center dark:text-red-500 dark:hover:text-red-400"
          >
            ✕
          </button>
        </div>
      )}
      {/* Price line at the moment of confirm, same discount rule the board's
          card already showed (never two discounts at once, migration 0149):
          the struck-through base, a "Pro" chip and " with Pro" when the
          member discount is what is being charged, or the quiet
          "Pro members pay $X" line for a non-member on a lead where
          membership would actually beat this price. This is the same
          feeCents the RPC will charge - see the "Applying charges" line
          right below, which prints the identical `fee` string. */}
      {baseFee && (
        <p className="text-xs text-stone-600 dark:text-stone-300">
          <span className="text-stone-400 line-through dark:text-stone-500">
            {baseFee}
          </span>{" "}
          <strong>
            {fee}
            {discountKind === "member" && " with Pro"}
          </strong>
          {discountKind === "member" && (
            <span className="chip ml-1 border border-hearth-200 bg-hearth-50 font-semibold text-hearth-700 dark:border-hearth-500/30 dark:bg-hearth-500/15 dark:text-hearth-300">
              Pro
            </span>
          )}
        </p>
      )}
      {memberQuoteStr && (
        <p className="text-xs text-stone-500 dark:text-stone-400">
          <Link
            href="/pro/plus?reason=leads"
            className="underline hover:text-stone-600 max-sm:inline-flex max-sm:min-h-11 max-sm:items-center dark:hover:text-stone-300"
          >
            Pro members pay {memberQuoteStr}
          </Link>
        </p>
      )}
      {/* The fee amount and the credit-back words are bolded on request: a pro
          skimming this card should not be able to miss that a lost bid comes
          back as wallet credit, never a cash refund. The *Rich helpers bold
          exact substrings of the same canonical sentences ActivityList.tsx
          and LeadsBoard.tsx render plain, so the wording itself never drifts
          (see src/lib/guaranteeCopy.ts). */}
      <p className="text-xs text-stone-500 dark:text-stone-400">
        Applying charges the <strong>{fee}</strong> lead fee from your
        wallet.{" "}
        {ghostProtectionGuaranteeRich()} {firstApplicationGuaranteeRich()}{" "}
        {creditNotCashLineRich()}
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
