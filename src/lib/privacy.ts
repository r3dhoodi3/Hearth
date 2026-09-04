import { createAdminClient } from "@/lib/supabase/admin";
import { normalizeEmail } from "@/lib/risk/emailNorm";

// =============================================================================
// OakTend - California privacy rights plumbing (CCPA/CPRA).
//
// Two jobs, both keyed to a single auth user id:
//
//   collectUserData(userId)  -> the "right to know" / portability payload
//   eraseUserData(userId)    -> the "right to delete" purge that runs BEFORE
//                               admin.auth.admin.deleteUser()
//
// Why the service role and not the caller's session: RLS is a *permission*
// gate, and a missing SELECT policy would silently make an export incomplete
// (and a purge partial). For a legal-rights surface, under-reporting is the
// dangerous failure, so we read with the service role and scope every query
// by hand to ids we have already proven belong to this user. Nothing here is
// ever called with a user id that didn't come from supabase.auth.getUser().
//
// Cal. Civ. Code 1798.100 (right to know), 1798.105 (right to delete),
// 1798.106 (correct), 1798.110/115 (categories + sources), 1798.130(a)(2)
// (portable, readily useable format).
// =============================================================================

// Buckets and their per-user prefixes. FK cascades delete database rows but
// NEVER touch Storage, so a purge that only deletes rows leaves the actual
// photos, documents, licence scans and insurance certificates sitting in the
// bucket forever. These are handled explicitly in eraseUserData().
const HOME_PHOTOS = "home-photos";
const PRO_LOGOS = "pro-logos";
const PRO_DOCS = "pro-docs";

type Json = Record<string, unknown>;

// -----------------------------------------------------------------------------
// Storage helpers
// -----------------------------------------------------------------------------

// Supabase Storage's list() is one level deep and returns folders as rows with
// a null id, so walking a prefix means recursing. Returns full object paths.
async function listAllObjects(
  admin: ReturnType<typeof createAdminClient>,
  bucket: string,
  prefix: string
): Promise<string[]> {
  const out: string[] = [];
  const limit = 1000;
  let offset = 0;

  // list() pages at `limit`. A folder with more objects than that would
  // otherwise silently lose everything past the first page, and a purge
  // that only sees page one deletes only page one. Keep paging until a
  // page comes back short.
  for (;;) {
    const { data, error } = await admin.storage
      .from(bucket)
      .list(prefix, { limit, offset });
    if (error || !data) break;

    for (const entry of data) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.id === null) {
        // A folder. Recurse.
        out.push(...(await listAllObjects(admin, bucket, path)));
      } else {
        out.push(path);
      }
    }

    if (data.length < limit) break;
    offset += limit;
  }
  return out;
}

async function removePrefix(
  admin: ReturnType<typeof createAdminClient>,
  bucket: string,
  prefix: string
): Promise<{ removed: number; ok: boolean }> {
  const paths = await listAllObjects(admin, bucket, prefix);
  if (paths.length === 0) return { removed: 0, ok: true };
  // remove() caps at 1000 keys per call. A failed batch means those objects
  // survive the purge, so surface it rather than swallowing the error.
  let ok = true;
  for (let i = 0; i < paths.length; i += 1000) {
    const { error } = await admin.storage
      .from(bucket)
      .remove(paths.slice(i, i + 1000));
    if (error) ok = false;
  }
  return { removed: paths.length, ok };
}

// -----------------------------------------------------------------------------
// Shared scoping: which property / lead / contractor ids belong to this user?
// -----------------------------------------------------------------------------

type Scope = {
  propertyIds: string[];
  // Leads on this user's properties (homeowner side) plus leads assigned to
  // their contractor listing (pro side).
  leadIds: string[];
  contractorId: string | null;
};

async function resolveScope(
  admin: ReturnType<typeof createAdminClient>,
  userId: string
): Promise<Scope> {
  const { data: properties } = await admin
    .from("properties")
    .select("id")
    .eq("user_id", userId);
  const propertyIds = (properties ?? []).map((p) => p.id);

  const { data: contractor } = await admin
    .from("contractors")
    .select("id")
    .eq("user_id", userId)
    .maybeSingle();
  const contractorId = contractor?.id ?? null;

  const leadIds = new Set<string>();
  if (propertyIds.length) {
    const { data } = await admin
      .from("contractor_leads")
      .select("id")
      .in("property_id", propertyIds);
    for (const l of data ?? []) leadIds.add(l.id);
  }
  if (contractorId) {
    const { data } = await admin
      .from("contractor_leads")
      .select("id")
      .eq("contractor_id", contractorId);
    for (const l of data ?? []) leadIds.add(l.id);
  }

  return { propertyIds, leadIds: [...leadIds], contractorId };
}

