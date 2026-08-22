"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getActiveProperty } from "@/lib/property";
import { lookupParcel } from "@/lib/parcel";
import { deriveOwnershipStatus } from "@/lib/ownershipMatch";
import {
  leadFeeFor,
  labelFor,
  JOB_CATEGORIES,
  ISSUE_CATEGORIES,
  BUDGET_RANGES,
  COLD_START_FREE_POSTING,
  BONUS_EXPIRY_DAYS,
  isMajorCategory,
} from "@/lib/constants";
import { setFlash } from "@/lib/flash";
import { hasPlus } from "@/lib/subscription";
import { alertProsForNewLead } from "@/lib/proAlerts";
import { sendNotification } from "@/lib/notify";
import { isMissingSchemaError } from "@/lib/dbErrors";
import { redactContact } from "@/lib/redact";
import { ok, err, type ActionResult } from "@/lib/actionResult";
import {
  launchCityForZip,
  OUT_OF_AREA_POST_MESSAGE,
} from "@/lib/serviceArea";
import { isAllowedValue } from "@/lib/formFields";
import type { Json } from "@/lib/database.types";

// Server-side counterpart to src/lib/analytics.ts's track(): that helper
// fires via navigator.sendBeacon, which doesn't exist in a server action, so
// this writes straight to app_events with the admin client instead. Mirrors
// src/app/pro/actions.ts's own trackServerEvent (same table, same
// isMissingSchemaError fallback to a log line if migration 0091 hasn't run
// on this DB yet, and never throws), duplicated here rather than imported
// since pro/actions.ts is a "use server" file and doesn't export it.
async function trackServerEvent(
  userId: string | null,
  event: string,
  props?: Record<string, unknown>
) {
  try {
    const admin = createAdminClient();
    const { error } = await admin.from("app_events").insert({
      event,
      props: (props ?? null) as Json | null,
      user_id: userId,
    });
    if (error && !isMissingSchemaError(error)) {
      console.error(`trackServerEvent(${event}): insert failed:`, error.message);
    } else if (error) {
      console.log("[track]", event, props ?? {});
    }
  } catch (e) {
    console.error(
      `trackServerEvent(${event}) failed:`,
      e instanceof Error ? e.message : e
    );
  }
}

// Apply fee formatted for a notification body: whole-dollar fees ($25/$50/$99)
// read as "$50", an aging-discounted fee ($42.50) keeps its cents. cents comes
// off lead_applications.fee_cents.
function formatFeeCents(cents: number): string {
  const dollars = (Number.isFinite(cents) ? cents : 0) / 100;
  return Number.isInteger(dollars) ? `$${dollars}` : `$${dollars.toFixed(2)}`;
}

// Photo URLs come from our own upload component (PhotoUpload), so anything
// oversized is not a real URL; drop it quietly instead of storing a broken
// link. Same rule as the issue tracker's photo handling.
function validPhotoUrls(formData: FormData): string[] {
  return (formData.getAll("photo_urls") as string[]).filter(
    (u) => typeof u === "string" && u.length > 0 && u.length <= 1000
  );
}

