"use server";

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isMissingSchemaError } from "@/lib/dbErrors";
import { isReportReason } from "@/lib/reportReasons";
import { err, ok, type ActionResult } from "@/lib/actionResult";

// Reporting a REVIEW or a PRO PROFILE (migration 0138). Chat reporting is
// older and stays where it is - LeadChat.tsx inserts into public.reports
// directly, RLS-scoped through can_access_lead - and this is the same table
// and the same inbox for the two surfaces a chat report cannot reach.
//
// Anyone signed in may file one. That is deliberate and it is the whole point
// of the feature: a public review or a public business page is read by people
// who have no relationship to the pro, and "you may only report someone you
// have already worked with" would make the control useless on exactly the
// content a stranger is most likely to be harmed by. What IS enforced:
//   * reporter_id is the session's user, never a form field (RLS re-checks);
//   * the thing being reported has to actually exist;
//   * a per-account rate limit, so the moderation inbox cannot be flooded.

const MAX_NOTE = 1000;

// A non-UUID id would reach Postgres as a 22P02 cast error rather than a
// clean "not found", so it is rejected here before any query runs.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Same fixed-window limiter (migration 0068) every other unauthenticated-ish
// write in the app uses. Fails OPEN on an RPC hiccup - only an explicit
// `allowed === false` blocks - because an outage must never swallow a real
// abuse report.
const REPORTS_PER_HOUR = 20;

export async function reportContentAction(
  formData: FormData
  // ActionResult<string>: `data`, when present, is the line to show instead of
  // the sheet's default thank-you. Only the duplicate case uses it.
): Promise<ActionResult<string>> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return err("Please sign in to report this.");

  const targetType = String(formData.get("target_type") || "").trim();
  const targetId = String(formData.get("target_id") || "").trim();
  const reason = String(formData.get("reason") || "").trim();
  const note = String(formData.get("note") || "")
    .trim()
    .slice(0, MAX_NOTE);

  if (targetType !== "review" && targetType !== "contractor") {
    return err("Couldn't tell what you're reporting.");
  }
  if (!UUID_RE.test(targetId)) {
    return err("Couldn't tell what you're reporting.");
  }
  if (!isReportReason(reason)) {
    return err("Please pick a reason.");
  }

  const admin = createAdminClient();

  // The target has to be real. ADMIN client for this one read: a review or a
  // contractor row is not necessarily readable by this account through RLS
  // (reviews are read through an RPC, and "contractors read" only returns a
  // pro a homeowner already works with), and without this check the reports
  // table would happily collect rows pointing at ids that never existed.
  // Only a yes/no leaves this block - never a column from the row.
  const { data: target, error: targetError } =
    targetType === "review"
      ? await admin.from("reviews").select("id").eq("id", targetId).maybeSingle()
      : await admin
          .from("contractors")
          .select("id")
          .eq("id", targetId)
          .maybeSingle();
  if (targetError) {
    console.error("reportContentAction: target lookup failed", targetError);
    return err("Couldn't send that report. Please try again.");
  }
  if (!target) {
    return err("That's no longer here.");
  }

  const { data: allowed } = await admin.rpc("rate_limit_hit", {
    p_bucket: `report:${user.id}`,
    p_limit: REPORTS_PER_HOUR,
    p_window_seconds: 3600,
  });
  if (allowed === false) {
    return err(
      "You've sent several reports already. Please wait a bit before sending another."
    );
  }

  // reporter_role is NOT NULL on reports (0009). Which side of the app the
  // reporter is on is a triage hint for whoever reads the inbox, nothing
  // more, so a missing contractor row simply reads as "homeowner".
  const { data: proRow } = await admin
    .from("contractors")
    .select("id")
    .eq("user_id", user.id)
    .maybeSingle();
  const reporterRole = proRow ? "contractor" : "homeowner";

  // The USER'S client: "reports insert" (0138) re-checks reporter_id =
  // auth.uid(), so a forged reporter cannot be written even if this function
  // got it wrong.
  const { error } = await supabase.from("reports").insert({
    lead_id: null,
    reporter_id: user.id,
    reporter_role: reporterRole,
    reason: note ? `${reason} - ${note}` : reason,
    target_type: targetType,
    target_id: targetId,
  });

  if (error) {
    // Already reported this exact thing. Migration 0139 adds a unique index on
    // (reporter_id, target_type, target_id), so a second identical report is a
    // 23505 rather than a duplicate row in the moderation inbox - the same
    // reason blockUserAction treats one as success. The end state the reporter
    // asked for is the end state they already have, so say so plainly instead
    // of an error: "it didn't work, try again" would have them filing it a
    // third time.
    if (error.code === "23505") {
      return ok("You've already reported this. Thanks, we'll take a look.");
    }
    if (isMissingSchemaError(error)) {
      // Migration 0138 has not been applied to this database yet: reports
      // still requires a lead_id and has no target columns. Say so honestly
      // rather than showing a thank-you for a report nobody will ever read.
      console.error("reportContentAction: reports missing 0138 shape", error);
      return err(
        "Reporting isn't switched on for this yet. Please use the contact form so we can look into it."
      );
    }
    console.error("reportContentAction: insert failed", error);
    return err("Couldn't send that report. Please try again.");
  }

  return ok();
}