// Small helper so an export never dies on one bad table: a table that errors
// or doesn't exist yields [] rather than failing the whole download. A real
// error (missing table/column, RLS surprise, etc.) is still logged - the
// previous version discarded `error` entirely, so a section could silently
// come back empty with no trace of why, which is the wrong failure mode for
// a legal-rights export (under-reporting, not just an ugly page).
async function rows(
  q: PromiseLike<{ data: unknown[] | null; error: unknown }>
): Promise<unknown[]> {
  const { data, error } = await q;
  if (error && data == null) {
    console.error("[privacy] section query failed, returning empty section", error);
  }
  return data ?? [];
}

// learning_requests, ai_usage and pro_projects are real tables (migrations
// 0014, 0024, 0045) that were never added to the hand-maintained
// database.types.ts, so the typed client rejects them by name. Same `as any`
// escape hatch the rest of the codebase already uses for these (see
// src/lib/aiUsage.ts), named so it's obvious this is a types gap and not a
// place where type safety was thrown away casually.
function untyped(admin: ReturnType<typeof createAdminClient>): any {
  return admin as any;
}

// -----------------------------------------------------------------------------
// Audit log - CCPA/CPRA gives requesters a right to a timely response (45 days,
// Cal. Civ. Code 1798.130(a)(2)), so a delete or export that only leaves a
// console.error behind is not durable evidence of when a request was actually
// fulfilled. privacy_actions (migration 0076) is written by the service role
// only and deliberately carries no FK to auth.users, so a delete's log row
// outlives the very deleteUser() call it records.
//
// Best-effort by design: a logging failure must never block or throw out of
// the deletion/export it is trying to record, so every failure mode here is
// swallowed after a console.error.
async function logPrivacyAction(
  admin: ReturnType<typeof createAdminClient>,
  userId: string,
  action: "delete" | "export",
  summary: Json
): Promise<void> {
  try {
    const { error } = await untyped(admin)
      .from("privacy_actions")
      .insert({ user_id: userId, action, summary });
    if (error) {
      console.error(`[privacy] failed to log ${action} action`, error);
    }
  } catch (err) {
    console.error(`[privacy] failed to log ${action} action`, err);
  }
}

// -----------------------------------------------------------------------------
// Right to know / portability
// -----------------------------------------------------------------------------

export type ExportPayload = Json;

