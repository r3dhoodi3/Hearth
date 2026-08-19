"use client";

import Link from "next/link";
import { useState } from "react";
import { useFormStatus } from "react-dom";
import InlineSpinner from "@/components/InlineSpinner";
import {
  unlockDirectRequestAction,
  declineDirectRequestAction,
} from "./actions";
import { GHOST_PROTECTION_DAYS } from "@/lib/constants";

// Submit button for the unlock confirm form. Needs its own component because
// useFormStatus only reports pending state inside a descendant of the <form>
// it belongs to, matching ApplyJobButton's ConfirmPayButton.
function UnlockPayButton({ fee }: { fee: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className="btn-primary flex-1 text-sm">
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
  canAfford: boolean;
  // Billing link carrying job context (?need=&category=) so the deposit page
  // can say what the funds are for and preselect an amount that covers it.
  billingHref?: string;
}) {
  const [confirming, setConfirming] = useState(false);

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
        <p className="text-xs text-stone-500 dark:text-stone-400">
          Unlocking accepts this request and charges the {fee} lead fee from your
          wallet. You get the homeowner&apos;s contact and the chat opens. If they
          never message you, ghost protection puts the fee back in your wallet
          as credit after {GHOST_PROTECTION_DAYS} days.
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
