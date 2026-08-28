import "server-only";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isMissingSchemaError } from "@/lib/dbErrors";

// Read side of blocking (migration 0138). The write side lives in
// src/app/(app)/account/blocks/actions.ts; this file is what pages call.
//
// EVERY read here degrades to "no blocks" when migration 0138 has not been
// applied to the live database yet: user_blocks comes back as a PostgREST 404
// / 42P01, isMissingSchemaError recognises it, and the caller gets an empty
// list instead of a crashed page. Same posture as every other post-0114
// feature in this codebase.

export type BlockedAccount = {
  // The blocked account's auth id. This is what unblockUserAction takes, and
  // it is only ever handed to the browser for rows the caller themselves
  // blocked, so it discloses nothing they did not already know.
  userId: string;
  // Best available human label. Never an email or a phone number: this list
  // is a management screen, not a directory.
  label: string;
  reason: string | null;
  createdAt: string;
};

// A person's name, shortened the way the rest of the app shows other people:
// first name plus a last initial. "Dana Whitfield" -> "Dana W."
function shortName(fullName: string): string {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "";
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.`;
}

// Everyone the signed-in account has blocked, newest first.
//
// The select runs on the USER'S client on purpose, so RLS ("user_blocks self
// select", blocker_user_id = auth.uid()) is the thing that scopes it - not a
// filter this function could get wrong. The admin client is used only to turn
// the resulting ids into labels.
export async function listMyBlocks(): Promise<BlockedAccount[]> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return [];

  const { data, error } = await supabase
    .from("user_blocks")
    .select("blocked_user_id, reason, created_at")
    .order("created_at", { ascending: false });

  if (error) {
    // 0138 not applied yet, or a blip. Either way the honest answer for a
    // list screen is "nothing to show" rather than a 500.
    if (!isMissingSchemaError(error)) {
      console.error("listMyBlocks: read failed", error);
    }
    return [];
  }
  const rows = data ?? [];
  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.blocked_user_id);

  // Labels. ADMIN client for these two reads, deliberately: a homeowner has
  // no RLS path to a pro's contractors row until they are working together,
  // and nobody has a path to another account's users row at all. Only the
  // display name leaves this function - never the email, phone, or any other
  // column these selects touch.
  const admin = createAdminClient();
  const [{ data: pros }, { data: people }] = await Promise.all([
    admin.from("contractors").select("user_id, name").in("user_id", ids),
    admin.from("users").select("id, full_name").in("id", ids),
  ]);

  const businessByUser = new Map<string, string>();
  for (const p of pros ?? []) {
    if (p.user_id && p.name) businessByUser.set(p.user_id, p.name);
  }
  const nameByUser = new Map<string, string>();
  for (const p of people ?? []) {
    if (p.full_name) nameByUser.set(p.id, shortName(p.full_name));
  }

  return rows.map((r) => ({
    userId: r.blocked_user_id,
    label:
      businessByUser.get(r.blocked_user_id) ||
      nameByUser.get(r.blocked_user_id) ||
      "Hearth member",
    reason: r.reason ?? null,
    createdAt: r.created_at,
  }));
}

// Is there a block in either direction between these two accounts?
//
// Mirrors the blocked_between() SQL helper for the one enforcement point that
// cannot live in the database: requestProAction creates a direct request from
// application code, so the gate has to be re-stated there. FAILS OPEN on a
// missing table (0138 not applied) - a request that should have been refused
// is a far smaller problem than every direct request in the product breaking
// because a migration is pending.
export async function isBlockedBetween(
  a: string,
  b: string
): Promise<boolean> {
  if (!a || !b || a === b) return false;
  // Two .in() filters rather than a hand-built .or() string: no user-derived
  // value is ever concatenated into PostgREST filter syntax, and because
  // user_blocks_not_self forbids a self-block, "blocker in {a,b} AND blocked
  // in {a,b}" is exactly the two directions and nothing else.
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("user_blocks")
    .select("id")
    .in("blocker_user_id", [a, b])
    .in("blocked_user_id", [a, b])
    .limit(1);
  if (error) {
    if (!isMissingSchemaError(error)) {
      console.error("isBlockedBetween: read failed", error);
    }
    return false;
  }
  return (data ?? []).length > 0;
}
