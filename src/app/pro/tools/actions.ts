"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentContractor } from "@/lib/contractor";
import { setFlash } from "@/lib/flash";

// Delete only counterpart to /api/pro-past-jobs: a past job row is extract
// once (migration 0050 grants no update on the table), so fixing a bad read
// means removing it and reuploading. Contractor scoped the same way as the
// CRM's deleteClientAction (src/app/pro/crm/actions.ts). No redirect here:
// this is called from inside the client heavy ProToolsClient, which keeps
// its own tab and draft state, so a redirect would reset that unnecessarily.
export async function deletePastJobAction(formData: FormData) {
  const contractor = await getCurrentContractor();
  if (!contractor) return;

  const id = String(formData.get("id") ?? "");
  if (!id) return;

  const supabase = createClient();
  const { error } = await supabase
    .from("pro_past_jobs")
    .delete()
    .eq("id", id)
    .eq("contractor_id", contractor.id);
  if (error) {
    setFlash("Couldn't remove that past job. Please try again.", "error");
    revalidatePath("/pro/tools");
    return;
  }

  setFlash("Past job removed.");
  revalidatePath("/pro/tools");
}

// A pro sends a generated AI back-office draft (estimate, invoice, follow-up,
// review response, or overdue reminder) straight into a lead's chat thread as
// a normal message, instead of only being able to copy it. Inserts into the
// same `messages` table sendQuoteAction/createInvoiceAction post their
// companion message into (see src/app/pro/chats/actions.ts), so unread
// badges, notifiers, and the applicant-nudge cron all treat it like any other
// message with no changes needed.
//
// Unlike those two actions, this one returns an honest result rather than
// void: ProToolsClient calls it directly (no surrounding <form>), and a pro
// sending real paperwork needs to know for certain whether it landed, not
// guess from a follow-up query.
export async function sendDraftToLeadAction(
  formData: FormData
): Promise<{ ok: boolean; error?: string; homeownerName?: string }> {
  const contractor = await getCurrentContractor();
  if (!contractor) {
    return { ok: false, error: "Please sign in and try again." };
  }

  const leadId = String(formData.get("lead_id") || "");
  // Capped at the same ceiling recordToolEditAction stores drafts under, which
  // is already sized to the largest draft /api/pro-tools can produce. The
  // client only ever sends a generated draft, but a server action takes
  // whatever FormData it is handed, and this text goes straight into a chat
  // thread a homeowner reads.
  const body = String(formData.get("body") || "")
    .trim()
    .slice(0, MAX_STORED_TEXT);
  if (!leadId || !body) {
    return { ok: false, error: "There's nothing to send yet." };
  }

  const supabase = createClient();

  // The lead must really be one of this contractor's own jobs. The id arrives
  // as client input (picked from a list built client-side), so re-check here
  // rather than trust it, same pattern as sendQuoteAction/createInvoiceAction
  // in pro/chats/actions.ts. RLS backs this too.
  const { data: ownLead } = await supabase
    .from("contractor_leads")
    .select("id, homeowner_name")
    .eq("id", leadId)
    .eq("contractor_id", contractor.id)
    .maybeSingle();
  if (!ownLead) {
    return { ok: false, error: "That conversation could not be found." };
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Cap chat sends per user with the same fixed-window limiter as
  // onboarding's parcel lookup (migration 0068). Fails open on a DB hiccup:
  // only an explicit `allowed === false` blocks, so a rate-limiter outage
  // never stops a legit pro from reaching a homeowner.
  if (user) {
    const admin = createAdminClient();
    const { data: allowed } = await admin.rpc("rate_limit_hit", {
      p_bucket: `chat:${user.id}`,
      p_limit: 30,
      p_window_seconds: 60,
    });
    if (allowed === false) {
      return {
        ok: false,
        error: "You're sending messages too quickly. Please wait a moment.",
      };
    }
  }

  // The draft's plain text goes in untouched (it may be multi-line estimate
  // or invoice text); this is the exact insert shape every other message in
  // the thread already uses.
  const { error } = await supabase.from("messages").insert({
    lead_id: leadId,
    sender_role: "contractor",
    sender_id: user?.id ?? null,
    body,
  });
  if (error) {
    return { ok: false, error: "Couldn't send it. Please try again." };
  }

  revalidatePath("/pro/chats");
  revalidatePath("/chats");
  return { ok: true, homeownerName: ownLead.homeowner_name || "the homeowner" };
}

const RECORDED_TOOLS = new Set([
  "estimate",
  "invoice",
  "followup",
  "review_response",
  "overdue",
]);
const MAX_STORED_TEXT = 6000; // matches the largest draft the assemble() step in /api/pro-tools can produce

// The "remember my edits" loop, write side. Called from ProToolsClient right
// after a pro sends or copies a draft they changed, so pro_tool_edits (see
// migration 0063) only ever holds edits a pro genuinely made, never a
// fabricated guess at their preferences. If the text going out matches the
// original AI draft exactly, the caller shouldn't even call this, and this
// checks again server side as a second guard against storing a no-op "edit".
// Silent and best effort: this is background learning, not a user facing
// action, so it never surfaces an error to the pro.
export async function recordToolEditAction(formData: FormData) {
  const contractor = await getCurrentContractor();
  if (!contractor) return;

  const tool = String(formData.get("tool") ?? "");
  const originalText = String(formData.get("original_text") ?? "").trim();
  const editedText = String(formData.get("edited_text") ?? "").trim();
  if (!RECORDED_TOOLS.has(tool)) return;
  if (!originalText || !editedText) return;
  if (originalText === editedText) return; // nothing the pro actually changed

  const supabase = createClient();
  await supabase.from("pro_tool_edits").insert({
    contractor_id: contractor.id,
    tool,
    original_text: originalText.slice(0, MAX_STORED_TEXT),
    edited_text: editedText.slice(0, MAX_STORED_TEXT),
  });
  // No revalidate: this doesn't change anything the current page renders.
}
