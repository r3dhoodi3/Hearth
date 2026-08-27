"use server";

import { randomUUID } from "crypto";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  getCurrentContractor,
  countPaidLeadApplications,
} from "@/lib/contractor";
import { sendNotification } from "@/lib/notify";
// ALWAYS awaited, everywhere in this file. setFlash writes its cookie through
// Next's async cookies() store, and every call site here is followed by a
// redirect() that throws immediately - so an un-awaited setFlash raced the
// unwind and the message it was meant to carry landed on the next page only
// sometimes. That is worse than no message: half the flashes in here are the
// only explanation the pro gets for why they were bounced back to the form
// ("Pick at least one city you serve", "Not enough balance to apply"), so a
// coin-flip toast reads as the app losing their work for no reason.
import { setFlash } from "@/lib/flash";
import {
  labelFor,
  JOB_CATEGORIES,
  LEAD_STATUSES,
  MAJOR_INTRO_FEE,
  PRO_DEPOSIT_BOOST_PTS,
  BACKGROUND_CHECK_MIN_PAID_LEADS,
  isMajorCategory,
} from "@/lib/constants";
import { agingLeadFee } from "@/lib/leadPricing";
import { hasProPlan } from "@/lib/subscription";
import { requestReviewForWonLead } from "@/lib/reviewRequest";
import { lookupCslbLicense, type CslbLookupResult } from "@/lib/cslb";
import { licenseDigits, licenseNameMatches } from "@/lib/licenseMatch";
import { createCandidateAndInvite } from "@/lib/checkr";
import { isMissingSchemaError } from "@/lib/dbErrors";
import { findActiveJobConflicts } from "@/lib/activeJobConflicts";
import { validateYelpUrl, validateGoogleReviewsUrl } from "@/lib/reviewLinks";
import {
  isAcceptablePublicText,
  COMPANY_NAME_REJECTED,
} from "@/lib/publicText";
import { recordSignal } from "@/lib/risk/signals";
import {
  isAcceptableCustomCategory,
  CUSTOM_CATEGORY_REJECTED,
} from "@/lib/customCategory";
import {
  cappedField,
  cappedFieldOrNull,
  isAllowedValue,
} from "@/lib/formFields";
import { recordTermsAcceptance } from "@/app/(auth)/recordTermsAcceptance";
import { selectLaunchCities } from "./onboarding/launchCities";
import type { Json } from "@/lib/database.types";

// Ceiling for the free-text "Other" service on CategoryPicker. It renders on
// the public /p/<id> page and the browse cards next to the canonical labels,
// which are all short, so this is generous for a real answer and still bounds
// a forged post.
const MAX_CUSTOM_CATEGORY = 100;

// Server-side counterpart to src/lib/analytics.ts's track(): that helper
// fires via navigator.sendBeacon, which doesn't exist in a server action, so
// this writes straight to app_events with the admin client instead. Mirrors
// src/app/api/track/route.ts's own insert: same table, same
// isMissingSchemaError fallback to a log line if migration 0091 hasn't run
// on this DB yet, and never throws, so a call site never needs its own
// try/catch around it.
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
  } catch (err) {
    console.error(
      `trackServerEvent(${event}) failed:`,
      err instanceof Error ? err.message : err
    );
  }
}

// Real CSLB check (0055) is debounced off the most recent check we recorded:
// license_verified_at (stamped only on a 'verified' outcome) or the
// checked_at stamped inside license_verify_detail on every decided outcome,
// verified or failed. Either one inside the window skips the network call,
// so a burst of profile saves or "Verify now" clicks can't hammer CSLB even
// while a license keeps failing.
const LICENSE_RECHECK_DEBOUNCE_MS = 10 * 60 * 1000;

// Why a check failed for a reason that is NOT the CSLB status sentence
// itself (migration 0125). Mirrors CslbVerifyDetail.failure_reason in
// src/lib/database.types.ts, which is what gets persisted.
export type LicenseVerifyFailureReason = "name_mismatch" | "duplicate_license";

// What a check decided to write. 'unknown' means the row is left exactly as
// it was - the never-downgrade-on-uncertainty rule.
type LicenseVerifyDecision = "verified" | "failed" | "unknown";

type LicenseVerifyResult = CslbLookupResult & {
  decision: LicenseVerifyDecision;
  failureReason: LicenseVerifyFailureReason | null;
};

// The account holder's own name, for the identity check below. A sole
// proprietor's CSLB record is registered to the PERSON ("DOE JOHN"), not to
// the trade name they typed into Hearth, so the personal name has to be one
// of the candidates or every legitimate sole proprietor would fail. Reads the
// users table with the admin client (0067 stripped column-level SELECT on
// several tables and this runs server-side off an id resolved from the
// session, never client input). Best-effort: any failure just means one fewer
// candidate name, and licenseNameMatches ignores nulls.
async function accountFullName(
  userId: string | null | undefined
): Promise<string | null> {
  if (!userId) return null;
  try {
    const admin = createAdminClient();
    const { data } = await admin
      .from("users")
      .select("full_name")
      .eq("id", userId)
      .maybeSingle();
    return ((data?.full_name as string | null) ?? null) || null;
  } catch {
    return null;
  }
}

// Is this license number already VERIFIED on some other Hearth account?
//
// One license, one account (migration 0125). This is the app-side half: it
// gives the second claimant an honest, explainable "already verified
// elsewhere" instead of a raw unique-violation, and it is what fills in
// failure_reason. The database's partial unique index is the real guarantee -
// this read can be raced, and the 23505 handler at the write below catches
// exactly that.
//
// Comparison is on DIGITS, matching the index expression
// regexp_replace(license_number, '\D', '', 'g') byte for byte, so "270-663"
// and "LIC# 270663" are one identity on both sides. The digit extraction can't
// be pushed into the PostgREST filter (no expression predicates), so this
// pulls the verified rows and compares in memory - bounded by a limit, and
// tiny in practice since only a CSLB-confirmed row can ever be 'verified'.
// Fails OPEN on a query error: the unique index still stops a real duplicate,
// and a transient read failure must not block a legitimate pro's badge.
const MAX_VERIFIED_LICENSE_SCAN = 5000;

async function verifiedElsewhere(
  contractorId: string,
  licenseNumber: string
): Promise<boolean> {
  const digits = licenseDigits(licenseNumber);
  if (!digits) return false;
  try {
    const admin = createAdminClient();
    const { data, error } = await admin
      .from("contractors")
      .select("id, license_number")
      .eq("license_verified_status", "verified")
      .not("license_number", "is", null)
      .neq("id", contractorId)
      .limit(MAX_VERIFIED_LICENSE_SCAN);
    if (error) {
      console.error("duplicate license pre-check failed:", error.message);
      return false;
    }
    return (data ?? []).some(
      (row) => licenseDigits(row.license_number) === digits
    );
  } catch (err) {
    console.error(
      "duplicate license pre-check failed:",
      err instanceof Error ? err.message : err
    );
    return false;
  }
}

// Runs a real CSLB lookup for a contractor's license number and writes the
// result onto license_verified_status/_at/_verify_detail (0037/0055).
// Returns null if the debounce window skipped the fetch, otherwise the CSLB
// result plus the decision this made from it (so callers can show the pro why
// a check did or didn't pass). An 'error' outcome (CSLB unreachable, timed
// out, or its page shape changed) NEVER changes license_verified_status: a
// fetch failure must never be treated as a failed license check.
//
// 0125: an 'active' license is not enough on its own. The CSLB-registered
// name has to line up with a name Hearth knows for this account
// (src/lib/licenseMatch.ts), and the number must not already be verified on
// another account. Either gate failing writes 'failed' with a failure_reason
// the profile page turns into plain-English copy plus a dispute form.
async function verifyContractorLicense(
  supabase: Awaited<ReturnType<typeof createClient>>,
  contractorId: string,
  licenseNumber: string,
  currentVerifiedAt: string | null | undefined,
  currentDetail?: unknown,
  // Every name Hearth knows for this account: the company name on the
  // contractors row and the account holder's own full name. A CSLB record
  // that matches NONE of them is somebody else's license (0125). Callers pass
  // what they have; nulls are ignored.
  candidateNames: Array<string | null | undefined> = []
): Promise<LicenseVerifyResult | null> {
  const lastCheckedAt =
    ((currentDetail as { checked_at?: string } | null | undefined)
      ?.checked_at as string | undefined) ?? currentVerifiedAt;
  if (lastCheckedAt) {
    const age = Date.now() - new Date(lastCheckedAt).getTime();
    if (Number.isFinite(age) && age < LICENSE_RECHECK_DEBOUNCE_MS) return null;
  }

  const result = await lookupCslbLicense(licenseNumber);

  const detail = {
    businessName: result.businessName ?? null,
    statusText: result.statusText ?? null,
    classifications: result.classifications ?? null,
    expires: result.expires ?? null,
    checked_at: new Date().toISOString(),
  };

  // What CSLB said maps to a decision: 'verified', 'failed', or 'unknown'
  // (leave the row exactly as it is). Before 0125 this was outcome === 'active'
  // and nothing else, which is precisely how a pro could verify against a
  // stranger's valid license number. The two identity gates below run ONLY
  // inside the 'active' branch, so neither can ever downgrade anyone off an
  // 'error' outcome.
  let failureReason: LicenseVerifyFailureReason | null = null;
  let decision: LicenseVerifyDecision =
    result.outcome === "active"
      ? "verified"
      : result.outcome === "not_found" || result.outcome === "inactive"
        ? "failed"
        : "unknown";

  if (decision === "verified") {
    if (!result.businessName) {
      // Active, but the parser got no name off the page. There is nothing to
      // check the account against, so this is UNKNOWN, not confirmed and not
      // failed - treated exactly like an 'error' outcome, status untouched.
      // Verifying here would reopen the whole hole: a badge granted purely on
      // a number, with no evidence it belongs to this pro.
      decision = "unknown";
    } else if (!licenseNameMatches(result.businessName, candidateNames)) {
      decision = "failed";
      failureReason = "name_mismatch";
    } else if (await verifiedElsewhere(contractorId, licenseNumber)) {
      // One license, one account. See migration 0125: the first account to
      // verify a number holds it until a human rules otherwise, and this pro
      // gets the dispute path instead of a second badge on the same license.
      decision = "failed";
      failureReason = "duplicate_license";
    }
  }

  const failedDetail = failureReason
    ? { ...detail, failure_reason: failureReason }
    : detail;

  let fields: Record<string, unknown> | null = null;
  if (decision === "verified") {
    fields = {
      license_verified_status: "verified",
      license_verified_at: new Date().toISOString(),
      license_verify_detail: detail,
    };
  } else if (decision === "failed") {
    fields = {
      license_verified_status: "failed",
      // Cleared, not kept: the public badge on /p/<id> keys off
      // license_verified_at alone, so leaving a stale timestamp here would
      // keep showing "License verified" for a license that just failed.
      license_verified_at: null,
      license_verify_detail: failedDetail,
    };
  }
  // decision === 'unknown': fields stays null, status is left exactly as-is.

  if (fields) {
    // 0078 revokes UPDATE on license_verified_status/_at/_verify_detail from
    // `authenticated` (a contractor could otherwise self-forge a "verified"
    // badge), so this write goes through the admin client instead of the
    // user-scoped `supabase` param. Still safe: `fields` is derived entirely
    // from the CSLB lookup above (never client input), and contractorId is
    // always the caller's own contractor id, resolved by every caller via
    // assertContractor()/getCurrentContractor(), never client-supplied.
    const admin = createAdminClient();
    const { error } = await (admin.from("contractors") as any)
      .update(fields)
      .eq("id", contractorId);
    if (error) {
      // 23505 = migration 0125's partial unique index on the verified license
      // digits. The verifiedElsewhere() pre-check above is a read, so two
      // accounts submitting the same number at the same moment can both pass
      // it and race to the write; the database settles that race and exactly
      // one update comes back 23505. This is the backstop, not the primary
      // path: convert the loser into the same "failed, duplicate_license"
      // result the pre-check would have produced, rather than surfacing a raw
      // constraint error to a pro who did nothing wrong.
      if (error.code === "23505") {
        failureReason = "duplicate_license";
        decision = "failed";
        const { error: dupError } = await (admin.from("contractors") as any)
          .update({
            license_verified_status: "failed",
            license_verified_at: null,
            license_verify_detail: {
              ...detail,
              failure_reason: "duplicate_license",
            },
          })
          .eq("id", contractorId);
        if (dupError) {
          console.error("license duplicate write failed:", dupError.message);
        }
        return { ...result, decision, failureReason };
      }
      console.error("license verification write failed:", error.message);
    }
  }

  return { ...result, decision, failureReason };
}

