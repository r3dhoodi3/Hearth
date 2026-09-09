"use client";

import { isNativeApp } from "@/lib/platform";

// =============================================================================
// IN-APP PURCHASE ABSTRACTION (RevenueCat), 2026-09-07, appstore-execute.
//
// This is the ONLY place OakTend's UI code should import
// @revenuecat/purchases-capacitor from. Everything else (PlanToggle,
// ProPlanToggle, the future paywall components) calls the plain functions
// below, which:
//   - on native (isNativeApp() true): call into the real RevenueCat SDK.
//   - on web: no-op / reject with a clear, typed error, so a stray import or
//     a misrouted call never silently pretends to succeed in a browser tab.
//
// WHY REVENUECAT INSTEAD OF HAND-ROLLING APPLE/GOOGLE RECEIPT VERIFICATION.
// RevenueCat verifies the StoreKit 2 / Play Billing receipt server-side and
// posts a normalized webhook event to src/app/api/iap/webhook/route.ts, which
// writes the same `subscriptions` table shape the Stripe webhook writes (see
// that route for the mapping). That means every existing "is this user Plus/
// Pro" gate in the app (ownsPlus(), isLiveProPlanRow(), etc. in
// src/lib/subscription.ts) keeps working unmodified: it has no idea whether
// the row came from Stripe or RevenueCat, and it does not need to.
//
// ENTITLEMENT IDENTIFIERS. RevenueCat's dashboard maps store products to
// "entitlements" - a project-level concept, not tied to one product id. These
// two identifiers are what OakTend's RevenueCat project must name its two
// entitlements (Landen sets this up when creating the RevenueCat account -
// see docs/APP-STORE-SUBMISSION.md). Getting the identifier right on both
// ends (here and in the RevenueCat dashboard) is required for
// getEntitlements() below to mean anything.
export const PLUS_ENTITLEMENT_ID = "oaktend_plus";
export const PRO_ENTITLEMENT_ID = "oaktend_pro";

// RevenueCat "offering"/"package" identifiers this app requests. Configured
// in the RevenueCat dashboard against the real App Store Connect / Play
// Console product ids - this file never hardcodes a raw product id, only the
// RevenueCat-side names, so a price or SKU change never touches this code.
export const PLUS_OFFERING_ID = "oaktend_plus";
export const PRO_OFFERING_ID = "oaktend_pro";

export class IapUnavailableError extends Error {
  constructor(action: string) {
    super(
      `${action} is only available in the OakTend app on iOS or Android, not on the web. Use the web checkout instead.`
    );
    this.name = "IapUnavailableError";
  }
}

type RevenueCatModule = typeof import("@revenuecat/purchases-capacitor");

let rcModulePromise: Promise<RevenueCatModule> | null = null;
function loadRevenueCat(): Promise<RevenueCatModule> {
  if (!rcModulePromise) {
    rcModulePromise = import("@revenuecat/purchases-capacitor");
  }
  return rcModulePromise;
}

let configured = false;
// The app_user_id the SDK is currently running as, so a sign-in by a DIFFERENT
// account on the same device re-points RevenueCat instead of leaving purchases
// attributed to the previous person.
let configuredUserId: string | null = null;

// Call once, as early as possible on native (src/lib/native/bootstrap.ts).
// appUserId is the OakTend/Supabase user id - the SAME id used everywhere
// else in the app, so RevenueCat's app_user_id in its webhook payload maps
// 1:1 onto subscriptions.user_id with no separate identity table. Safe to
// call again with a different id (e.g. after sign-in) - RevenueCat's SDK
// treats a re-configure with a new appUserID as a logIn.
export async function configurePurchases(appUserId: string): Promise<void> {
  if (!isNativeApp()) return;
  const apiKey =
    // NEXT_PUBLIC_ because this key is read client-side, same as Stripe's
    // publishable key - RevenueCat's public SDK key is designed to be
    // embedded in a shipped app binary (it can only start a purchase flow,
    // never read or grant entitlements on its own; the WEBHOOK secret,
    // REVENUECAT_WEBHOOK_SECRET, is what actually grants access and stays
    // server-only - see the webhook route and .env.local.example).
    process.env.NEXT_PUBLIC_REVENUECAT_IOS_API_KEY ||
    process.env.NEXT_PUBLIC_REVENUECAT_ANDROID_API_KEY;
  if (!apiKey) {
    console.warn(
      "configurePurchases: no NEXT_PUBLIC_REVENUECAT_*_API_KEY set - RevenueCat is dormant. See .env.local.example."
    );
    return;
  }
  const { Purchases, LOG_LEVEL } = await loadRevenueCat();
  await Purchases.setLogLevel({ level: LOG_LEVEL.WARN });
  if (configured && configuredUserId && configuredUserId !== appUserId) {
    // Already running as somebody else on this device (account switch without
    // a full app relaunch). logIn re-points the SDK at the new app_user_id;
    // calling configure() again in that state is not guaranteed to move it,
    // and a purchase attributed to the PREVIOUS account is money landing on
    // the wrong subscriptions row.
    await Purchases.logIn({ appUserID: appUserId });
  } else {
    await Purchases.configure({ apiKey, appUserID: appUserId });
  }
  configured = true;
  configuredUserId = appUserId;
}

