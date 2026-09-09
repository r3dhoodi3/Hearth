"use client";

import { useState } from "react";
import Link from "next/link";
import { PRO_PLAN, formatUsd } from "@/lib/constants";
import { purchasePro, restorePurchases, IapUnavailableError } from "@/lib/iap";
import BillingLegalLine from "@/components/BillingLegalLine";
import InlineSpinner from "@/components/InlineSpinner";
import { tap, success as hapticSuccess, warn as hapticWarn } from "@/lib/native/haptics";

// Native-only replacement for ProPlanToggle's Stripe checkout forms. Rendered
// ONLY when isNativeApp() is true (see the guard in ProPlanToggle.tsx) - the
// web path never mounts this component. Twin of
// src/app/(app)/plus/NativePlusCheckout.tsx; see that file's header comment
// for the Apple-disclosure and Restore-Purchases reasoning, which applies
// here unchanged.
export default function NativeProCheckout() {
  const [busy, setBusy] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [restored, setRestored] = useState<boolean | null>(null);

  async function onPurchase() {
    // Pro-side twin of NativePlusCheckout's haptics: the same tap on intent,
    // success on a completed purchase, warn on a real failure, so both sides
    // of the app feel the same on a phone.
    tap();
    setBusy(true);
    setError(null);
    try {
      await purchasePro();
      hapticSuccess();
      window.location.href = "/pro/plus?welcome=1";
    } catch (err) {
      setBusy(false);
      if (err instanceof IapUnavailableError) {
        setError(err.message);
      } else if (err && typeof err === "object" && "userCancelled" in err) {
        return;
      } else {
        hapticWarn();
        setError("Couldn't complete the purchase. Please try again.");
      }
    }
  }

  async function onRestore() {
    setRestoring(true);
    setError(null);
    try {
      const entitlements = await restorePurchases();
      setRestored(entitlements.pro);
      if (entitlements.pro) {
        window.location.href = "/pro/plus?welcome=1";
      }
    } catch {
      setError("Couldn't restore purchases just now. Please try again.");
    } finally {
      setRestoring(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="card-hero space-y-3 text-center">
        <p className="text-lg font-medium text-oaktend-700 dark:text-stone-300">
          OakTend Pro membership
        </p>
        <p className="text-2xl font-semibold text-stone-900 dark:text-stone-100">
          {formatUsd(PRO_PLAN.monthly)}
          <span className="text-base font-normal text-stone-500 dark:text-stone-400">
            /month
          </span>
        </p>
        <p className="text-sm text-stone-600 dark:text-stone-300">
          {PRO_PLAN.trialDays} days free, then {formatUsd(PRO_PLAN.monthly)}{" "}
          a month. Renews automatically until you cancel.
        </p>

        <div className="rounded-xl border border-stone-200 bg-stone-50 p-3 text-left text-xs text-stone-600 max-sm:text-sm dark:border-white/10 dark:bg-stone-900 dark:text-stone-300">
          <p>
            OakTend Pro automatically renews at {formatUsd(PRO_PLAN.monthly)}
            {" "}per month unless auto-renew is turned off at least 24 hours
            before the end of the current period. Manage or cancel your
            subscription anytime in your{" "}
            <span className="font-medium text-stone-900 dark:text-stone-100">
              Settings &gt; Apple ID &gt; Subscriptions
            </span>{" "}
            (iOS) or the Play Store&apos;s Subscriptions page (Android). Payment is
            charged to your store account at confirmation of purchase.
          </p>
          {/* Pro-side twin of the identical note in
              src/app/(app)/plus/NativePlusCheckout.tsx - see that file for why
              store-decided trial eligibility has to be said out loud here. */}
          <p className="mt-2">
            The free days are the App Store or Play Store introductory offer and
            apply to first-time subscribers only. If your store account has used
            it before, billing starts at purchase.
          </p>
          <p className="mt-2">
            <Link href="/pro-terms" className="underline hover:text-stone-900 dark:hover:text-stone-100">
              Pro Terms
            </Link>{" "}
            &middot;{" "}
            <Link href="/privacy" className="underline hover:text-stone-900 dark:hover:text-stone-100">
              Privacy Policy
            </Link>
          </p>
        </div>

        {error && (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {error}
          </p>
        )}
        {restored === false && (
          <p className="text-sm text-stone-500 dark:text-stone-400">
            No previous purchase found on this account.
          </p>
        )}

        <button
          type="button"
          onClick={onPurchase}
          disabled={busy}
          className="btn-primary w-full py-3 disabled:opacity-50"
        >
          {busy && <InlineSpinner size={14} />}
          {busy ? "Starting…" : `Try Pro free for ${PRO_PLAN.trialDays} days`}
        </button>

        <button
          type="button"
          onClick={onRestore}
          disabled={restoring}
          className="text-sm text-stone-500 underline hover:text-stone-700 disabled:opacity-50 dark:text-stone-400 dark:hover:text-stone-200"
        >
          {restoring ? "Restoring…" : "Restore purchases"}
        </button>
      </div>

      <BillingLegalLine className="text-center text-xs text-stone-500 max-sm:text-sm dark:text-stone-400" />
    </div>
  );
}
