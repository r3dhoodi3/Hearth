-- =============================================================================
-- Hearth - lock contractors columns correctly, v2 (0083)
-- RUN THIS AGAINST THE LIVE DATABASE (Supabase SQL editor).
-- SUPERSEDES 0078_lock_contractor_columns.sql.
--
-- WHY 0078 DID NOTHING (CONFIRMED, security audit 2026-07-19, finding #1):
-- 0078 only ran `revoke update (<trust cols>) ... from authenticated` /
-- `revoke insert (<trust cols>) ... from authenticated`. In Postgres, a
-- column-level REVOKE is only meaningful as a NARROWING of an existing
-- column-level GRANT. Supabase's default `alter default privileges ... grant
-- all` gives `authenticated` (and `anon`) the *table-level* UPDATE/INSERT
-- privilege on every new table, contractors included. Postgres checks
-- table-level privileges FIRST: while that table-level grant stands, a
-- column-level REVOKE on top of it is a complete no-op. So after 0078, any
-- signed-in pro could still run, from the browser with only the anon key and
-- their own session:
--
--   supabase.from('contractors').update({
--     license_verified_status: 'verified',
--     background_check_status: 'clear',
--     background_checked_at: new Date().toISOString(),
--     balance: 999999,
--   }).eq('id', myContractorId)
--
-- and self-grant the "License verified" / "Background checked" trust badges
-- shown to homeowners on /p/<id>, plus write balance/rating/review_count.
--
-- THE FIX: revoke the TABLE-LEVEL update/insert privilege outright, then
-- grant back UPDATE/INSERT scoped to an explicit column allowlist - the
-- pattern quotes/invoices/household already use correctly (per the audit,
-- "column-locks are done CORRECTLY... only 0078 got it wrong"). A bare
-- column-level GRANT with no table-level grant behind it is fully enforced:
-- writing any column NOT in the list fails with 42501 permission denied.
--
-- COLUMN LIST, verified against every migration that touches
-- public.contractors (0001 initial CREATE TABLE plus every subsequent
-- `alter table ... add column`; grep confirms no drops/renames):
--   id, name, license_number, categories, service_area, contact_email,
--   contact_phone, vetted, rating, created_at                        (0001)
--   user_id                                                          (0005)
--   balance                                                          (0008)
--   review_count                                                     (0016)
--   logo_url, about, license_state, insurance_carrier,
--     insurance_expires, license_insurance_updated_at                (0033)
--   license_verified_status                                         (0037)
--   license_verified_at        (0037, re-added idempotently by 0055)
--   slug                                                             (0043)
--   referred_by, referred_attributed_at                              (0044)
--   service_state                                                    (0046)
--   license_expires, license_doc_path, insurance_doc_path            (0051)
--   license_verify_detail                                            (0055)
--   background_check_status, background_checked_at,
--     checkr_candidate_id, background_check_detail                   (0057)
--   serves_orange_county                                             (0074)
--
-- EDITABLE SET = the exact union of columns every remaining legit
-- USER-SCOPED (createClient(), i.e. `authenticated`) write touches, verified
-- against the current app code (post-0078: the three risky call sites 0078
-- flagged - license verification writes in saveCompanyAction/
-- verifyLicenseNowAction, and the Checkr candidate write in
-- startBackgroundCheckAction - were already moved to createAdminClient(),
-- confirmed by inline comments citing 0078 at each site):
--   - src/app/pro/actions.ts saveCompanyAction(), profile UPDATE (~201-204):
--       name, license_number, service_area, contact_phone, contact_email,
--       categories, service_state, serves_orange_county
--   - src/app/pro/actions.ts saveCompanyAction(), onboarding INSERT
--       (~339-348, plus the missing-column retry `base` at ~348):
--       id, name, license_number, service_area, contact_phone,
--       contact_email, categories, user_id, vetted, referred_by,
--       referred_attributed_at, service_state
--   - src/app/pro/actions.ts verifyLicenseNowAction() UPDATE (~466-468):
--       license_number (subset of the profile UPDATE set above)
--   - src/app/api/pro-compliance/route.ts POST handler UPDATE (~246-248):
--       license_doc_path, license_expires, insurance_doc_path,
--       insurance_expires, insurance_carrier
--   - src/app/pro/profile/actions.ts savePublicPageAction() UPDATE (~213-215):
--       about, license_number, license_state, insurance_carrier,
--       insurance_expires, logo_url, license_insurance_updated_at
-- No other `.from("contractors")` write in src/ uses a user-scoped client -
-- every cron route, the Checkr/Stripe webhooks, sitemap.ts, and
-- src/lib/{contractor,privacy,proAlerts}.ts all write through
-- createAdminClient() (service_role), which authenticates as `service_role`
-- and so bypasses table/column grants entirely - unaffected by this
-- migration, nothing to add here.
--
-- EXCLUDED (admin/trigger-only - closes the IDOR; every write above already
-- goes through createAdminClient(), which bypasses grants as service_role,
-- so nothing legitimate breaks):
--   license_verified_status, license_verified_at, license_verify_detail,
--   background_check_status, background_checked_at, checkr_candidate_id,
--   background_check_detail, balance, rating, review_count
--
-- ALSO EXCLUDED, deliberately, as neither table warrants it today:
--   id, user_id, vetted   - INSERT only, never UPDATE (id is the PK and
--                            never rewritten; user_id/vetted are set once at
--                            onboarding and never touched by any later
--                            user-scoped write in the app)
--   slug                  - not written by any user-scoped call site today
--                            (read-only in app code); add an UPDATE/INSERT
--                            grant here in a future migration if/when a slug
--                            editor ships
--   created_at             - column default only, never app-written
--
-- Safe to re-run: REVOKE on a privilege that isn't currently held is a
-- silent no-op, and GRANT is idempotent (re-asserting an already-held
-- privilege is not an error).
-- =============================================================================

-- Strip the table-level privilege entirely. This is the actual fix: 0078
-- never touched this, which is why it was a no-op.
revoke update, insert on public.contractors from authenticated, anon;

-- Re-grant UPDATE scoped to exactly the columns legit user-scoped profile /
-- compliance / public-page saves touch today.
grant update (
  name,
  license_number,
  service_area,
  contact_phone,
  contact_email,
  categories,
  service_state,
  serves_orange_county,
  license_doc_path,
  license_expires,
  insurance_doc_path,
  insurance_expires,
  insurance_carrier,
  about,
  license_state,
  logo_url,
  license_insurance_updated_at
) on public.contractors to authenticated;

-- Re-grant INSERT scoped to exactly the columns the onboarding insert (and
-- its missing-column retry) touches today.
grant insert (
  id,
  name,
  license_number,
  service_area,
  contact_phone,
  contact_email,
  categories,
  user_id,
  vetted,
  referred_by,
  referred_attributed_at,
  service_state
) on public.contractors to authenticated;

-- `anon` gets nothing back: every legit contractors write requires a signed-in
-- session (assertContractor()/getCurrentContractor() resolve a real user),
-- so there is no legitimate anon UPDATE/INSERT path to preserve.