// Resolve a referral code to a contractor id, or null. A code is another
// pro's slug (0043) or the first 8 hex chars of their contractor id (or the
// full id). Unknown, ambiguous, or malformed codes resolve to null: a bad
// code must NEVER block onboarding. Delegated to the resolve_referral_code
// RPC (0067): after that migration stripped column-level SELECT on
// contractors, a direct .from("contractors") read of another pro's row would
// be blocked by RLS, so the three lookups (full id, slug, 8-hex prefix) live
// in one SECURITY DEFINER function instead.
async function resolveReferralCode(
  supabase: Awaited<ReturnType<typeof createClient>>,
  raw: FormDataEntryValue | null
): Promise<string | null> {
  try {
    const { data } = await supabase.rpc("resolve_referral_code", {
      p_code: String(raw ?? ""),
    });
    return (data as string | null) ?? null;
  } catch {
    // Ignore silently: referral attribution is strictly best-effort.
    return null;
  }
}

// Create (onboarding) or update (profile) the current user's contractor company.
export async function saveCompanyAction(formData: FormData) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/signin");

  // A category decides which pros a posted job reaches, so the canonical
  // values are held to the shared list: a forged one would silently opt a
  // company into a matching bucket the rest of the app has no entry for.
  //
  // But CategoryPicker.tsx is NOT a pure allow-list picker. Alongside the 14
  // checkboxes it renders a free-text "Other" box and posts whatever the pro
  // typed as one more `categories` value (see its hidden input), and it reads
  // that value back out on edit by treating every stored non-canonical entry
  // as the custom one. So an allow-list over ALL posted values would delete a
  // pro's custom service on their next save of any field, and because an
  // EMPTY categories array means "matches every request" downstream
  // (src/app/(app)/contractors/actions.ts:1209), a pro whose only category
  // was custom would flip from matching nothing to matching everything.
  // Canonical values go through the list; at most one leftover is kept as the
  // free-text service, trimmed and capped, which is all the form can produce.
  //
  // MODERATION: that one leftover is unreviewed free text rendered verbatim on
  // the public /p/<slug> page and the browse cards, so it goes through
  // isAcceptableCustomCategory (src/lib/customCategory.ts) before it is kept.
  // A rejected value is DROPPED, not fatal: the canonical picks, the company
  // name, the license, and every other field on this form still save, and the
  // pro is told why the one box was ignored via the flash below. Failing the
  // whole save over it would lose everything else they just typed.
  const rawCategories = formData
    .getAll("categories")
    .map((c) => String(c).trim())
    .filter(Boolean);
  const customCandidates = rawCategories
    .filter((c) => !isAllowedValue(JOB_CATEGORIES, c))
    .slice(0, 1)
    .map((c) => c.slice(0, MAX_CUSTOM_CATEGORY));
  const acceptedCustom = customCandidates.filter((c) =>
    isAcceptableCustomCategory(c)
  );
  const customRejected = customCandidates.length > acceptedCustom.length;
  const categories = Array.from(
    new Set([
      ...rawCategories.filter((c) => isAllowedValue(JOB_CATEGORIES, c)),
      ...acceptedCustom,
    ])
  );
  // Trimmed and capped server-side. The form's maxLength is a client hint
  // only, and this row is public (the /p/<id> page, the job board, the share
  // cards all render it), so an unbounded paste would land in front of
  // homeowners as well as in the database.
  const fields = {
    name: cappedField(formData, "name", 200),
    license_number: cappedFieldOrNull(formData, "license_number", 50),
    service_area: cappedFieldOrNull(formData, "service_area", 300),
    contact_phone: cappedFieldOrNull(formData, "contact_phone", 40),
    contact_email:
      cappedFieldOrNull(formData, "contact_email", 254) || user.email || null,
    categories,
  };

  // Service state (0046, state-level locality). Unlike referral attribution
  // this IS editable on later saves, but only when the submitting form
  // actually carried the field: a form without it (e.g. the profile form
  // until it grows the select) must never wipe a stored value. Anything but
  // a clean two-letter code stores null, which the job board treats as
  // "show everything" (cold-start safe). Kept out of `fields` and written
  // via (as any) with a missing-column retry because the column lands in
  // migration 0046 and isn't in the generated types.
  const serviceStateEntry = formData.get("service_state");
  const serviceStateCode = String(serviceStateEntry ?? "")
    .trim()
    .toUpperCase();
  const serviceState = /^[A-Z]{2}$/.test(serviceStateCode)
    ? serviceStateCode
    : null;
  const stateWrite =
    serviceStateEntry !== null ? { service_state: serviceState } : {};
  const hasStateWrite = serviceStateEntry !== null;

  // Service area: the launch cities (all of Orange County since 0129), as
  // checkboxes. Posted by BOTH the signup form and the profile editor
  // (LaunchCityCheckboxes, same field names), and one answer feeds three
  // stored fields (see ./onboarding/launchCities.ts) - service_area gets the
  // canonical comma-separated string the rest of the app already renders,
  // 0074's serves_orange_county attestation stays truthful because every
  // launch city is in Orange County, and 0124's launch_cities (widened to nine
  // by 0126 and to the whole county by 0129) carries the per-city pick the job
  // board and apply gate actually filter on. The "All of Orange County" box on
  // the form is not a value: it posts every city, so nothing here sees it.
  //
  // Same missing-field-safe discipline as service_state above, with the hidden
  // `service_cities_present` marker doing the work `formData.get` can't:
  // unchecked checkboxes post nothing, so an empty getAll() is ambiguous on
  // its own. The marker is what says "this form asked the question". A form
  // without it (an older client, or any lean post) leaves its own service_area
  // value in `fields` standing and never touches the stored attestation or
  // city pick.
  const cityMarker = formData.get("service_cities_present");
  const hasCityWrite = cityMarker !== null;
  const citySelection = selectLaunchCities(
    formData.getAll("service_cities").map(String)
  );
  if (hasCityWrite) {
    fields.service_area = citySelection.serviceArea;
  }

  // Orange County launch gate (0074). Derived from the cities above when the
  // form asked for them; the older `serves_orange_county` yes/no radio is
  // still honored as a fallback so any form still posting it keeps working.
  // A form carrying neither (e.g. the profile edit form) posts null for both
  // and must never wipe a stored value.
  const ocEntry = formData.get("serves_orange_county");
  const servesOrangeCounty = hasCityWrite
    ? citySelection.servesOrangeCounty
    : ocEntry !== null && String(ocEntry) === "true";
  const hasOcWrite = hasCityWrite || ocEntry !== null;
  const ocWrite = hasOcWrite ? { serves_orange_county: servesOrangeCounty } : {};

  // The per-city half of the launch gate (migration 0124). serves_orange_county
  // above is county-wide and stays as-is; this is the answer the pro actually
  // gave, which open_jobs_for_me and apply_to_lead filter each job's ZIP
  // against. Same missing-field-safe discipline as everything above: only
  // written when the submitting form carried the city question (the
  // `service_cities_present` marker), so a form that never asked can't wipe a
  // stored pick. Kept out of `fields` and written via the (as any) casts below
  // because the column lands in 0124, with its own retry there for a live DB
  // that hasn't run it yet.
  const cityWrite = hasCityWrite
    ? { launch_cities: citySelection.cities }
    : {};

  const existing = await getCurrentContractor();

  // Server-side floor under the browser's `required`: a post that asked the
  // city question but carries no city must not create a company, must not
  // land on the waitlist panel, and must not blank an existing pro's stored
  // pick (which since 0124 would empty their job board). Answering nothing is
  // not the same as answering "I'm outside your area", so send them back to
  // pick one - to whichever form they actually submitted, now that the profile
  // editor asks this question too.
  if (hasCityWrite && citySelection.cities.length === 0) {
    await setFlash("Pick at least one city you serve.", "error");
    redirect(existing ? "/pro/profile" : "/pro/onboarding");
  }

  // Server-side floor under the browser's `required`, same discipline as the
  // city check above: the name is trimmed now, so a post of nothing but spaces
  // would otherwise create (or rename to) a nameless listing on the job board
  // and the public /p/<id> page.
  if (!fields.name) {
    await setFlash("Enter your company name.", "error");
    redirect(existing ? "/pro/profile" : "/pro/onboarding");
  }

  // MODERATION: the business name is unreviewed free text rendered verbatim on
  // the public /p/<slug> page, the browse cards, the job board and every share
  // card, and a pro can rewrite it at any time. It gets the same gate the
  // custom-service box has had since it shipped - profanity/slurs and
  // off-platform contact routes, both read off the Unicode fold so a
  // zero-width space or a Cyrillic look-alike does not walk past.
  //
  // ONLY WHEN THE NAME ACTUALLY CHANGED. This check is fatal to the whole save
  // (the name is required, so there is nothing to fall back to), and this
  // action saves the entire profile form - categories, licence, service area,
  // review links, every field on the page. An unconditional check would mean
  // that a pro whose STORED name the filter dislikes could never save anything
  // again: they would open their profile, change their service area, hit save,
  // and be bounced with a message about a name they did not touch, forever,
  // with no way to fix it because the fix is also a save. isAcceptablePublicText
  // is deliberately forgiving about surnames, but no filter is perfect, and
  // "never able to edit your own profile" is not a failure mode worth risking
  // for a name that is already live. So the gate applies to the value being
  // introduced, not to the value already stored.
  const nameChanged = fields.name !== (existing?.name ?? null);
  if (nameChanged && !isAcceptablePublicText(fields.name)) {
    await setFlash(COMPANY_NAME_REJECTED, "error");
    redirect(existing ? "/pro/profile" : "/pro/onboarding");
  }

  // Trial-abuse signals (src/lib/risk, migration 0130). A pro who burned a free
  // Hearth Pro trial and came back under a new email usually brings the same
  // two things with them: the company's phone number and the company's name.
  // Both are normalized before hashing (digits only for the phone, punctuation
  // and legal suffixes stripped for the name, see normalizeSignalValue), so
  // "Ramirez Plumbing, Inc." and "ramirez plumbing llc" land on one value.
  //
  // Worth 20 and 15 points respectively, which is nowhere near a block on its
  // own - two brothers running separate companies off one shop line is a real
  // thing, and so is a common trade name. It takes a pile of other signals to
  // matter. Best-effort: neither call can throw or fail a profile save.
  await Promise.all([
    recordSignal(user.id, "company_name", fields.name, "save_company"),
    recordSignal(user.id, "phone", fields.contact_phone, "save_company"),
  ]);

  // Optional outbound review-page links (0110). Same missing-column-safe
  // pattern as service_state / serves_orange_county above: only write a field
  // when the submitting form actually carried it, so a lean form can't wipe a
  // stored value. Each URL is validated server-side (reviewLinks.ts); an empty
  // string clears the field. A bad link surfaces via the existing flash/error
  // pattern (setFlash + redirect back to the form the pro submitted from),
  // exactly like the "Profile saved." / waitlist redirects below, and nothing
  // is written when validation fails. Kept out of `fields` and written via the
  // (as any) casts below because the columns land in 0110 and aren't in the
  // generated types.
  const reviewLinkBack = existing ? "/pro/profile" : "/pro/onboarding";
  const yelpEntry = formData.get("yelp_url");
  const googleEntry = formData.get("google_reviews_url");
  const hasReviewLinkWrite = yelpEntry !== null || googleEntry !== null;
  const reviewLinkWrite: Record<string, string | null> = {};
  if (yelpEntry !== null) {
    const r = validateYelpUrl(String(yelpEntry));
    if (!r.ok) {
      await setFlash(r.error, "error");
      redirect(reviewLinkBack);
    }
    reviewLinkWrite.yelp_url = r.value;
  }
  if (googleEntry !== null) {
    const r = validateGoogleReviewsUrl(String(googleEntry));
    if (!r.ok) {
      await setFlash(r.error, "error");
      redirect(reviewLinkBack);
    }
    reviewLinkWrite.google_reviews_url = r.value;
  }
  // Set by the retries below when the two columns had to be dropped to get the
  // rest of the save through. The flash has to say so: the save DID succeed,
  // but the links the pro just typed are not on the row, and a plain "Profile
  // saved." would be a lie they only discover by reloading the form.
  let reviewLinksDropped = false;

  if (existing) {
    // The license is a legal identifier: locked once VERIFIED (0037), not
    // before. Until a check confirms the number, the pro can still correct a
    // typo. A form that didn't carry the field at all (a read-only or absent
    // input posts nothing) keeps the stored value either way, so a lean form
    // can't wipe or swap it.
    const licenseEntry = formData.get("license_number");
    const licenseVerified =
      (existing as any).license_verified_status === "verified";
    if (
      existing.license_number &&
      (licenseVerified || licenseEntry === null)
    ) {
      fields.license_number = existing.license_number;
    }
    // A changed number resets verification to square one: any earlier check
    // proved a different license. 'pending' when a number is on file,
    // 'unverified' when it was cleared, per 0037's vocabulary.
    const licenseChanged =
      fields.license_number !== (existing.license_number ?? null);
    const licenseWrite = licenseChanged
      ? {
          license_verified_status: fields.license_number
            ? "pending"
            : "unverified",
          license_verified_at: null,
          license_verify_detail: null,
        }
      : {};
    let { error } = await supabase
      .from("contractors")
      .update({ ...fields, ...stateWrite, ...ocWrite, ...cityWrite, ...reviewLinkWrite } as any)
      .eq("id", existing.id);

    // The review links need the same thing launch_cities does: 0085 revoked the
    // TABLE-level UPDATE and re-granted an allowlist, and 0113 added yelp_url /
    // google_reviews_url without extending it (0128 is the fix). Until 0128 is
    // applied live, the columns EXIST but carry no grant, so this is a bare
    // 42501 that isMissingSchemaError cannot see - which is why the retry below
    // used to let it through and hard-500 every single profile save, whether or
    // not the pro typed a link (the form posts both boxes either way).
    //
    // Retried FIRST, ahead of the launch_cities retry, on purpose. Dropping the
    // review links is the cheapest honest fallback available; running the city
    // retry first would throw away the pro's city selection to work around a
    // failure the city columns had nothing to do with, and then still fail.
    let effectiveReviewLinkWrite = reviewLinkWrite;
    if (error && hasReviewLinkWrite && error.code === "42501") {
      console.error(
        "contractors update: review-link UPDATE grant missing (run migration 0128); retrying without yelp_url/google_reviews_url:",
        error.message
      );
      effectiveReviewLinkWrite = {};
      reviewLinksDropped = true;
      ({ error } = await supabase
        .from("contractors")
        .update({ ...fields, ...stateWrite, ...ocWrite, ...cityWrite } as any)
        .eq("id", existing.id));
    }
    // launch_cities needs both the column (0124) and its own column-level
    // UPDATE grant, since 0085 revoked the table-level privilege and re-granted
    // an allowlist - exactly the 42501 shape 0098 had to fix for
    // serves_orange_county. Retry without that field (loudly logged) so a live
    // DB still on 0123 saves everything else rather than failing the whole
    // profile save. Whether serves_orange_county rides along depends on WHY
    // the write failed: column absent (isMissingSchemaError) is a pre-0124 DB
    // with no city filter, so the attestation alone still gives the pro the
    // correct pre-0124 board. A 42501 with the column present is a
    // half-applied 0124: the city filter IS live, and serves_orange_county =
    // true with launch_cities stuck at '{}' would look enabled while the
    // board shows nothing - drop both and let the re-save after the full
    // migration store them together.
    if (
      error &&
      hasCityWrite &&
      (error.code === "42501" || isMissingSchemaError(error))
    ) {
      const columnMissing = isMissingSchemaError(error);
      console.error(
        columnMissing
          ? "contractors update: launch_cities column missing (run migration 0124); retrying without it:"
          : "contractors update: launch_cities UPDATE grant missing (run migration 0124 fully); retrying without it and without serves_orange_county:",
        error.message
      );
      ({ error } = await supabase
        .from("contractors")
        .update({
          ...fields,
          ...stateWrite,
          ...(columnMissing ? ocWrite : {}),
          ...effectiveReviewLinkWrite,
        } as any)
        .eq("id", existing.id));
    }
    // Same graceful missing-column retry as the insert path below: if 0046
    // (or 0074, or 0110's review-link columns) hasn't run yet, save everything
    // else rather than failing the whole form.
    if (
      error &&
      (hasStateWrite || hasOcWrite || hasReviewLinkWrite) &&
      isMissingSchemaError(error)
    ) {
      // This retry drops the review links too, so the pro has to be told.
      if (hasReviewLinkWrite) reviewLinksDropped = true;
      ({ error } = await supabase
        .from("contractors")
        .update(fields)
        .eq("id", existing.id));
    }
    if (error) throw new Error(error.message);

    // license_verified_status/_at/_verify_detail are trust columns 0078
    // revokes UPDATE on for `authenticated` (self-forged "verified" badges),
    // so this reset can't go through the user client above. Admin client,
    // scoped to existing.id: the caller's own contractor, resolved by
    // getCurrentContractor() at the top of this action, never client input.
    if (licenseChanged) {
      const admin = createAdminClient();
      const { error: licenseError } = await admin
        .from("contractors")
        .update(licenseWrite as any)
        .eq("id", existing.id);
      if (licenseError && !isMissingSchemaError(licenseError)) {
        throw new Error(licenseError.message);
      }
    }

    // Real CSLB check (0055), only when this save actually changed the
    // license number on file (first time, or a pre-verification typo fix: a
    // verified number is locked above, so it never re-triggers here). CSLB
    // is California's registry, so the lookup only runs for companies
    // serving CA; any other state's license stays 'pending' (on file, not
    // yet checkable) instead of collecting a public "failed" badge from a
    // registry that was never going to have it. Re-checking an unchanged
    // license is "Verify now" (verifyLicenseNowAction below) or the weekly
    // recheck cron. Best-effort: a CSLB hiccup must never block the profile
    // save that already succeeded.
    const effectiveServiceState = hasStateWrite
      ? serviceState
      : (((existing as any).service_state as string | null) ?? null);
    if (
      licenseChanged &&
      fields.license_number &&
      effectiveServiceState === "CA"
    ) {
      try {
        await verifyContractorLicense(
          supabase,
          existing.id,
          fields.license_number,
          // The number just changed, so no earlier check applies to it:
          // don't let the old number's timestamp debounce this one away.
          null,
          null,
          // 0125 identity check: the business name being saved right now (not
          // the stale stored one), plus the account holder's own name for the
          // sole-proprietor case where CSLB registered the license to the
          // person rather than the trade name.
          [
            fields.name,
            existing.name,
            await accountFullName(user.id),
            (user.user_metadata?.full_name as string | undefined) ?? null,
          ]
        );
      } catch (err) {
        console.error(
          "license verification failed:",
          err instanceof Error ? err.message : err
        );
      }
    }

    // The rejected-custom-service notice takes the flash slot when there is
    // one: the save DID succeed, but one box was quietly ignored, and the
    // flash cookie holds a single message - a plain "Profile saved." here
    // would leave the pro believing their custom service was stored.
    // Same single-slot reasoning covers the dropped review links (0128 not
    // applied yet). When both went wrong the rejected service name is the one
    // the pro has to act on, so it leads, with the links noted after it.
    if (customRejected) {
      await setFlash(
        reviewLinksDropped
          ? `${CUSTOM_CATEGORY_REJECTED} Review links could not be stored yet.`
          : CUSTOM_CATEGORY_REJECTED,
        "error"
      );
    } else if (reviewLinksDropped) {
      await setFlash("Saved. Review links could not be stored yet.", "warning");
    } else {
      await setFlash("Profile saved.");
    }
    revalidatePath("/pro/profile");
    redirect("/pro/profile");
  }

  // Orange County launch gate (0074), first-time company creation only. A pro
  // who didn't check the box never gets a contractors row at all: instead
  // they land on a waitlist so Hearth can reach out when it opens in their
  // area. The signup form no longer routes here (its two city checkboxes
  // require at least one, and the guard above catches an empty answer), so
  // this now only catches a post that carries no service-area answer at all.
  // Best-effort insert (the unique index on lower(email), role means a
  // resubmit is silently a no-op, not an error) - the reject must go through
  // either way.
  if (!servesOrangeCounty) {
    try {
      const waitlistEmail = (fields.contact_email || user.email || "").trim();
      if (waitlistEmail) {
        // Throttle before the insert, the same way the homeowner side does
        // (joinMarketWaitlistAction in src/app/onboarding/actions.ts). The
        // email here is caller-supplied (contact_email off this very form),
        // so 0074's uniqueness on (lower(email), role) is not a ceiling: one
        // account can post a different address every time. Keyed on IP, not
        // user id, because that is what a burst of fresh throwaway pro
        // accounts actually shares. Same derivation, same bucket shape, same
        // 5/hour budget, and the same fail-open posture: only an explicit
        // `allowed === false` blocks, so a limiter outage never costs a real
        // out-of-area pro their place on the list. The reject below still
        // goes through either way.
        const ip =
          (await headers()).get("x-forwarded-for")?.split(",")[0]?.trim() ??
          null;
        const { data: allowed } = await createAdminClient().rpc(
          "rate_limit_hit",
          {
            p_bucket: `waitlist:${ip ?? "unknown"}`,
            p_limit: 5,
            p_window_seconds: 3600,
          }
        );
        if (allowed !== false) {
          await (supabase as any).from("market_waitlist").insert({
            email: waitlistEmail,
            role: "pro",
            state: serviceState,
          });
        }
      }
    } catch (err) {
      console.error(
        "market_waitlist insert failed:",
        err instanceof Error ? err.message : err
      );
    }
    // Honest end state instead of dumping them back on a blank form (which
    // lost every field they'd just typed): redirect to a query flag
    // OnboardingCompanyForm reads to show an in-panel confirmation, plus a
    // working sign-out link, instead of a toast over an empty form. Mirrors
    // the homeowner out_of_area step's tone (src/app/onboarding/OnboardingForm.tsx).
    redirect("/pro/onboarding?waitlisted=1");
  }

  // First-time setup. `vetted` is a matchability flag, not a trust claim:
  // true is what lets matching include the company, and nothing has actually
  // been vetted at signup. No homeowner-facing copy may call a pro "vetted"
  // off this column; the real trust signals are the CSLB license check
  // (0055) and the opt-in background check (0057). id is generated here
  // (instead of left to the column default) so a CSLB check right after the
  // insert has the new row's id without a second round trip.
  const newContractorId = randomUUID();
  const base = {
    id: newContractorId,
    ...fields,
    user_id: user.id,
    // Matchable immediately; see the note above. Not a vetting claim.
    vetted: true,
  };

  // Referral attribution (0044): written ONLY here, on the creating insert,
  // never on later edits. An unresolvable code is dropped silently.
  const referredBy = await resolveReferralCode(
    supabase,
    formData.get("referral_code")
  );
  const referral = referredBy
    ? { referred_by: referredBy, referred_attributed_at: new Date().toISOString() }
    : {};

  // license_verified_status is a trust column: 0078 revokes INSERT (as well
  // as UPDATE) on it for `authenticated`, so it can no longer be set on this
  // user-scoped insert (a brand-new pro could otherwise self-grant a
  // 'verified' badge on the row they're creating). It's left out here
  // entirely; the column's own default ('unverified', 0037) applies, and the
  // 'pending' queue-up for a supplied license number is written separately
  // below via the admin client, scoped to the row just created. If a column
  // doesn't exist yet (migration not run), retry without the extras so
  // onboarding never breaks, same pattern as pro/help/actions. The retry is
  // gated on the missing-column fingerprint specifically: retrying on a
  // transient error would silently drop referral attribution on an insert
  // that might succeed the second time.
  // ocWrite rides the creating insert: the pro just answered the Orange
  // County question, and dropping it here left the row on 0074's FALSE
  // default, which hard-hides the whole job board from them. Requires
  // 0096's INSERT grant on serves_orange_county (0083's allowlist missed
  // it); the 42501 fallback below keeps signup alive on a live DB that
  // has not run 0096 yet (old dropped-answer behavior, loudly logged).
  // cityWrite rides the creating insert for the same reason ocWrite does: the
  // pro just answered which cities they cover, and dropping it here would leave
  // launch_cities at 0124's '{}' default, which hides the whole job board from
  // them just as surely as a false serves_orange_county did before 0098.
  // Requires 0124's INSERT grant on the column (0085's allowlist can't know
  // about a column added later); the retry below keeps signup alive on a live
  // DB that has not run 0124 yet, loudly logged. Whether serves_orange_county
  // survives the retry depends on why the write failed - see the comment at
  // the retry itself.
  let { error } = await supabase
    .from("contractors")
    .insert({ ...base, ...referral, ...stateWrite, ...ocWrite, ...cityWrite, ...reviewLinkWrite } as any);

  // Same story as the update path above: 0085 re-granted INSERT by column list
  // and 0113's yelp_url / google_reviews_url never joined it (0128 is the fix),
  // so on a live DB without 0128 the columns exist with no grant - a bare 42501
  // that isMissingSchemaError cannot recognize. Retried first, ahead of the
  // launch_cities and serves_orange_county retries, so a fixable review-link
  // failure never costs the pro the city answers they just gave.
  let effectiveReviewLinkWrite = reviewLinkWrite;
  if (error && hasReviewLinkWrite && error.code === "42501") {
    console.error(
      "contractors insert: review-link INSERT grant missing (run migration 0128); retrying without yelp_url/google_reviews_url:",
      error.message
    );
    effectiveReviewLinkWrite = {};
    reviewLinksDropped = true;
    ({ error } = await supabase
      .from("contractors")
      .insert({ ...base, ...referral, ...stateWrite, ...ocWrite, ...cityWrite } as any));
  }
  if (
    error &&
    hasCityWrite &&
    (error.code === "42501" || isMissingSchemaError(error))
  ) {
    // Which fallback is honest depends on WHY the write failed. Column absent
    // (isMissingSchemaError) means the DB is pre-0124: no city filter exists,
    // so keeping serves_orange_county gives the pro the correct pre-0124
    // board. A 42501 with the column present means 0124 is half-applied: the
    // city filter IS live, so serves_orange_county=true with launch_cities
    // stuck at '{}' would look enabled while the board shows nothing - drop
    // both and let the pro re-save once the migration is complete.
    const columnMissing = isMissingSchemaError(error);
    console.error(
      columnMissing
        ? "contractors insert: launch_cities column missing (run migration 0124); retrying without it:"
        : "contractors insert: launch_cities INSERT grant missing (run migration 0124 fully); retrying without it and without serves_orange_county:",
      error.message
    );
    ({ error } = await supabase
      .from("contractors")
      .insert({
        ...base,
        ...referral,
        ...stateWrite,
        ...(columnMissing ? ocWrite : {}),
        ...effectiveReviewLinkWrite,
      } as any));
  }
  if (error && hasOcWrite && error.code === "42501") {
    console.error(
      "contractors insert: serves_orange_county INSERT grant missing (run migration 0096); retrying without it:",
      error.message
    );
    ({ error } = await supabase
      .from("contractors")
      .insert({ ...base, ...referral, ...stateWrite, ...effectiveReviewLinkWrite } as any));
  }
  if (error && (referredBy || hasStateWrite || hasOcWrite || hasReviewLinkWrite)) {
    // isMissingSchemaError, not a hand-rolled regex: PostgREST reports a
    // missing INSERT column as PGRST204 "schema cache", which the old
    // pattern here missed, hard-500ing every new pro signup on a live DB
    // without 0046 instead of falling back to the base insert.
    if (isMissingSchemaError(error)) {
      // The base insert carries no review links either, so say so below.
      if (hasReviewLinkWrite) reviewLinksDropped = true;
      ({ error } = await supabase.from("contractors").insert(base));
    } else {
      console.error("contractors insert failed:", error.message);
    }
  }
  if (error) throw new Error(error.message);

  // A supplied license number is only "on file", not checked: queue it as
  // 'pending' (0037) so nothing downstream can claim a verification that
  // never ran. license_verified_status is one of the trust columns 0078
  // revokes INSERT/UPDATE on for `authenticated`, so this can't ride the
  // insert above; write it via the admin client instead, scoped to
  // newContractorId (generated at the top of this action, never
  // client-supplied). Best-effort: a hiccup here leaves the safe
  // 'unverified' default in place rather than blocking account creation,
  // which already succeeded above; the CSLB check right below (CA only)
  // will still run either way and can move status past 'unverified' itself.
  if (fields.license_number) {
    const admin = createAdminClient();
    const { error: pendingError } = await admin
      .from("contractors")
      .update({ license_verified_status: "pending" })
      .eq("id", newContractorId);
    if (pendingError) {
      console.error(
        "contractors pending-status write failed:",
        pendingError.message
      );
    }
  }

  // Real CSLB check (0055) for a license number supplied at onboarding.
  // California companies only: CSLB is CA's registry, so any other state's
  // license stays 'pending' (on file, awaiting a check) instead of getting a
  // public "failed" badge from a lookup that could never succeed.
  // Best-effort: a CSLB hiccup must never block account creation, which
  // already succeeded above.
  if (fields.license_number && serviceState === "CA") {
    try {
      await verifyContractorLicense(
        supabase,
        newContractorId,
        fields.license_number,
        null,
        null,
        // 0125 identity check, same candidates as the edit path above: the
        // company name just entered, plus the account holder's own name.
        [
          fields.name,
          await accountFullName(user.id),
          (user.user_metadata?.full_name as string | undefined) ?? null,
        ]
      );
    } catch (err) {
      console.error(
        "license verification failed:",
        err instanceof Error ? err.message : err
      );
    }
  }

  // The company row is what makes this account a pro, so this is the moment
  // the pro terms are agreed to - whoever they are and whichever door they
  // came through. Idempotent (it checks for an existing row first), so a pro
  // who already has a pro_terms row from contractor-signup or /auth/callback
  // gets a no-op, and the homeowner who just added a business gets the row
  // that was missing before.
  await recordTermsAcceptance(user.id, "pro_terms");

  // Preferred landing side. Only stamped when the account has NO side stamped
  // yet: a homeowner who adds a business keeps landing on their home until
  // they switch sides themselves (the profile menu's switcher,
  // setPreferredSideAction), because the row they just created already gets
  // them into /pro without touching this. The refresh matters for the same
  // reason it does in /auth/callback: the session cookie still carries the
  // pre-stamp JWT, and that cookie is what getSides() reads.
  const currentSide = (user.user_metadata?.role ?? user.app_metadata?.role) as
    | string
    | undefined;
  if (currentSide !== "contractor" && currentSide !== "homeowner") {
    const admin = createAdminClient();
    const { error: stampError } = await admin.auth.admin.updateUserById(
      user.id,
      { user_metadata: { ...(user.user_metadata ?? {}), role: "contractor" } }
    );
    if (stampError) {
      // Best-effort: the contractors row alone already opens /pro, so a failed
      // stamp only costs them their default landing side.
      console.error("saveCompanyAction: failed to stamp preferred side", {
        userId: user.id,
        stampError,
      });
    } else {
      const { error: refreshError } = await supabase.auth.refreshSession();
      if (refreshError) {
        console.error(
          "saveCompanyAction: failed to refresh session after side stamp",
          refreshError
        );
      }
    }
  }

  // Same single-flash-slot reasoning as the edit path above: the account was
  // created either way, but a dropped custom service has to be said out loud.
  if (customRejected) {
    await setFlash(
      reviewLinksDropped
        ? `${CUSTOM_CATEGORY_REJECTED} Review links could not be stored yet.`
        : CUSTOM_CATEGORY_REJECTED,
      "error"
    );
  } else if (reviewLinksDropped) {
    await setFlash("Saved. Review links could not be stored yet.", "warning");
  } else {
    await setFlash("You're all set. Leads will appear here.");
  }
  revalidatePath("/", "layout");
  redirect("/pro");
}