// Homeowner posts a job (Indeed-style). No pro is picked here: the lead is left
// unassigned (contractor_id null) so matching pros can apply to it. The chosen
// pro is selected later from the applicants.
export async function postJobAction(formData: FormData) {
  const property = await getActiveProperty();
  if (!property) throw new Error("No active property");

  // Launch-area gate (0124, widened to nine cities by 0126). Onboarding only
  // accepts launch-city ZIPs now, but homes claimed before that change can
  // carry any Orange County ZIP. open_jobs_for_me and apply_to_lead both
  // refuse jobs outside the launch cities, so a post from such a home would
  // succeed, notify nobody, and sit invisible forever - the homeowner deserves
  // the honest answer at post time instead. The message is the shared one in
  // src/lib/serviceArea.ts, so the city list only has to change in one place.
  if (!launchCityForZip(property.zip ?? "")) {
    setFlash(OUT_OF_AREA_POST_MESSAGE, "error");
    redirect("/contractors");
  }
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/signin");

  // Abuse gate: a post fans out up to ~250 pro notification writes (and, once
  // COLD_START_FREE_POSTING/COLD_START_FREE_ALERTS flip real providers on, up
  // to 200 real SMS/email sends) per submission, and posting is currently free
  // and uncapped during cold start (the open-job-count cap below is skipped
  // entirely while COLD_START_FREE_POSTING is on). Without a limiter here, a
  // looped/scripted poster could spam every matched pro at will. Fixed-window
  // limiter (migration 0068), same pattern as onboarding's parcel lookup and
  // account/help's support message. Fails open on a DB hiccup: only an
  // explicit `allowed === false` blocks, so a rate-limiter outage never stops
  // a legit homeowner from posting.
  const admin = createAdminClient();
  const { data: allowed } = await admin.rpc("rate_limit_hit", {
    p_bucket: `post:${user.id}`,
    p_limit: 8,
    p_window_seconds: 3600,
  });
  if (allowed === false) {
    setFlash("You're posting jobs too quickly, please wait a bit.", "error");
    redirect("/contractors");
  }
  // Daily cap on top of the hourly one (security audit finding #3): the hourly
  // limiter alone still lets one account post up to 8 * 24 = 192 times a day,
  // each fanning out up to ~200 pro emails/SMS with no consent gate on the
  // email side - a real cost/reputation cannon. 20/day is far above what any
  // real household could ever need (the free-tier open-job cap below is 3
  // OPEN jobs at once, not a daily count) but stops a scripted/looped poster
  // cold. Same fixed-window limiter, same fail-open-on-DB-hiccup behavior as
  // the hourly check above.
  const { data: allowedDay } = await admin.rpc("rate_limit_hit", {
    p_bucket: `post-day:${user.id}`,
    p_limit: 20,
    p_window_seconds: 86400,
  });
  if (allowedDay === false) {
    setFlash(
      "You've reached today's posting limit. Please try again tomorrow.",
      "error"
    );
    redirect("/contractors");
  }

  // Lazy ownership check (migration 0093): a property claimed before this
  // feature shipped never got an assessor-record check at claim time, so
  // ownership_checked_at is null forever unless something runs it. Run the
  // same check onboarding does (src/app/onboarding/actions.ts) once, here,
  // best-effort, so the fan-out gate below has a real answer instead of
  // treating every legacy property as permanently unverified. A property
  // already checked (checked_at set, verified or not) is never re-checked
  // here - onboarding's check is the source of truth going forward.
  let ownershipStatus = property.ownership_status;
  // `== null` (not `=== null`) on purpose: if this deploys before migration
  // 0093 has run against the live DB, ownership_checked_at simply is not a
  // selected column, so it reads back as undefined, not null. A strict
  // `=== null` check would silently never fire in that window, and every
  // job post would fall through to withholding email/SMS forever (see the
  // fail-safe default of ownershipStatus below) instead of at least
  // attempting the check - `== null` catches both and the try/catch below
  // still fails safe if the RPC or column genuinely doesn't exist yet.
  if (property.ownership_checked_at == null && property.zip) {
    try {
      const metaName = (user.user_metadata?.full_name as string | undefined)?.trim();
      let fullName = metaName || null;
      if (!fullName) {
        const { data: profile } = await supabase
          .from("users")
          .select("full_name")
          .eq("id", user.id)
          .maybeSingle();
        fullName = profile?.full_name?.trim() || null;
      }
      const facts = await lookupParcel(property.address_line1, property.zip);
      ownershipStatus = deriveOwnershipStatus(fullName, facts);
      await admin.rpc("record_ownership_check", {
        p_property_id: property.id,
        p_status: ownershipStatus,
        p_owner_names: facts.owner_names,
        p_owner_type: facts.owner_type,
        p_owner_occupied: facts.owner_occupied,
      });
    } catch (err) {
      console.error("Lazy ownership verification check failed:", err);
    }
  }

  const category = formData.get("category") as string;
  const issueId = (formData.get("issue_id") as string) || null;
  const timing = (formData.get("timing") as string) || null;
  const message = ((formData.get("message") as string) || "").trim() || null;

  // Existing issue photos the owner removed from the pre-attached preview
  // before posting (ExistingJobPhotos.tsx). Since a job posted from an issue
  // reuses that SAME issue_id for its photos (see photoIssueId below), a
  // "remove" here is a real delete of that photo row, scoped to this exact
  // issue and property so the form can't be used to touch anything else. Runs
  // before the description-length gate below so a removal always takes
  // effect even if the rest of the post is rejected and the owner retries.
  const removePhotoIds = (formData.getAll("remove_photo_ids") as string[]).filter(
    (id) => typeof id === "string" && /^[0-9a-f-]{36}$/i.test(id)
  );
  if (removePhotoIds.length && issueId) {
    await supabase
      .from("photos")
      .delete()
      .eq("property_id", property.id)
      .eq("related_type", "issue")
      .eq("related_id", issueId)
      .in("id", removePhotoIds);
  }

  // Optional budget band: a signal for pros, never a commitment. Only accept a
  // known band value; never write arbitrary client input.
  const budgetRaw = (formData.get("budget_range") as string) || "";
  const budgetRange = BUDGET_RANGES.some((b) => b.value === budgetRaw)
    ? budgetRaw
    : null;

  // Major-tier project scope (0114): square footage, material notes, and a
  // plans/permits flag. Read and validated regardless of category, but only
  // ever attached to the lead when the category is actually major-tier
  // (roof/structural/remodeling) - a non-major post ignores these fields
  // entirely, so its behavior is byte-for-byte what it was before 0114.
  const isMajor = isMajorCategory(category);

  // Square footage: clamped to a sane range rather than rejected outright -
  // it's a pro-facing signal, not a fact worth failing the whole post over.
  const SQUARE_FOOTAGE_MIN = 1;
  const SQUARE_FOOTAGE_MAX = 20000;
  const sqFtRaw = (formData.get("square_footage") as string) || "";
  const sqFtParsed = sqFtRaw.trim() ? Number(sqFtRaw) : NaN;
  const squareFootage =
    isMajor && Number.isFinite(sqFtParsed)
      ? Math.round(
          Math.min(SQUARE_FOOTAGE_MAX, Math.max(SQUARE_FOOTAGE_MIN, sqFtParsed))
        )
      : null;

  // Material notes: short free text, capped well under the DB's own CHECK
  // (300 chars, migration 0114) so a truncated-but-valid value always reaches
  // the insert rather than tripping the constraint.
  const MATERIAL_NOTES_MAX_LEN = 300;
  const materialNotesRaw = ((formData.get("material_notes") as string) || "").trim();
  const materialNotes =
    isMajor && materialNotesRaw
      ? materialNotesRaw.slice(0, MATERIAL_NOTES_MAX_LEN)
      : null;

  // Checkbox: absent from formData entirely when unchecked, so its presence
  // IS the true/false answer. Null (not false) for a non-major post, since
  // the question was never asked there.
  const hasPlansPermits = isMajor ? formData.has("has_plans_permits") : null;

  const photoUrls = validPhotoUrls(formData);

  // Contact details are captured on the form and snapshotted onto the job,
  // since a lead is a frozen packet: pros read only contractor_leads, never the
  // homeowner's account. The signed-in user's auth email is the fallback when
  // the form field is left blank.
  const homeownerName = (formData.get("homeowner_name") as string) || null;
  const homeownerEmail =
    (formData.get("homeowner_email") as string) || user.email || null;
  const homeownerPhone = (formData.get("homeowner_phone") as string) || null;

  // The job description pros see: the homeowner's own words, falling back to the
  // linked issue's text.
  let issueDescription: string | null = message;
  let issueSeverity: string | null = null;
  if (issueId) {
    const { data: issue } = await supabase
      .from("issues")
      .select("description, severity")
      .eq("id", issueId)
      .maybeSingle();
    issueDescription = message ?? issue?.description ?? null;
    issueSeverity = issue?.severity ?? null;
  }

  // The redirect on either validation gate below carries what the owner typed
  // back as query params (the page already prefills category/timing/desc/
  // issue from searchParams), so a rejected post keeps the text fields.
  // Contact fields re-prefill from the saved profile as usual.
  const keepParamsQuery = () => {
    const keep = new URLSearchParams();
    if (category) keep.set("category", category);
    if (timing) keep.set("timing", timing);
    if (message) keep.set("desc", message);
    if (issueId) keep.set("issue", issueId);
    return keep.toString();
  };
  // Photos are the one thing the round-trip can't keep: they live in
  // PhotoUpload's client state, which the redirect remounts empty. So the
  // already-uploaded objects are removed from storage (they'd be unreachable
  // orphans otherwise). Best-effort, same pattern as saveDocumentAction: a
  // storage hiccup here should never block the validation redirect.
  const cleanupOrphanPhotos = async () => {
    if (!photoUrls.length) return;
    const paths = photoUrls
      .map((u) => u.split("/home-photos/")[1])
      .filter((p): p is string => Boolean(p));
    if (paths.length) {
      await supabase.storage.from("home-photos").remove(paths);
    }
  };

  // Only a real category may set the payout tier: a forged value would fall
  // back to the cheapest "other" fee in leadFeeFor, and would reach no pro at
  // all (open_jobs_for_me matches on exact equality with a pro's own
  // categories). Same check updateJobAction and directRequestAction make, in
  // the setFlash + redirect style this action uses.
  if (!isAllowedValue(JOB_CATEGORIES, category)) {
    await cleanupOrphanPhotos();
    setFlash("Please pick a valid job category.", "error");
    redirect("/contractors");
  }

  // Pros pay to apply, so a posting has to give them something to go on:
  // require a real description (at least 20 characters) before it goes live.
  if ((issueDescription ?? "").trim().length < 20) {
    await cleanupOrphanPhotos();
    setFlash(
      photoUrls.length
        ? "Please describe the job in at least 20 characters so pros know what they're applying to. Your photos weren't kept, so please re-attach them."
        : "Please describe the job in at least 20 characters so pros know what they're applying to.",
      "error"
    );
    const query = keepParamsQuery();
    redirect(query ? `/contractors?${query}` : "/contractors");
  }

  // Major-tier jobs (0114) need a real budget so pros can bid seriously - no
  // more silent "Prefer not to say". BudgetField makes the select `required`
  // client-side for these categories; this is the authoritative server-side
  // enforcement (a client hitting the action directly, or an older cached
  // page, can't bypass it).
  if (isMajor && !budgetRange) {
    await cleanupOrphanPhotos();
    setFlash(
      "Pros need a budget range to bid seriously on projects this size. Please pick one and post again.",
      "error"
    );
    const query = keepParamsQuery();
    redirect(query ? `/contractors?${query}` : "/contractors");
  }

  // Scrub contact info out of the description before it's stored anywhere:
  // pros pay to apply through the marketplace, and a homeowner's "call me at
  // ..." dropped into the free-text field would let a pro take the job
  // off-platform before ever paying to apply. The 20-character check above
  // ran on the real text (so a description that's mostly a phone number still
  // has to carry enough real content), but everything stored on the lead, fed
  // to the carrier issue, and pushed to pro alerts uses the redacted version.
  issueDescription = issueDescription ? redactContact(issueDescription) : issueDescription;

  const address = [property.address_line1, property.city, property.state]
    .filter(Boolean)
    .join(", ");

  // Guard against a double-submit posting the same job twice: if an identical
  // open posting was just created (same property + category), reuse it.
  const { data: recent } = await supabase
    .from("contractor_leads")
    .select("id, created_at")
    .eq("property_id", property.id)
    .eq("category", category)
    .is("contractor_id", null)
    .eq("status", "new")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (recent && Date.now() - new Date(recent.created_at).getTime() < 15000) {
    redirect("/contractors?posted=1");
  }

  // Free vs Plus open-job limits: a free homeowner may have 3 open jobs at a
  // time (plenty for any normal household, and it keeps junk postings down);
  // Plus removes the cap. An open listing is one no pro has been picked for yet.
  // COLD START: while COLD_START_FREE_POSTING is on, posting is free for
  // everyone and the cap is skipped entirely. Flip the constant to restore it.
  if (!COLD_START_FREE_POSTING) {
    const plus = await hasPlus();
    const limit = plus ? Infinity : 3;
    const { count: openCount } = await supabase
      .from("contractor_leads")
      .select("id", { count: "exact", head: true })
      .eq("property_id", property.id)
      .is("contractor_id", null)
      .eq("status", "new");
    if ((openCount ?? 0) >= limit) {
      // Only free homeowners can reach this: Plus is unlimited.
      redirect("/plus?reason=job_limit");
    }
  }

  // Photos ride on an issue (photos rows with related_type 'issue'), which is
  // exactly what the pro board's has_photos signal reads (0028's
  // open_jobs_for_me checks photos against the lead's issue_id). A job posted
  // straight from this form has no issue yet, so create a lightweight one to
  // carry the photos. Born converted_to_lead so the issue tracker never nudges
  // the owner about it, and severity stays off the lead (issueSeverity is
  // untouched) so no bogus severity chip appears on the pro's card.
  // Best-effort: if the carrier issue can't be created, the post still goes
  // through, just without photos.
  let photoIssueId = issueId;
  if (photoUrls.length && !photoIssueId) {
    const issueCategory = ISSUE_CATEGORIES.some((c) => c.value === category)
      ? category
      : "other";
    const { data: carrier } = await supabase
      .from("issues")
      .insert({
        property_id: property.id,
        category: issueCategory,
        severity: "low",
        description: (issueDescription ?? "").slice(0, 4000) || null,
        converted_to_lead: true,
      })
      .select("id")
      .single();
    if (carrier) photoIssueId = carrier.id;
  }

  const leadRow = {
    property_id: property.id,
    issue_id: photoIssueId,
    contractor_id: null, // open job: pros apply, homeowner picks later
    category,
    status: "new",
    payout_amount: leadFeeFor(category),
    homeowner_name: homeownerName,
    homeowner_email: homeownerEmail,
    homeowner_phone: homeownerPhone,
    property_address: address,
    issue_description: issueDescription,
    issue_severity: issueSeverity,
    timing,
  };

  // budget_range (0047) and square_footage/material_notes/has_plans_permits
  // (0114) may not have reached this database yet: write them via `as any`,
  // cascading down to fewer columns on the missing-column fingerprint
  // specifically, so posting never breaks on a DB mid-migration. Same pattern
  // as the contractors insert in pro/actions, extended to two optional
  // layers instead of one: the 0114 scope fields are stripped first (the
  // newer of the two migrations, so the more likely one to be missing), then
  // budget_range, before falling back to the bare row.
  const scopeExtras: Record<string, unknown> = {};
  if (squareFootage !== null) scopeExtras.square_footage = squareFootage;
  if (materialNotes !== null) scopeExtras.material_notes = materialNotes;
  if (hasPlansPermits !== null) scopeExtras.has_plans_permits = hasPlansPermits;
  const budgetExtras: Record<string, unknown> = {};
  if (budgetRange) budgetExtras.budget_range = budgetRange;

  let { data: inserted, error } = await supabase
    .from("contractor_leads")
    .insert({ ...leadRow, ...budgetExtras, ...scopeExtras } as any)
    .select("id, created_at")
    .single();
  if (
    error &&
    Object.keys(scopeExtras).length > 0 &&
    isMissingSchemaError(error)
  ) {
    ({ data: inserted, error } = await supabase
      .from("contractor_leads")
      .insert({ ...leadRow, ...budgetExtras } as any)
      .select("id, created_at")
      .single());
  }
  if (
    error &&
    Object.keys(budgetExtras).length > 0 &&
    isMissingSchemaError(error)
  ) {
    ({ data: inserted, error } = await supabase
      .from("contractor_leads")
      .insert(leadRow as any)
      .select("id, created_at")
      .single());
  }
  if (error) throw new Error(error.message);

  // Second half of the double-submit guard. The pre-insert check above is
  // check-then-act: two truly concurrent submits (two tabs, a network retry
  // landing in a second lambda) can both pass it before either insert lands.
  // So re-check AFTER the insert: among identical open postings created within
  // the same 15s window, every duplicate submit sees the same deterministic
  // order (created_at, then id as the tiebreak), the first row is the keeper,
  // and any submit whose own row isn't the keeper deletes its row (plus the
  // carrier issue it just created, if any) and lands on the same "posted"
  // redirect. App-level best effort, not a DB constraint: a residual race
  // remains if a read misses a not-yet-visible concurrent commit, but the
  // window shrinks from the whole action to the moments around the insert.
  if (inserted?.id) {
    const windowStart = new Date(
      new Date(inserted.created_at).getTime() - 15000
    ).toISOString();
    const { data: twins } = await supabase
      .from("contractor_leads")
      .select("id")
      .eq("property_id", property.id)
      .eq("category", category)
      .is("contractor_id", null)
      .eq("status", "new")
      .gte("created_at", windowStart)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true });
    const keeper = twins?.[0];
    if (keeper && keeper.id !== inserted.id) {
      await supabase.from("contractor_leads").delete().eq("id", inserted.id);
      // The keeper submit attaches photos to its own carrier issue; ours
      // would be an orphan, so drop it (only if this submit created it: a
      // pre-existing linked issue is never touched).
      if (photoIssueId && photoIssueId !== issueId) {
        await supabase.from("issues").delete().eq("id", photoIssueId);
      }
      redirect("/contractors?posted=1");
    }
  }

  // "post_job" (src/app/api/track/route.ts): fires once for the kept posting
  // (below the dedup block above, so a duplicate submit that gets deleted
  // never double-counts). No PII, just the category.
  await trackServerEvent(user.id, "post_job", { category });

  // Attach the uploaded photos to the (existing or carrier) issue, exactly like
  // the issue tracker does, so pros see the "Photos attached" quality chip.
  // Best-effort: a photo hiccup should never break the post.
  if (photoUrls.length && photoIssueId) {
    await supabase.from("photos").insert(
      photoUrls.map((url) => ({
        property_id: property.id,
        related_type: "issue",
        related_id: photoIssueId!,
        url,
      }))
    );
  }

  // Mark the originating issue so we don't keep nudging the owner about it.
  if (issueId) {
    await supabase
      .from("issues")
      .update({ converted_to_lead: true })
      .eq("id", issueId);
  }

  // Instant new-job alerts through the full notification stack (in-app now,
  // email/SMS once those providers are configured). Normally a Hearth Pro
  // member perk; while COLD_START_FREE_ALERTS is on, every category-matched
  // pro gets one. Pros not alerted keep the nudge below unchanged.
  // alertProsForNewLead catches everything internally and returns the ids it
  // reached, so this can never break the post and members aren't pinged twice.
  const alertedPros = await alertProsForNewLead({
    category,
    timing,
    issue_description: issueDescription,
    // For the cold-start free-alerts path's state-level locality check
    // (null-safe, mirroring 0046: missing data never hides a job).
    property_state: property.state ?? null,
    // For the launch-city filter (0124), so a pro isn't texted about a job
    // the board and apply gate will both refuse them. Null-safe the same way.
    property_zip: property.zip ?? null,
    // Fan-out-cannon gate (migration 0093): an unverified property must not
    // be able to trigger up to 200 real emails/texts to pros on someone
    // else's say-so. In-app notifications still go out either way - only
    // the external channels are held back until the assessor-record match
    // says this poster is plausibly who they claim to be.
    externalChannels: ownershipStatus === "verified",
  });

  // Nudge matching pros that a fresh job just came in, so they see it while
  // it's still open and worth racing other applicants for. Best-effort only:
  // a notification hiccup should never break the homeowner's post.
  try {
    const { data: matches } = await admin
      .from("contractors")
      .select("user_id")
      .not("user_id", "is", null)
      .contains("categories", [category])
      .limit(50);
    const categoryLabel = labelFor(JOB_CATEGORIES, category);
    // Collect rows and send a single batched insert instead of awaiting one
    // insert per matched pro sequentially: up to 50 round-trips in series was
    // adding latency to the post and amplifying it per-post.
    const rows = (matches ?? []).flatMap((match) => {
      if (!match.user_id || alertedPros.has(match.user_id)) return [];
      return [
        {
          user_id: match.user_id,
          kind: "new_lead",
          title: `New ${categoryLabel} job posted nearby`,
          body: "A homeowner just posted a job. Apply before other pros do.",
          url: "/pro",
        },
      ];
    });
    if (rows.length) {
      await admin.from("notifications").insert(rows);
    }
  } catch {
    // Notifications are a nice-to-have here, not part of the posting flow.
  }

  revalidatePath("/contractors");
  revalidatePath("/issues");
  // Unique token so the post form remounts and the job fields reset for the next
  // posting (contact stays, since it's prefilled from the profile).
  redirect(`/contractors?posted=${Date.now()}`);
}

