"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getCurrentContractor } from "@/lib/contractor";
import { setFlash } from "@/lib/flash";

const STAGES = ["lead", "quoted", "won", "lost"] as const;
type Stage = (typeof STAGES)[number];

function isStage(value: string): value is Stage {
  return (STAGES as readonly string[]).includes(value);
}

async function assertContractor() {
  const contractor = await getCurrentContractor();
  if (!contractor) redirect("/pro/onboarding");
  return contractor;
}

// A follow up date is optional and, if present, must parse. Blank clears it.
function parseFollowUp(raw: FormDataEntryValue | null): {
  ok: boolean;
  value: string | null;
} {
  const value = String(raw ?? "").trim();
  if (!value) return { ok: true, value: null };
  return { ok: !Number.isNaN(new Date(value).getTime()), value };
}

// Estimated deal value arrives from the form as plain dollars and is stored
// as cents. Blank clears it. Negative amounts and anything at or above ten
// million dollars are rejected as almost certainly a typo.
const MAX_EST_VALUE_DOLLARS = 10_000_000;
function parseEstValue(raw: FormDataEntryValue | null): {
  ok: boolean;
  value: number | null;
  message?: string;
} {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) return { ok: true, value: null };
  const dollars = Number(trimmed);
  if (!Number.isFinite(dollars)) {
    return { ok: false, value: null, message: "That estimated value doesn't look right." };
  }
  if (dollars < 0) {
    return { ok: false, value: null, message: "Estimated value can't be negative." };
  }
  if (dollars > MAX_EST_VALUE_DOLLARS) {
    return {
      ok: false,
      value: null,
      message: `Estimated value must be under $${MAX_EST_VALUE_DOLLARS.toLocaleString("en-US")}.`,
    };
  }
  return { ok: true, value: Math.round(dollars * 100) };
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Add a client to the tracker, either typed in fresh or (with lead_id set)
// from the Track button on a suggested lead.
//
// NO REDIRECT ON THIS FORM, on any path, success or failure: it is always
// submitted from /pro/crm, so a redirect() back to the exact path the form is
// already on is the same-path App Router footgun documented on the /pro/profile
// save (../actions.ts, saveCompanyAction) - it can leave the route stuck on its
// loading.tsx boundary instead of resolving back to the real page, which is
// exactly what testers saw: "Adding..." stayed on screen and the list and the
// "Your clients (0)" counter never updated until a manual reload.
// revalidatePath() alone marks /pro/crm stale, which is what makes the next
// render (still on this same action response, no navigation needed) pick up
// the new row, the new counter, and the flash message - see FlashToast's own
// comment for why a revalidate-only render is exactly what it is listening for.
export async function addClientAction(formData: FormData) {
  const contractor = await assertContractor();

  const name = String(formData.get("client_name") ?? "").trim();
  if (!name) {
    await setFlash("A client name is required.", "error");
    revalidatePath("/pro/crm");
    return;
  }
  if (name.length > 80) {
    await setFlash("Client name must be 80 characters or fewer.", "error");
    revalidatePath("/pro/crm");
    return;
  }

  const stageRaw = String(formData.get("stage") ?? "lead");
  const stage: Stage = isStage(stageRaw) ? stageRaw : "lead";

  const noteRaw = String(formData.get("note") ?? "").trim();
  if (noteRaw.length > 1000) {
    await setFlash("Note must be 1,000 characters or fewer.", "error");
    revalidatePath("/pro/crm");
    return;
  }

  const followUp = parseFollowUp(formData.get("follow_up_on"));
  if (!followUp.ok) {
    await setFlash("That follow up date doesn't look right.", "error");
    revalidatePath("/pro/crm");
    return;
  }

  const supabase = await createClient();

  // Double-submit guard (persona C2, 2026-08-30): a second tap of "Add a
  // client" inside two minutes with the same name used to create a second
  // identical row. Treat it as the same add. Same-name clients added later
  // (a real second Jordan) still go through.
  const { data: recent } = await supabase
    .from("pro_clients")
    .select("id")
    .eq("contractor_id", contractor.id)
    .eq("client_name", name)
    .gte("created_at", new Date(Date.now() - 2 * 60 * 1000).toISOString())
    .limit(1);
  if (recent && recent.length > 0) {
    await setFlash("Already added.", "info");
    revalidatePath("/pro/crm");
    return;
  }

  const { data: inserted, error } = await supabase
    .from("pro_clients")
    .insert({
      contractor_id: contractor.id,
      client_name: name,
      stage,
      note: noteRaw || null,
      follow_up_on: followUp.value,
    })
    .select("id")
    .single();
  if (error) {
    await setFlash("Couldn't add that client. Please try again.", "error");
    revalidatePath("/pro/crm");
    return;
  }

  // MED-1: the initial note used to live only on pro_clients.note. The
  // detail page's timeline (crm/[id]/page.tsx) reads exclusively from
  // pro_client_notes, so that first note rendered fine on the client card
  // here in the list, then went permanently invisible on the detail page the
  // moment any real note got added there (the timeline has entries, so the
  // "no notes yet" fallback never runs either). Mirror it into
  // pro_client_notes so it shows up in the timeline from the start.
  // pro_clients.note is left as-is too: ClientRow.tsx's list preview still
  // falls back to that column when pro_client_notes has nothing yet.
  // Best-effort - the client row landed either way, and a note mirror
  // failure must not undo that or block the flash below.
  if (noteRaw && inserted?.id) {
    const { error: noteError } = await supabase
      .from("pro_client_notes")
      .insert({ client_id: inserted.id, body: noteRaw });
    if (noteError) {
      console.error(
        "addClientAction: initial note mirror failed:",
        noteError.message
      );
    }
  }

  await setFlash("Client added.");
  revalidatePath("/pro/crm");
}

