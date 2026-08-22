"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getActiveProperty } from "@/lib/property";
import { formatUSDCents } from "@/lib/quotes";
import { setFlash } from "@/lib/flash";

// Mirrors contractors/actions: a generic, honest failure the homeowner can act
// on, used for every guard miss and the status-update error below.
const QUOTE_ERROR = "Couldn't update the quote, please try again.";

// Shared body for accept/decline: verifies the quote is really on a lead
// attached to the caller's own property before touching anything (the id
// arrives as client input; RLS backs this too, but a clean no-op beats a raw
// database error if someone tampers with it), flips status, then notifies
// the pro. Never touches choose_applicant or any money logic, only this
// row's status.
async function respondToQuote(
  formData: FormData,
  newStatus: "accepted" | "declined"
) {
  const property = await getActiveProperty();
  if (!property) {
    await setFlash(QUOTE_ERROR, "error");
    revalidatePath("/chats");
    return;
  }

  const quoteId = String(formData.get("quote_id") || "");
  if (!quoteId) {
    await setFlash(QUOTE_ERROR, "error");
    revalidatePath("/chats");
    return;
  }

  const supabase = await createClient();

  const { data: quote } = await supabase
    .from("lead_quotes")
    .select("id, lead_id, contractor_id, total_cents, status")
    .eq("id", quoteId)
    .eq("status", "sent")
    .maybeSingle();
  if (!quote) {
    // Already accepted/declined/withdrawn, so there's nothing left to change.
    await setFlash("That quote can no longer be updated.", "error");
    revalidatePath("/chats");
    return;
  }

  const { data: lead } = await supabase
    .from("contractor_leads")
    .select("id")
    .eq("id", quote.lead_id)
    .eq("property_id", property.id)
    .maybeSingle();
  if (!lead) {
    await setFlash(QUOTE_ERROR, "error");
    revalidatePath("/chats");
    return;
  }

  const { error } = await supabase
    .from("lead_quotes")
    .update({ status: newStatus, updated_at: new Date().toISOString() })
    .eq("id", quoteId)
    .eq("status", "sent");
  if (error) {
    await setFlash(QUOTE_ERROR, "error");
    revalidatePath("/chats");
    return;
  }

  // Tell the pro their quote was answered. Best-effort: a notification
  // hiccup should never undo a status change that already saved.
  try {
    const { data: contractor } = await supabase
      .from("contractors")
      .select("user_id")
      .eq("id", quote.contractor_id)
      .maybeSingle();
    if (contractor?.user_id) {
      const admin = createAdminClient();
      const amount = formatUSDCents(quote.total_cents);
      await admin.from("notifications").insert({
        user_id: contractor.user_id,
        kind: newStatus === "accepted" ? "quote_accepted" : "quote_declined",
        title:
          newStatus === "accepted"
            ? `Your ${amount} quote was accepted`
            : `Your ${amount} quote was declined`,
        body:
          newStatus === "accepted"
            ? "The homeowner accepted your quote. Check the chat to follow up."
            : "The homeowner declined your quote.",
        url: "/pro/chats",
      });
    }
  } catch (err) {
    console.error(
      "quote response notification:",
      err instanceof Error ? err.message : err
    );
  }

  revalidatePath("/chats");
  revalidatePath("/pro/chats");
}

export async function acceptQuoteAction(formData: FormData) {
  await respondToQuote(formData, "accepted");
}

export async function declineQuoteAction(formData: FormData) {
  await respondToQuote(formData, "declined");
}

// Mirrors the QUOTE_ERROR constant above: a generic, honest failure the
// homeowner can act on.
const INVOICE_ERROR = "Couldn't sign the invoice, please try again.";

// The homeowner signs a 'sent' invoice on their own lead, either by typing
// their name (signature_method='in_app') or by marking it as signed in
// person (signature_method='in_person', e.g. a paper signature on site).
// Never touches money/payout logic, only this row's status and who/when/how
// it was signed.
export async function signInvoiceAction(formData: FormData) {
  const property = await getActiveProperty();
  if (!property) {
    await setFlash(INVOICE_ERROR, "error");
    revalidatePath("/chats");
    return;
  }

  const invoiceId = String(formData.get("invoice_id") || "");
  const method = String(formData.get("signature_method") || "");
  if (!invoiceId || (method !== "in_app" && method !== "in_person")) {
    await setFlash(INVOICE_ERROR, "error");
    revalidatePath("/chats");
    return;
  }

  const supabase = await createClient();

  const { data: invoice } = await supabase
    .from("invoices")
    .select("id, lead_id, contractor_id, total_cents, status")
    .eq("id", invoiceId)
    .eq("status", "sent")
    .maybeSingle();
  if (!invoice) {
    // Already signed/voided, so there's nothing left to change.
    await setFlash("That invoice can no longer be signed.", "error");
    revalidatePath("/chats");
    return;
  }

  const { data: lead } = await supabase
    .from("contractor_leads")
    .select("id, homeowner_name")
    .eq("id", invoice.lead_id)
    .eq("property_id", property.id)
    .maybeSingle();
  if (!lead) {
    await setFlash(INVOICE_ERROR, "error");
    revalidatePath("/chats");
    return;
  }

  // In-app signing records the name the homeowner actually typed (it may not
  // be them personally, e.g. a spouse signing). In-person signing has no
  // typed field, so it falls back to the name already on file for this lead.
  let signedBy: string;
  if (method === "in_app") {
    signedBy = String(formData.get("signed_by") || "").trim().slice(0, 120);
    if (!signedBy) {
      await setFlash("Please type your name to sign.", "error");
      revalidatePath("/chats");
      return;
    }
  } else {
    signedBy = lead.homeowner_name?.trim() || "the homeowner";
  }

  const { error } = await supabase
    .from("invoices")
    .update({
      status: "signed",
      signed_at: new Date().toISOString(),
      signed_by: signedBy,
      signature_method: method,
      updated_at: new Date().toISOString(),
    })
    .eq("id", invoiceId)
    .eq("status", "sent");
  if (error) {
    await setFlash(INVOICE_ERROR, "error");
    revalidatePath("/chats");
    return;
  }

  // Tell the pro their invoice was signed. Best-effort: a notification
  // hiccup should never undo a status change that already saved.
  try {
    const { data: contractor } = await supabase
      .from("contractors")
      .select("user_id")
      .eq("id", invoice.contractor_id)
      .maybeSingle();
    if (contractor?.user_id) {
      const admin = createAdminClient();
      const amount = formatUSDCents(invoice.total_cents);
      await admin.from("notifications").insert({
        user_id: contractor.user_id,
        kind: "invoice_signed",
        title: `Your ${amount} invoice was signed`,
        body: `${signedBy} signed it ${method === "in_app" ? "in the app" : "in person"}.`,
        url: "/pro/chats",
      });
    }
  } catch (err) {
    console.error(
      "invoice signed notification:",
      err instanceof Error ? err.message : err
    );
  }

  revalidatePath("/chats");
  revalidatePath("/pro/chats");
}