// Homeowner edits a posted job (category, timing, details, contact). RLS limits
// the update to a lead on a property the caller owns. An edit re-applies the
// posting guards from postJobAction (pros pay to apply, so an edit must not
// degrade the posting below what a fresh post is allowed to be), and once any
// pro has paid the non-refundable apply fee the category (and with it the
// payout tier) is frozen, mirroring closeJobAction's refusal to cancel.
//
// EditJobForm calls this programmatically (await updateJobAction(fd)) rather
// than posting a plain <form>, so it returns ActionResult instead of using
// setFlash: the panel only closes after a real ok(), and a validation failure
// keeps it open with the typed input intact and the error shown inline.
export async function updateJobAction(
  formData: FormData
): Promise<ActionResult> {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/signin");

  const leadId = String(formData.get("lead_id"));
  const category = formData.get("category") as string;
  const timing = (formData.get("timing") as string) || null;
  const message = ((formData.get("message") as string) || "").trim() || null;
  const homeownerName = (formData.get("homeowner_name") as string) || null;
  // Mirror postJobAction: the signed-in user's auth email is the fallback when
  // the form field is left blank, so an edit never strips the contact email
  // off the frozen lead packet.
  const homeownerEmail =
    (formData.get("homeowner_email") as string) || user.email || null;
  const homeownerPhone = (formData.get("homeowner_phone") as string) || null;

  // Only a real category may set the payout tier: a forged value would fall
  // back to the cheapest "other" fee in leadFeeFor.
  if (!JOB_CATEGORIES.some((c) => c.value === category)) {
    return err("Please pick a valid job category.");
  }

  // Same 20-character description floor as postJobAction: pros pay to apply,
  // so an edit can't blank out what they're applying to. Not labeled
  // "optional" on the form: see the honest label + minLength hint there.
  if ((message ?? "").length < 20) {
    return err(
      "Please describe the job in at least 20 characters so pros know what they're applying to."
    );
  }

  // RLS scopes this read to a lead the caller owns, same as the update below.
  const { data: lead } = await supabase
    .from("contractor_leads")
    .select("id, category")
    .eq("id", leadId)
    .maybeSingle();
  if (!lead) {
    return err("Couldn't find that job. Please refresh and try again.");
  }

  // Once a pro has paid the (non-refundable) apply fee, the job they paid for
  // can't morph into a different, differently-priced one: refuse a category
  // swap, exactly as closeJobAction refuses a cancel. Timing/details/contact
  // edits on the same category are still fine.
  if (category !== lead.category) {
    const { count } = await (supabase as any)
      .from("lead_applications")
      .select("id", { count: "exact", head: true })
      .eq("lead_id", leadId);
    if ((count ?? 0) > 0) {
      return err(
        "Pros have already paid to apply to this job, so its category can't change. Edit the details, or post the new work as a separate job."
      );
    }
  }

  // Scrub contact info out of the description before it's stored, mirroring
  // postJobAction: pros pay to apply through the marketplace, and a "call me
  // at ..." dropped into an edit would let a pro take the job off-platform
  // before ever paying to apply. The 20-character floor above ran on the raw
  // text; only the stored value is redacted.
  const redactedMessage = message ? redactContact(message) : message;

  const { error } = await supabase
    .from("contractor_leads")
    .update({
      category,
      payout_amount: leadFeeFor(category),
      timing,
      issue_description: redactedMessage,
      homeowner_name: homeownerName,
      homeowner_email: homeownerEmail,
      homeowner_phone: homeownerPhone,
    })
    .eq("id", leadId);
  if (error) return err("Couldn't save those changes just now. Please try again.");

  // The flash cookie survives revalidatePath, so this still shows even
  // though EditJobForm closes the panel itself on ok() rather than reloading.
  setFlash("Job updated.", "success");
  revalidatePath("/contractors");
  return ok();
}

