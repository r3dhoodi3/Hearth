"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requestOriginFromHeaders } from "@/lib/requestOrigin";
import { setFlash } from "@/lib/flash";
import { type ActionResult, ok, err } from "@/lib/actionResult";

const HOUSEHOLD_PATH = "/account/household";
const MAX_MEMBERS_PER_HOME = 4;

// Every QR token lives exactly this long, unless a scanner opens the join
// link while it's still valid: /join/household/[token] then extends it to a
// flat 30 minute grace window, once, via a conditional update (migration
// 0097). Kept in one place so the mint action, the static refresh label
// (HouseholdQrCode.tsx), and this comment can't drift apart.
const QR_TOKEN_LIFETIME_SECONDS = 5 * 60;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Invite someone to share day to day access to a home the caller owns. RLS's
// "household_members owner insert" policy re-checks ownership server side, so
// this validation is about friendly error messages, not the real gate.
export async function inviteMemberAction(formData: FormData) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/signin");

  const propertyId = (formData.get("property_id") as string) || "";
  // NOT sliced to a ceiling like other free-text fields: this address is mailed
  // an invite, and a truncated address still has an "@" and would reach a
  // stranger, so an over-length value is REJECTED below rather than trimmed.
  const email = ((formData.get("email") as string) || "").trim().toLowerCase();

  if (!propertyId) {
    setFlash("Choose a home to invite someone to.", "error");
    redirect(HOUSEHOLD_PATH);
  }
  if (!EMAIL_RE.test(email) || email.length > 254) {
    setFlash("Enter a valid email address.", "error");
    redirect(HOUSEHOLD_PATH);
  }
  if (user.email && email === user.email.trim().toLowerCase()) {
    setFlash("You can't invite yourself.", "error");
    redirect(HOUSEHOLD_PATH);
  }

  // App side cap: count invited plus active rows on this home before insert.
  const { count, error: countError } = await supabase
    .from("household_members")
    .select("id", { count: "exact", head: true })
    .eq("property_id", propertyId);
  if (countError) {
    setFlash("Couldn't send the invite. Please try again.", "error");
    redirect(HOUSEHOLD_PATH);
  }
  if ((count ?? 0) >= MAX_MEMBERS_PER_HOME) {
    setFlash(
      `This home already has the maximum of ${MAX_MEMBERS_PER_HOME} members.`,
      "error"
    );
    redirect(HOUSEHOLD_PATH);
  }

  // An invite sends mail to an address the caller typed, so an unlimited invite
  // loop is a way to send mail to strangers with Hearth's name on it. The
  // per-home member cap above doesn't stop that on its own: a rejected or
  // deleted invite frees the slot again. Charged HERE, immediately before the
  // insert and only after every cheap check (property, email shape, not-self,
  // cap) has passed, so a mistyped or self-addressed invite never burns a slot.
  // Same fixed-window limiter (migration 0068) and same fail-open posture as
  // the rest of the spam-class buckets - only an explicit `allowed === false`
  // blocks - so a limiter outage never stops a real homeowner from adding their
  // partner.
  const rlAdmin = createAdminClient();
  const { data: allowed } = await rlAdmin.rpc("rate_limit_hit", {
    p_bucket: `invite:${user.id}`,
    p_limit: 10,
    p_window_seconds: 86400,
  });
  if (allowed === false) {
    setFlash(
      "You've sent a lot of invites today. Please try again tomorrow.",
      "error"
    );
    redirect(HOUSEHOLD_PATH);
  }

  const { error } = await supabase.from("household_members").insert({
    property_id: propertyId,
    invited_email: email,
    invited_by: user.id,
  });

  if (error) {
    // 23505: the unique index on (property_id, lower(invited_email)) caught a
    // duplicate invite, either already pending or already an active member.
    if (error.code === "23505") {
      setFlash("That email has already been invited to this home.", "error");
    } else {
      setFlash("Couldn't send the invite. Please try again.", "error");
    }
    redirect(HOUSEHOLD_PATH);
  }

  setFlash(
    `Invited ${email}. If they don't have a Hearth account yet, the invite waits until they sign up with that email.`
  );
  revalidatePath(HOUSEHOLD_PATH);
  redirect(HOUSEHOLD_PATH);
}

// Remove a member or cancel a pending invite. Only the property's owner can
// reach a row that still belongs to someone else, enforced by the
// "household_members owner delete" policy.
export async function removeMemberAction(formData: FormData) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/signin");

  const id = (formData.get("id") as string) || "";
  const { error } = await supabase.from("household_members").delete().eq("id", id);
  if (error) {
    setFlash("Couldn't remove that person. Please try again.", "error");
    redirect(HOUSEHOLD_PATH);
  }
  setFlash("Removed from the home.");
  revalidatePath(HOUSEHOLD_PATH);
  redirect(HOUSEHOLD_PATH);
}

// Accept an invite addressed to the caller's own email. The
// "household_members invitee claim" policy is what actually enforces that
// this can only move a legitimate invite (status invited, no member yet, the
// caller's own email) into an active membership tied to the caller's uid.
export async function acceptInviteAction(formData: FormData) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/signin");

  const id = (formData.get("id") as string) || "";
  const { error } = await supabase
    .from("household_members")
    .update({
      status: "active",
      member_user_id: user.id,
      accepted_at: new Date().toISOString(),
    })
    .eq("id", id);
  if (error) {
    setFlash("Couldn't accept that invite. Please try again.", "error");
    redirect(HOUSEHOLD_PATH);
  }
  setFlash("You're in. That home now shows up in your homes list.");
  revalidatePath("/", "layout");
  redirect(HOUSEHOLD_PATH);
}