// Everything OakTend holds that is keyed to this person, as plain JSON.
// JSON is a "structured, commonly used, machine-readable" format, which is
// what 1798.130(a)(2) asks for.
export async function collectUserData(userId: string): Promise<ExportPayload> {
  const admin = createAdminClient();
  const { propertyIds, leadIds, contractorId } = await resolveScope(
    admin,
    userId
  );

  const { data: authUser } = await admin.auth.admin.getUserById(userId);

  const [
    profile,
    properties,
    homeSystems,
    maintenanceTasks,
    issues,
    improvements,
    photos,
    documents,
    intentSignals,
    householdMembers,
    leads,
    messages,
    messageReactions,
    reviews,
    reports,
    notifications,
    supportMessages,
    learningRequests,
    aiUsage,
    subscriptions,
    termsAcceptances,
    pushSubscriptions,
  ] = await Promise.all([
    rows(admin.from("users").select("*").eq("id", userId)),
    propertyIds.length
      ? rows(admin.from("properties").select("*").in("id", propertyIds))
      : [],
    propertyIds.length
      ? rows(admin.from("home_systems").select("*").in("property_id", propertyIds))
      : [],
    propertyIds.length
      ? rows(
          admin.from("maintenance_tasks").select("*").in("property_id", propertyIds)
        )
      : [],
    propertyIds.length
      ? rows(admin.from("issues").select("*").in("property_id", propertyIds))
      : [],
    propertyIds.length
      ? rows(admin.from("improvements").select("*").in("property_id", propertyIds))
      : [],
    propertyIds.length
      ? rows(admin.from("photos").select("*").in("property_id", propertyIds))
      : [],
    propertyIds.length
      ? rows(admin.from("documents").select("*").in("property_id", propertyIds))
      : [],
    propertyIds.length
      ? rows(admin.from("intent_signals").select("*").in("property_id", propertyIds))
      : [],
    propertyIds.length
      ? rows(
          admin.from("household_members").select("*").in("property_id", propertyIds)
        )
      : [],
    leadIds.length
      ? rows(admin.from("contractor_leads").select("*").in("id", leadIds))
      : [],
    // Only the messages this person actually wrote. The other party's messages
    // are their personal information, not this user's, so they stay out of the
    // export even though they sit in the same thread.
    rows(admin.from("messages").select("*").eq("sender_id", userId)),
    rows(admin.from("message_reactions").select("*").eq("user_id", userId)),
    leadIds.length
      ? rows(admin.from("reviews").select("*").in("lead_id", leadIds))
      : [],
    rows(admin.from("reports").select("*").eq("reporter_id", userId)),
    rows(admin.from("notifications").select("*").eq("user_id", userId)),
    rows(admin.from("support_messages").select("*").eq("user_id", userId)),
    rows(untyped(admin).from("learning_requests").select("*").eq("user_id", userId)),
    rows(untyped(admin).from("ai_usage").select("*").eq("user_id", userId)),
    rows(admin.from("subscriptions").select("*").eq("user_id", userId)),
    // terms_acceptances (0075): the signup/consent checkbox ledger. push_
    // subscriptions (0143): the device endpoints notifications go to. Both
    // are personal information the privacy policy lists as collected, and
    // both were missing from this export until now.
    rows(admin.from("terms_acceptances").select("*").eq("user_id", userId)),
    rows(admin.from("push_subscriptions").select("*").eq("user_id", userId)),
  ]);

  // Pro-side records, only fetched when this account actually has a listing.
  let pro: Json | null = null;
  if (contractorId) {
    // A handful of child tables are keyed off ids that only exist once their
    // parent row is fetched (wallet -> wallet_transactions/bonus_grants,
    // pro_clients -> pro_client_notes, pro_projects -> pro_project_photos,
    // contractor_leads -> lead_reads), so those parents are fetched first,
    // same pattern the wallet lookup already used, rather than a
    // contractor_id filter that doesn't exist on the child table.
    const walletsRows = (await rows(
      admin.from("wallets").select("*").eq("contractor_id", contractorId)
    )) as { id: string }[];
    const walletIds = walletsRows.map((w) => w.id);

    const proClientsRows = (await rows(
      admin.from("pro_clients").select("*").eq("contractor_id", contractorId)
    )) as { id: string }[];
    const clientIds = proClientsRows.map((c) => c.id);

    const proProjectsRows = (await rows(
      untyped(admin).from("pro_projects").select("*").eq("contractor_id", contractorId)
    )) as { id: string }[];
    const projectIds = proProjectsRows.map((p) => p.id);

    // Leads assigned to this contractor specifically. Not the same as the
    // Scope's combined leadIds, which also folds in leads on properties this
    // account owns as a homeowner - using that here would leak another
    // contractor's read receipt on this user's own posted job.
    const { data: proLeadsData } = await admin
      .from("contractor_leads")
      .select("id")
      .eq("contractor_id", contractorId);
    const proLeadIds = (proLeadsData ?? []).map((l) => l.id);

    const [
      contractor,
      walletTransactions,
      bonusGrants,
      invoices,
      proPastJobs,
      leadApplications,
      leadQuotes,
      proClientNotes,
      proProjectPhotos,
      proToolEdits,
      leadReads,
    ] = await Promise.all([
      rows(admin.from("contractors").select("*").eq("id", contractorId)),
      walletIds.length
        ? rows(
            admin.from("wallet_transactions").select("*").in("wallet_id", walletIds)
          )
        : [],
      walletIds.length
        ? rows(admin.from("bonus_grants").select("*").in("wallet_id", walletIds))
        : [],
      rows(admin.from("invoices").select("*").eq("contractor_id", contractorId)),
      rows(admin.from("pro_past_jobs").select("*").eq("contractor_id", contractorId)),
      rows(
        admin.from("lead_applications").select("*").eq("contractor_id", contractorId)
      ),
      rows(admin.from("lead_quotes").select("*").eq("contractor_id", contractorId)),
      clientIds.length
        ? rows(admin.from("pro_client_notes").select("*").in("client_id", clientIds))
        : [],
      projectIds.length
        ? rows(
            untyped(admin)
              .from("pro_project_photos")
              .select("*")
              .in("project_id", projectIds)
          )
        : [],
      rows(admin.from("pro_tool_edits").select("*").eq("contractor_id", contractorId)),
      proLeadIds.length
        ? rows(
            admin
              .from("lead_reads")
              .select("*")
              .in("lead_id", proLeadIds)
              .eq("role", "contractor")
          )
        : [],
    ]);
    const wallets = walletsRows;
    const proClients = proClientsRows;
    const proProjects = proProjectsRows;
    pro = {
      contractor_listing: contractor,
      wallets,
      wallet_transactions: walletTransactions,
      bonus_grants: bonusGrants,
      invoices,
      crm_clients: proClients,
      crm_client_notes: proClientNotes,
      portfolio_projects: proProjects,
      portfolio_project_photos: proProjectPhotos,
      past_jobs: proPastJobs,
      lead_applications: leadApplications,
      quotes: leadQuotes,
      tool_edits: proToolEdits,
      lead_read_receipts: leadReads,
    };
  }

  const payload: ExportPayload = {
    export_metadata: {
      generated_at: new Date().toISOString(),
      format: "JSON",
      about:
        "Everything OakTend holds that is linked to your account. Photos and " +
        "documents are listed by their storage path and filename; the files " +
        "themselves are downloadable from inside the app.",
      // 1798.110(c): the categories, the sources, the business purpose, and
      // the third parties. Kept in the file itself so the export is
      // self-describing rather than pointing at a page that may have moved.
      categories_of_personal_information_collected: CATEGORIES.map((c) => ({
        category: c.category,
        examples: c.examples,
        sensitive: c.sensitive,
        source: c.source,
        purpose: c.purpose,
      })),
      third_parties_disclosed_to: THIRD_PARTIES,
      sold_or_shared_for_cross_context_behavioral_advertising: false,
    },
    account: {
      auth: authUser?.user
        ? {
            id: authUser.user.id,
            email: authUser.user.email,
            created_at: authUser.user.created_at,
            last_sign_in_at: authUser.user.last_sign_in_at,
            user_metadata: authUser.user.user_metadata,
          }
        : null,
      profile,
    },
    home: {
      properties,
      systems: homeSystems,
      maintenance_tasks: maintenanceTasks,
      issues,
      improvements,
      photos,
      documents,
      intent_signals: intentSignals,
      household_members: householdMembers,
    },
    marketplace: {
      jobs: leads,
      messages_you_sent: messages,
      message_reactions: messageReactions,
      reviews,
      reports_you_filed: reports,
    },
    account_activity: {
      notifications,
      support_messages: supportMessages,
      learning_requests: learningRequests,
      ai_usage: aiUsage,
      subscriptions,
      terms_acceptances: termsAcceptances,
      push_subscriptions: pushSubscriptions,
    },
    pro,
  };

  // Log a category-key summary only - never the payload itself, which would
  // duplicate the export's personal information into the audit trail.
  await logPrivacyAction(admin, userId, "export", {
    categories_exported: Object.keys(payload).filter((k) => k !== "export_metadata"),
    included_pro_data: pro !== null,
  });

  return payload;
}