// Homeowner closes (cancels) a job posting. Two shapes, depending on whether
// any pro has paid to apply:
//  - No live applicants: nothing paid, nothing to preserve. Delete, as before.
//  - Has live applicants (status 'applied', not yet ghost-refunded - mirrors
//    enforce_contractor_leads_locked()'s own "live" check in 0087): the
//    non-refundable apply fee means the row can't just vanish, and this used
//    to be flatly refused ("pick one instead"). It's opened up here, but
//    WITHOUT inventing any new money logic. See migration 0092 for the full
//    reasoning: a raw status flip to 'closed' either gets silently reverted
//    by the DB trigger (0087) or, if forced through a privileged RPC, would
//    make ghost_refund_application() - the only refund path for these fees -
//    permanently unable to see the lead (it requires status = 'new'). So
//    instead this stamps a plain owner_closed_at marker the ghost-protection
//    cron and refund function never look at, and notifies the applicants.
//    Their apply fee still comes back automatically on the normal 7-day
//    ghost-protection schedule if nobody was chosen - this action moves zero
//    money and reads no wallet/fee columns.
export async function closeJobAction(formData: FormData) {
  const supabase = await createClient();
  const leadId = String(formData.get("lead_id"));
  // Capped before it ever reaches notification bodies or the flash message:
  // it's a free-text field with no length limit at the source.
  const reason = ((formData.get("reason") as string) || "").slice(0, 200);

  // RLS scopes this read to a lead on a property the caller owns.
  const { data: lead } = await supabase
    .from("contractor_leads")
    .select("id, contractor_id, status")
    .eq("id", leadId)
    .maybeSingle();
  if (!lead) {
    setFlash("Couldn't find that job. Please refresh and try again.", "error");
    revalidatePath("/contractors");
    return;
  }
  if (lead.contractor_id || lead.status !== "new") {
    // A pro is already assigned (or the lead is otherwise not a plain open
    // posting): closing here would be meaningless, and the UI never renders
    // this form for that job. Guard anyway against a forged/replayed submit.
    setFlash(
      "This job already has a pro assigned, so it can't be closed here.",
      "error"
    );
    revalidatePath("/contractors");
    return;
  }

  const { count } = await (supabase as any)
    .from("lead_applications")
    .select("id", { count: "exact", head: true })
    .eq("lead_id", leadId)
    .eq("status", "applied")
    .is("refunded_at", null);

  if ((count ?? 0) > 0) {
    // Stamp the marker. The `.is("owner_closed_at", null)` filter makes a
    // resubmit (e.g. a doubled form post) a no-op on the second try, so
    // applicants are never notified twice for the same close.
    const { data: updated, error } = await (supabase as any)
      .from("contractor_leads")
      .update({ owner_closed_at: new Date().toISOString() })
      .eq("id", leadId)
      .is("owner_closed_at", null)
      .select("id")
      .maybeSingle();

    if (error && isMissingSchemaError(error)) {
      // Migration 0092 hasn't run against this database yet: degrade to the
      // old refusal instead of crashing or silently no-oping.
      setFlash(
        "Pros have already applied, so this job can't be closed. Pick one from the applicants.",
        "error"
      );
      revalidatePath("/contractors");
      return;
    }
    if (error) {
      setFlash("Couldn't close that job just now. Please try again.", "error");
      revalidatePath("/contractors");
      return;
    }

    // Tell the pros who paid to apply, honestly: closed, nobody picked, fee
    // follows the normal ghost-protection refund timeline. Best-effort: the
    // close itself already saved, so a notification hiccup here shouldn't
    // turn into an error the homeowner sees.
    if (updated) {
      try {
        const { data: apps } = await (supabase as any)
          .from("lead_applications")
          .select("contractor_id")
          .eq("lead_id", leadId)
          .eq("status", "applied")
          .is("refunded_at", null);
        const contractorIds: string[] = Array.from(
          new Set<string>(
            (apps ?? [])
              .map((a: any) => a.contractor_id as string | null)
              .filter((id: string | null): id is string => Boolean(id))
          )
        );
        if (contractorIds.length) {
          const admin = createAdminClient();
          const { data: contractors } = await admin
            .from("contractors")
            .select("id, user_id")
            .in("id", contractorIds);
          const notifyTargets = (contractors ?? []).filter(
            (c): c is typeof c & { user_id: string } => Boolean(c.user_id)
          );
          const userIds = Array.from(
            new Set(notifyTargets.map((c) => c.user_id))
          );
          // Contact details so the email/SMS channels can fire once their
          // providers are configured, following the contractors -> users
          // sms_consent pattern in src/app/pro/chats/actions.ts.
          const { data: users } = userIds.length
            ? await admin
                .from("users")
                .select("id, email, phone, sms_consent")
                .in("id", userIds)
            : { data: [] as { id: string; email: string | null; phone: string | null; sms_consent: boolean | null }[] };
          const userById = new Map((users ?? []).map((u) => [u.id, u]));
          // The money line is the ghost-protection rule, unchanged by this
          // close: nobody was chosen, so the fee comes back as wallet credit
          // on the usual 7-day schedule.
          const creditLine =
            " If you paid to apply, that fee comes back to your wallet as credit on the usual 7-day schedule.";
          const body = reason
            ? `They closed it without choosing anyone: ${reason}.${creditLine}`
            : `They closed it without choosing anyone.${creditLine}`;
          // sendNotification always writes the in-app row unconditionally;
          // email/SMS stay dormant until their provider env vars are set.
          await Promise.all(
            notifyTargets.map((c) => {
              const contact = userById.get(c.user_id);
              return sendNotification(admin, {
                userId: c.user_id,
                kind: "job_closed",
                title: "The homeowner closed this job",
                body,
                url: "/pro",
                email: contact?.email ?? null,
                phone: contact?.phone ?? null,
                smsConsent: contact?.sms_consent === true,
              });
            })
          );
        }
      } catch {
        // Notifications are a nice-to-have here, not part of the close.
      }
    }

    setFlash(reason ? `Job closed: ${reason}.` : "Job closed.", "info");
    revalidatePath("/contractors");
    revalidatePath("/dashboard");
    return;
  }

  // No live applicants: nothing paid, nothing to preserve. Delete as before.
  const { error } = await supabase
    .from("contractor_leads")
    .delete()
    .eq("id", leadId);
  if (error) setFlash("Couldn't close that job just now. Please try again.", "error");
  else setFlash(reason ? `Job closed: ${reason}.` : "Job closed.", "info");
  revalidatePath("/contractors");
  revalidatePath("/dashboard");
}

