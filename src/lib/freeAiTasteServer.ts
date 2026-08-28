import { createAdminClient } from "@/lib/supabase/admin";
import { isMissingSchemaError } from "@/lib/dbErrors";
import {
  FREE_TASTE_COLUMN,
  FREE_TASTE_LIMIT,
  type FreeAiFeature,
} from "@/lib/freeAiTaste";

// The database half of the free AI taste (see src/lib/freeAiTaste.ts for what
// the taste is and why). Service-role only, so it never ships to the browser.
//
// HOW A TASTE IS SPENT. Claimed ATOMICALLY up front through
// claim_free_ai_taste (migration 0135) and handed back through
// refund_free_ai_taste if the model call never produces a result. That
// ordering is deliberate, and it is the same trade the quote analyzer and the
// chat already make:
//
//  - Claiming up front is the only race-proof option. A check-then-increment
//    around a 60 second model call lets two tabs both pass the same check and
//    each spend a taste that was not there, which is a free account with no
//    limit at all if you can arrange it reliably.
//  - Refunding on failure is what keeps the promise the UI makes. A blurry
//    photo, a thrown request, or a ceiling above the caller must never burn a
//    taste, exactly like refundAskUsage / refundAiUsage in src/lib/aiUsage.ts.
//
// The net effect on the counter is identical to incrementing after a success;
// the difference is that the race window is closed rather than merely narrow.
//
// FAILS OPEN FOR EXACTLY ONE ERROR, and fails CLOSED for every other.
//
// The one: migration 0135 is not live yet, so the column and the function do
// not exist and every claim errors with a missing-schema shape
// (isMissingSchemaError in src/lib/dbErrors.ts - 42703/42P01/PGRST202/
// PGRST204/PGRST205 and their "not found in the schema cache" wording). Failing
// closed there would take a working, previously free feature away from every
// free account until someone pastes SQL, and would tell people they had spent
// a taste the database cannot prove they spent (the same reasoning as the FAIL
// OPEN in src/app/(app)/quote-check/page.tsx). That window is bounded: it shuts
// the moment the migration lands.
//
// Everything else - a timeout, a connection failure, a permission error, a
// future rename of the RPC - now REFUSES with the same 402 the routes already
// show at the paywall. A blip that silently disabled the gate forever, with a
// console.error nobody reads as the only symptom, was the actual risk here: it
// is the one failure mode that costs real money on the paid vision model and
// announces nothing. Cost is still additionally bounded by the per-user daily
// cap, the burst window, and the owner-wide spend breakers, all of which fail
// CLOSED as before.
//
// The fail-open is logged ONCE PER PROCESS at warn level, naming 0135, so a
// pending migration is one loud line at the top of the log rather than a
// console.error per request that reads like noise.

// How many tastes this account has left, for the meter only. Returns null for
// a Plus/trialing account (no meter is shown at all) and null when the counter
// cannot be read, in which case the UI shows nothing rather than a guess - the
// same posture askRemaining takes in src/lib/aiUsage.ts.
export async function freeTastesLeft(
  userId: string,
  isPlus: boolean,
  feature: FreeAiFeature
): Promise<number | null> {
  if (isPlus) return null;
  const limit = FREE_TASTE_LIMIT[feature];
  const column = FREE_TASTE_COLUMN[feature];
  try {
    const admin = createAdminClient();
    // Cast: the two columns are migration 0135 and src/lib/database.types.ts
    // carries them by hand, the same convention the rest of the app uses for
    // post-0029 columns.
    const { data, error } = await (admin as any)
      .from("users")
      .select(column)
      .eq("id", userId)
      .maybeSingle();
    if (error || !data) return null;
    const used = Number(data[column] ?? 0);
    if (!Number.isFinite(used)) return null;
    return Math.max(0, limit - used);
  } catch {
    return null;
  }
}

// Whether this process has already said 0135 is missing. One line per process,
// not one per request: the message is an operator instruction ("go paste the
// SQL"), and repeating it per request buries it.
let warnedMissingMigration = false;

function warnMissingMigrationOnce(feature: FreeAiFeature, err: unknown): void {
  if (warnedMissingMigration) return;
  warnedMissingMigration = true;
  console.warn(
    `free AI tastes are NOT being metered: claim_free_ai_taste is missing, so migration 0135 is not applied to this database. ` +
      `Failing OPEN for ${feature} until it is. Paste supabase/PASTE-ME-live-2026-08-28-free-ai-tastes.sql to close the gate.`,
    err
  );
}

// Spend one taste, atomically, or report that this account is out.
//
// `allowed` is what the route gates on. `claimed` says whether a counter
// actually moved, so the caller knows whether there is anything to refund; a
// Plus account and a fail-open both come back allowed with claimed false.
export async function claimFreeTaste(
  userId: string,
  isPlus: boolean,
  feature: FreeAiFeature
): Promise<{ allowed: boolean; claimed: boolean }> {
  // Plus and trialing accounts never touch the counter.
  if (isPlus) return { allowed: true, claimed: false };

  try {
    const admin = createAdminClient();
    const { data, error } = await admin.rpc("claim_free_ai_taste", {
      p_user: userId,
      p_feature: feature,
      p_limit: FREE_TASTE_LIMIT[feature],
    });
    if (error) throw error;
    // The function returns a plain boolean: true means this request got one.
    if (data === true) return { allowed: true, claimed: true };
    return { allowed: false, claimed: false };
  } catch (err) {
    // The ONE fail-open: the function/column is not on this database yet.
    // isMissingSchemaError reads both a PostgREST error object and a thrown
    // Error's message, so a missing RPC (PGRST202, "Could not find the function
    // ... in the schema cache") is caught either way. See the header.
    if (isMissingSchemaError(err as { code?: string; message?: string })) {
      warnMissingMigrationOnce(feature, err);
      return { allowed: true, claimed: false };
    }
    // Everything else FAILS CLOSED. The caller turns this into the same 402
    // and the same paywall sentence a used-up allowance gets, so nobody meets
    // a stack trace and nobody gets a free run at the paid model because the
    // database hiccuped.
    console.error(
      `claim_free_ai_taste failed for ${feature} - failing CLOSED:`,
      err
    );
    return { allowed: false, claimed: false };
  }
}

// Hand a claimed taste back. Best effort, exactly like refundAiUsage: it never
// throws and never blocks the response, since the outcome the caller is about
// to report is already decided. A no-op when nothing was claimed.
export async function refundFreeTaste(
  userId: string,
  feature: FreeAiFeature,
  claimed: boolean
): Promise<void> {
  if (!claimed) return;
  try {
    const admin = createAdminClient();
    const { error } = await admin.rpc("refund_free_ai_taste", {
      p_user: userId,
      p_feature: feature,
    });
    if (error) throw error;
  } catch (err) {
    console.error(`refund_free_ai_taste failed for ${feature}:`, err);
  }
}