async function assertContractor() {
  const contractor = await getCurrentContractor();
  if (!contractor) redirect("/signin");
  return contractor;
}

// "Verify now" / "Reverify" button on /pro/profile: an on-demand CSLB check
// for a pro whose license number is on file but not yet verified. The button
// lives inside the profile <form>, so the action receives the form's data and
// checks the license number currently in the input, not a stale DB value: a
// pro who fixes a typo and clicks "Reverify" means the corrected number, and
// a changed number is persisted (reset to 'pending', per 0037) before the
// check. Same verifyContractorLicense used by saveCompanyAction and the
// weekly recheck cron, so the debounce and the never-downgrade-on-'error'
// rule apply here too; the debounce is skipped when the number changed, since
// the previous check proved a different license.
export async function verifyLicenseNowAction(formData: FormData) {
  const contractor = await assertContractor();

  const stored = contractor.license_number ?? null;
  const licenseVerified =
    (contractor as any).license_verified_status === "verified";
  // A verified number is locked (mirrors saveCompanyAction), and a form
  // without the field (read-only or absent input posts nothing) keeps the
  // stored value, so neither path can swap a locked license.
  const licenseEntry = formData.get("license_number");
  const typed =
    licenseEntry === null ? null : String(licenseEntry).trim() || null;
  const licenseNumber =
    licenseVerified || licenseEntry === null ? stored : typed;
  if (!licenseNumber) {
    await setFlash("Add a license number first.", "error");
    revalidatePath("/pro/profile");
    return;
  }

  // CSLB covers California licenses only, so a pro who explicitly serves
  // another state is refused honestly: their license stays on file, not
  // publicly "failed" by a registry that was never going to have it. A
  // null/blank service_state ("All states", or a pre-0046 row) IS eligible:
  // this is an explicit user-initiated check, and a non-CSLB number safely
  // parses as not-found.
  const serviceState =
    (((contractor as any).service_state as string | null) ?? null) || null;
  if (serviceState !== null && serviceState !== "CA") {
    await setFlash(
      "Automatic license checks currently cover California (CSLB) licenses only. Yours stays on file; set State You Serve to California to run a CSLB check.",
      "info"
    );
    revalidatePath("/pro/profile");
    return;
  }

  const supabase = await createClient();

  // A corrected (unsaved) number is persisted first, resetting verification
  // to square one: any earlier check proved a different license. If this
  // write fails, bail rather than check a number that isn't on file.
  const licenseChanged = licenseNumber !== stored;
  if (licenseChanged) {
    const { error } = await (supabase.from("contractors") as any)
      .update({ license_number: licenseNumber })
      .eq("id", contractor.id);
    if (error) {
      console.error("verifyLicenseNowAction: license save failed:", error.message);
      await setFlash("Couldn't save the corrected license number. Try again.", "error");
      revalidatePath("/pro/profile");
      return;
    }

    // license_verified_status/_at/_verify_detail are trust columns 0078
    // revokes UPDATE on for `authenticated`; write via the admin client.
    // Scoped to contractor.id: the caller's own contractor, from
    // assertContractor() above, never client-supplied.
    const admin = createAdminClient();
    const { error: resetError } = await (admin.from("contractors") as any)
      .update({
        license_verified_status: "pending",
        license_verified_at: null,
        license_verify_detail: null,
      })
      .eq("id", contractor.id);
    if (resetError) {
      console.error(
        "verifyLicenseNowAction: license reset failed:",
        resetError.message
      );
      await setFlash("Couldn't save the corrected license number. Try again.", "error");
      revalidatePath("/pro/profile");
      return;
    }
  }

  const result = await verifyContractorLicense(
    supabase,
    contractor.id,
    licenseNumber,
    // A just-changed number was never checked: the old number's timestamps
    // must not debounce this check away.
    licenseChanged ? null : contractor.license_verified_at,
    licenseChanged ? null : (contractor as any).license_verify_detail,
    // 0125 identity check: this company's name plus the account holder's own
    // name (CSLB registers a sole proprietor's license to the person).
    [contractor.name, await accountFullName(contractor.user_id)]
  );

  if (!result) {
    await setFlash("Already checked recently. Try again in a few minutes.", "info");
  } else if (result.failureReason === "name_mismatch") {
    // Deliberately does NOT echo the CSLB-registered name back: whoever is
    // sitting at this form may not be the person that name belongs to.
    await setFlash(
      "The CSLB lists this license under a different name than your account. If this is your license, file a dispute below and we will review it.",
      "error"
    );
  } else if (result.failureReason === "duplicate_license") {
    await setFlash(
      "This license number is already verified on another Hearth account. If someone else used your license, file a dispute below and we will investigate.",
      "error"
    );
  } else if (result.decision === "verified") {
    await setFlash("License verified against the CSLB database.", "success");
  } else if (result.decision === "failed") {
    await setFlash(
      result.statusText
        ? `CSLB says: ${result.statusText}`
        : "CSLB could not confirm this license.",
      "error"
    );
  } else if (result.outcome === "active") {
    // Active, but CSLB returned no registered name to check the account
    // against, so nothing was decided either way. Not a failure - honest
    // "unknown" copy, and their status is untouched.
    await setFlash(
      "CSLB didn't return a name we could check this license against. Nothing changed; try again later.",
      "info"
    );
  } else {
    await setFlash("Couldn't reach the CSLB site. Try again later.", "info");
  }
  revalidatePath("/pro/profile");
}

