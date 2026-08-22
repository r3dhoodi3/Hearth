"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getCurrentContractor } from "@/lib/contractor";
import { hasProPlan } from "@/lib/subscription";
import { setFlash } from "@/lib/flash";
import { JOB_CATEGORIES } from "@/lib/constants";

// Server actions for the pro's project portfolio (migration 0045). Projects
// appear on the public page (/p/<id>) through the public_pro_profile RPC;
// pros manage them here. Every write re-verifies ownership through the
// contractor row (RLS enforces the same thing at the database layer).
//
// Tiering, enforced HERE so the client UI is only a convenience:
//   * Every pro can showcase up to FREE_PROJECT_LIMIT projects.
//   * Pro members (hasProPlan) get unlimited projects; the Before/After
//     labels rendering publicly is gated inside the RPC itself.

const FREE_PROJECT_LIMIT = 3;
const MAX_PHOTOS_PER_PROJECT = 20;

// async since Next 15: setFlash writes a cookie, and cookies() is a Promise
// there. Still `never`-returning at the end (redirect throws), so every call
// site keeps its control-flow meaning as long as it awaits.
async function fail(message: string): Promise<never> {
  await setFlash(message, "error");
  redirect("/pro/profile");
}

// True only if `raw` is a URL whose origin exactly matches Supabase Storage
// AND whose path is a public object under `pathPrefix`. Parsed with new
// URL() rather than a substring check: a substring check like
// `url.includes("/pro-logos/<id>/projects/")` is defeated by e.g.
// "https://evil.com/x?y=/pro-logos/<id>/projects/" (the substring is
// present, but the host is attacker-controlled). Same helper and reasoning
// as isOwnedStoragePath in pro/profile/actions.ts - kept as a local copy so
// this file doesn't reach into a sibling server action module.
function isOwnedStoragePath(raw: string, pathPrefix: string): boolean {
  if (!raw) return false;
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!base) return false;
  try {
    const url = new URL(raw);
    const storageOrigin = new URL(base).origin;
    return url.origin === storageOrigin && url.pathname.startsWith(pathPrefix);
  } catch {
    return false;
  }
}

