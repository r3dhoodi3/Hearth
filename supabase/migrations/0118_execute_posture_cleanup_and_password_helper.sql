-- =============================================================================
-- Hearth - execute-posture cleanup + has-password helper (0118)
-- RUN THIS AGAINST THE LIVE DATABASE (Supabase SQL editor); editing repo SQL
-- alone does NOT change the already-deployed database. 0117 is the last
-- migration in this folder, so this is the next one to apply, in order, with
-- no gaps.
--
-- Four independent, low-risk hardening items, each verified against production
-- by a read-only leak sweep. Nothing here moves money, changes a price, alters
-- an RLS policy, or drops a column.
--
-- Part 1: lead_previews (0006) - revoke the anon SELECT grant. The view is a
--   public open-job feed with real rows behind it, but src/ has ZERO readers.
-- Part 2: resolve_referral_code(text) (0067) and browse_pros(text) (0111) -
--   revoke EXECUTE from anon (and from PUBLIC for resolve_referral_code, whose
--   default grant was never revoked). Both only have callers behind auth.
-- Part 3: owns_property(uuid) (0048) - grant EXECUTE to service_role so the
--   0117 direct_to carve-out (SECURITY INVOKER) works under a service_role
--   write.
-- Part 4: NEW current_user_has_password() - SECURITY DEFINER, service_role
--   only, so the app can read hasPassword from the real auth.users column
--   instead of guessing from OAuth identities.
--
-- Idempotent: REVOKE is naturally re-runnable; CREATE OR REPLACE for the new
-- function; the function grant is a set-to-state operation. Safe to re-run.
--
-- ORDERING: none of the four parts depend on each other and none depend on
-- anything past 0117. Part 3 must land before any service_role write to
-- contractor_leads.direct_to is attempted (that path is the reason for the
-- grant), but there is no ordering hazard WITHIN this migration.
--
-- This migration was written and reasoned about, but NOT executed against any
-- database (per instructions). Dry-run against a staging copy of the live
-- schema before applying to production.
-- =============================================================================


-- =============================================================================
-- Part 1: lead_previews - revoke the anon SELECT grant
-- =============================================================================
-- 0006_lead_previews.sql line 22 ran `grant select on public.lead_previews to
-- anon, authenticated;` - the grant came from role `anon`, not `public`, so
-- only `anon` needs revoking here (a revoke from `public` would be a harmless
-- no-op since `public` was never granted, but it is omitted to mirror the
-- actual grant exactly). This view runs with its owner's rights and returns
-- real open-job rows (category, coarse area, severity, fee) to the anonymous
-- key: a read-only sweep confirmed 200 with 23 rows to the anon key. A grep of
-- src/ found ZERO readers - the only reference is the generated row type in
-- database.types.ts - so revoking anon breaks nothing. The `authenticated`
-- grant is left in place.
revoke select on public.lead_previews from anon;

comment on view public.lead_previews is
  'UNUSED public job-board feed. Was anon-readable (0006) and returned real '
  'open-lead rows to the anonymous key, but nothing in src/ ever read it, so '
  'the anon SELECT grant was revoked in 0118. The authenticated grant is kept '
  'in case a signed-in surface ever wants it. Still runs with owner rights '
  'with no RLS behind it: NEVER add homeowner_name, homeowner_email, '
  'homeowner_phone, property_address, property_id, issue_id, issue_description '
  'or contractor_id, and re-review before re-granting anon. Capped at 200 '
  'rows (0117).';


-- =============================================================================
-- Part 2: resolve_referral_code(text), browse_pros(text) - close anon EXECUTE
-- =============================================================================
-- resolve_referral_code(text) (0067 lines 19-39) was granted EXECUTE only to
-- `authenticated`, but its PostgreSQL default PUBLIC grant was never revoked,
-- so anon can still call it through PostgREST. Its only callers are behind
-- auth. Revoke from PUBLIC (which also removes anon's inherited access) and,
-- for good measure and to be explicit, from anon directly. The 0067 grant to
-- `authenticated` is a direct grant and is NOT touched, so signed-in callers
-- keep access.
revoke execute on function public.resolve_referral_code(text) from public;
revoke execute on function public.resolve_referral_code(text) from anon;

-- browse_pros(text) (0111 line 153) has an EXPLICIT anon grant. Its only
-- callers are behind auth, so revoke the anon grant. The separate
-- `authenticated` grant (0111 line 154) is left in place.
revoke execute on function public.browse_pros(text) from anon;


-- =============================================================================
-- Part 3: owns_property(uuid) - grant EXECUTE to service_role
-- =============================================================================
-- 0048 lines 192-195 revoked EXECUTE from public/anon/authenticated and granted
-- it only to `authenticated`. The 0117 contractor_leads trigger's direct_to
-- carve-out (enforce_contractor_leads_locked, Part 1 of 0117) calls
-- public.owns_property(old.property_id) and is SECURITY INVOKER, so it runs as
-- the calling role. A future service_role write to contractor_leads.direct_to
-- would therefore hit "permission denied for function owns_property". Granting
-- EXECUTE to service_role closes that gap. This is additive: it does not widen
-- client-facing access (service_role is server-only), and the existing
-- `authenticated` grant is untouched.
grant execute on function public.owns_property(uuid) to service_role;


-- =============================================================================
-- Part 4: current_user_has_password() - real hasPassword signal
-- =============================================================================
-- The app currently guesses whether a user has set a password by inspecting
-- their OAuth identities, which is a heuristic that gets edge cases wrong. The
-- source of truth is auth.users.encrypted_password, which no client role may
-- read. This SECURITY DEFINER function reads that column for the CURRENT auth
-- user only (auth.uid()) and returns a single boolean, so it leaks nothing
-- beyond "do I, the caller, have a password" - it takes no argument and cannot
-- be pointed at another account. Returns false when auth.uid() is null (no
-- session), never an error.
--
-- SECURITY: it reads auth.users, which is why it is SECURITY DEFINER and why it
-- is locked to service_role only (mirrors 0068 rate_limit_hit and 0115
-- match_support_contact). The app calls it from a server route holding the
-- service-role key; auth.uid() still resolves to the end user because the JWT
-- is forwarded on that request. Exposing it to anon or authenticated would let
-- a caller confirm password state, so both are revoked.
create or replace function public.current_user_has_password()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1
    from auth.users u
    where u.id = auth.uid()
      and u.encrypted_password is not null
      and u.encrypted_password <> ''
  );
$$;

revoke all on function public.current_user_has_password() from public, anon, authenticated;
grant execute on function public.current_user_has_password() to service_role;

comment on function public.current_user_has_password() is
  'Returns whether the CURRENT auth user (auth.uid()) has a non-null '
  'encrypted_password in auth.users; false when there is no session. Lets the '
  'app derive hasPassword from the real password column instead of OAuth '
  'identity heuristics. Reads auth.users, so SECURITY DEFINER and service_role '
  'only (0068 / 0115 pattern): exposing it to anon or authenticated would let '
  'a caller confirm account password state.';