// "Start my background check" button on /pro/profile (0057): opt-in only,
// never auto-run. Creates a Checkr candidate + invitation and saves the
// candidate id so the webhook (src/app/api/checkr/webhook) can match Checkr's
// events back to this contractor. Checkr does the rest by email - Hearth
// never collects the candidate's sensitive info itself.
export async function startBackgroundCheckAction(formData: FormData) {
  const contractor = await assertContractor();

  // Every check costs Hearth real money, so only the two states that
  // legitimately allow a (re)start may reach the Checkr API: 'none' (never
  // started) and 'consider' (retry after a non-clear result). 'invited',
  // 'pending', and 'clear' all bail out here as the cheap early exit; the
  // REAL double-click / replayed-POST lock is the atomic status claim
  // further down, right before the Checkr call - this read alone cannot
  // close that race. Read fresh from the DB, not client-supplied state.
  const status =
    ((contractor as any).background_check_status as string | undefined) ??
    "none";
  if (status !== "none" && status !== "consider") {
    await setFlash(
      status === "clear"
        ? "Your background check has already cleared."
        : "Your background check is already in progress. Check your email for Checkr's invitation.",
      "info"
    );
    revalidatePath("/pro/profile");
    return;
  }

  const email = contractor.contact_email;
  if (!email) {
    await setFlash("Add an email address to your profile first.", "error");
    revalidatePath("/pro/profile");
    return;
  }

  // Earn-in gate: Hearth pays Checkr for every check, so the perk unlocks
  // after BACKGROUND_CHECK_MIN_PAID_LEADS paid lead applications rather than
  // at signup. Without this, an account could be created, verified on Hearth's
  // dime, and abandoned the same afternoon.
  //
  // FAILS CLOSED on a count error (countPaidLeadApplications returns null):
  // this decision spends real money with a third party, and "we could not
  // read the ledger" is never a good enough reason to send the bill. The pro
  // sees a try-again message and nothing is charged.
  const paidLeads = await countPaidLeadApplications(contractor.id);
  if (paidLeads === null) {
    await setFlash(
      "Couldn't check your lead history just now. Try again in a moment.",
      "error"
    );
    revalidatePath("/pro/profile");
    return;
  }
  if (paidLeads < BACKGROUND_CHECK_MIN_PAID_LEADS) {
    await setFlash(
      `Hearth covers your background check after ${BACKGROUND_CHECK_MIN_PAID_LEADS} paid leads - you're at ${paidLeads} of ${BACKGROUND_CHECK_MIN_PAID_LEADS}.`,
      "info"
    );
    revalidatePath("/pro/profile");
    return;
  }

  // The check runs against a PERSON, so it needs their legal name, not the
  // business name ("Bob's Plumbing LLC" split into first/last would risk a
  // check against a garbled identity). The card's form collects it
  // explicitly and it goes only to Checkr, never stored by Hearth.
  const firstName = String(formData.get("legal_first_name") ?? "")
    .trim()
    .slice(0, 80);
  const lastName = String(formData.get("legal_last_name") ?? "")
    .trim()
    .slice(0, 80);
  if (!firstName || !lastName) {
    await setFlash("Enter your legal first and last name to start.", "error");
    revalidatePath("/pro/profile");
    return;
  }

  // Checkr requires a work location state. contractors.service_state (0046)
  // isn't in the generated types, so it's read off an any-cast; a pro who
  // left it blank ("all states") falls back to CA, matching Hearth's
  // current Orange County, CA launch markets.
  const workLocationState =
    (contractor as any).service_state || "CA";

  // CLAIM the status atomically BEFORE spending money. The whitelist check at
  // the top is a plain read, so two concurrent submissions (double-click, a
  // replayed POST) could both see 'none' and both create a billed Checkr
  // candidate. This conditional update is the real lock, the same pattern
  // analyze-quote uses for the free credit: only the request that flips the
  // row from its read state to 'invited' proceeds; the loser matches zero
  // rows and gets the ordinary already-in-progress message.
  const admin = createAdminClient();
  const { data: claimed, error: claimError } = await (
    admin.from("contractors") as any
  )
    .update({ background_check_status: "invited" })
    .eq("id", contractor.id)
    .eq("background_check_status", status)
    .select("id");
  if (claimError || !claimed || claimed.length === 0) {
    if (claimError) {
      console.error(
        "startBackgroundCheckAction: status claim failed:",
        claimError.message
      );
    }
    await setFlash(
      "Your background check is already in progress. Check your email for Checkr's invitation.",
      "info"
    );
    revalidatePath("/pro/profile");
    return;
  }

  const result = await createCandidateAndInvite({
    email,
    firstName,
    lastName,
    workLocationState,
  });

  if (!result.ok) {
    console.error("startBackgroundCheckAction failed:", result.error);
    // Release the claim so the pro can retry: put the status back to what it
    // was, but only if it is still the 'invited' this request just wrote (a
    // webhook could theoretically have advanced it). Best effort - a failed
    // revert is logged, and support can reset the column.
    const { error: revertError } = await (admin.from("contractors") as any)
      .update({ background_check_status: status })
      .eq("id", contractor.id)
      .eq("background_check_status", "invited");
    if (revertError) {
      console.error(
        "startBackgroundCheckAction: claim revert failed:",
        revertError.message
      );
    }
    await setFlash(
      "Couldn't start your background check. Try again in a few minutes.",
      "error"
    );
    revalidatePath("/pro/profile");
    return;
  }

  // checkr_candidate_id is a trust column 0078 revokes UPDATE on for
  // `authenticated`; write via the admin client. The value comes from the
  // Checkr candidate just created above (never client input), and the write
  // is scoped to contractor.id: the caller's own contractor, from
  // assertContractor() above. The status itself was already claimed as
  // 'invited' before the Checkr call - only the candidate id lands here.
  const { error } = await (admin.from("contractors") as any)
    .update({ checkr_candidate_id: result.candidateId })
    .eq("id", contractor.id);
  if (error) {
    console.error("startBackgroundCheckAction: save failed:", error.message);
    await setFlash(
      "Your check started, but we couldn't save it here. Contact support.",
      "error"
    );
    revalidatePath("/pro/profile");
    return;
  }

  await setFlash(
    "Background check started. Check your email for Checkr's invitation.",
    "success"
  );
  revalidatePath("/pro/profile");
}

