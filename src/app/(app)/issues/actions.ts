"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getActiveProperty } from "@/lib/property";
import { ISSUE_CATEGORIES, SEVERITIES } from "@/lib/constants";
import { isAllowedValue } from "@/lib/formFields";
import { setFlash } from "@/lib/flash";
import { ok, err, type ActionResult } from "@/lib/actionResult";
import { isOwnedStoragePath } from "@/lib/ownedStoragePath";

// Server-side length cap for free-text fields: trim, then quietly slice
// rather than erroring, so a paste-happy owner never loses their report.
function clipText(v: FormDataEntryValue | null, max: number): string | null {
  const s = typeof v === "string" ? v.trim() : "";
  return s ? s.slice(0, max) : null;
}

// Photo URLs come from PhotoUpload.tsx, which uploads to
// `${propertyId}/<uuid>.<ext>` in the home-photos bucket and posts the
// resulting URL back in a hidden field. "Comes from our own component" is not
// something the server can assume, though: a server action takes whatever
// FormData it is handed, and these strings are stored verbatim and later fed
// to /api/img to be signed. The length check alone let a forged post attach
// ANOTHER property's object key to a row on this one - a stored pointer at
// someone else's photo, plus a signing request for a path this caller never
// uploaded. So each URL now has to prove it sits under this property's own
// prefix (src/lib/ownedStoragePath.ts). Anything else is dropped quietly, the
// same way an oversized value already was: the only way to produce one is to
// forge the post, and the issue itself still saves.
function validPhotoUrls(formData: FormData, propertyId: string): string[] {
  return (formData.getAll("photo_urls") as string[]).filter((u) =>
    isOwnedStoragePath(u, propertyId)
  );
}

export async function reportIssueAction(
  formData: FormData
): Promise<ActionResult> {
  const property = await getActiveProperty();
  if (!property) {
    return err("Couldn't log that issue. Try again.");
  }
  const supabase = await createClient();

  const category = formData.get("category") as string;
  const severity = formData.get("severity") as string;
  // The <select>s aren't the guard: a server action takes whatever FormData it
  // is handed. Re-check both against the same lists the rest of the app reads
  // (same pattern as saveInspectionFindingsAction in inspection/actions.ts), so
  // a forged value can't write an enum that has no label, no icon, and no
  // matching contractor category.
  if (
    !isAllowedValue(ISSUE_CATEGORIES, category) ||
    !isAllowedValue(SEVERITIES, severity)
  ) {
    return err("Couldn't log that issue. Try again.");
  }

  // The system this issue hangs off is a hidden form field, so it is as
  // forgeable as the enums above and nothing downstream re-derives it: the
  // resolve path reads issues.system_id back and writes to that home_systems
  // row. RLS on home_systems would refuse the write, but a row pointing at
  // another home's system is a broken record either way, so the id is checked
  // against THIS home before it is stored. Dropped to null rather than
  // rejected, so a stale id just logs an unlinked issue.
  const systemIdRaw = (formData.get("system_id") as string) || null;
  let systemId: string | null = null;
  if (systemIdRaw) {
    const { data: sys } = await supabase
      .from("home_systems")
      .select("id")
      .eq("id", systemIdRaw)
      .eq("property_id", property.id)
      .maybeSingle();
    systemId = sys?.id ?? null;
  }

  const { data: issue, error } = await supabase
    .from("issues")
    .insert({
      property_id: property.id,
      system_id: systemId,
      category,
      severity,
      description: clipText(formData.get("description"), 4000),
    })
    .select("id")
    .single();

  if (error || !issue) {
    // Any photos the owner already picked were uploaded straight to storage
    // by PhotoUpload before this insert ran, so a failure here leaves them
    // orphaned (no DB row references them yet). Keeping this simple: report
    // the error and leave the form open (no redirect) so the owner can retry,
    // which will attach those same photo URLs once the insert succeeds.
    // Sweeping up true orphans (the owner gives up instead) is left to
    // future janitor work, not built here.
    return err("Couldn't log that issue. Try again.");
  }

  // Attach any uploaded photos.
  const urls = validPhotoUrls(formData, property.id);
  if (urls.length) {
    await supabase.from("photos").insert(
      urls.map((url) => ({
        property_id: property.id,
        related_type: "issue",
        related_id: issue.id,
        url,
      }))
    );
  }

  setFlash("Issue logged. Let's find you a pro.");
  revalidatePath("/issues");
  revalidatePath("/dashboard");
  revalidatePath("/forecast");

  // Hand the owner straight into the "get a pro" flow for this issue.
  // Encode the category so raw form input can't inject extra query params.
  redirect(
    `/contractors?issue=${issue.id}&category=${encodeURIComponent(category ?? "")}`
  );
}