// -----------------------------------------------------------------------------
// Right to delete
// -----------------------------------------------------------------------------

export type EraseSummary = {
  storageObjectsRemoved: number;
  tablesPurged: string[];
  // Things we deliberately did not touch, and why. Surfaced so the deletion
  // path can never quietly claim more than it did.
  retained: string[];
  // Things we did not delete outright, but stripped of identifying fields
  // and left in place, and why. Separate from `retained` on purpose: a pro's
  // CRM copy of a departed homeowner is not "kept as-is", it is de-identified,
  // and those are different promises to make in a privacy disclosure.
  deidentified: string[];
  // How many pro_clients rows had name/phone/email/address scrubbed. Kept as
  // its own field (not just parsed out of `deidentified`'s prose) so the
  // privacy_actions log entry records a real number, not a sentence.
  proClientsDeidentifiedCount: number;
  // Labels for deletes/removals that ERRORED. A non-empty list means the purge
  // was partial: the caller must log it rather than report a clean deletion.
  failed: string[];
  // Set when the contractors-row delete specifically failed. That FK is
  // ON DELETE SET NULL (0005), so a failed delete would orphan the whole
  // company record permanently - the PRO delete path must abort on this
  // instead of proceeding to delete the auth user.
  contractorDeleteFailed: boolean;
};

// The label a pro sees in place of a departed homeowner's real name. Exported
// so the CRM detail views can recognize a de-identified row if they ever need
// to (e.g. to hide the "message this client" action), without hard-coding the
// string in more than one place.
export const DEIDENTIFIED_CLIENT_NAME = "Deleted homeowner";