export async function updateLeadStatusAction(formData: FormData) {
  const leadId = formData.get("id") as string;
  const status = formData.get("status") as string;
  // Only accept a known status value; never write arbitrary client input.
  if (!LEAD_STATUSES.some((s) => s.value === status)) {
    await setFlash("Unknown status.", "error");
    return;
  }
  const contractor = await assertContractor();
  const supabase = await createClient();
  // Read the current status first so the review ask below fires only on a real
  // transition INTO Won, not on a re-save of an already-closed job. RLS scopes
  // the read to this contractor's own leads, same as the update.
  const { data: before } = await supabase
    .from("contractor_leads")
    .select("status, category")
    .eq("id", leadId)
    .maybeSingle();
  // RLS also guarantees the lead is assigned to this contractor.
  const { error } = await supabase
    .from("contractor_leads")
    .update({ status })
    .eq("id", leadId);
  if (error) throw new Error(error.message);
  const baseFlash = `Lead marked ${labelFor(LEAD_STATUSES, status)}`;
  await setFlash(baseFlash);

  // Hearth Pro perk: when a member marks a job Won, ask the homeowner for a
  // review automatically. Only on the closed transition (never for lost /
  // accepted / new), only for live Pro plans, and best-effort throughout: a
  // hiccup here must never break the status update. `before` also proves the
  // lead really belongs to this contractor before anyone gets pinged.
  if (status === "closed" && before && before.status !== "closed") {
    try {
      if (await hasProPlan()) {
        await requestReviewForWonLead({
          leadId,
          contractorUserId: contractor.user_id,
          businessName: contractor.name,
        });
      } else {
        // The moment the perk is actually withheld is the only honest moment
        // to name it: a non-member just closed a job and, unlike a member, no
        // review ask left the building. Reviews are what win the NEXT job, so
        // this is a real loss, stated where it really happens.
        await setFlash(
          `${baseFlash}. Job won - but no review request went out. Pro members get a review asked for automatically the moment they mark a job Won.`
        );
      }
    } catch (err) {
      console.error(
        "review request:",
        err instanceof Error ? err.message : err
      );
    }
    // "job_won" (src/app/api/track/route.ts): fires on the same real
    // transition INTO Won as the review ask above, independent of Pro plan
    // status. No PII, just the category.
    await trackServerEvent(contractor.user_id, "job_won", {
      category: before.category,
    });
  }

  revalidatePath("/pro");
}