export async function updateIssueAction(
  formData: FormData
): Promise<ActionResult> {
  const id = formData.get("id") as string;
  const supabase = await createClient();

  const category = formData.get("category") as string;
  const severity = formData.get("severity") as string;
  // Same allow-list as reportIssueAction above: an edit is just as forgeable
  // as the original post, so it gets the same check.
  if (
    !isAllowedValue(ISSUE_CATEGORIES, category) ||
    !isAllowedValue(SEVERITIES, severity)
  ) {
    return err("Couldn't save your changes. Try again.");
  }

  // RLS limits the update to an issue on a property the caller owns.
  const { error } = await supabase
    .from("issues")
    .update({
      category,
      severity,
      description: clipText(formData.get("description"), 4000),
    })
    .eq("id", id);
  if (error) {
    return err("Couldn't save your changes. Try again.");
  }
  setFlash("Issue updated");
  revalidatePath("/issues");
  revalidatePath("/dashboard");
  revalidatePath("/forecast");
  return ok();
}

// When an issue is resolved, lift the "bad condition" flag it put on its system
// so a chat-logged condition drop doesn't linger after the problem is fixed.
// We only clear a LOW rating (<=2) - the state a problem would have caused -
// and never touch a healthy or owner-confirmed one. This is on top of, not
// instead of, the live open-issues join Home and Cost Forecast both read
// (dashboard/page.tsx's issueForSystem, forecast.ts's buildForecast): that
// join is what actually clears the "needs repair" flag the moment status
// flips to resolved, no mutation required. This function only cleans up the
// separate condition_rating side effect some issues also cause.
async function liftSystemConditionForIssue(supabase: any, issueId: string) {
  const { data: issue } = await supabase
    .from("issues")
    .select("system_id")
    .eq("id", issueId)
    .maybeSingle();
  if (!issue?.system_id) return;
  const { data: sys } = await supabase
    .from("home_systems")
    .select("id, condition_rating")
    .eq("id", issue.system_id)
    .maybeSingle();
  if (sys && sys.condition_rating != null && sys.condition_rating <= 2) {
    await supabase
      .from("home_systems")
      .update({ condition_rating: null })
      .eq("id", sys.id);
  }
}

export async function resolveIssueAction(formData: FormData) {
  const id = formData.get("id") as string;
  const supabase = await createClient();
  const { error } = await supabase
    .from("issues")
    .update({ status: "resolved" })
    .eq("id", id);
  if (error) {
    setFlash("Couldn't resolve that issue. Try again.", "error");
    return;
  }
  await liftSystemConditionForIssue(supabase, id);
  setFlash("Issue resolved");
  revalidatePath("/issues");
  revalidatePath("/dashboard");
  revalidatePath("/forecast");
}

// Undo: reopen a resolved issue (accidental check-off). Called programmatically
// from IssueRow's checkbox toggle, which needs the ActionResult to surface a
// failure as a toast and revert the optimistic flip (setFlash alone never shows
// on this stay-on-page path).
export async function reopenIssueAction(id: string): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase
    .from("issues")
    .update({ status: "open" })
    .eq("id", id);
  if (error) {
    return err("Couldn't reopen that issue. Try again.");
  }
  revalidatePath("/issues");
  revalidatePath("/dashboard");
  revalidatePath("/forecast");
  return ok();
}

// Resolve via the checkbox toggle (takes an id, not FormData). Same
// ActionResult contract as reopenIssueAction above.
export async function checkResolveIssueAction(
  id: string
): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase
    .from("issues")
    .update({ status: "resolved" })
    .eq("id", id);
  if (error) {
    return err("Couldn't update that issue. Try again.");
  }
  await liftSystemConditionForIssue(supabase, id);
  revalidatePath("/issues");
  revalidatePath("/dashboard");
  revalidatePath("/forecast");
  return ok();
}
