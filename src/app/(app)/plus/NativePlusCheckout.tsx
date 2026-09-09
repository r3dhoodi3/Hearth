"use client";

import { useState } from "react";
import Link from "next/link";
import { PLUS_PLAN, formatUsd } from "@/lib/constants";
import { purchasePlus, restorePurchases, IapUnavailableError } from "@/lib/iap";
import BillingLegalLine from "@/components/BillingLegalLine";
import InlineSpinner from "@/components/InlineSpinner";
import { tap, success as hapticSuccess, warn as hapticWarn } from "@/lib/native/haptics";

// =============================================================================
// The native-only replacement for PlanToggle's Stripe checkout form. Rendered
// ONLY when isNativeApp() is true (see the guard in PlanToggle.tsx) - the web
// path never mounts this component, so web stays byte-identical.
//
// Apple requires, at or near the point of purchase (App Store Connect Help,
// "offer auto-renewable subscriptions" - see the research report section 1):
// title, price, price-per-unit, auto-renewal terms, and links to Terms of Use
// and Privacy Policy. This block states all of that in plain language before
// the native purchase sheet (RevenueCat -> StoreKit/Play Billing) ever opens.
// Restore Purchases is mandatory whenever IAP is offered (Family Sharing +
// reinstall support).
//
// ONE PRICE SHOWN: monthly, matching PlanToggle's own preselected anchor
// cadence. RevenueCat/App Store Connect can sell multiple cadences as
// separate IAP products later; this stub buys whatever
// PLUS_OFFERING_ID resolves to in the RevenueCat dashboard (see
// src/lib/iap.ts) rather than letting the buyer pick a cadence client-side,
// since a native purchase sheet's own price/cadence display is the source of
// truth Apple actually reviews against - this screen's job is the REQUIRED
// disclosure text, not a full picker.
export default function NativePlusCheckout() {
  const [busy, setBusy] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [restored, setRestored] = useState<boolean | null>(null);

  async function onPurchase() {
    tap();
    setBusy(true);
    setError(null);
    try {
      await purchasePlus();
      hapticSuccess();
      // The RevenueCat webhook (src/app/api/iap/webhook/route.ts) writes the
      // subscriptions row a moment later; refresh so ownsPlus() picks it up,
      // same pattern the Stripe web checkout's ?welcome=1 redirect uses.
      window.location.href = "/plus?welcome=1";
    } catch (err) {
      setBusy(false);
      if (err instanceof IapUnavailableError) {
        setError(err.message);
      } else if (err && typeof err === "object" && "userCancelled" in err) {
        // RevenueCat rejects with { userCancelled: true } when the person
        // dismisses the native purchase sheet - not a real error.
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
      setRestored(entitlements.plus);
      if (entitlements.plus) {
        window.location.href = "/plus?welcome=1";
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
        <p className="text-lg font-medium text-bark-700 dark:text-stone-300">
          OakTend Plus
        </p>
        <p className="text-2xl font-semibold text-stone-900 dark:text-stone-100">
          {formatUsd(PLUS_PLAN.monthly)}
          <span className="text-base font-normal text-stone-500 dark:text-stone-400">
            /month
          </span>
        </p>
        <p className="text-sm text-stone-600 dark:text-stone-300">
          {PLUS_PLAN.trialDays} days free, then {formatUsd(PLUS_PLAN.monthly)}{" "}
          a month. Renews automatically until you cancel.
        </p>

        {/* Apple-required auto-renewal disclosure block: price, period, and
            plain auto-renew language, plus Terms/Privacy links, all visible
            before the purchase button below. */}
        <div className="rounded-xl border border-stone-200 bg-stone-50 p-3 text-left text-xs text-stone-600 max-sm:text-sm dark:border-white/10 dark:bg-stone-900 dark:text-stone-300">
          <p>
            OakTend Plus automatically renews at {formatUsd(PLUS_PLAN.monthly)}
            {" "}per month unless auto-renew is turned off at least 24 hours
            before the end of the current period. Manage or cancel your
            subscription anytime in your {" "}
            <span className="font-medium text-stone-900 dark:text-stone-100">
              Settings &gt; Apple ID &gt; Subscriptions
            </span>{" "}
            (iOS) or the Play Store&apos;s Subscriptions page (Android). Payment is
            charged to your store account at confirmation of purchase.
          </p>
          {/* Trial eligibility is decided by the STORE, not by OakTend: an
              Apple ID or Google account that already used the introductory
              offer is charged straight away. Saying so here keeps the button
              copy above from reading as a promise the store may not keep,
              which is the kind of subscription-disclosure mismatch App Review
              rejects under 3.1.2. */}
          <p className="mt-2">
            The free days are the App Store or Play Store introductory offer and
            apply to first-time subscribers only. If your store account has used
            it before, billing starts at purchase.
          </p>
          <p className="mt-2">
            <Link href="/terms" className="underline hover:text-stone-900 dark:hover:text-stone-100">
              Terms of Use
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
          {busy ? "Starting…" : `Start ${PLUS_PLAN.trialDays} free days`}
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