// Dollar string for a fee in cents, matching the board's money() formatting
// ($99, not $99.00; $49.99 keeps its cents).
function feeString(cents: number) {
  const fee = cents / 100;
  return Number.isInteger(fee) ? `$${fee}` : `$${fee.toFixed(2)}`;
}

// Stale-tab price guard shared by applyToJobAction and
// unlockDirectRequestAction. The confirm form posts the fee it DISPLAYED
// (fee_cents); this recomputes what the charge RPC will derive right now:
// the aging price from the lead row (agingLeadFee mirrors the DB's
// lead_fee_cents) with the first big-ticket intro (0113) applied on top,
// using the same my_applications-based check page.tsx uses for
// hasPaidMajor, run fresh here. Returns an error message when the live
// price is HIGHER than what the pro saw, so a tab rendered before the intro
// was consumed elsewhere can't confirm $49.99 and silently charge $99.
// Never blocks when the live price is lower or equal to the displayed one,
// and fails open (null) whenever an input is unreadable: the DB still
// derives the true price under the wallet lock either way, this only closes
// the minutes-long stale-display window (the few-ms race between this check
// and the RPC is acceptable).
async function staleDisplayedFeeError(
  supabase: any,
  displayedEntry: FormDataEntryValue | null,
  lead: {
    payout_amount: number | string | null;
    created_at: string | null;
    category: string | null;
  } | null
): Promise<string | null> {
  const displayedCents = Number(displayedEntry);
  if (!lead || !lead.created_at || !Number.isFinite(displayedCents) || displayedCents <= 0) {
    return null;
  }
  let currentCents = Math.round(
    agingLeadFee(Number(lead.payout_amount ?? 0), lead.created_at).fee * 100
  );
  const major = isMajorCategory(lead.category ?? "");
  if (major) {
    const { data: myApps, error } = await supabase.rpc("my_applications");
    // Fail open on a read hiccup: without the payment history we can't tell
    // whether the intro still applies, and assuming it doesn't would block a
    // legit intro-priced apply (the one thing this guard must never do).
    if (error) return null;
    const hasPaidMajor = ((myApps ?? []) as any[]).some(
      (a) => Number(a.fee_cents ?? 0) > 0 && isMajorCategory(a.category)
    );
    const introCents = Math.round(MAJOR_INTRO_FEE * 100);
    if (!hasPaidMajor && introCents < currentCents) currentCents = introCents;
  }
  if (currentCents > displayedCents) {
    return major
      ? `The price for this lead is now ${feeString(currentCents)} (your first big-ticket discount was already used). Refresh to see the current price.`
      : `The price for this lead is now ${feeString(currentCents)}. Refresh to see the current price.`;
  }
  return null;
}