// Homeowner picks a pro from the applicants. The DB function assigns + unlocks
// the chosen pro (they get contact + chat) and declines the rest.
export async function chooseApplicantAction(formData: FormData) {
  const supabase = (await createClient()) as any;
  const applicationId = String(formData.get("application_id"));
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Capture the applicants who are about to be credited BEFORE the pick runs:
  // choose_applicant() flips the losers to 'declined' and stamps their
  // refunded_at, so this same "live, never-refunded, non-zero fee" filter run
  // afterward would come back empty. Read here mirrors the DB's credit-back
  // eligibility exactly (status 'applied', refunded_at null, fee > 0, and not
  // the chosen application), so we notify precisely the pros who got credit and
  // never the chosen pro. Best-effort: a read hiccup just means no notice, it
  // never blocks the pick. RLS scopes this to a lead the caller owns.
  let credited: { contractor_id: string; fee_cents: number }[] = [];
  try {
    const { data: chosenApp } = await supabase
      .from("lead_applications")
      .select("lead_id")
      .eq("id", applicationId)
      .maybeSingle();
    if (chosenApp?.lead_id) {
      const { data: apps } = await supabase
        .from("lead_applications")
        .select("contractor_id, fee_cents")
        .eq("lead_id", chosenApp.lead_id)
        .eq("status", "applied")
        .is("refunded_at", null)
        .neq("id", applicationId);
      credited = (apps ?? [])
        .filter(
          (a: { contractor_id: string | null; fee_cents: number | null }) =>
            Boolean(a.contractor_id) && (a.fee_cents ?? 0) > 0
        )
        .map((a: { contractor_id: string; fee_cents: number }) => ({
          contractor_id: a.contractor_id,
          fee_cents: a.fee_cents,
        }));
    }
  } catch {
    // The pick still runs; the credit-back notice is best-effort only.
  }

  const { error } = await supabase.rpc("choose_applicant", {
    p_application: applicationId,
  });
  if (error) setFlash("Couldn't select that pro just now. Please try again.", "error");
  else {
    setFlash(
      "Pro selected. They now have your contact and can message you.",
      "success"
    );
    // "choose_applicant" (src/app/api/track/route.ts): fires once per
    // successful pick. The category isn't already in scope here (would need
    // an extra application -> lead join just for this), so no props.
    await trackServerEvent(user?.id ?? null, "choose_applicant");

    // Tell every non-chosen applicant their fee came back as wallet credit
    // (the DB already granted it inside choose_applicant). Same
    // contractor -> user -> contact resolution and sendNotification path as
    // closeJobAction, so the email/SMS channels fire once configured, gated by
    // the recipient's own consent inside sendNotification. Best-effort: a
    // notification hiccup must never undo a pick that already committed.
    if (credited.length) {
      try {
        const admin = createAdminClient();
        const contractorIds = Array.from(
          new Set(credited.map((c) => c.contractor_id))
        );
        const { data: contractors } = await admin
          .from("contractors")
          .select("id, user_id")
          .in("id", contractorIds);
        // contractor_id -> user_id, for the ones with a real user to notify.
        const userByContractor = new Map<string, string>(
          (contractors ?? [])
            .filter((c): c is { id: string; user_id: string } =>
              Boolean(c.user_id)
            )
            .map((c) => [c.id, c.user_id])
        );
        const userIds = Array.from(new Set(userByContractor.values()));
        const { data: users } = userIds.length
          ? await admin
              .from("users")
              .select("id, email, phone, sms_consent")
              .in("id", userIds)
          : {
              data: [] as {
                id: string;
                email: string | null;
                phone: string | null;
                sms_consent: boolean | null;
              }[],
            };
        const userById = new Map((users ?? []).map((u) => [u.id, u]));
        await Promise.all(
          credited.map((c) => {
            const userId = userByContractor.get(c.contractor_id);
            if (!userId) return Promise.resolve(false);
            const contact = userById.get(userId);
            const feeLabel = formatFeeCents(c.fee_cents);
            return sendNotification(admin, {
              userId,
              kind: "apply_credit_back",
              title: "Your fee came back as credit",
              body: `The homeowner went with another pro this time. Your ${feeLabel} apply fee is back in your wallet as credit, good for ${BONUS_EXPIRY_DAYS} days.`,
              url: "/pro",
              email: contact?.email ?? null,
              phone: contact?.phone ?? null,
              smsConsent: contact?.sms_consent === true,
            });
          })
        );
      } catch {
        // Notifications are a nice-to-have here, not part of the pick.
      }
    }
  }
  revalidatePath("/contractors");
}

