"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getActiveProperty } from "@/lib/property";
import { isOwnedStoragePath } from "@/lib/ownedStoragePath";
import { setFlash } from "@/lib/flash";
import type { PrepKey } from "./PanicCard";

const PREP_KEYS: PrepKey[] = ["water_shutoff", "gas_shutoff", "breaker_panel"];

type PrepValue = { photo_path: string | null; note: string | null };
type PrepMap = Partial<Record<PrepKey, PrepValue>>;

// Saves one prep slot (a photo location + note) into properties.emergency_prep.
// emergency_prep is a migration-0031 column not yet in database.types.ts, so we
// cast at the query call site (same pattern as the ai_usage route) until types
// regenerate. If the migration hasn't run against the live DB yet, this update
// fails and we show a soft message instead of throwing, since the panic flows
// themselves must keep working either way.
export async function savePrepItemAction(formData: FormData) {
  const property = await getActiveProperty();
  // Thrown messages are written as copy a homeowner could read. Next redacts
  // server-action errors in production today, but that is framework behaviour,
  // not a promise, and in dev the raw string does show.
  if (!property)
    throw new Error("Couldn't find your home. Try again from the dashboard.");

  const key = formData.get("key") as PrepKey;
  if (!PREP_KEYS.includes(key))
    throw new Error("Couldn't save that item. Refresh the page and try again.");

  // Cap lengths server-side so an oversized payload can't bloat the row. A
  // note gets trimmed to a sane size.
  //
  // The photo key gets the same guard every other action that persists a
  // client-chosen storage key uses (src/lib/ownedStoragePath.ts). Length alone
  // was the whole check here, which was the one gap left in that rule: this
  // form hands back a hidden field, so the key is as forgeable as any other
  // input, and PrepPhotoUpload.tsx always writes under `${propertyId}/`. A key
  // that does not belong to this home is dropped, falling back to whatever
  // photo the slot already had.
  const rawUrl = ((formData.get("photo_url") as string) || "").trim();
  const photoUrl = isOwnedStoragePath(rawUrl, property.id) ? rawUrl : "";
  const note = ((formData.get("note") as string) || "").trim().slice(0, 2000);

  const supabase = await createClient();
  try {
    const existing = ((property as any).emergency_prep ?? {}) as PrepMap;
    const next: PrepMap = {
      ...existing,
      [key]: {
        photo_path: photoUrl || existing[key]?.photo_path || null,
        note: note || null,
      },
    };
    const { error } = await (supabase as any)
      .from("properties")
      .update({ emergency_prep: next })
      .eq("id", property.id);
    if (error) throw error;
    await setFlash("Saved. You're ready for this one.");
  } catch (err) {
    console.error("emergency_prep save failed", err);
    await setFlash(
      "Couldn't save that just now. Please try again in a bit.",
      "error"
    );
  }
  revalidatePath("/emergency");
}
