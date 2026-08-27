"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getProperties } from "@/lib/property";
import { cappedField, cappedFieldOrNull, FIELD_MAX } from "@/lib/formFields";
import { setFlash } from "@/lib/flash";

const FEEDBACK_PATH = "/feedback";

type ReviewPromptKind = "prompt_shown" | "loved" | "not_really";

// What ReviewPrompt.tsx (mounted once in src/app/(app)/layout.tsx) needs to
// decide whether to show itself. Server-only because app_feedback has no
// select policy for `authenticated` (migration 0133) - the account cannot
// read its own "have I been asked before" state from the browser even if it
// tried, on purpose, so this is the one supported way to answer that.
//
// Returns null when there is no signed-in user (shouldn't happen inside the
// (app) shell, but the caller treats null the same as "not eligible").
export async function getReviewPromptSignals(): Promise<{
  alreadyShownOrAnswered: boolean;
  hasMeaningfulActivity: boolean;
} | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  try {
    // Any event row at all - shown, loved, or not_really - means never ask
    // again. This is what makes dismissing with the X "count as answered":
    // the card writes 'prompt_shown' the moment it actually renders, before
    // the person does anything, so a silent dismissal already leaves a row
    // behind. Service-role only, since the account cannot select this table.
    const admin = createAdminClient();
    const { data: existing, error } = await admin
      .from("app_feedback")
      .select("id")
      .eq("user_id", user.id)
      .limit(1);
    if (error) throw error;
    if (existing && existing.length > 0) {
      return { alreadyShownOrAnswered: true, hasMeaningfulActivity: false };
    }

    // "Claimed a home" from the owner's four-way OR (the other three are
    // posted a job, asked Ask Hearth 3+ times, and a pro applied to a job).
    // Only this one is actually checked: src/app/(app)/layout.tsx - the only
    // place ReviewPrompt is mounted - redirects to /onboarding for anyone
    // with zero properties, so by the time this code runs the answer is
    // always true. Kept as a real check rather than assumed, so a future
    // mount point that isn't gated the same way (the pro shell, say) fails
    // toward not showing the prompt instead of silently inheriting a
    // homeowner-only assumption.
    const properties = await getProperties();
    return {
      alreadyShownOrAnswered: false,
      hasMeaningfulActivity: properties.length > 0,
    };
  } catch (err) {
    console.error(
      "getReviewPromptSignals failed - not showing the prompt:",
      err
    );
    // Fail toward NOT showing: a broken signal check must never turn into a
    // repeat nag, and skipping the ask costs nothing but one missed prompt.
    return { alreadyShownOrAnswered: true, hasMeaningfulActivity: false };
  }
}

// Logs one prompt event: 'prompt_shown' the moment the card actually renders,
// 'loved' / 'not_really' when a button is tapped. Best effort and silent on
// failure - a homeowner tapping a review prompt button must never see an
// error toast over it, and the worst case of a dropped write is one extra ask
// later, not a broken page.
export async function recordReviewPromptEvent(
  kind: ReviewPromptKind
): Promise<void> {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;
    await supabase
      .from("app_feedback")
      .insert({ user_id: user.id, side: "homeowner", kind });
  } catch (err) {
    console.error("recordReviewPromptEvent failed:", err);
  }
}

// The private feedback form on /feedback. Always records kind 'not_really':
// this page is only ever reached from that button (or a direct visit, which
// means the same thing - someone wants to tell us something rather than rate
// us). This can land as a SECOND row for the same account alongside the bare
// 'not_really' the button click already wrote - one is the answer, one is
// what they actually said, and app_feedback is an event log, not a
// one-row-per-user table, so that is fine.
export async function submitFeedbackAction(formData: FormData) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    setFlash("Please sign in to send feedback.", "error");
    redirect(FEEDBACK_PATH);
  }

  const message = cappedField(formData, "message", FIELD_MAX.message);
  if (!message) {
    setFlash("Please write a short note first.", "error");
    redirect(FEEDBACK_PATH);
  }

  // Only present when the "you can email me back" toggle was on: the input
  // does not render at all otherwise, so FormData simply has no entry for it.
  const contactEmail = cappedFieldOrNull(
    formData,
    "contact_email",
    FIELD_MAX.email
  );

  const { error } = await supabase.from("app_feedback").insert({
    user_id: user.id,
    side: "homeowner",
    kind: "not_really",
    message,
    contact_email: contactEmail,
  });

  if (error) setFlash("Couldn't send that. Please try again.", "error");
  else setFlash("Thanks. This goes straight to us.", "success");
  redirect(FEEDBACK_PATH);
}