// Review comment length cap: generous enough for real feedback, short enough to
// keep the pro's review list scannable.
const REVIEW_COMMENT_MAX = 600;

// Homeowner leaves (or edits) a star rating + comment for a job. Goes through
// the leave_review() RPC (0017), which derives the contractor from the lead,
// verifies the caller owns the job, and enforces one review per job, so the
// contractor being reviewed can't be forged from the form and ratings can't be
// manipulated. The RPC upserts (one row per lead_id), so resubmitting just
// edits the existing review instead of being rejected: there is no unhappy
// path to steer around, which is exactly the point. This is the only place a
// review is written, so both /contractors and /chats can share it.
//
// ReviewButton calls this programmatically (await saveReviewAction(fd))
// rather than posting a plain <form>, so it returns ActionResult instead of
// using setFlash: the modal only closes (and the share follow-up only shows)
// after a real ok(), never optimistically on submit.
export async function saveReviewAction(
  formData: FormData
): Promise<ActionResult> {
  const supabase = await createClient();
  const leadId = String(formData.get("lead_id") || "");
  const rating = Number(formData.get("rating"));
  const comment = String(formData.get("comment") || "").trim();

  if (!leadId || !Number.isInteger(rating) || rating < 1 || rating > 5) {
    return err("Please pick a star rating between 1 and 5.");
  }
  if (comment.length > REVIEW_COMMENT_MAX) {
    return err(
      `Reviews are capped at ${REVIEW_COMMENT_MAX} characters. Please shorten yours.`
    );
  }

  // Check whether this lead already has a review before the upsert, so the pro
  // is notified once, on the first review, not on every later edit.
  const { data: already } = await supabase
    .from("reviews")
    .select("id")
    .eq("lead_id", leadId)
    .maybeSingle();

  const { error } = await supabase.rpc("leave_review", {
    p_lead: leadId,
    p_rating: rating,
    p_comment: comment,
  });

  if (error) {
    revalidatePath("/contractors");
    revalidatePath("/chats");
    return err("Couldn't post your review just now. Please try again.");
  }

  // Tell the pro a review came in. Best-effort: a notification hiccup should
  // never undo a review that already saved. Only on the first review for this
  // job, not on later edits.
  if (!already) {
    try {
      const { data: lead } = await supabase
        .from("contractor_leads")
        .select("contractor_id, homeowner_name")
        .eq("id", leadId)
        .maybeSingle();
      if (lead?.contractor_id) {
        const { data: contractor } = await supabase
          .from("contractors")
          .select("user_id")
          .eq("id", lead.contractor_id)
          .maybeSingle();
        if (contractor?.user_id) {
          const admin = createAdminClient();
          // A 4 or 5 star review gets a ready-made share card (see
          // src/app/api/review-card/[reviewId]/route.tsx), so its
          // notification points straight at the share spot instead of the
          // generic message below. This REPLACES the generic notification
          // rather than adding to it, so a first 4/5-star review still
          // produces exactly one notification, not two.
          if (rating >= 4) {
            // Capped: homeowner_name has no length limit at the source, and
            // this is a notification title, not a place for a 500-char "name".
            const firstName =
              (lead.homeowner_name ?? "").trim().split(/\s+/)[0].slice(0, 40) ||
              "A homeowner";
            await admin.from("notifications").insert({
              user_id: contractor.user_id,
              kind: "new_review",
              title: `New ${rating}-star review from ${firstName}, your share card is ready`,
              body: "Download a share card and a ready-to-post caption for social media.",
              url: "/pro/business#share-reviews",
            });
          } else {
            await admin.from("notifications").insert({
              user_id: contractor.user_id,
              kind: "new_review",
              title: "You received a new review",
              body: "A homeowner just reviewed a completed job. Check your profile to see it.",
              url: "/pro",
            });
          }
        }
      }
    } catch (notifyErr) {
      console.error(
        "review notification:",
        notifyErr instanceof Error ? notifyErr.message : notifyErr
      );
    }
  }

  // The flash cookie survives revalidatePath, so this still shows even
  // though ReviewButton closes the modal itself on ok() rather than reloading.
  setFlash("Thanks for your review!", "success");
  revalidatePath("/contractors");
  revalidatePath("/chats");
  return ok();
}