// Apply to an open job. The DB function charges the per-category fee from the
// wallet (cash first, then bonus) and records the application. Returns false if
// the wallet balance is short.
export async function applyToJobAction(formData: FormData) {
  const contractor = await assertContractor();
  const leadId = String(formData.get("id"));
  const message = (formData.get("message") as string) || "";

  // Orange County launch gate (0074), defense-in-depth: open_jobs_for_me()
  // already hides jobs from a pro who hasn't confirmed Orange County, but a
  // direct POST to this action (stale tab, replayed request) must be refused
  // before any fee is spent, not just hidden from the board. assertContractor
  // already loaded the full row via the admin client, so this is a read of
  // data already in hand, not a second query.
  if (!(contractor as any).serves_orange_county) {
    await setFlash(
      "Pick the cities you serve in your profile before applying to jobs.",
      "error"
    );
    revalidatePath("/pro");
    return;
  }

  // Marketplace integrity: a pro with an active job for this homeowner in
  // this category already has them in Messages, so a second apply fee would
  // double-charge them for the same relationship. Checked here (friendly
  // error, no charge attempted) and again inside apply_to_lead (0060) as the
  // hard backstop. Completed/closed jobs never block: rehires stay open.
  const conflicts = await findActiveJobConflicts(contractor.id, [leadId]);
  const conflict = conflicts.get(leadId);
  if (conflict) {
    await setFlash(
      `You already have an active ${labelFor(JOB_CATEGORIES, conflict.category)} job with this homeowner. Message them there instead; once that job wraps up, you can apply to their new ones again.`,
      "error"
    );
    revalidatePath("/pro");
    return;
  }

  // Advisory pre-check (see migration 0092's RESIDUAL note): apply_to_lead
  // has no awareness of owner_closed_at, so without this a pro could still
  // pay to apply to a job the homeowner already closed. RLS only lets a pro
  // SELECT a lead once they're the assigned contractor ("leads contractor
  // select", 0005), which an unassigned open job never is, so this reads
  // through the admin client rather than the user-scoped one. Advisory only:
  // a race between this check and the RPC below is acceptable (ghost
  // protection still refunds an apply fee paid in that window), and this
  // never touches apply_to_lead's own SQL or any money logic.
  // payout_amount/created_at/category ride along for the stale-price guard
  // below, so it costs no extra query.
  const admin = createAdminClient();
  const { data: leadClosedCheck, error: leadClosedError } = await admin
    .from("contractor_leads")
    .select("owner_closed_at, payout_amount, created_at, category")
    .eq("id", leadId)
    .maybeSingle();
  if (leadClosedError && !isMissingSchemaError(leadClosedError)) {
    console.error(
      "applyToJobAction: owner_closed_at pre-check failed:",
      leadClosedError.message
    );
  }
  if (!leadClosedError && (leadClosedCheck as any)?.owner_closed_at) {
    await setFlash(
      "The homeowner closed this job before you applied, so you were not charged.",
      "error"
    );
    revalidatePath("/pro");
    return;
  }
  // Any error here (0092 not run yet, or an unrelated hiccup) falls through
  // and lets apply_to_lead run exactly as it did before this check existed:
  // this pre-check is advisory only and must never itself block a legit apply.

  // Replay guard: apply_to_lead returns true idempotently when this pro
  // already applied, and the success branch below would then re-send the
  // "Application sent. $X was charged" receipt for money that was never
  // charged a second time. Same posture as unlockDirectRequestAction's
  // guard: check for the existing application row BEFORE the RPC and return
  // a neutral flash with no receipt. Best-effort dedupe, not a correctness
  // guarantee: a truly concurrent double-submit can still reach the RPC's
  // own idempotent true, and a read hiccup falls through as before.
  try {
    const { data: existingApp, error: existingAppError } = await admin
      .from("lead_applications")
      .select("id")
      .eq("lead_id", leadId)
      .eq("contractor_id", contractor.id)
      .maybeSingle();
    if (!existingAppError && existingApp) {
      await setFlash("You already applied to this job.");
      revalidatePath("/pro");
      return;
    }
  } catch {
    // Best-effort: on a read hiccup, fall through to the RPC as before.
  }

  const supabase = (await createClient()) as any;

  // Stale-tab price guard (staleDisplayedFeeError above): if the live price
  // is now HIGHER than the fee this confirm form displayed (typically the
  // first big-ticket intro was consumed in another tab), refuse to charge
  // and ask for a refresh instead of silently billing the higher amount.
  const staleError = await staleDisplayedFeeError(
    supabase,
    formData.get("fee_cents"),
    leadClosedError ? null : ((leadClosedCheck as any) ?? null)
  );
  if (staleError) {
    await setFlash(staleError, "error");
    revalidatePath("/pro");
    return;
  }

  const { data, error } = await supabase.rpc("apply_to_lead", {
    p_lead: leadId,
    p_message: message,
  });
  if (error) {
    // The DB raises 'Job is full' at the applicant cap and 'Already working
    // with this homeowner' at the relationship guard (0060) - both different
    // problems than a short wallet, so each gets its own message instead of
    // the raw error. Anything else is a database failure the pro can't act
    // on, so it's logged server-side and shown as a plain generic: raw
    // Postgres text names our tables, columns and constraints.
    if (error.message.includes("Job is full")) {
      await setFlash(
        "This job is full: 3 pros already applied. Try another job.",
        "error"
      );
    } else if (error.message.includes("Already working with this homeowner")) {
      await setFlash(
        "You already have an active job with this homeowner in this category. Message them there instead.",
        "error"
      );
    } else {
      console.error("applyToJobAction: apply_to_lead failed:", error);
      await setFlash("Couldn't apply just now. Please try again.", "error");
    }
  } else if (data === false)
    await setFlash("Not enough balance. Add funds to apply.", "error");
  else {
    // A successful apply is the moment a non-member has just spent real money
    // on a lead, so it is the honest moment to name what a membership would
    // have done to that spend. Deliberately ONLY the deposit boost: the $10
    // monthly lead credit is held back until a trial converts (see
    // src/app/pro/plus/page.tsx), so promising it here would overpromise to
    // exactly the pros most likely to start a trial next. PRO_DEPOSIT_BOOST_PTS
    // is the same constant the webhook passes to apply_deposit, so this can
    // never quote a match the wallet does not actually pay.
    const proMember = await hasProPlan();
    await setFlash(
      proMember
        ? "Applied. The homeowner will review your application."
        : `Applied. The homeowner will review your application. Pro members earn +${PRO_DEPOSIT_BOOST_PTS}% on every deposit, so the same money buys more leads.`,
      "success"
    );
    // Receipt notification: what they applied to and what it cost. Rows are
    // service-role-only inserts (no client policy), so this uses the admin
    // client. Best-effort: a hiccup here must never break a paid application.
    try {
      if (contractor.user_id) {
        // Reuses the admin client created for the owner_closed_at pre-check
        // above, rather than opening a second one.
        const [{ data: lead }, { data: appRow }] = await Promise.all([
          admin
            .from("contractor_leads")
            .select("category")
            .eq("id", leadId)
            .maybeSingle(),
          // The application row the RPC just wrote holds the EXACT amount
          // charged (fee_cents), including the first big-ticket intro price
          // (migration 0113) and any aging markdown, so the receipt can
          // never misquote what the wallet actually paid.
          admin
            .from("lead_applications")
            .select("fee_cents")
            .eq("lead_id", leadId)
            .eq("contractor_id", contractor.id)
            .maybeSingle(),
        ]);
        if (lead) {
          const chargedCents = Number((appRow as any)?.fee_cents);
          // The dollar amount comes ONLY from the application row the RPC
          // just wrote. If that read fails, omit the amount entirely rather
          // than guessing: the aging-tier math would misquote an
          // intro-priced (0113) charge.
          const feeStr =
            Number.isFinite(chargedCents) && chargedCents > 0
              ? feeString(chargedCents)
              : null;
          await admin.from("notifications").insert({
            user_id: contractor.user_id,
            kind: "apply_receipt",
            title: "Application sent",
            body: feeStr
              ? `You applied to a ${labelFor(JOB_CATEGORIES, lead.category)} job. ${feeStr} was charged to your wallet.`
              : `You applied to a ${labelFor(JOB_CATEGORIES, lead.category)} job. The fee was charged to your wallet.`,
            url: "/pro",
          });
          // "pro_apply" (src/app/api/track/route.ts): fires once per
          // successful, fee-charged application. No PII, just the category.
          await trackServerEvent(contractor.user_id, "pro_apply", {
            category: lead.category,
          });
        }
      }
    } catch {
      // The receipt is a nice-to-have; the application already went through.
    }
  }
  revalidatePath("/pro");
  revalidatePath("/pro/billing");
}

