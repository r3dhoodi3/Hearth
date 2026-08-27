import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ============================================================================
// These started life as failing tests: the failure WAS the finding. Migration
// 0131 (2026-08-26) closed both holes and they now pass. They stay as the
// regression guards: if either goes red again, a later migration has dropped
// or weakened a database-side guard described below. Do not delete them.
//
// BACKGROUND
// ----------
// An IDOR sweep added app-layer guards to the three server actions that write
// a client-chosen storage key or row id:
//   src/app/(app)/contractors/actions.ts  validPhotoUrls / issue_id
//   src/app/(app)/issues/actions.ts       system_id
//   src/app/(app)/profile/actions.ts      photo_urls / system id
// src/lib/ownershipChecks.test.ts asserts those guards are present.
//
// Those guards are real, but they only cover the Next.js server actions.
// Supabase exposes the same tables over PostgREST with the public anon key and
// the caller's own session JWT, so an attacker never has to go through a
// server action at all. Two writes reach the database with NO check on either
// side once the server action is skipped:
//
//   A) photos.url is unbound.
//      Policy: "photos owner all" (0002_rls_policies.sql:67-69)
//        for all using (owns_property(property_id))
//               with check (owns_property(property_id))
//      It constrains property_id. It says NOTHING about url. There is no
//      CHECK constraint and no trigger on public.photos (grep "create trigger"
//      across supabase/migrations: nothing on photos).
//
//      So this succeeds today, authenticated as an ordinary homeowner:
//        POST /rest/v1/photos
//        { "property_id": "<a property I own>",
//          "related_type": "issue",
//          "related_id":   "<an issue on that same property>",
//          "url":          "<ANOTHER homeowner's object key>" }
//
//      Why that matters: migration 0104's can_view_job_photo_full() binds a
//      signed URL to a lead purely by matching photos.url and photos.related_id
//      against contractor_leads.issue_id, and then checks only that the caller
//      owns the LEAD's property. Both halves are satisfied by the attacker's
//      own rows. /api/job-photo?...&full=1 then signs that object with the
//      ADMIN client (src/app/api/job-photo/route.ts:66-75), which is not
//      subject to storage RLS. Result: full-resolution download of another
//      property's private photo.
//
//      The object keys to put in `url` are not a secret: open_jobs_for_me()
//      returns raw photo_urls to every board-eligible pro (0104), and
//      src/app/pro/page.tsx hands them to <JobPhotoStrip urls={...}>, a client
//      component, so they sit in the RSC payload of the pro job board.
//
//   B) contractor_leads.issue_id is unchecked on INSERT.
//      enforce_contractor_leads_locked() (latest body:
//      0121_lock_lead_homeowner_fields.sql) pins issue_id on UPDATE:
//        new.issue_id := old.issue_id;                      (0121, UPDATE branch)
//      but its INSERT branch only normalizes contractor_id / paid / paid_at /
//      status / payout_amount. issue_id is written through as sent.
//      "contractor_leads owner all" (0002:75-77) only checks property_id.
//
//      So this succeeds today:
//        POST /rest/v1/contractor_leads
//        { "property_id": "<a property I own>",
//          "category": "plumbing",
//          "issue_id": "<another homeowner's issue id>" }
//
//      which is exactly the forgery the postJobAction fix blocks in the app,
//      re-issued one layer down.
//
// THE FIX (either one closes A; both are cheap):
//   1. A BEFORE INSERT OR UPDATE trigger on public.photos that rejects a url
//      whose first storage path segment is not new.property_id::text - the
//      same rule src/lib/ownedStoragePath.ts already applies in TypeScript.
//   2. Add the INSERT-side issue_id check to enforce_contractor_leads_locked:
//        if new.issue_id is not null and not exists (
//          select 1 from public.issues i
//          where i.id = new.issue_id and i.property_id = new.property_id
//        ) then
//          new.issue_id := null;
//        end if;
// Defence in depth for A: also require the object key's first segment to equal
// cl.property_id inside can_view_job_photo_full / can_preview_job_photo.
// ============================================================================

const MIGRATIONS_DIR = fileURLToPath(
  new URL("../../supabase/migrations", import.meta.url)
);

function allMigrationSql(): string {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => readFileSync(`${MIGRATIONS_DIR}/${f}`, "utf8"))
    .join("\n");
}

// Comments in this repo's migrations describe holes at length, so a naive
// grep would match the prose that explains a bug rather than the DDL that
// fixes it. Strip line comments before asserting on anything.
function sqlWithoutComments(): string {
  return allMigrationSql().replace(/--[^\n]*/g, "");
}

describe("photos.url must be bound to photos.property_id in the database", () => {
  it("has a trigger or constraint on public.photos, not just RLS on property_id", () => {
    const sql = sqlWithoutComments();
    const hasPhotosTrigger =
      /create\s+(?:or\s+replace\s+)?trigger\s+\w+\s+before\s+insert[\s\S]{0,120}?on\s+public\.photos/i.test(
        sql
      );
    const hasPhotosCheck =
      /alter\s+table\s+public\.photos[\s\S]{0,200}?add\s+constraint[\s\S]{0,200}?check/i.test(
        sql
      );
    expect(
      hasPhotosTrigger || hasPhotosCheck,
      "public.photos has no BEFORE INSERT trigger and no CHECK constraint, so " +
        "photos.url is whatever the client sends. RLS only constrains " +
        'property_id ("photos owner all", 0002_rls_policies.sql:67). A raw ' +
        "PostgREST insert can therefore file another property's object key " +
        "under a row this account owns, and can_view_job_photo_full (0104) " +
        "will then authorise /api/job-photo to sign it with the admin client."
    ).toBe(true);
  });
});

describe("contractor_leads.issue_id must be checked on INSERT, not only UPDATE", () => {
  it("the lead lock trigger validates issue_id against property_id on insert", () => {
    const sql = sqlWithoutComments();
    // The INSERT branch of enforce_contractor_leads_locked has to mention
    // issue_id at all. Today it only appears in the UPDATE branch
    // (`new.issue_id := old.issue_id`, 0121), which cannot help an INSERT.
    // Matched strictly BETWEEN the INSERT branch opener and the UPDATE branch
    // opener, so the UPDATE branch's own pin cannot satisfy this.
    const insertBranchTouchesIssueId = /tg_op\s*=\s*'INSERT'((?:(?!tg_op\s*=\s*'UPDATE')[\s\S])*)/gi
      .exec(sql) !== null &&
      Array.from(
        sql.matchAll(
          /tg_op\s*=\s*'INSERT'((?:(?!tg_op\s*=\s*'UPDATE')[\s\S])*)/gi
        )
      ).some((m) => /issue_id/i.test(m[1] ?? ""));
    expect(
      insertBranchTouchesIssueId,
      "enforce_contractor_leads_locked() pins issue_id on UPDATE (0121) but " +
        "its INSERT branch never looks at it, and \"contractor_leads owner " +
        'all" (0002_rls_policies.sql:75) only checks property_id. A raw ' +
        "PostgREST insert can attach another homeowner's issue_id to a lead " +
        "on a property this account owns, which republishes that home's " +
        "photo keys through open_jobs_for_me and unlocks them full " +
        "resolution through can_view_job_photo_full. The app-layer fix in " +
        "postJobAction does not reach this path."
    ).toBe(true);
  });
});