// Create a new project or update an existing one (hidden project_id decides).
// Photos are saved as the full current set: the form submits every photo it
// shows (kept + newly uploaded), so the rows are replaced wholesale.
export async function saveProjectAction(formData: FormData) {
  const contractor = await getCurrentContractor();
  if (!contractor) redirect("/pro/onboarding");

  const supabase = await createClient();
  // Cast: the 0045 tables aren't in the generated types (database.types.ts
  // is not regenerated here).
  const from = supabase.from as any;

  const str = (name: string) => String(formData.get(name) ?? "").trim();

  const projectId = str("project_id") || null;

  // Title: required, capped server-side (the input's maxLength is a hint).
  const title = str("title");
  if (!title) await fail("Give the project a title.");
  if (title.length > 80) await fail("The title must be 80 characters or fewer.");

  // Category: must be one of the canonical job categories, or none.
  const categoryRaw = str("category");
  const category = JOB_CATEGORIES.some((c) => c.value === categoryRaw)
    ? categoryRaw
    : null;

  const description = str("description");
  if (description.length > 500) {
    await fail("The description must be 500 characters or fewer.");
  }

  const months = str("months");
  if (months.length > 20) {
    await fail('Keep the "when" short, like "March 2026".');
  }

  // Photos: paired hidden inputs in document order, so index i of photo_urls
  // matches index i of photo_befores. Only URLs inside THIS contractor's
  // projects/ folder of the pro-logos bucket are accepted, so rows can't be
  // pointed at arbitrary images (these URLs are rendered, not fetched
  // server-side, but the same strict check is used for consistency and to
  // rule out any future SSRF-shaped consumer).
  const urls = formData.getAll("photo_urls").map((v) => String(v));
  const befores = formData.getAll("photo_befores").map((v) => String(v));
  const prefix = `/storage/v1/object/public/pro-logos/${contractor.id}/projects/`;
  const photos = urls
    .map((url, i) => ({ url, is_before: befores[i] === "1" }))
    .filter((p) => isOwnedStoragePath(p.url, prefix));
  if (photos.length > MAX_PHOTOS_PER_PROJECT) {
    await fail(`A project can have up to ${MAX_PHOTOS_PER_PROJECT} photos.`);
  }

  const fields = {
    title,
    category,
    description: description || null,
    months: months || null,
  };

  let savedId = projectId;

  if (projectId) {
    // Update: ownership check through the contractor row (plus RLS).
    const { data: existing, error: ownErr } = await from("pro_projects")
      .select("id")
      .eq("id", projectId)
      .eq("contractor_id", contractor.id)
      .maybeSingle();
    if (ownErr || !existing) await fail("That project couldn't be found.");

    const { error } = await from("pro_projects")
      .update(fields)
      .eq("id", projectId)
      .eq("contractor_id", contractor.id);
    if (error) await fail("Couldn't save the project. Please try again.");

    // Replace the photo set with what the form currently shows.
    const { error: clearErr } = await from("pro_project_photos")
      .delete()
      .eq("project_id", projectId);
    if (clearErr) await fail("Couldn't save the project photos. Please try again.");
  } else {
    // Create: enforce the free tier cap server-side. Members are unlimited.
    const { count, error: countErr } = await from("pro_projects")
      .select("id", { count: "exact", head: true })
      .eq("contractor_id", contractor.id);
    if (countErr) {
      await fail("Projects aren't set up yet. Please try again later.");
    }
    const existingCount = count ?? 0;
    if (existingCount >= FREE_PROJECT_LIMIT && !(await hasProPlan())) {
      await fail(
        `Free accounts can showcase up to ${FREE_PROJECT_LIMIT} projects. ` +
          "Hearth Pro members get unlimited projects: see /pro/plus."
      );
    }

    const { data: created, error } = await from("pro_projects")
      .insert({ contractor_id: contractor.id, ...fields, sort: existingCount })
      .select("id")
      .single();
    if (error || !created) {
      await fail("Couldn't save that project just now. Please try again.");
    }
    savedId = created.id as string;
  }

  if (photos.length > 0) {
    const rows = photos.map((p, i) => ({
      project_id: savedId,
      url: p.url,
      is_before: p.is_before,
      sort: i,
    }));
    const { error } = await from("pro_project_photos").insert(rows);
    if (error) await fail("Couldn't save the project photos. Please try again.");
  }

  await setFlash(projectId ? "Project updated." : "Project added.");
  revalidatePath("/pro/profile");
  redirect("/pro/profile");
}

// Delete a project (photos cascade with it). Storage objects are removed
// best-effort: a leftover file in the public bucket is harmless, so a failed
// cleanup never blocks the delete.
export async function deleteProjectAction(formData: FormData) {
  const contractor = await getCurrentContractor();
  if (!contractor) redirect("/pro/onboarding");

  const supabase = await createClient();
  // Cast: the 0045 tables aren't in the generated types.
  const from = supabase.from as any;

  const projectId = String(formData.get("project_id") ?? "").trim();
  if (!projectId) await fail("That project couldn't be found.");

  const { data: existing, error: ownErr } = await from("pro_projects")
    .select("id")
    .eq("id", projectId)
    .eq("contractor_id", contractor.id)
    .maybeSingle();
  if (ownErr || !existing) await fail("That project couldn't be found.");

  // Collect storage paths before the rows cascade away.
  const { data: photoRows } = await from("pro_project_photos")
    .select("url")
    .eq("project_id", projectId);
  const marker = "/pro-logos/";
  const paths = (Array.isArray(photoRows) ? photoRows : [])
    .map((r: { url: string }) => {
      const idx = r.url.indexOf(marker);
      return idx >= 0 ? r.url.slice(idx + marker.length) : null;
    })
    .filter((p: string | null): p is string =>
      Boolean(p && p.startsWith(`${contractor.id}/projects/`))
    );

  const { error } = await from("pro_projects")
    .delete()
    .eq("id", projectId)
    .eq("contractor_id", contractor.id);
  if (error) await fail("Couldn't delete the project. Please try again.");

  if (paths.length > 0) {
    // Best-effort: 0033's owner delete policy covers these paths.
    await supabase.storage.from("pro-logos").remove(paths);
  }

  await setFlash("Project deleted.");
  revalidatePath("/pro/profile");
  redirect("/pro/profile");
}