// One tap from the auto suggestion list: creates a client row prefilled from a
// lead the pro was already chosen for, so nothing new about the homeowner is
// exposed here beyond what the pipeline already showed. This only ever copies
// the visible display name, never homeowner_email or homeowner_phone.
// Same same-path footgun as addClientAction above, and the same fix: this form
// is always submitted from /pro/crm too, so every exit is a revalidate, never a
// redirect back to the page it is already on.
export async function trackLeadAction(formData: FormData) {
  const contractor = await assertContractor();
  const leadId = String(formData.get("lead_id") ?? "");
  if (!leadId) {
    await setFlash("Couldn't track that one.", "error");
    revalidatePath("/pro/crm");
    return;
  }

  const name =
    String(formData.get("client_name") ?? "").trim().slice(0, 80) || "Client";
  const stageRaw = String(formData.get("stage") ?? "lead");
  const stage: Stage = isStage(stageRaw) ? stageRaw : "lead";

  const supabase = await createClient();

  // The lead must really be one of this contractor's own jobs. The form only
  // ever offers those, but the id arrives as client input, so re check here
  // rather than trust it (linking an arbitrary lead would be harmless data
  // wise, RLS still guards the chat, but the row would be a lie).
  const { data: ownLead } = await supabase
    .from("contractor_leads")
    .select("id")
    .eq("id", leadId)
    .eq("contractor_id", contractor.id)
    .maybeSingle();
  if (!ownLead) {
    await setFlash("That job isn't yours to track.", "error");
    revalidatePath("/pro/crm");
    return;
  }

  // A quick double click shouldn't create a second row for the same lead.
  // There's no unique constraint, so this is a best effort check, not a hard
  // guarantee, which is fine for this client tracker.
  const { data: already } = await supabase
    .from("pro_clients")
    .select("id")
    .eq("contractor_id", contractor.id)
    .eq("lead_id", leadId)
    .maybeSingle();
  if (already) {
    await setFlash("Already tracking that one.");
    revalidatePath("/pro/crm");
    return;
  }

  const { error } = await supabase.from("pro_clients").insert({
    contractor_id: contractor.id,
    lead_id: leadId,
    client_name: name,
    stage,
  });
  if (error) {
    await setFlash("Couldn't track that client. Please try again.", "error");
    revalidatePath("/pro/crm");
    return;
  }

  await setFlash("Client tracked.");
  revalidatePath("/pro/crm");
}