// Which pro_clients rows are about the homeowner being deleted? There are two
// ways a row can be theirs:
//
//   1. lead_id points at a job posted on a property this homeowner owned.
//      This is the reliable link: contractor_leads.property_id ->
//      properties.user_id is the actual account relationship, independent of
//      whatever the pro typed into client_name/email for that row.
//
//   2. No lead_id (the pro typed the client in by hand, see addClientAction
//      in src/app/pro/crm/actions.ts), so the only signal available is
//      whether what the pro typed for email matches this homeowner's own
//      account email, normalized.
//
// SECURITY: this used to also match on users.phone, and on users.email
// straight off the public.users row. Both are attacker-controlled: phone is
// never verified and is freely editable from /account, and email on the
// public.users row is a cache of the auth email that (depending on how it
// got there) is not guaranteed to be re-verified on every change. Matching
// on either meant anyone could type a victim's phone number or claimed email
// into their OWN account, delete that account, and have every pro_clients
// row bearing that value scrubbed platform-wide - including rows that never
// had anything to do with the attacker. So:
//
//   - Phone matching is gone entirely. There is no verified phone to match
//     against, and this purge would rather under-scrub a phone-only row than
//     let anyone wipe an arbitrary number out of a stranger's CRM.
//   - Email matching now reads the ACCOUNT'S VERIFIED IDENTITY -
//     admin.auth.admin.getUserById(userId).data.user.email - never
//     public.users.email. If that lookup fails or has no email, the email
//     branch is skipped rather than falling back to the unverified column.
//   - Email matching is also scoped to contractors who actually received a
//     lead from this homeowner (resolved from ownLeadIds via
//     contractor_leads.contractor_id), not the whole pro_clients table. A
//     matching email at a contractor this homeowner never dealt with is not
//     this homeowner's relationship to redact - it is either a stranger's
//     coincidence or someone else's forged input, and scrubbing it would be
//     de-identifying the wrong person's CRM entry.
//
// `ownLeadIds` is the caller's already-resolved list of contractor_leads ids
// on this homeowner's own properties (eraseUserData fetches this once for the
// chat-attachment purge and passes it in here, rather than this function
// re-querying it).
export async function findProClientIdsToScrub(
  admin: ReturnType<typeof createAdminClient>,
  userId: string,
  ownLeadIds: string[]
): Promise<string[]> {
  const ids = new Set<string>();

  if (ownLeadIds.length) {
    const { data: byLead } = await admin
      .from("pro_clients")
      .select("id")
      .in("lead_id", ownLeadIds);
    for (const row of byLead ?? []) ids.add(row.id as string);
  }

  // The verified identity, not the editable users.email column. A failed
  // lookup or a userless auth record skips the email branch entirely rather
  // than matching on nothing (which .eq("email", null) would not do anyway,
  // but skip explicitly so the intent is not left to normalizeEmail's
  // behavior on null/undefined).
  const { data: authUser, error: authError } = await admin.auth.admin.getUserById(
    userId
  );
  const authEmailNorm = authError
    ? null
    : normalizeEmail(authUser?.user?.email ?? null)?.normalized ?? null;

  if (authEmailNorm && ownLeadIds.length) {
    // Which contractors actually received one of this homeowner's leads?
    // Only their pro_clients rows are in scope for the email match - see the
    // SECURITY note above.
    const { data: leadRows } = await admin
      .from("contractor_leads")
      .select("contractor_id")
      .in("id", ownLeadIds);
    const contractorIds = [
      ...new Set(
        (leadRows ?? [])
          .map((r) => r.contractor_id as string | null)
          .filter((id): id is string => Boolean(id))
      ),
    ];

    if (contractorIds.length) {
      // pro_clients has no normalized email column to filter this in SQL, so
      // this pulls every candidate row (already scoped to the relevant
      // contractors) and compares normalized emails in JS. Same trade-off
      // the rest of this file makes (see the header comment): a legal-rights
      // purge favors completeness over a cheap query.
      const { data: candidates } = await admin
        .from("pro_clients")
        .select("id, email")
        .in("contractor_id", contractorIds)
        .not("email", "is", null);
      for (const row of candidates ?? []) {
        const rowEmailNorm = normalizeEmail(row.email ?? null)?.normalized ?? null;
        if (rowEmailNorm && rowEmailNorm === authEmailNorm) ids.add(row.id as string);
      }
    }
  }

  return [...ids];
}

// Strip the identifying fields off a batch of pro_clients rows, leaving the
// pro's own stage/note/lead_id/est_value_cents untouched. This is an update,
// not a delete: the row (and the pro's notes timeline hanging off it in
// pro_client_notes) is the pro's own CRM record of a deal, which they are
// entitled to keep. Only the departed homeowner's identifying details go.
export async function scrubProClientContactInfo(
  admin: ReturnType<typeof createAdminClient>,
  ids: string[]
): Promise<{ error: unknown }> {
  if (!ids.length) return { error: null };
  const { error } = await admin
    .from("pro_clients")
    .update({
      client_name: DEIDENTIFIED_CLIENT_NAME,
      email: null,
      phone: null,
      address: null,
      updated_at: new Date().toISOString(),
    })
    .in("id", ids);
  return { error };
}

