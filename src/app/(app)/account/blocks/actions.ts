"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isMissingSchemaError } from "@/lib/dbErrors";
import { err, ok, type ActionResult } from "@/lib/actionResult";

// Blocking (migration 0138). Two actions, one rule: the caller is always the
// BLOCKER, taken from the session and never from the form.
//
// The form never names the person being blocked either. It names a THING the
// caller is already looking at - a lead they are on, or a contractor profile -
// and this file resolves the other party from it server-side. That is the
// difference between "block whoever this id says" (an IDOR waiting to happen:
// a crafted id would let anyone plant a block between two strangers, silently
// cutting off a competitor's job board) and "block the person on the other end
// of this conversation".
//
// The one place a raw user id IS accepted is unblockUserAction, and it is safe
// there for a different reason: the delete is scoped to blocker_user_id =
// auth.uid() both in the query and in RLS, so the worst a forged id can do is
// delete nothing.

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MAX_REASON = 500;

// Postgres unique_violation. A second block of the same person is not an
// error worth showing anyone - the end state they asked for is the end state
// they already have.
const UNIQUE_VIOLATION = "23505";

const NOT_APPLIED =
  "Blocking isn't switched on yet. Please try again later, or contact us if it keeps happening.";

// Per-account ceiling on new blocks, the same shape reportContentAction uses
// (20/hour on `report:<user>`). A block only affects the two accounts involved,
// so there is little for an attacker here - but it is an authenticated INSERT
// loop with no bound of its own: the UNIQUE constraint stops repeats of the
// SAME pair, not a sweep that blocks every pro on the board one id at a time.
// 30 is far above any honest use (nobody blocks thirty people in an hour) and
// far below a useful sweep.
const BLOCKS_PER_HOUR = 30;

// Both pages that render the list, plus the chat surfaces whose Block control
// reads its own state. Cheap, and it means an unblock is visible on the other
// side of the app without a hard reload.
function revalidateBlockSurfaces() {
  revalidatePath("/account/blocks");
  revalidatePath("/pro/blocks");
}

// The two people on a lead, read with the admin client because neither side
// has an RLS path to the other's row until they are already working together.
// Returns nulls rather than throwing so callers can give their own message.
async function partiesOnLead(
  leadId: string
): Promise<{ homeownerId: string | null; proUserId: string | null }> {
  const admin = createAdminClient();
  const { data: lead } = await admin
    .from("contractor_leads")
    .select("property_id, contractor_id")
    .eq("id", leadId)
    .maybeSingle();
  if (!lead) return { homeownerId: null, proUserId: null };

  const [{ data: property }, { data: pro }] = await Promise.all([
    lead.property_id
      ? admin
          .from("properties")
          .select("user_id")
          .eq("id", lead.property_id)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    lead.contractor_id
      ? admin
          .from("contractors")
          .select("user_id")
          .eq("id", lead.contractor_id)
          .maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  return {
    homeownerId: property?.user_id ?? null,
    proUserId: pro?.user_id ?? null,
  };
}

// Block the other party to something the caller is already part of.
//
// Accepts EITHER:
//   lead_id       - the thread this is being done from. The counterparty is
//                   whichever of the two people on that lead is not the
//                   caller, and a caller who is neither is refused.
//   contractor_id - a pro's public profile. Anyone signed in may block a pro
//                   they can see; the pro's account is resolved from the row.
export async function blockUserAction(
  formData: FormData
): Promise<ActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return err("Please sign in first.");

  const leadId = String(formData.get("lead_id") || "").trim();
  const contractorId = String(formData.get("contractor_id") || "").trim();
  const reason =
    String(formData.get("reason") || "")
      .trim()
      .slice(0, MAX_REASON) || null;

  let targetId: string | null = null;

  if (leadId) {
    if (!UUID_RE.test(leadId)) return err("Couldn't find that conversation.");
    const { homeownerId, proUserId } = await partiesOnLead(leadId);
    if (user.id === homeownerId) targetId = proUserId;
    else if (user.id === proUserId) targetId = homeownerId;
    else {
      // Not a party to this lead. Same message either way, so a crafted id
      // cannot be used to probe which leads exist.
      return err("You can only block someone you're in a conversation with.");
    }
    if (!targetId) {
      return err("There's nobody on the other side of this conversation yet.");
    }
  } else if (contractorId) {
    if (!UUID_RE.test(contractorId)) return err("Couldn't find that pro.");
    const admin = createAdminClient();
    const { data: pro } = await admin
      .from("contractors")
      .select("user_id")
      .eq("id", contractorId)
      .maybeSingle();
    if (!pro?.user_id) return err("Couldn't find that pro.");
    targetId = pro.user_id;
  } else {
    return err("Couldn't tell who to block.");
  }

  if (targetId === user.id) {
    return err("You can't block your own account.");
  }

  // Checked once the target is resolved, so a malformed or unauthorized
  // request cannot spend the budget of the account it is aimed from. Same
  // fixed-window RPC, same fail-open posture as every other rate_limit_hit
  // call in this codebase: a limiter hiccup must not stop someone blocking
  // the person harassing them.
  const { data: withinLimit } = await createAdminClient().rpc("rate_limit_hit", {
    p_bucket: `block:${user.id}`,
    p_limit: BLOCKS_PER_HOUR,
    p_window_seconds: 3600,
  });
  if (withinLimit === false) {
    return err(
      "You've blocked several accounts just now. Please wait a bit before blocking another."
    );
  }

  // The USER'S client, not the admin one: "user_blocks self insert" checks
  // blocker_user_id = auth.uid(), so the database re-checks the ownership
  // rule this function just applied instead of taking its word for it.
  const { error } = await supabase.from("user_blocks").insert({
    blocker_user_id: user.id,
    blocked_user_id: targetId,
    reason,
  });

  if (error) {
    if (error.code === UNIQUE_VIOLATION) {
      // Already blocked. That is the state they wanted.
      revalidateBlockSurfaces();
      return ok();
    }
    if (isMissingSchemaError(error)) {
      console.error("blockUserAction: user_blocks missing (0138)", error);
      return err(NOT_APPLIED);
    }
    console.error("blockUserAction: insert failed", error);
    return err("Couldn't block this person just now. Please try again.");
  }

  revalidateBlockSurfaces();
  return ok();
}

// Remove a block the caller placed. Scoped to the caller twice over: the
// query filters on blocker_user_id = their id, and "user_blocks self delete"
// enforces the same thing in the database, so a forged blocked_user_id
// deletes nothing rather than somebody else's block.
export async function unblockUserAction(
  formData: FormData
): Promise<ActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return err("Please sign in first.");

  const blockedUserId = String(formData.get("blocked_user_id") || "").trim();
  if (!UUID_RE.test(blockedUserId)) {
    return err("Couldn't find that block.");
  }

  const { error } = await supabase
    .from("user_blocks")
    .delete()
    .eq("blocker_user_id", user.id)
    .eq("blocked_user_id", blockedUserId);

  if (error) {
    if (isMissingSchemaError(error)) {
      console.error("unblockUserAction: user_blocks missing (0138)", error);
      return err(NOT_APPLIED);
    }
    console.error("unblockUserAction: delete failed", error);
    return err("Couldn't unblock this person just now. Please try again.");
  }

  revalidateBlockSurfaces();
  return ok();
}
