"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getActiveProperty } from "@/lib/property";
import { setFlash } from "@/lib/flash";
import { DEFAULT_LIFESPANS } from "@/lib/health";
import { labelFor, SYSTEM_TYPES } from "@/lib/constants";
import { isMissingSchemaError } from "@/lib/dbErrors";
import { isOwnedStoragePath } from "@/lib/ownedStoragePath";
import { toObjectPath } from "@/lib/storage";

// The vault's write path. The client uploads the file and runs vision
// extraction first; these actions persist the result and, on the owner's
// say-so, push the facts into the digital twin. RLS scopes every write to the
// caller's own property.

function s(formData: FormData, key: string): string | null {
  const v = formData.get(key);
  const t = typeof v === "string" ? v.trim() : "";
  return t.length ? t : null;
}

// Save an uploaded document + its extracted facts to the vault. Returns a small
// result so the client can tell the truth: only show "Saved" when ok is true,
// and keep the review form (plus the error) when the save actually failed.
export async function saveDocumentAction(
  formData: FormData
): Promise<{ ok: true } | { ok: false; error: string }> {
  const property = await getActiveProperty();
  if (!property)
    throw new Error("Couldn't find your home. Try again from the dashboard.");
  const supabase = await createClient();

  const fileUrl = s(formData, "file_url");
  if (!fileUrl) throw new Error("No file uploaded");

  // file_url is set by DocumentUpload.tsx AFTER it uploads to
  // `${propertyId}/docs/<uuid>.<ext>`, but this action takes whatever FormData
  // it is handed, and nothing downstream re-derives the key: it is stored
  // as-is and later handed to /api/img to sign. So the claimed key has to be
  // proved to live under THIS property before it is written, or a caller could
  // point their own document row at another property's object (and get it
  // signed on request). Rejected quietly with the same shape as a failed save,
  // since the only way to reach it is a forged post.
  if (!isOwnedStoragePath(fileUrl, property.id)) {
    console.error("saveDocumentAction: file_url outside the property prefix");
    const message =
      "Couldn't save that document right now. Please try again in a bit.";
    await setFlash(message, "error");
    return { ok: false, error: message };
  }

  const yearRaw = s(formData, "install_year");
  const year = yearRaw ? Number(yearRaw) : null;

  const full = {
    property_id: property.id,
    file_url: fileUrl,
    doc_type: s(formData, "doc_type"),
    title: s(formData, "title") ?? "Home document",
    brand: s(formData, "brand"),
    model: s(formData, "model"),
    install_year: Number.isInteger(year as number) ? year : null,
    warranty_expires: s(formData, "warranty_expires"),
    system_type: s(formData, "system_type"),
    summary: s(formData, "summary"),
  };

  let { error } = await supabase.from("documents").insert(full);
  if (error && isMissingSchemaError(error)) {
    // Live DB missing the 0019 vault columns: keep the document itself (the
    // file + a title beats losing the upload), drop only the extracted-fact
    // columns that do not exist yet. Same degradation pattern as taxes/value.
    ({ error } = await supabase.from("documents").insert({
      property_id: property.id,
      file_url: fileUrl,
      title: full.title,
    } as any));
  }
  if (error) {
    // Total failure: never crash the request (the old throw here put a raw
    // Next error overlay in front of the owner), and never strand the
    // already-uploaded file as an unfindable orphan in the bucket.
    console.error("saveDocumentAction failed:", error.message);
    // toObjectPath, not a split on the bucket marker: the stored value can be
    // a bare object key (no "/home-photos/" in it at all, so the split gave
    // undefined and the orphan was never removed) or a URL with a "?t=" cache
    // buster on the end (which the split kept, so the remove() named an object
    // that does not exist). It is also the exact same reading /api/img and
    // isOwnedStoragePath use, so the key deleted here is the key that was
    // signed.
    const path = toObjectPath(fileUrl);
    if (path) {
      await supabase.storage.from("home-photos").remove([path]);
    }
    const message =
      "Couldn't save that document right now. Please try again in a bit.";
    await setFlash(message, "error");
    revalidatePath("/documents");
    return { ok: false, error: message };
  }

  await setFlash("Saved to your documents.", "success");
  revalidatePath("/documents");
  return { ok: true };
}