/**
 * Detach the SDK from the signed-out account (RevenueCat falls back to an
 * anonymous id). Called when the session ends so a purchase made by whoever
 * signs in next cannot be attributed to the person who just left - the same
 * shared-device concern the app's own sign-out already handles for cookies.
 */
export async function logOutPurchases(): Promise<void> {
  if (!isNativeApp() || !configured) return;
  try {
    const { Purchases } = await loadRevenueCat();
    await Purchases.logOut();
  } catch {
    // Best effort: an SDK that is already anonymous throws, and there is
    // nothing useful to tell the user about it.
  }
  configuredUserId = null;
}

async function ensureConfigured(): Promise<void> {
  if (!isNativeApp()) throw new IapUnavailableError("Purchases");
  if (!configured) {
    throw new Error(
      "RevenueCat is not configured yet. configurePurchases(userId) must run before purchasePlus()/restorePurchases()."
    );
  }
}

/** Which paid entitlements (if any) the signed-in device currently holds. */
export async function getEntitlements(): Promise<{
  plus: boolean;
  pro: boolean;
}> {
  if (!isNativeApp()) return { plus: false, pro: false };
  await ensureConfigured();
  const { Purchases } = await loadRevenueCat();
  const { customerInfo } = await Purchases.getCustomerInfo();
  const active = customerInfo.entitlements.active ?? {};
  return {
    plus: Boolean(active[PLUS_ENTITLEMENT_ID]),
    pro: Boolean(active[PRO_ENTITLEMENT_ID]),
  };
}

// Buys the first package on the named offering. OakTend's paywall UI (unlike
// RevenueCat's own hosted Paywalls product, which this app does not use) is
// the same custom cards PlanToggle/ProPlanToggle already render, so this
// stays a plain "buy the thing" call rather than a full offering picker - the
// cadence choice happens on OakTend's own UI, and offeringId picks the right
// RevenueCat offering (Plus vs Pro) for it. If OakTend later sells multiple
// cadences as separate IAP products (weekly/monthly/yearly, mirroring the web
// pricing), this can take a `packageId` param to select among an offering's
// packages instead of always taking the first.
async function purchaseOffering(offeringId: string): Promise<void> {
  await ensureConfigured();
  const { Purchases } = await loadRevenueCat();
  const offerings = await Purchases.getOfferings();
  const offering = offerings.all[offeringId] ?? offerings.current;
  const pkg = offering?.availablePackages?.[0];
  if (!pkg) {
    throw new Error(
      `No RevenueCat package found for offering "${offeringId}". Check the RevenueCat dashboard has this offering configured with at least one package attached.`
    );
  }
  await Purchases.purchasePackage({ aPackage: pkg });
  // Deliberately not reading the purchase result's customerInfo to decide
  // "is Plus now": the RevenueCat webhook writing the subscriptions row is
  // the single source of truth every other gate reads (see the module
  // comment). This call resolving without throwing means the store sheet
  // completed; the UI should show a pending/confirming state and let the
  // webhook (which usually lands within seconds) be what flips ownsPlus()/
  // isLiveProPlanRow() to true, exactly like the Stripe webhook already does
  // for the web checkout->?welcome=1 flow.
}

export async function purchasePlus(): Promise<void> {
  await purchaseOffering(PLUS_OFFERING_ID);
}

export async function purchasePro(): Promise<void> {
  await purchaseOffering(PRO_OFFERING_ID);
}

/**
 * Required by Apple/Google whenever IAP is offered (App Store Connect
 * guideline on subscriptions, Family Sharing note in the research report).
 * Re-links any past purchase on this Apple ID/Google account to the current
 * app_user_id without a new charge.
 */
export async function restorePurchases(): Promise<{ plus: boolean; pro: boolean }> {
  await ensureConfigured();
  const { Purchases } = await loadRevenueCat();
  const { customerInfo } = await Purchases.restorePurchases();
  const active = customerInfo.entitlements.active ?? {};
  return {
    plus: Boolean(active[PLUS_ENTITLEMENT_ID]),
    pro: Boolean(active[PRO_ENTITLEMENT_ID]),
  };
}