// Purge everything that admin.auth.admin.deleteUser() would NOT remove, then
// let the caller delete the auth user (which cascades the rest).
//
// Two categories of leftovers this fixes:
//
//  1. Rows whose FK is ON DELETE SET NULL, not CASCADE. Deleting the auth user
//     leaves these rows in place with a null user id - and several of them
//     hold personal information in the row itself, so nulling the id does not
//     de-identify them. support_messages keeps name/email/phone/message
//     verbatim (0024_support_messages.sql), learning_requests keeps the typed
//     question, messages keep their body, reports keep their reason.
//  2. Storage objects. No FK and no trigger reaches these, so every photo,
//     uploaded document, logo, licence scan and insurance certificate would
//     otherwise survive the account indefinitely.
export async function eraseUserData(userId: string): Promise<EraseSummary> {
  const admin = createAdminClient();
  const { propertyIds, leadIds, contractorId } = await resolveScope(
    admin,
    userId
  );

  let storageObjectsRemoved = 0;
  const tablesPurged: string[] = [];
  const retained: string[] = [];
  const deidentified: string[] = [];
  let proClientsDeidentifiedCount = 0;
  const failed: string[] = [];
  let contractorDeleteFailed = false;

  // Run one storage prefix removal, tallying the count on success and pushing a
  // label to `failed` when a batch errored (those objects survived the purge).
  const purgeStorage = async (bucket: string, prefix: string) => {
    const { removed, ok } = await removePrefix(admin, bucket, prefix);
    storageObjectsRemoved += removed;
    if (!ok) failed.push(`storage: ${bucket}/${prefix}`);
  };

  // Run one row delete, recording success vs. failure so a swallowed error can
  // never let deleted-looking data quietly survive.
  const purgeTable = async (
    label: string,
    q: PromiseLike<{ error: unknown }>
  ) => {
    const { error } = await q;
    if (error) failed.push(label);
    else tablesPurged.push(label);
  };

  // --- Storage: home photos, chat attachments, uploaded documents ----------
  for (const propertyId of propertyIds) {
    await purgeStorage(HOME_PHOTOS, propertyId);
  }
  // Chat attachments live at chat/<lead_id>/. When the homeowner leaves, the
  // lead cascades away with the property and these files become unreachable,
  // so they go too. A pro's leads survive (contractor_id is set null), which
  // is why this is scoped to leads on properties the user owns, not all leads
  // they were party to.
  const ownLeadIds: string[] = [];
  if (propertyIds.length) {
    const { data: ownLeads } = await admin
      .from("contractor_leads")
      .select("id")
      .in("property_id", propertyIds);
    for (const lead of ownLeads ?? []) {
      ownLeadIds.push(lead.id as string);
      await purgeStorage(HOME_PHOTOS, `chat/${lead.id}`);
    }
  }
  if (contractorId) {
    await purgeStorage(PRO_LOGOS, contractorId);
    await purgeStorage(PRO_DOCS, contractorId);

    // Chat attachments this pro uploaded live at chat/<lead_id>/... under the
    // HOMEOWNER's property, not under contractorId, so purgeStorage above
    // never reaches them. Unlike the homeowner path (whose own leads are
    // purged by property id a few lines up), a departing pro's leads are
    // NOT purged here: contractor_leads.contractor_id is ON DELETE SET NULL,
    // so the thread and its photos stay on the homeowner's account after
    // this pro leaves, and deleting them would delete the homeowner's copy
    // of the conversation too.
    const { data: assignedLeads } = await admin
      .from("contractor_leads")
      .select("id")
      .eq("contractor_id", contractorId);
    if (assignedLeads && assignedLeads.length) {
      retained.push(
        "Chat attachments you uploaded in job threads (home-photos/chat/<lead_id>/...) are not deleted: those threads live on the homeowner's account, not yours."
      );
    }
  }

  // --- Rows that would survive with a nulled user id ----------------------
  // Ordered child-before-parent where it matters. Best-effort: a failed delete
  // is recorded in `failed` and we keep going, rather than aborting mid-purge -
  // EXCEPT the contractors row below, whose failure the caller must act on.
  await purgeTable(
    "message_reactions",
    admin.from("message_reactions").delete().eq("user_id", userId)
  );
  await purgeTable(
    "messages",
    admin.from("messages").delete().eq("sender_id", userId)
  );
  await purgeTable(
    "reports",
    admin.from("reports").delete().eq("reporter_id", userId)
  );
  await purgeTable(
    "support_messages",
    admin.from("support_messages").delete().eq("user_id", userId)
  );
  await purgeTable(
    "learning_requests",
    untyped(admin).from("learning_requests").delete().eq("user_id", userId)
  );

  // The contractor listing's FK to auth.users is ON DELETE SET NULL, so
  // without this the whole company record - name, contact email and phone,
  // licence number, background-check status - would outlive the account as an
  // orphan. Deleting it cascades wallets, invoices, CRM clients, portfolio
  // projects, quotes and applications. Unlike the rows above, a failure here
  // MUST stop the account deletion: a nulled-out contractor row is a permanent
  // orphan, so `contractorDeleteFailed` is surfaced for the caller to abort on.
  if (contractorId) {
    const { error } = await admin
      .from("contractors")
      .delete()
      .eq("id", contractorId);
    if (error) {
      failed.push("contractors (and its cascade)");
      contractorDeleteFailed = true;
    } else {
      tablesPurged.push("contractors (and its cascade)");
    }
  }

  // --- Honest accounting of what stays ------------------------------------
  if (contractorId && leadIds.length) {
    // contractor_leads.contractor_id is ON DELETE SET NULL, so a departing
    // pro's jobs detach but the homeowner's own snapshot on them (name,
    // email, phone, address) stays - and that data belongs to the homeowner,
    // not to the pro who is leaving. Removing it would delete someone else's
    // personal information.
    retained.push(
      "Jobs you quoted on stay in the homeowner's account. They hold the homeowner's information, not yours."
    );
  }
  retained.push(
    "Records we must keep by law, including invoices and payment records kept for tax and accounting purposes."
  );

  // --- De-identify a pro's CRM copy of this homeowner ---------------------
  // A pro's client tracker (pro_clients) is the pro's own record of a deal,
  // and its notes and job history are theirs to keep - but the homeowner's
  // name, phone, email, and address inside it are this person's personal
  // information, and stay linked to it after this account is gone unless we
  // scrub them here. This runs immediately (not on a 30-day timer): "within
  // 30 days" in the privacy policy is the outer bound the law requires, not
  // a promise to wait.
  //
  // Dual-side accounts (this same person also runs a contractor listing) need
  // no special case: any pro_clients row under THEIR OWN contractor_id that
  // happens to match gets deleted a few lines up anyway, when the contractors
  // row cascades - so by the time this scrub would touch it, it's already
  // gone. This only ever reaches other pros' CRM copies of this homeowner.
  const proClientIdsToScrub = await findProClientIdsToScrub(
    admin,
    userId,
    ownLeadIds
  );
  if (proClientIdsToScrub.length) {
    const { error } = await scrubProClientContactInfo(admin, proClientIdsToScrub);
    if (error) {
      failed.push("pro_clients (contact info scrub)");
    } else {
      proClientsDeidentifiedCount = proClientIdsToScrub.length;
      deidentified.push(
        `${proClientIdsToScrub.length} pro CRM record(s) that referenced you had your name, phone, email, and address removed. The pro's own notes and job history were kept.`
      );
    }
  }

  const summary: EraseSummary = {
    storageObjectsRemoved,
    tablesPurged,
    retained,
    deidentified,
    proClientsDeidentifiedCount,
    failed,
    contractorDeleteFailed,
  };

  // Written while the user still exists, but by design (see migration 0076)
  // this row has no FK to auth.users, so it survives the deleteUser() call
  // the caller makes right after this returns.
  await logPrivacyAction(admin, userId, "delete", summary as unknown as Json);

  return summary;
}