// Push a saved document's facts into the digital twin: update the matching home
// system (or create it), and, if the doc carries a warranty date, set a
// reminder so the owner hears about it before coverage lapses.
export async function applyDocumentToTwinAction(formData: FormData) {
  const property = await getActiveProperty();
  if (!property)
    throw new Error("Couldn't find your home. Try again from the dashboard.");
  const supabase = await createClient();

  const id = s(formData, "id");
  if (!id) throw new Error("No document");

  // Idempotency gate, FIRST: atomically claim the document by stamping
  // applied_at only where it is still null. A double-click or replayed POST
  // finds zero rows here and bails, so the twin push and the warranty
  // reminder insert below can never run twice for one document. Trade-off:
  // if a write below fails after the claim, the doc reads as applied with
  // partial effects, which beats the old order (stamp last) that let repeat
  // submits duplicate reminders.
  const { data: claimed } = await supabase
    .from("documents")
    .update({ applied_at: new Date().toISOString() })
    .eq("id", id)
    .is("applied_at", null)
    .select("id")
    .maybeSingle();
  if (!claimed) {
    // Already applied (possibly by a concurrent submit a moment ago): the
    // work is done, so report success rather than an error.
    await setFlash("Already added to your home.", "success");
    revalidatePath("/documents");
    revalidatePath("/dashboard");
    return;
  }

  const { data: doc } = await supabase
    .from("documents")
    .select(
      "id, system_type, brand, model, install_year, warranty_expires, title"
    )
    .eq("id", id)
    .maybeSingle();
  if (!doc) throw new Error("Document not found");

  const material =
    [doc.brand, doc.model].filter(Boolean).join(" ").trim() || null;

  let touchedSystem = false;
  if (doc.system_type) {
    // Update the existing system of this type, if there is one; otherwise add it.
    const { data: existing } = await supabase
      .from("home_systems")
      .select("id, material_or_model, install_year")
      .eq("property_id", property.id)
      .eq("system_type", doc.system_type)
      .maybeSingle();

    if (existing) {
      await supabase
        .from("home_systems")
        .update({
          // Only fill blanks / newer facts; don't clobber what the owner set.
          material_or_model: existing.material_or_model ?? material,
          install_year: doc.install_year ?? existing.install_year,
        })
        .eq("id", existing.id);
    } else {
      await supabase.from("home_systems").insert({
        property_id: property.id,
        system_type: doc.system_type,
        material_or_model: material,
        install_year: doc.install_year,
        expected_lifespan_years: DEFAULT_LIFESPANS[doc.system_type] ?? null,
      });
    }
    touchedSystem = true;
  }

  // A warranty date the owner would otherwise forget → a dated reminder.
  if (doc.warranty_expires) {
    const label = doc.title || "your home document";
    await supabase.from("maintenance_tasks").insert({
      property_id: property.id,
      title: `Warranty expires: ${label}`,
      due_date: doc.warranty_expires,
      status: "open",
    });
  }

  // applied_at was already stamped by the claim at the top of this action.

  const sysLabel = doc.system_type
    ? labelFor(SYSTEM_TYPES, doc.system_type)
    : null;
  await setFlash(
    touchedSystem
      ? `Added to your home${sysLabel ? ` (${sysLabel})` : ""}.`
      : "Saved to your home record.",
    "success"
  );
  revalidatePath("/documents");
  revalidatePath("/dashboard");
}

export async function deleteDocumentAction(formData: FormData) {
  const supabase = await createClient();
  const id = s(formData, "id");
  if (!id) return;
  // RLS guarantees the row belongs to the caller's property.
  const { error } = await supabase.from("documents").delete().eq("id", id);
  if (error) throw new Error(error.message);
  await setFlash("Document removed", "info");
  revalidatePath("/documents");
}