// Full contact and details save from the client detail page: name, phone,
// email, address, estimated value, stage, and follow up date all in one form.
// Every field is validated server side; on any failure the pro is sent back
// to the same detail page (not the list) so nothing typed is lost from view.
export async function updateClientDetailsAction(formData: FormData) {
  const contractor = await assertContractor();
  const id = String(formData.get("id") ?? "");
  if (!id) redirect("/pro/crm");

  // NO REDIRECT ON THIS FORM either, on any exit: it is always submitted
  // from /pro/crm/[id] (see the addClientAction comment above for the same
  // App Router footgun on the list page). back() marks that same detail path
  // stale so the next render - still this action's own response, no
  // navigation needed - shows the flash and whatever was already typed.
  // revalidatePath() does not stop execution the way redirect() used to, so
  // every validation branch below now needs its own explicit `return`.
  const back = () => revalidatePath(`/pro/crm/${id}`);

  const name = String(formData.get("client_name") ?? "").trim();
  if (!name) {
    await setFlash("A client name is required.", "error");
    back();
    return;
  }
  if (name.length > 80) {
    await setFlash("Client name must be 80 characters or fewer.", "error");
    back();
    return;
  }

  const phone = String(formData.get("phone") ?? "").trim();
  if (phone.length > 30) {
    await setFlash("Phone must be 30 characters or fewer.", "error");
    back();
    return;
  }

  const email = String(formData.get("email") ?? "").trim();
  if (email.length > 120) {
    await setFlash("Email must be 120 characters or fewer.", "error");
    back();
    return;
  }
  if (email && !EMAIL_PATTERN.test(email)) {
    await setFlash("That email doesn't look right.", "error");
    back();
    return;
  }

  const address = String(formData.get("address") ?? "").trim();
  if (address.length > 200) {
    await setFlash("Address must be 200 characters or fewer.", "error");
    back();
    return;
  }

  const estValue = parseEstValue(formData.get("est_value"));
  if (!estValue.ok) {
    await setFlash(estValue.message ?? "That estimated value doesn't look right.", "error");
    back();
    return;
  }

  const stageRaw = String(formData.get("stage") ?? "lead");
  const stage: Stage = isStage(stageRaw) ? stageRaw : "lead";

  const followUp = parseFollowUp(formData.get("follow_up_on"));
  if (!followUp.ok) {
    await setFlash("That follow up date doesn't look right.", "error");
    back();
    return;
  }

  // .select("id") is what turns the contractor_id filter into a real answer.
  // Without it a write that matched NOTHING - a tampered id, or someone
  // else's client - returns no error, and the pro would be told "Client
  // updated." about a row that was never touched. An empty array is the
  // "not yours" signal.
  const supabase = await createClient();
  const { data: updated, error } = await supabase
    .from("pro_clients")
    .update({
      client_name: name,
      phone: phone || null,
      email: email || null,
      address: address || null,
      est_value_cents: estValue.value,
      stage,
      follow_up_on: followUp.value,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("contractor_id", contractor.id)
    .select("id");
  if (error) {
    await setFlash("Couldn't save your changes. Please try again.", "error");
    back();
    return;
  }
  if (!updated || updated.length === 0) {
    await setFlash("That client isn't yours.", "error");
    back();
    return;
  }

  await setFlash("Client updated.");
  revalidatePath("/pro/crm");
  revalidatePath(`/pro/crm/${id}`);
}

export async function deleteClientAction(formData: FormData) {
  const contractor = await assertContractor();
  const id = String(formData.get("id") ?? "");
  if (!id) redirect("/pro/crm");

  // Same reason as updateClientDetailsAction: .select("id") is the only way
  // to tell "deleted your row" from "matched nothing", so a tampered id gets
  // an honest refusal instead of "Client removed."
  const supabase = await createClient();
  const { data: removed, error } = await supabase
    .from("pro_clients")
    .delete()
    .eq("id", id)
    .eq("contractor_id", contractor.id)
    .select("id");
  // The failure exits stay on /pro/crm/[id], the page this form is always
  // submitted from, so they revalidate instead of redirecting: a same-path
  // App Router redirect leaves the route stuck on its loading boundary.
  if (error) {
    await setFlash("Couldn't remove that client. Please try again.", "error");
    revalidatePath(`/pro/crm/${id}`);
    return;
  }
  if (!removed || removed.length === 0) {
    await setFlash("That client isn't yours.", "error");
    revalidatePath(`/pro/crm/${id}`);
    return;
  }

  await setFlash("Client removed.");
  revalidatePath("/pro/crm");
  redirect("/pro/crm");
}

// Add a note to a client's timeline. The client id arrives as client input,
// so its ownership is checked explicitly before the insert rather than
// trusting the form: RLS backs this too, but a friendly flash beats a raw
// database error if someone tampers with the id.
//
// This form, too, is always submitted from /pro/crm/[id] - so, same as
// updateClientDetailsAction above, every exit that stays on that page is a
// revalidate, never a redirect back to the page it's already on. Only the
// "this client isn't real / isn't yours" branches actually leave the page,
// because there is nowhere on it left to show.
export async function addNoteAction(formData: FormData) {
  const contractor = await assertContractor();
  const clientId = String(formData.get("client_id") ?? "");
  if (!clientId) redirect("/pro/crm");

  const body = String(formData.get("body") ?? "").trim();
  if (!body) {
    await setFlash("A note can't be empty.", "error");
    revalidatePath(`/pro/crm/${clientId}`);
    return;
  }
  if (body.length > 1000) {
    await setFlash("Note must be 1,000 characters or fewer.", "error");
    revalidatePath(`/pro/crm/${clientId}`);
    return;
  }

  const supabase = await createClient();
  const { data: ownClient } = await supabase
    .from("pro_clients")
    .select("id")
    .eq("id", clientId)
    .eq("contractor_id", contractor.id)
    .maybeSingle();
  if (!ownClient) redirect("/pro/crm");

  const { error } = await supabase
    .from("pro_client_notes")
    .insert({ client_id: clientId, body });
  if (error) {
    await setFlash("Couldn't add that note. Please try again.", "error");
    revalidatePath(`/pro/crm/${clientId}`);
    return;
  }

  await setFlash("Note added.");
  revalidatePath(`/pro/crm/${clientId}`);
  revalidatePath("/pro/crm");
}

export async function deleteNoteAction(formData: FormData) {
  const contractor = await assertContractor();
  const clientId = String(formData.get("client_id") ?? "");
  const noteId = String(formData.get("note_id") ?? "");
  if (!clientId || !noteId) redirect("/pro/crm");

  const supabase = await createClient();
  const { data: ownClient } = await supabase
    .from("pro_clients")
    .select("id")
    .eq("id", clientId)
    .eq("contractor_id", contractor.id)
    .maybeSingle();
  if (!ownClient) redirect("/pro/crm");

  const { error } = await supabase
    .from("pro_client_notes")
    .delete()
    .eq("id", noteId)
    .eq("client_id", clientId);
  if (error) {
    await setFlash("Couldn't remove that note. Please try again.", "error");
    revalidatePath(`/pro/crm/${clientId}`);
    return;
  }

  await setFlash("Note removed.");
  revalidatePath(`/pro/crm/${clientId}`);
}