// Homeowner asks ONE specific pro for a quote (Direct Requests, migration
// 0104). Modeled on rehireProAction, but instead of an already-assigned free
// repeat lead this creates a PENDING request: the pro is stored in direct_to,
// contractor_id stays NULL (so no other pro can see it and no contact/chat
// opens), and the pro pays the normal per-category lead fee to unlock = accept
// it. Nothing fans out to the general board: only the target pro is notified.
//
// Submitted programmatically from the /p/<id> request form (like
// HireAgainButton), so it returns ActionResult on every failure - the modal
// stays open with the typed description intact and the error shown inline. On
// success it redirects to /contractors, where the pending request is now
// visible, with a success banner.
export async function requestProAction(
  formData: FormData
): Promise<ActionResult> {
  const property = await getActiveProperty();
  if (!property) throw new Error("No active property");

  // Launch-area gate, same reasoning as postJobAction: a pre-launch-gate home
  // outside the launch cities must not create a request a pro would then pay
  // to unlock for a job outside the launch area.
  if (!launchCityForZip(property.zip ?? "")) {
    return err(OUT_OF_AREA_POST_MESSAGE);
  }
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/signin");

  const contractorId = String(formData.get("contractor_id") || "");
  const category = String(formData.get("category") || "");
  const timing = (formData.get("timing") as string) || null;
  const description = ((formData.get("description") as string) || "").trim();

  if (!contractorId) {
    return err("Couldn't send your request just now. Please try again.");
  }
  // Only a real category may set the payout tier: a forged value would fall
  // back to the cheapest "other" fee in leadFeeFor. Mirrors updateJobAction.
  if (!JOB_CATEGORIES.some((c) => c.value === category)) {
    return err("Please pick a valid job category.");
  }
  // Same 20-character floor as every other lead path: the pro needs real text
  // to decide whether to pay to unlock.
  if (description.length < 20) {
    return err(
      "Please describe the job in at least 20 characters so the pro knows what you need."
    );
  }

  // Abuse gate: a direct request notifies one specific pro, and cancel +
  // re-request (cancelDirectRequestAction deletes the pending row, freeing the
  // per-pro uniqueness guard below) could otherwise be looped to bomb that one
  // pro with notifications. Cap the number of direct requests one homeowner can
  // fire per hour. Same fixed-window limiter (migration 0068) and same
  // fail-open-on-DB-hiccup posture as postJobAction: only an explicit
  // `allowed === false` blocks.
  const rlAdmin = createAdminClient();
  const { data: allowedRequest } = await rlAdmin.rpc("rate_limit_hit", {
    p_bucket: `direct-request:${user.id}`,
    p_limit: 10,
    p_window_seconds: 3600,
  });
  if (allowedRequest === false) {
    return err(
      "You're sending requests too quickly, please wait a bit before requesting another pro."
    );
  }

  // The target pro must exist, be claimed (a real user to notify and charge),
  // and serve this category (null/empty categories means "takes anything",
  // matching how open_jobs_for_me treats them).
  //
  // ADMIN client for this ONE read, on purpose. The "contractors read" policy
  // (migration 0067) only returns a row to a homeowner who is ALREADY related
  // to that pro - they have a lead assigned to them, or an application from
  // them. A direct request is by definition the opposite case: the homeowner
  // just found this pro on the board or a shared /p/<id> link and has no
  // relationship yet, so the user-scoped read came back empty every time and
  // every first request to a new pro failed with "isn't available right now".
  // The select list is deliberately the public-safe subset - id, user_id,
  // name, categories, serves_orange_county - the same facts the public pro
  // page and the job board already show, and none of them are rendered back to
  // the caller beyond the pro's own name in the messages below.
  const proAdmin = createAdminClient();
  const { data: pro } = await proAdmin
    .from("contractors")
    .select("id, user_id, name, categories, serves_orange_county")
    .eq("id", contractorId)
    .maybeSingle();
  if (!pro || !pro.user_id) {
    return err("That pro isn't available for direct requests right now.");
  }
  // Same launch-market gate as browse_pros and apply_to_lead: /p/<id> is a
  // public shareable link, so a request could otherwise target a pro who
  // never confirmed they serve Orange County.
  if (!pro.serves_orange_county) {
    return err("That pro isn't taking Hearth jobs in your area yet.");
  }
  const serves =
    !pro.categories ||
    pro.categories.length === 0 ||
    pro.categories.includes(category);
  if (!serves) {
    return err(
      `${pro.name ?? "This pro"} doesn't list that service. Pick one they offer, or post the job to all local pros instead.`
    );
  }

  // One pending direct request per (property, pro) at a time. A pending row is
  // one still aimed at this pro (direct_to set), not yet unlocked
  // (contractor_id null), still open (status 'new'), and not declined.
  const { data: existing } = await (supabase as any)
    .from("contractor_leads")
    .select("id")
    .eq("property_id", property.id)
    .eq("direct_to", contractorId)
    .is("contractor_id", null)
    .eq("status", "new")
    .is("direct_declined_at", null)
    .limit(1)
    .maybeSingle();
  if (existing) {
    return err(
      `You already have a pending request with ${pro.name ?? "this pro"}. Give them a little time to respond.`
    );
  }

  const address = [property.address_line1, property.city, property.state]
    .filter(Boolean)
    .join(", ");

  // Contact snapshot, same columns postJobAction / rehire_pro freeze onto the
  // lead: pros read only contractor_leads, never the homeowner's account.
  const { data: profile } = await supabase
    .from("users")
    .select("full_name, email, phone")
    .eq("id", user.id)
    .maybeSingle();
  const homeownerName = profile?.full_name || null;
  const homeownerEmail = profile?.email || user.email || null;
  const homeownerPhone = profile?.phone || null;

  // Scrub contact info out of the description before it's stored, exactly like
  // postJobAction: the pro pays to unlock, and a "call me at ..." in the free
  // text would let them take the job off-platform before paying.
  const leadRow = {
    property_id: property.id,
    direct_to: contractorId,
    contractor_id: null, // pending: the pro pays to unlock = accept
    category,
    status: "new",
    paid: false,
    payout_amount: leadFeeFor(category),
    homeowner_name: homeownerName,
    homeowner_email: homeownerEmail,
    homeowner_phone: homeownerPhone,
    property_address: address,
    issue_description: redactContact(description),
    timing,
  };

  const { error } = await (supabase as any)
    .from("contractor_leads")
    .insert(leadRow)
    .select("id")
    .single();
  if (error) {
    // Migration 0104 may not have run against this database yet (direct_to is
    // an unknown column): degrade to a soft message instead of crashing.
    if (isMissingSchemaError(error)) {
      return err(
        "Direct requests aren't available yet. Please check back soon."
      );
    }
    // The partial unique index caught a racing double-submit: same message
    // the pre-insert check gives, not a scary generic error.
    if ((error as { code?: string }).code === "23505") {
      return err(
        `You already have a pending request with ${pro.name ?? "this pro"}. Give them a little time to respond.`
      );
    }
    return err("Couldn't send your request just now. Please try again.");
  }

  // Notify only the target pro. No alertProsForNewLead fan-out: a direct
  // request belongs to this one pro alone. Best-effort, like every other
  // notification path: a hiccup here must not undo a request that saved.
  try {
    const admin = createAdminClient();
    const categoryLabel = labelFor(JOB_CATEGORIES, category);
    const { data: contact } = await admin
      .from("users")
      .select("email, phone, sms_consent")
      .eq("id", pro.user_id)
      .maybeSingle();
    await sendNotification(admin, {
      userId: pro.user_id,
      kind: "direct_request",
      title: "A homeowner asked for you",
      body: `A homeowner wants a quote for ${categoryLabel} work and asked for you specifically. Open your jobs to see it.`,
      url: "/pro",
      email: contact?.email ?? null,
      phone: contact?.phone ?? null,
      smsConsent: contact?.sms_consent === true,
    });
  } catch {
    // Notifications are a nice-to-have here, not part of the request flow.
  }

  await trackServerEvent(user.id, "direct_request", { category });

  revalidatePath("/contractors");
  redirect("/contractors?directsent=1");
}

// Homeowner cancels a PENDING direct request. Nothing has been paid (the pro
// only pays on unlock, and a pending request is by definition not unlocked:
// contractor_id null, no lead_applications row), so there is no fee to preserve
// and nothing for ghost protection to look at. That makes a plain delete the
// clean choice here, unlike closeJobAction's owner_closed_at marker (which only
// exists to keep a PAID open job's refund path intact). RLS scopes the delete
// to a lead on a property the caller owns; the direct_to / contractor_id guards
// stop this from touching a normal open job or an already-unlocked one.
export async function cancelDirectRequestAction(formData: FormData) {
  const supabase = (await createClient()) as any;
  const leadId = String(formData.get("lead_id") || "");

  const { data: lead } = await supabase
    .from("contractor_leads")
    .select("id, direct_to, contractor_id")
    .eq("id", leadId)
    .maybeSingle();
  if (!lead || !lead.direct_to || lead.contractor_id) {
    // Not a pending direct request (or already unlocked): nothing to cancel
    // here. Guard against a forged/replayed submit.
    setFlash("Couldn't cancel that request just now. Please try again.", "error");
    revalidatePath("/contractors");
    return;
  }

  const { error } = await supabase
    .from("contractor_leads")
    .delete()
    .eq("id", leadId)
    .is("contractor_id", null);
  if (error) setFlash("Couldn't cancel that request just now. Please try again.", "error");
  else setFlash("Request cancelled.", "info");
  revalidatePath("/contractors");
}

