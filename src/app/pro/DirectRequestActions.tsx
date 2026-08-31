"use client";

import Link from "next/link";
import { markPushMoment } from "@/lib/pushPrompt";
import { useState } from "react";
import { useFormStatus } from "react-dom";
import InlineSpinner from "@/components/InlineSpinner";
import {
  unlockDirectRequestAction,
  declineDirectRequestAction,
} from "./actions";
import { GHOST_PROTECTION_DAYS } from "@/lib/constants";
import {
  INSURANCE_REQUIRED_MESSAGE,
  INSURANCE_UPLOAD_HREF,
} from "@/lib/insuranceGate";

// Submit button for the unlock confirm form. Needs its own component because
// useFormStatus only reports pending state inside a descendant of the <form>
// it belongs to, matching ApplyJobButton's ConfirmPayButton.
function UnlockPayButton({ fee }: { fee: string }) {
  const { pending } = useFormStatus();
    // A pro unlocking a direct request is exactly the moment the push prompt is allowed
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

// The free "Pass" submit, in its own form.
function PassButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className="btn-secondary text-sm">
      {pending && <InlineSpinner />}
      Pass
    </button>
  );
}

// Unlock / Pass actions for an "Asked for you" card. Unlocking accepts the
// request and charges the per-category fee, so it takes an explicit confirm
// first, same as ApplyJobButton. A short wallet routes to billing instead of
// the action, reusing the deposit-prompt pattern.
export default function DirectRequestActions({
  leadId,
  fee,
  feeCents,
  insuranceRequired = false,
  canAfford,
  billingHref = "/pro/billing",
}: {
  leadId: string;
  fee: string;
  // The displayed fee in cents, posted to the action so it can refuse to
  // charge when the live price has climbed above what this card showed
  // (e.g. the first big-ticket intro was consumed in another tab). Optional:
  // without it the action simply skips that guard.
  feeCents?: number;
  // Big-job insurance gate (0153): true when this is a major-tier request
  // and the pro has no current insurance on file. Swaps the unlock button
  // for the requirement; the server action and the RPC refuse the same case.
  insuranceRequired?: boolean;
  canAfford: boolean;
  // Billing link carrying job context (?need=&category=) so the deposit page
  // can say what the funds are for and preselect an amount that covers it.
  billingHref?: string;
}) {
  const [confirming, setConfirming] = useState(false);

  if (insuranceRequired) {
    return (
      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/15 dark:text-amber-300">
          <span>{INSURANCE_REQUIRED_MESSAGE}</span>
          <Link
            href={INSURANCE_UPLOAD_HREF}
            className="font-medium underline max-sm:inline-flex max-sm:min-h-11 max-sm:items-center"
          >
            Add insurance
          </Link>
        </div>
        {/* Passing is free and needs no insurance, so it stays available. */}
        <form action={declineDirectRequestAction}>
          <input type="hidden" name="id" value={leadId} />
          <PassButton />
        </form>
      </div>
    );
  }

  if (confirming) {
    return (
      <form
        action={unlockDirectRequestAction}
        className="space-y-2 rounded-lg border border-stone-200 bg-stone-50 p-3 dark:border-white/10 dark:bg-stone-900"
      >
        <input type="hidden" name="id" value={leadId} />
        {Number.isFinite(feeCents) && (
          <input type="hidden" name="fee_cents" value={feeCents} />
        )}
        {/* Fee amount and the credit-back words bolded on request, same
            treatment as ApplyJobButton.tsx's confirm step. */}
        <p className="text-xs text-stone-500 dark:text-stone-400">
          Unlocking accepts this request and charges the <strong>{fee}</strong>{" "}
          lead fee from your wallet. You get the homeowner&apos;s contact and
          the chat opens. If they never message you, ghost protection puts
          the fee back in your wallet as{" "}
          <strong>lead credit (not cash)</strong> after {GHOST_PROTECTION_DAYS}{" "}
          days.
        </p>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setConfirming(false)}
            className="btn-secondary text-sm"
          >
            Cancel
          </button>
          <UnlockPayButton fee={fee} />
        </div>
      </form>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {canAfford ? (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          className="btn-primary text-sm"
        >
          Unlock for {fee}
        </button>
      ) : (
        <Link href={billingHref} className="btn-primary text-sm">
          Add funds to unlock ({fee})
        </Link>
      )}
      <form action={declineDirectRequestAction}>
        <input type="hidden" name="id" value={leadId} />
        <PassButton />
      </form>
    </div>
  );
}
