import { createAdminClient } from "@/lib/supabase/admin";
import { sendNotification } from "@/lib/notify";

// OakTend Pro perk: automated review requests. When a Pro member marks a job
// Won (closed), the homeowner gets a friendly nudge to leave a review, linking
// to /contractors where the review form lives (ReviewButton on the job row).
// This only ASKS: it never touches rating math, ordering, or who is allowed to
// review: the leave_review RPC keeps enforcing all of that. Free pros lose
// nothing; they can still ask manually like before.
//
// Best-effort throughout: any failure is logged and swallowed so a
// notification hiccup can never break the pro's status update.

export async function requestReviewForWonLead(input: {
  leadId: string;
  contractorUserId: string | null;
  businessName: string | null;
}): Promise<void> {
  try {
    const admin = createAdminClient();

    // Resolve the homeowner: contractor_leads -> property_id -> properties.user_id.
    const { data: lead } = await admin
      .from("contractor_leads")
      .select("property_id")
      .eq("id", input.leadId)
      .maybeSingle();
    if (!lead?.property_id) return;

    const { data: property } = await admin
      .from("properties")
      .select("user_id")
      .eq("id", lead.property_id)
      .maybeSingle();
    const ownerId = property?.user_id;
    if (!ownerId) return;
    // A pro closing a job on their own property shouldn't be asked to review
    // themselves.
    if (input.contractorUserId && ownerId === input.contractorUserId) return;

    // The lead id in the url doubles as the idempotency key: one ask per job,
    // ever, even if the status is toggled away and back to Won. /contractors
    // ignores unknown query params, so the link still lands on the job list.
    const url = `/contractors?review=${input.leadId}`;
    const { data: existing } = await admin
      .from("notifications")
      .select("id")
      .eq("user_id", ownerId)
      .eq("kind", "review_request")
      .eq("url", url)
      .limit(1)
      .maybeSingle();
    if (existing) return;

    // Contact details so the email/SMS channels fire too once their provider
    // env vars are set (they stay dormant until then). sms_consent gates the
    // SMS channel specifically (TCPA - see src/lib/notify.ts).
    const { data: owner } = await admin
      .from("users")
      .select("email, phone, sms_consent")
      .eq("id", ownerId)
      .maybeSingle();

    const name = input.businessName?.trim() || "your pro";
    await sendNotification(admin, {
      userId: ownerId,
      kind: "review_request",
      title: `How did ${name} do?`,
      body: "Leave a quick review to help other homeowners pick the right pro.",
      url,
      email: owner?.email ?? null,
      phone: owner?.phone ?? null,
      smsConsent: owner?.sms_consent === true,
    });
  } catch (err) {
    console.error(
      "review request:",
      err instanceof Error ? err.message : err
    );
  }
}
