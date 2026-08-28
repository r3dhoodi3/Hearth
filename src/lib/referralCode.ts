import "server-only";
import { randomInt } from "crypto";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isMissingSchemaError } from "@/lib/dbErrors";

// The current homeowner's personal invite slug (users.referral_code, migration
// 0099), generated LAZILY the first time it is actually needed - the share
// moment after a review, or the "Invite a neighbor" card on /account. Most
// users never generate one, so this is deliberately not backfilled at signup.
//
// v1 is pure neighbor-to-neighbor sharing: this code identifies the inviter in
// a /homeowner-signup?ref=CODE link and nothing more. No reward, no wallet.
//
// Every failure mode returns null rather than throwing: a share button that
// can't produce a link just doesn't appear, but nothing in the review or
// account flow ever breaks because of it. A live DB that hasn't run 0099 yet
// (the column is missing) is one such silent-null case.

// 8 chars from an unambiguous, all-uppercase alphabet: no 0/O, no 1/I/L, so a
// code read off a screen or said aloud can't be mistyped. 32^8 is ~1.1e12
// combinations, far past any collision or guessing concern at this scale.
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 8;

function generateCode(): string {
  let out = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    out += ALPHABET[randomInt(ALPHABET.length)];
  }
  return out;
}

// referral_code / referred_by aren't in src/lib/database.types.ts (not
// regenerated for 0099), so every query touching them is cast to any - the
// same convention claimPropertyAction and the other post-migration writers use.
export async function getOrCreateReferralCode(): Promise<string | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  try {
    // Already generated? Return it - the common case after the first share.
    const { data: existing, error: readErr } = await (supabase.from("users") as any)
      .select("referral_code")
      .eq("id", user.id)
      .maybeSingle();
    if (readErr) return null; // includes missing-column on a pre-0099 DB
    if (existing?.referral_code) return existing.referral_code as string;

    // Generate one. The UPDATE is guarded by `referral_code is null`, so two
    // concurrent first-time requests can't both win: the second matches zero
    // rows and re-reads whatever the first committed. A candidate that happens
    // to collide with ANOTHER user's code trips the unique index (23505) and
    // we simply try a fresh candidate.
    //
    // WRITTEN WITH THE ADMIN CLIENT, read with the caller's. Migration 0139
    // locks referral_code / referred_by against any non-service-role update:
    // an account that can rewrite its own invite code (or who invited it) is
    // an account that can rewrite an attribution record, which is harmless
    // today and a payout bug the day a reward ships. The id is still the
    // VERIFIED session's user.id from getUser() above, never anything the
    // browser supplied, and `.eq("id", user.id)` keeps the write on that one
    // row - so the elevated client buys exactly one thing: permission to set
    // this column, on this caller's own row.
    const admin = createAdminClient();
    for (let attempt = 0; attempt < 6; attempt++) {
      const candidate = generateCode();
      const { data, error } = await (admin.from("users") as any)
        .update({ referral_code: candidate })
        .eq("id", user.id)
        .is("referral_code", null)
        .select("referral_code")
        .maybeSingle();

      if (!error && data?.referral_code) return data.referral_code as string;

      // Candidate collided with a different user's existing code: retry.
      if (error && (error as { code?: string }).code === "23505") continue;

      // Column/table missing on a live DB that hasn't run 0099: feature off.
      if (error && isMissingSchemaError(error)) return null;

      // No error but no row updated => a concurrent request set our code
      // between the read and this update. Re-read the winner and use it.
      if (!error && !data) {
        const { data: now } = await (supabase.from("users") as any)
          .select("referral_code")
          .eq("id", user.id)
          .maybeSingle();
        if (now?.referral_code) return now.referral_code as string;
      }

      // Any other error: give up quietly rather than loop on a real fault.
      if (error) return null;
    }
    return null;
  } catch {
    return null;
  }
}
