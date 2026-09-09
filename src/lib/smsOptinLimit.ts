import type { createAdminClient } from "@/lib/supabase/admin";

// =============================================================================
// OakTend - per-user rate limit on the SMS opt-in confirmation text.
//
// users.phone is unverified and freely editable (see the header comment on
// src/lib/privacy.ts for the same fact biting a different feature), so the
// SMS opt-in checkbox on the homeowner account page (saveAccountAction, see
// src/app/(app)/account/actions.ts) and its pro-side twin (saveProSmsConsent,
// see src/app/pro/actions.ts) both let someone repeatedly toggle consent off
// and on to fire the "you're opted in" confirmation text at whatever number
// is currently entered - including a number that belongs to someone else.
//
// This is the one shared check both call sites run immediately before that
// send, so the two stay identical rather than drifting into two different
// limits. Same fixed-window rate_limit_hit RPC (migration 0070) the rest of
// the codebase already uses (see src/lib/aiUsage.ts's countAskUsage), on a
// TWO buckets, both must pass: one keyed to the account (the thing doing the
// toggling; a number-only limit would reset every time the attacker typed a
// new one) and one keyed to the normalized phone number (so a stranger's
// number cannot be hit 2 more times from every fresh free account - red
// team, 2026-09-03).
//
// Fails CLOSED, same direction as every other abuse-shaped counter in this
// codebase: an RPC outage must not hand out unmetered texts to an arbitrary
// number. The one exposure that closes is the confirmation text itself; the
// consent flag is still saved either way, so the account owner never loses
// their actual preference over a limiter hiccup.
// =============================================================================

const SMS_OPTIN_LIMIT = 2;
const SMS_OPTIN_WINDOW_SECONDS = 24 * 60 * 60;

export function smsOptinBucket(userId: string): string {
  return `sms_optin:${userId}`;
}

export function smsOptinPhoneBucket(phone: string): string {
  return `sms_optin_phone:${phone.replace(/\D/g, "")}`;
}

// Call this immediately before sending the opt-in confirmation, on the same
// admin client the caller already holds. Returns true only when the send may
// proceed; every other outcome (limit hit, RPC error) returns false and has
// already logged why.
export async function smsOptinConfirmationAllowed(
  admin: ReturnType<typeof createAdminClient>,
  userId: string,
  phone: string
): Promise<boolean> {
  try {
    for (const bucket of [smsOptinBucket(userId), smsOptinPhoneBucket(phone)]) {
      const { data: allowed, error } = await admin.rpc("rate_limit_hit", {
        p_bucket: bucket,
        p_limit: SMS_OPTIN_LIMIT,
        p_window_seconds: SMS_OPTIN_WINDOW_SECONDS,
      });
      if (error) throw error;
      if (allowed === false) {
        console.warn(
          `smsOptinConfirmationAllowed: rate limit hit on ${bucket.split(":")[0]} for user ${userId}, skipping send`
        );
        return false;
      }
    }
    return true;
  } catch (err) {
    console.warn(
      "smsOptinConfirmationAllowed: rate_limit_hit failed, failing closed:",
      err
    );
    return false;
  }
}