// -----------------------------------------------------------------------------
// Disclosure tables - the single source of truth for what we collect, why, and
// who receives it. Rendered on /account/privacy and embedded in every export
// so the two can never drift apart.
// -----------------------------------------------------------------------------

export type Category = {
  category: string;
  examples: string;
  // True where this falls in the CPRA's "sensitive personal information"
  // bucket (Cal. Civ. Code 1798.140(ae)).
  sensitive: boolean;
  source: string;
  purpose: string;
};

export const CATEGORIES: Category[] = [
  {
    category: "Identifiers",
    examples: "Name, email address, phone number, account ID.",
    sensitive: false,
    source: "You, when you create an account or edit your profile.",
    purpose: "Signing you in, contacting you, and connecting you with pros.",
  },
  {
    category: "Account credentials",
    examples: "Your password (stored only as a salted hash, never in plain text).",
    sensitive: true,
    source: "You, at sign-up.",
    purpose: "Authenticating you. Nothing else.",
  },
  {
    category: "Property and household records",
    examples:
      "Street address, year built, square footage, systems and appliances, maintenance history, repair issues, improvements, and household members you invite.",
    sensitive: false,
    source:
      "You, plus public parcel and assessor data we look up from the address you give us.",
    purpose:
      "Building your home profile, generating your maintenance plan, and scoping jobs for pros.",
  },
  {
    category: "Precise geolocation",
    examples:
      "The latitude and longitude of the home you add, derived from its street address.",
    sensitive: true,
    source: "Derived from the address you enter, via our property-data provider.",
    purpose:
      "Matching you with pros who serve your area and localising home alerts. We do not track your device's location, and we do not use this for advertising or profiling.",
  },
  {
    category: "Financial information",
    examples:
      "Purchase price, mortgage balance, assessed value, insurance premium and renewal date, job budgets, invoices, and contractor wallet balances.",
    sensitive: true,
    source: "You, plus public assessor records.",
    purpose:
      "Home-value and tax-appeal tools, insurance check-ups, and billing. Card numbers never reach OakTend: payments run through Stripe's hosted checkout.",
  },
  {
    category: "Message contents",
    examples:
      "Messages you exchange with pros, support requests, questions you ask the assistant, and photos or documents you upload.",
    sensitive: true,
    source: "You.",
    purpose:
      "Delivering your messages, answering your questions, and reading the documents you ask us to read.",
  },
  {
    category: "Professional and licensing information",
    examples:
      "For contractors: company name, About-section text, service area, contractor licence number, licence and insurance documents, and background-check status.",
    sensitive: false,
    source:
      "You, plus the California State License Board and our background-check provider.",
    purpose:
      "Verifying that pros on OakTend are licensed and insured, and, for company name and About text, checking for slurs, profanity, and off-platform contact details before a public profile goes live. Public profiles exist only for pros who serve Orange County.",
  },
  {
    category: "Commercial activity",
    examples:
      "Jobs you post, quotes, reviews you write, subscription status, and payment records.",
    sensitive: false,
    source: "You, and your use of OakTend.",
    purpose: "Running the marketplace and your subscription.",
  },
  {
    category: "Abuse-prevention identifiers",
    examples:
      "Scrambled (one-way hashed) versions of your IP address, a first-party device cookie, a coarse browser fingerprint, your payment method's Stripe reference, your email address with dots and +tags removed, and (when you provide them) your phone number, your company name, and your home's county parcel number. The original values are never stored, and the scrambled ones cannot be turned back into them.",
    sensitive: false,
    source: "Your browser and Stripe when you sign up or start a membership, and the details you enter when you claim a home or set up a business.",
    purpose:
      "One thing only: stopping the same person from claiming the free trial over and over with new accounts, by linking accounts that share a value. Never used for advertising, never profiled, never shared, and never used to follow you to another company's site. Kept only as long as your account exists and deleted with it. A chargeback flags the account. A manual review may flag an account and remove its free-trial eligibility. Both are logged. Automated risk scoring may also affect trial eligibility once we turn it on.",
  },
];