// Decline an invite before claiming it, covered by the
// "household_members invitee decline" policy.
export async function declineInviteAction(formData: FormData) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/signin");

  const id = (formData.get("id") as string) || "";
  const { error } = await supabase.from("household_members").delete().eq("id", id);
  if (error) {
    setFlash("Couldn't decline that invite. Please try again.", "error");
    redirect(HOUSEHOLD_PATH);
  }
  setFlash("Invite declined.");
  revalidatePath(HOUSEHOLD_PATH);
  redirect(HOUSEHOLD_PATH);
}

// Leave a home the caller is an active member of, covered by the
// "household_members member leave" policy (member_user_id = auth.uid()).
export async function leaveHomeAction(formData: FormData) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/signin");

  const id = (formData.get("id") as string) || "";
  const { error } = await supabase.from("household_members").delete().eq("id", id);
  if (error) {
    setFlash("Couldn't leave that home. Please try again.", "error");
    redirect(HOUSEHOLD_PATH);
  }
  setFlash("You've left that home.");
  revalidatePath("/", "layout");
  redirect(HOUSEHOLD_PATH);
}

// ---- QR invites (migrations 0095, 0097) -------------------------------------
//
// A second way to reach the exact same household_members row the invite/
// accept flow above produces: the owner shows a QR code, someone scans it
// and lands on /join/household/[token], and redeem_household_invite_token()
// (SECURITY DEFINER, runs as the joiner's own session) does the insert -
// same cap, same one-row-per-property-per-email constraint, idempotent for
// an already-active member. This action only ever mints the token; it never
// touches household_members itself.
//
// TTL: 5 minutes from mint. If the link is opened while still valid, the
// join page extends it once to a 30 minute grace window (scanned_at,
// migration 0097), so a real signup + onboarding flow has room to finish
// without getting kicked out just for taking longer than 5 minutes.
export interface HouseholdQrToken {
  token: string;
  joinUrl: string;
  expiresAt: string;
}

// Called directly (not as a <form action>) from the household tab's client
// component on mount, and again every time its current token silently
// expires (no visible countdown, see HouseholdQrCode.tsx). Returns a typed
// ActionResult (src/lib/actionResult.ts) rather than throwing, since the
// caller is a client component that needs to keep the tab's layout in place
// and show the failure inline, not an unhandled rejection or a thrown error
// that would otherwise surface as a generic error boundary.
export async function mintHouseholdQrTokenAction(
  propertyId: string
): Promise<ActionResult<HouseholdQrToken>> {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return err("Please sign in.");

    // Owner only - a household member must not be able to mint invites for a
    // home they don't own, matching 0048's "a member cannot ... invite
    // anyone else." Checked against the row's actual user_id, not just
    // whether the select succeeds: RLS's "properties member select" policy
    // (0048) lets a member read this same row, so a successful select alone
    // isn't proof of ownership.
    const { data: property, error: propertyError } = await supabase
      .from("properties")
      .select("id, user_id")
      .eq("id", propertyId)
      .maybeSingle();
    if (propertyError || !property || property.user_id !== user.id) {
      return err("You can only invite people to a home you own.");
    }

    const admin = createAdminClient();
    const expiresAt = new Date(Date.now() + QR_TOKEN_LIFETIME_SECONDS * 1000);

    // Self-cleanup: drop this owner's previous, UNSCANNED-or-expired tokens
    // for THIS home before minting a fresh one, so the table can't quietly
    // accumulate stale rows. No cron needed.
    //
    // Deliberately spares a token someone has already scanned and is still
    // inside its grace window (scanned_at set, expires_at in the future,
    // migration 0097): the household tab re-mints every 5 minutes on its
    // own auto-refresh timer, and an unconditional delete here would yank a
    // scanned token out from under someone mid-signup, kicking them out for
    // a reason that has nothing to do with anything they did. A scanned,
    // still-live token is left alone and simply expires on its own 30
    // minute clock; only a never-opened or already-expired token gets swept
    // on every re-mint.
    const nowIso = new Date().toISOString();
    const { error: cleanupError } = await admin
      .from("household_invite_tokens")
      .delete()
      .eq("created_by", user.id)
      .eq("property_id", propertyId)
      .or(`scanned_at.is.null,expires_at.lte.${nowIso}`);
    if (cleanupError) {
      console.error("mintHouseholdQrTokenAction: cleanup failed", cleanupError);
      return err("Couldn't create an invite code. Try again.");
    }

    const { data: inserted, error: insertError } = await admin
      .from("household_invite_tokens")
      .insert({
        property_id: propertyId,
        created_by: user.id,
        expires_at: expiresAt.toISOString(),
      })
      .select("token, expires_at")
      .single();
    if (insertError || !inserted) {
      console.error("mintHouseholdQrTokenAction: insert failed", insertError);
      return err("Couldn't create an invite code. Try again.");
    }

    // Absolute URL built from the Host header (requestOriginFromHeaders),
    // not NEXT_PUBLIC_SITE_URL or a hardcoded host: the code is read by a
    // phone camera, sometimes off a screenshot, so it must resolve to
    // whatever host this request actually came in on (localhost while
    // developing, the LAN IP, a tunnel, or the real domain in prod) - same
    // reasoning as requestOrigin() itself.
    const origin = await requestOriginFromHeaders();
    return ok({
      token: inserted.token,
      joinUrl: `${origin}/join/household/${inserted.token}`,
      expiresAt: inserted.expires_at,
    });
  } catch (e) {
    // Last-resort net: anything above this line that throws instead of
    // returning an `error` field (a network blip calling Supabase, a
    // missing Host header) still comes back as a typed failure, never an
    // unhandled rejection the client component would have to guess about.
    console.error("mintHouseholdQrTokenAction: unexpected failure", e);
    return err("Couldn't create an invite code. Try again.");
  }
}