// Unlock (= accept) a direct request a homeowner aimed at this pro. The DB
// function unlock_direct_request (0104) charges the per-category lead fee from
// the wallet exactly like apply_to_lead (cash first, then bonus), assigns the
// lead, and opens the chat. It returns false ONLY for a short wallet, so that
// path drives the deposit prompt (the card's Unlock button already routes a
// short wallet to billing before this runs; this is the backstop for a balance
// that changed between render and submit). Any other non-unlockable state
// raises, and an already-unlocked lead returns true (idempotent).
export async function unlockDirectRequestAction(formData: FormData) {
  const contractor = await assertContractor();
  const leadId = String(formData.get("id"));

  // Replay guard: unlock_direct_request is idempotent and returns true for BOTH
  // a fresh unlock and a repeat one, so a replayed POST would otherwise re-fire
  // the "accepted your request" notification to the homeowner. Read
  // direct_unlocked_at BEFORE the RPC; if this lead was already unlocked, skip
  // the notification below (but still redirect the pro into the chat, the way a
  // normal unlock lands them there). The read goes through the admin client:
  // until the unlock sets contractor_id the pro isn't the lead's contractor, so
  // a user-scoped read of a still-pending request would be blocked by RLS.
  // Best-effort dedupe, not a correctness guarantee: a truly concurrent
  // double-submit can still slip a second notice through.
  // payout_amount/created_at/category ride along for the stale-price guard
  // below, so it costs no extra query.
  const admin = createAdminClient();
  let alreadyUnlocked = false;
  let leadRow: any = null;
  try {
    const { data: pre } = await (admin.from("contractor_leads") as any)
      .select("direct_unlocked_at, payout_amount, created_at, category")
      .eq("id", leadId)
      .maybeSingle();
    alreadyUnlocked = Boolean(pre?.direct_unlocked_at);
    leadRow = pre ?? null;
  } catch {
    // Best-effort: on a read hiccup, fall through and notify as before.
  }

  const supabase = (await createClient()) as any;

  // Stale-tab price guard (staleDisplayedFeeError above): if the live price
  // is now HIGHER than the fee this confirm form displayed (typically the
  // first big-ticket intro was consumed in another tab), refuse to charge
  // and ask for a refresh instead of silently billing the higher amount.
  // Skipped on the idempotent repeat unlock: it was already paid, so no new
  // charge can happen.
  if (!alreadyUnlocked) {
    const staleError = await staleDisplayedFeeError(
      supabase,
      formData.get("fee_cents"),
      leadRow
    );
    if (staleError) {
      await setFlash(staleError, "error");
      revalidatePath("/pro");
      return;
    }
  }

  const { data, error } = await supabase.rpc("unlock_direct_request", {
    p_lead: leadId,
  });
  if (error) {
    // Raw Postgres text names our tables, columns and constraints, so it's
    // logged server-side and the pro sees a plain generic instead.
    console.error("unlockDirectRequestAction: unlock_direct_request failed:", error);
    await setFlash("Couldn't unlock this request just now. Please try again.", "error");
    revalidatePath("/pro");
    return;
  }
  if (data === false) {
    await setFlash("Not enough balance. Add funds to unlock.", "error");
    revalidatePath("/pro");
    revalidatePath("/pro/billing");
    return;
  }

  // Unlocked. Tell the homeowner their pro is in and the chat is open.
  // Best-effort: a notification hiccup must never undo a paid unlock. The pro
  // isn't the lead's contractor until the unlock above sets contractor_id, and
  // the owner-contact read is service-role either way, so this goes through the
  // admin client (reused from the replay-guard read above), same posture as the
  // pro-side quote/invoice notifications. Skipped on the idempotent repeat
  // unlock so a replayed POST doesn't re-notify (see the guard above).
  if (!alreadyUnlocked) try {
    const { data: lead } = await admin
      .from("contractor_leads")
      .select("property_id")
      .eq("id", leadId)
      .maybeSingle();
    if (lead?.property_id) {
      const { data: property } = await admin
        .from("properties")
        .select("user_id")
        .eq("id", lead.property_id)
        .maybeSingle();
      if (property?.user_id) {
        // "Messages from pros" (pro_messages) gates the email/SMS channels
        // only, never the in-app row: an unset pref reads as enabled.
        const { data: owner } = await admin
          .from("users")
          .select("email, phone, sms_consent, notification_prefs")
          .eq("id", property.user_id)
          .maybeSingle();
        const wantsProMessages = owner?.notification_prefs?.pro_messages ?? true;
        await sendNotification(admin, {
          userId: property.user_id,
          kind: "direct_accepted",
          title: `${contractor.name} accepted your request`,
          body: "They can see your details now and the chat is open. Message them to get started.",
          url: `/chats?lead=${leadId}`,
          email: wantsProMessages ? owner?.email ?? null : null,
          phone: wantsProMessages ? owner?.phone ?? null : null,
          smsConsent: wantsProMessages ? owner?.sms_consent === true : false,
        });
      }
    }
  } catch (err) {
    console.error(
      "direct accept notification:",
      err instanceof Error ? err.message : err
    );
  }

  revalidatePath("/pro");
  revalidatePath("/pro/billing");
  // Land the pro in the chat for the lead they just unlocked, the way choosing
  // or rehiring drops the homeowner straight into the thread.
  redirect(`/pro/chats?lead=${leadId}`);
}

// Pass on a direct request (free). decline_direct_request (0104) stamps
// direct_declined_at and is idempotent. The homeowner is nudged to post the job
// to every local pro instead. The pro is not the lead's contractor on a pending
// request (contractor_id is null), so the owner lookup goes through the admin
// client, resolved before the decline so the row is still readable.
export async function declineDirectRequestAction(formData: FormData) {
  const contractor = await assertContractor();
  const leadId = String(formData.get("id"));

  const admin = createAdminClient();
  let ownerUserId: string | null = null;
  // Replay guard: decline_direct_request is idempotent (returns void whether it
  // stamped direct_declined_at now or it was already stamped), so a replayed
  // POST would otherwise re-notify the homeowner. Read the stamp BEFORE the RPC
  // and skip the notification when the request was already declined. Best-effort
  // dedupe, not a correctness guarantee: a truly concurrent double-submit can
  // still slip a second notice through, but the common replay case is covered.
  let alreadyDeclined = false;
  try {
    const { data: lead } = await (admin.from("contractor_leads") as any)
      .select("property_id, direct_declined_at")
      .eq("id", leadId)
      .maybeSingle();
    if (lead?.property_id) {
      const { data: property } = await admin
        .from("properties")
        .select("user_id")
        .eq("id", lead.property_id)
        .maybeSingle();
      ownerUserId = property?.user_id ?? null;
    }
    alreadyDeclined = Boolean(lead?.direct_declined_at);
  } catch {
    // Best-effort: a lookup hiccup just means no homeowner notification.
  }

  const supabase = (await createClient()) as any;
  const { error } = await supabase.rpc("decline_direct_request", {
    p_lead: leadId,
  });
  if (error) {
    // Same reasoning as unlockDirectRequestAction above: log the raw error,
    // show copy that doesn't leak the schema.
    console.error("declineDirectRequestAction: decline_direct_request failed:", error);
    await setFlash("Couldn't pass on this request just now. Please try again.", "error");
    revalidatePath("/pro");
    return;
  }

  if (ownerUserId && !alreadyDeclined) {
    try {
      const { data: owner } = await admin
        .from("users")
        .select("email, phone, sms_consent, notification_prefs")
        .eq("id", ownerUserId)
        .maybeSingle();
      const wantsProMessages = owner?.notification_prefs?.pro_messages ?? true;
      await sendNotification(admin, {
        userId: ownerUserId,
        kind: "direct_declined",
        title: `${contractor.name} passed on your request`,
        body: "You can post this job to all local pros instead and get more options.",
        url: "/contractors",
        email: wantsProMessages ? owner?.email ?? null : null,
        phone: wantsProMessages ? owner?.phone ?? null : null,
        smsConsent: wantsProMessages ? owner?.sms_consent === true : false,
      });
    } catch (err) {
      console.error(
        "direct decline notification:",
        err instanceof Error ? err.message : err
      );
    }
  }

  await setFlash("You passed on this request.");
  revalidatePath("/pro");
}

// NOTE: a markLeadPaidAction used to live here that wrote the client-supplied
// `paid` / `paid_at` fields directly to contractor_leads. `paid` gates access to
// the homeowner's contact info and chat, so letting the client set it was an
// unlock-without-paying risk. It had no callers (unlocking happens only through
// the SECURITY DEFINER charge_lead / choose_applicant flows that confirm
// payment), so it was removed rather than patched.