export type ThirdParty = {
  name: string;
  role: string;
  receives: string;
};

// Service providers and contractors under Cal. Civ. Code 1798.140(ag)/(j) -
// each is contractually limited to processing on OakTend's behalf. None of
// these is a sale or a share for cross-context behavioural advertising.
export const THIRD_PARTIES: ThirdParty[] = [
  {
    name: "Supabase",
    role: "Database, authentication, and file storage",
    receives: "Everything in your account. This is where OakTend's data lives.",
  },
  {
    name: "Stripe",
    role: "Payments",
    receives:
      "Your email address and subscription or payment details. Card numbers go to Stripe directly and never touch OakTend's servers.",
  },
  {
    // OakTend's ONE AI vendor. Every AI feature runs on Anthropic's Claude
    // through Anthropic's paid API - see /ai-disclosure, which this entry has
    // to agree with word for word on what actually leaves the app. Audio is
    // deliberately absent: voice input is on-device browser speech
    // recognition, so no recording is ever made or sent anywhere.
    name: "Anthropic (Claude)",
    role: "AI assistant, document reading, and photo analysis",
    receives:
      "The question you ask, plus context from your home profile (first name, address, systems, open tasks, recent issues), and any photo or document you submit to an AI feature. No audio: dictation runs on your own device and no recording is sent. Also your purchase price, assessed value, and OakTend's own home-value estimate when you generate a Property Tax Appeal Kit; your insurance premium and renewal date when you generate an Insurance Requote Packet; and the full contents of a contractor's quote when you use the quote analyzer. For contractors: their wallet balance (cash and bonus), license number and verification status, and background-check status when they use Ask OakTend for Pros; their own past-job dollar totals (labor and materials) when they use the estimate or invoice tools; and the full image of an uploaded past invoice, quote, or receipt when they add it to their pricing history.",
  },
  {
    name: "RentCast",
    role: "Property data and valuation",
    receives:
      "Your home's street address and ZIP code. When RentCast has an automated valuation for your address, OakTend uses it as the headline home-value estimate; otherwise OakTend calculates a ballpark from your purchase price and typical price trends for your state.",
  },
  {
    name: "Photon (OpenStreetMap)",
    role: "Address suggestions while you type",
    receives:
      "The partial street address you're typing, plus the city (once your ZIP resolves to one) and the word \"California\", appended to help Photon find the right match. No name, account, or other personal information is sent with it.",
  },
  {
    name: "California State License Board (CSLB)",
    role: "Contractor licence verification",
    receives: "A contractor's licence number only.",
  },
  {
    name: "Checkr",
    role: "Contractor background checks",
    receives:
      "A contractor's name and email address. OakTend never collects or transmits your Social Security number or date of birth; you provide those to Checkr directly.",
  },
  {
    name: "Open-Meteo",
    role: "Weather alerts",
    receives:
      "Your home's city name. Not your street address and not your stored coordinates.",
  },
  {
    name: "CPSC SaferProducts",
    role: "Appliance recall alerts",
    receives: "Appliance brand names. No information that identifies you.",
  },
  {
    name: "Resend",
    role: "Email delivery",
    receives: "Your email address and the contents of the email we send you.",
  },
  {
    name: "Twilio",
    role: "Text-message delivery",
    receives:
      "Your phone number and the contents of the text we send you. 10-digit US numbers only, and every text includes a reply-STOP opt-out.",
  },
];