// Homeowner converts a direct request into a normal open job ("Post publicly
// instead"): clears direct_to so the lead becomes a plain open posting every
// matching pro can apply to, then runs the SAME fan-out postJobAction does
// (alertProsForNewLead + the batched new_lead notifications insert). Used both
// when the target pro passed (declined) and when the homeowner simply changes
// their mind while still waiting.
export async function postDirectPubliclyAction(formData: FormData) {
  const property = await getActiveProperty();
  if (!property) throw new Error("No active property");

  // Launch-area gate, same reasoning as postJobAction: converting a direct
  // request into an open posting must not create a board job no pro can see.
  if (!launchCityForZip(property.zip ?? "")) {
    setFlash(OUT_OF_AREA_POST_MESSAGE, "error");
    redirect("/contractors");
  }
  const supabase = (await createClient()) as any;
  const leadId = String(formData.get("lead_id") || "");

  // RLS scopes this read to a lead the caller owns. It must still be a pending
  // direct request (aimed at a pro, not yet unlocked) to convert.
  const { data: lead } = await supabase
    .from("contractor_leads")
    .select("id, property_id, category, timing, issue_description, direct_to, contractor_id")
    .eq("id", leadId)
    .maybeSingle();
  if (
    !lead ||
    !lead.direct_to ||
    lead.contractor_id ||
    lead.property_id !== property.id
  ) {
    setFlash("Couldn't post that job just now. Please try again.", "error");
    revalidatePath("/contractors");
    return;
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/signin");

  // Abuse gate: converting a direct request to a public job runs the SAME
  // alertProsForNewLead + batched new_lead fan-out as postJobAction (up to ~250
  // pro notification writes, and real SMS/email once those providers flip on),
  // so it gets the SAME two limiters, sharing postJobAction's 'post'/'post-day'
  // buckets so this path can't be looped to sidestep the posting cap. Same
  // fixed-window limiter (migration 0068), same fail-open-on-DB-hiccup behavior:
  // only an explicit `allowed === false` blocks.
  const admin = createAdminClient();
  const { data: allowed } = await admin.rpc("rate_limit_hit", {
    p_bucket: `post:${user.id}`,
    p_limit: 8,
    p_window_seconds: 3600,
  });
  if (allowed === false) {
    setFlash("You're posting jobs too quickly, please wait a bit.", "error");
    redirect("/contractors");
  }
  const { data: allowedDay } = await admin.rpc("rate_limit_hit", {
    p_bucket: `post-day:${user.id}`,
    p_limit: 20,
    p_window_seconds: 86400,
  });
  if (allowedDay === false) {
    setFlash(
      "You've reached today's posting limit. Please try again tomorrow.",
      "error"
    );
    redirect("/contractors");
  }

  // Clear the target and the decline stamp so the lead is a plain open job.
  const { data: updated, error } = await supabase
    .from("contractor_leads")
    .update({ direct_to: null, direct_declined_at: null })
    .eq("id", leadId)
    .is("contractor_id", null)
    .not("direct_to", "is", null)
    .select("id")
    .maybeSingle();
  if (error || !updated) {
    setFlash("Couldn't post that job just now. Please try again.", "error");
    revalidatePath("/contractors");
    return;
  }

  const category = lead.category as string;
  const timing = (lead.timing as string) ?? null;
  const issueDescription = (lead.issue_description as string) ?? null;

  // Same instant-alert fan-out as postJobAction. externalChannels gated on
  // this property's ownership status, mirroring postJobAction's final gate:
  // in-app rows always go out, email/SMS only for a verified poster.
  const alertedPros = await alertProsForNewLead({
    category,
    timing,
    issue_description: issueDescription,
    property_state: property.state ?? null,
    property_zip: property.zip ?? null,
    externalChannels: property.ownership_status === "verified",
  });

  // Nudge matching pros a fresh job is open, skipping anyone already alerted
  // above so nobody is pinged twice. Best-effort, same as postJobAction.
  try {
    // Reuses the admin client created for the rate-limit gates above.
    const { data: matches } = await admin
      .from("contractors")
      .select("user_id")
      .not("user_id", "is", null)
      .contains("categories", [category])
      .limit(50);
    const categoryLabel = labelFor(JOB_CATEGORIES, category);
    const rows = (matches ?? []).flatMap((match: { user_id: string | null }) => {
      if (!match.user_id || alertedPros.has(match.user_id)) return [];
      return [
        {
          user_id: match.user_id,
          kind: "new_lead",
          title: `New ${categoryLabel} job posted nearby`,
          body: "A homeowner just posted a job. Apply before other pros do.",
          url: "/pro",
        },
      ];
    });
    if (rows.length) {
      await admin.from("notifications").insert(rows);
    }
  } catch {
    // Notifications are a nice-to-have here, not part of the conversion.
  }

  setFlash("Posted to all local pros. Matching pros can now apply.", "success");
  revalidatePath("/contractors");
}

// Homeowner re-hires a pro they've already worked with (My Pros). The repeat
// lead is free for the pro: rehire_pro() inserts it already assigned, with no
// apply fee and no wallet charge, so nobody pays to work together again.
// rehire_pro isn't in the generated types yet, so the rpc client is cast to
// any (same pattern as choose_applicant/apply_to_lead above).
//
// HireAgainButton calls this programmatically (await rehireProAction(fd))
// rather than posting a plain <form>, so every failure returns ActionResult
// instead of using setFlash + redirect: the modal stays open with the typed
// description intact and the error shown inline. On success there is nothing
// to return to: the action redirects straight to the new chat thread, same as
// before (redirect() still works from a programmatically-invoked action).
export async function rehireProAction(
  formData: FormData
): Promise<ActionResult> {
  const property = await getActiveProperty();
  if (!property) throw new Error("No active property");
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/signin");

  const contractorId = String(formData.get("contractor_id") || "");
  const category = String(formData.get("category") || "");
  // Trimmed here, same as before, but ALSO trimmed client-side before submit
  // now (HireAgainButton): the textarea's minLength=20 counts raw characters,
  // so 20 spaces used to pass the browser check and only fail here, with a
  // confusing "it looked fine, why did it fail" mismatch.
  const description = ((formData.get("description") as string) || "").trim();

  if (!contractorId || !category) {
    return err("Couldn't send that request just now. Please try again.");
  }

  // Only a real category may set the payout tier, same check updateJobAction
  // and directRequestAction make. A rehire is free for the pro, but the
  // category still decides labels, icons, and how the job is matched.
  if (!isAllowedValue(JOB_CATEGORIES, category)) {
    return err("Please pick a valid job category.");
  }

  // Mirror postJobAction: the pro needs a real description to go on, even on a
  // repeat job.
  if (description.length < 20) {
    return err(
      "Please describe the job in at least 20 characters so your pro knows what to expect."
    );
  }

  const rpc = supabase as any;
  const { data: leadId, error } = await rpc.rpc("rehire_pro", {
    p_property: property.id,
    p_contractor: contractorId,
    p_category: category,
    p_description: description,
  });

  if (error) {
    // Migration 0030 may not have run against this database yet: degrade to a
    // soft message instead of crashing the page.
    const missingFn =
      error.code === "PGRST202" ||
      (/rehire_pro/i.test(error.message ?? "") &&
        /(does not exist|schema cache|not find)/i.test(error.message ?? ""));
    return err(
      missingFn
        ? "Hiring a pro again isn't available yet. Please check back soon."
        : "Couldn't send that request just now. Please try again."
    );
  }

  // Nudge the pro that a free repeat lead just came in. Best-effort only, same
  // as the new-job notification in postJobAction: a hiccup here should never
  // break the rehire itself.
  try {
    const { data: profile } = await supabase
      .from("users")
      .select("full_name")
      .eq("id", user.id)
      .maybeSingle();
    const homeownerName = profile?.full_name || "A homeowner";

    const { data: contractor } = await supabase
      .from("contractors")
      .select("user_id")
      .eq("id", contractorId)
      .maybeSingle();
    if (contractor?.user_id) {
      const admin = createAdminClient();
      await admin.from("notifications").insert({
        user_id: contractor.user_id,
        kind: "new_lead",
        title: `${homeownerName} wants to hire you again: free repeat lead`,
        body: "No apply fee, they already trust your work. Check your jobs to say hi.",
        url: "/pro",
      });
    }
  } catch {
    // Notifications are a nice-to-have here, not part of the rehire flow.
  }

  revalidatePath("/contractors");
  redirect(`/chats?lead=${leadId}`);
}
