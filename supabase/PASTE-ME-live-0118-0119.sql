-- ============================================================================
-- HEARTH LIVE-DB BUNDLE: migrations 0118 + 0119 in order (2026-08-15)
-- Paste this WHOLE file into the Supabase SQL editor and run it ONCE.
-- Safe to re-run: every section is idempotent.
-- Live DB should be at 0117 before this (you already pasted 0115-0117).
-- After running, live is at 0119.
-- ============================================================================

-- >>>>>>>>>> BEGIN 0118_execute_posture_cleanup_and_password_helper.sql >>>>>>>>>>

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


-- <<<<<<<<<< END 0118_execute_posture_cleanup_and_password_helper.sql <<<<<<<<<<


-- >>>>>>>>>> BEGIN 0119_lock_lead_homeowner_fields.sql >>>>>>>>>>

-- =============================================================================
-- Hearth - lock homeowner-identity and job-detail columns against the
--          assigned pro (0119)
-- RUN THIS AGAINST THE LIVE DATABASE (Supabase SQL editor); editing repo SQL
-- alone does NOT change the already-deployed database. 0118 is the last
-- migration in this folder, so this is the next one to apply, in order, with
-- no gaps.
--
-- ONE finding from a read-only leak sweep (MED, data integrity, money-adjacent
-- because homeowner_name is rendered on the review share card). Nothing here
-- moves money, changes a price, or alters an RLS policy.
--
-- THE HOLE: the assigned pro holds a full-row UPDATE policy on
-- contractor_leads ("leads contractor update", 0005_contractor_side.sql lines
-- 47-54) whose WITH CHECK only re-verifies contractor_id. 0117's
-- enforce_contractor_leads_locked() pins contractor_id / paid / paid_at /
-- payout_amount / property_id / issue_id / direct_to and guards status for
-- non-privileged writers, but it does NOT protect the homeowner-identity or
-- job-detail columns. So the assigned pro can, from the browser with their own
-- session, rewrite homeowner_name, homeowner_email, homeowner_phone,
-- property_address, issue_description, issue_severity, budget_range, timing,
-- square_footage, material_notes, has_plans_permits and owner_closed_at on the
-- lead they were assigned. homeowner_name is shown to the homeowner and
-- rendered on the review share card, so a pro could spoof it.
--
-- THE FIX: extend the SAME trigger, because a GRANT-based column lock cannot
-- tell the owner from the pro (both are the `authenticated` role). On a
-- non-privileged depth-1 UPDATE, when the writer is NOT the property owner
-- (public.owns_property(old.property_id) is false, i.e. the write is the
-- assigned pro, not the homeowner or a household member), revert those columns
-- to their OLD values. When the writer IS the owner, they stay editable so
-- updateJobAction / closeJobAction keep working. The privileged path
-- (hearth.lead_write = on, used by the SECURITY DEFINER money RPCs) and the
-- FK-cascade depth>1 path are untouched: the addition lives entirely inside
-- 0117's existing `if not v_privileged and pg_trigger_depth() <= 1` branch.
--
-- WHY owns_property IS THE RIGHT DISCRIMINATOR, and why calling it here works:
--   - The owner reaches this table through "contractor_leads owner all"
--     (0002_rls_policies.sql lines 75-77), gated by owns_property(property_id),
--     so owns_property(old.property_id) is TRUE for the homeowner and every
--     household member 0048 folded into that helper.
--   - The assigned pro reaches it through "leads contractor update" (0005),
--     which never consults owns_property, so owns_property(old.property_id) is
--     FALSE for the pro.
--   - This function is SECURITY INVOKER (no `security definer` clause), so
--     owns_property runs as the calling role. It is EXECUTE-granted to
--     `authenticated` (0048 line 195) and to `service_role` (0118 Part 3), so
--     the call resolves for the pro, the owner, and any future service_role
--     write alike.
--
-- WHY THE PRO-SIDE REVERT IS SAFE (status is the pro's ONLY legitimate direct
-- write): every other pro write to contractor_leads goes through a SECURITY
-- DEFINER RPC that sets hearth.lead_write = on first (apply_to_lead,
-- unlock_direct_request, decline_direct_request, choose_applicant, rehire_pro,
-- the deposit/credit flows), so those run on the privileged path and skip this
-- whole branch. The single non-privileged direct pro write is
-- updateLeadStatusAction (src/app/pro/actions.ts), which writes ONLY status.
-- On that write none of the protected columns change, so the outer guard below
-- is false and owns_property is never even called. The status guard 0087
-- added is left exactly as-is and still handles status.
--
-- WHY THE OWNER PATH STILL WORKS (columns updateJobAction / closeJobAction
-- legitimately write): updateJobAction
-- (src/app/(app)/contractors/actions.ts) writes category, payout_amount,
-- timing, issue_description, homeowner_name, homeowner_email, homeowner_phone;
-- closeJobAction writes owner_closed_at; postJobAction sets property_address,
-- issue_severity, budget_range, square_footage, material_notes,
-- has_plans_permits at insert. For every one of those the writer owns the
-- property, so owns_property is TRUE and the revert below never fires. The
-- owner keeps full edit rights; only the non-owner (the pro) is reverted.
--
-- payout_amount IS DELIBERATELY NOT IN THE REVERT LIST BELOW. category is
-- reverted for the non-owner BEFORE 0117's existing recompute block, and that
-- recompute (unchanged) authoritatively derives payout_amount from the final
-- category via public.contractor_lead_base_fee(). So a pro who forges category,
-- payout_amount, or both still ends with payout_amount = base fee for the
-- ORIGINAL category, exactly as 0117 intended, and the delicate $0-rehire /
-- anti-lowball money logic is left completely alone.
--
-- MACHINE-DIFF vs the 0117 function body (the base copied verbatim): the ONLY
-- change is one new block inserted immediately after 0117's
-- `-- ---- end 0117 addition ----` line and before the payout recompute
-- comment. It is bracketed by `-- ---- 0119 addition ...` / `-- ---- end 0119
-- addition ----`. Every other line, comment included, is byte-for-byte 0117's
-- (the base body 0117 in turn copied from 0088). 0117 is confirmed the latest
-- definition on disk: a grep of create-or-replace for this function across
-- 0001-0118 lands in 0077/0084/0087/0088/0117 only, and 0089-0116 mention it
-- solely in comments.
--
-- Idempotent: CREATE OR REPLACE for the function; the trigger binding
-- (0077 line 215, bound by name) is unchanged so no CREATE TRIGGER is needed.
-- Safe to re-run.
--
-- This migration was written and reasoned about, but NOT executed against any
-- database (per instructions). Dry-run against a staging copy of the live
-- schema before applying to production.
-- =============================================================================

create or replace function public.enforce_contractor_leads_locked()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_privileged boolean := coalesce(current_setting('hearth.lead_write', true), '') = 'on';
  v_is_party   boolean;
  v_has_live_apps boolean;
begin
  if tg_op = 'INSERT' then
    if not v_privileged then
      -- Reproduces exactly what postJobAction already sends for a fresh,
      -- unassigned posting. A forged insert (contractor_id pre-set, paid =
      -- true, payout_amount lowballed) is silently corrected instead of
      -- rejected, so the ordinary posting flow sees no behavior change.
      new.contractor_id := null;
      new.paid := false;
      new.paid_at := null;
      new.status := 'new';
      new.payout_amount := public.contractor_lead_base_fee(new.category);
    end if;
    return new;
  end if;

  if tg_op = 'UPDATE' then
    -- 0084 fix (finding #5, unchanged): pg_trigger_depth() > 1 means this
    -- UPDATE was fired from inside another trigger - the FK's ON DELETE SET
    -- NULL action on contractor_leads.contractor_id when a contractors row
    -- is deleted (0005), a nested trigger invocation, not a direct client
    -- statement. Skip ALL anti-forgery stripping (including the status guard
    -- below) only for that RI-cascade case, so account deletion (CCPA erase)
    -- still works. Direct client writes are always depth = 1.
    if not v_privileged and pg_trigger_depth() <= 1 then
      if new.contractor_id is distinct from old.contractor_id then
        new.contractor_id := old.contractor_id;
      end if;
      if new.paid is distinct from old.paid then
        new.paid := old.paid;
      end if;
      if new.paid_at is distinct from old.paid_at then
        new.paid_at := old.paid_at;
      end if;

      -- ---- 0117 addition: pin the lead to its property, issue and target ---
      -- A lead's chat thread, its notifications, and the job photos a paid pro
      -- can see are all resolved through property_id / issue_id. Re-pointing
      -- either one moves a live lead into another homeowner's account. No
      -- application path ever updates them, so a flat revert is correct.
      new.property_id := old.property_id;
      new.issue_id    := old.issue_id;

      -- direct_to: revert every change EXCEPT the one legitimate transition,
      -- a homeowner clearing an already-set target on a still-unassigned lead
      -- so it becomes a plain public job (postDirectRequestAsJobAction). A
      -- flat revert would break that feature silently. Setting direct_to from
      -- null, or swapping it to a different pro, is always reverted: that is
      -- the actual hole, since the target pro gets a private unlock path into
      -- the lead.
      -- Nested rather than one flat AND chain on purpose: PostgreSQL does not
      -- promise left-to-right short-circuiting inside a single boolean
      -- expression, so a flat version could call owns_property() on EVERY
      -- non-privileged lead UPDATE, including the ones that never mention
      -- direct_to. The outer IF makes that impossible.
      if new.direct_to is distinct from old.direct_to then
        if not (
          old.direct_to is not null
          and new.direct_to is null
          and old.contractor_id is null
          and coalesce(public.owns_property(old.property_id), false)
        ) then
          new.direct_to := old.direct_to;
        end if;
      end if;
      -- ---- end 0117 addition ------------------------------------------------

      -- ---- 0119 addition: block the assigned pro from rewriting homeowner
      --      identity and job detail --------------------------------------
      -- The pro's UPDATE policy ("leads contractor update", 0005) re-checks
      -- only contractor_id, so without this the assigned pro could rewrite the
      -- homeowner's name/email/phone (name is shown to the homeowner and on the
      -- review share card - spoofable), the property address, and the job
      -- detail fields on the lead they were assigned. The owner writes these
      -- legitimately through updateJobAction / closeJobAction; the pro must
      -- not. owns_property(old.property_id) is TRUE for the homeowner and any
      -- household member (they reach this row via "contractor_leads owner all",
      -- 0002) and FALSE for the pro (who reaches it via the contractor policy),
      -- so it is the exact owner-vs-pro discriminator. SECURITY INVOKER, and
      -- owns_property is granted to authenticated (0048) and service_role
      -- (0118), so the call resolves for whichever role is writing.
      --
      -- Same nested shape as the direct_to block above, and for the same
      -- reason: the outer IF fires only when one of the protected columns
      -- actually changed, so owns_property() is never evaluated on the pro's
      -- ordinary status-only write (updateLeadStatusAction, the pro's ONLY
      -- legitimate non-privileged write), nor on any update that leaves these
      -- columns alone.
      --
      -- payout_amount is intentionally absent here: category is reverted for
      -- the non-owner, and 0117's recompute block just below derives
      -- payout_amount from the final category, so a pro-forged category and/or
      -- payout_amount still lands on the base fee for the ORIGINAL category
      -- without this block touching the money logic. This runs BEFORE that
      -- recompute so the recompute sees the reverted category.
      if new.homeowner_name    is distinct from old.homeowner_name
         or new.homeowner_email  is distinct from old.homeowner_email
         or new.homeowner_phone  is distinct from old.homeowner_phone
         or new.property_address is distinct from old.property_address
         or new.issue_description is distinct from old.issue_description
         or new.issue_severity   is distinct from old.issue_severity
         or new.budget_range     is distinct from old.budget_range
         or new.timing           is distinct from old.timing
         or new.square_footage   is distinct from old.square_footage
         or new.material_notes   is distinct from old.material_notes
         or new.has_plans_permits is distinct from old.has_plans_permits
         or new.category         is distinct from old.category
         or new.owner_closed_at  is distinct from old.owner_closed_at then
        if not coalesce(public.owns_property(old.property_id), false) then
          new.homeowner_name    := old.homeowner_name;
          new.homeowner_email   := old.homeowner_email;
          new.homeowner_phone   := old.homeowner_phone;
          new.property_address  := old.property_address;
          new.issue_description := old.issue_description;
          new.issue_severity    := old.issue_severity;
          new.budget_range      := old.budget_range;
          new.timing            := old.timing;
          new.square_footage    := old.square_footage;
          new.material_notes    := old.material_notes;
          new.has_plans_permits := old.has_plans_permits;
          new.category          := old.category;
          new.owner_closed_at   := old.owner_closed_at;
        end if;
      end if;
      -- ---- end 0119 addition ------------------------------------------------

      -- Recompute only when category or payout_amount actually changed, so a
      -- status-only update (the pro's updateLeadStatusAction) never touches
      -- payout_amount - this is what keeps rehire_pro's free ($0) leads from
      -- being corrupted back to a paid tier the next time their status
      -- changes. When it IS one of those two columns changing, recomputing
      -- from category reproduces updateJobAction's own
      -- payout_amount = leadFeeFor(category) and blocks a lowballed forgery.
      if new.category is distinct from old.category
         or new.payout_amount is distinct from old.payout_amount then
        new.payout_amount := public.contractor_lead_base_fee(new.category);
      end if;

      -- ---- 0087 addition: status transition guard -------------------------
      if new.status is distinct from old.status then
        v_is_party := coalesce(public.can_access_lead(old.id), false);
        if not v_is_party then
          -- Should be unreachable given RLS, but never let a non-party's
          -- status write through if this ever runs outside RLS's scope.
          new.status := old.status;
        elsif new.status = 'accepted' then
          -- (b) 'accepted' is normally set together with contractor_id by
          -- choose_applicant (privileged). A non-privileged write to 'accepted'
          -- is legitimate ONLY as a pro un-marking their OWN already-assigned
          -- lead from a mistaken 'closed'/'lost' back to active (the pro's
          -- JobStatusSelect dropdown offers exactly this). Allow that; block the
          -- real hole: a homeowner or stranger self-accepting an UNASSIGNED
          -- lead (contractor_id null), or anyone accepting a lead not assigned
          -- to their own contractor.
          if old.contractor_id is null
             or old.contractor_id not in (
               select id from public.contractors where user_id = auth.uid()
             )
             or old.status not in ('closed', 'lost') then
            new.status := old.status;
          end if;
        elsif old.status in ('accepted', 'closed', 'lost') and new.status = 'new' then
          -- (c) No moving a lead backward to 'new' once it has left that
          -- state.
          new.status := old.status;
        elsif old.contractor_id is null and old.status = 'new'
              and new.status in ('closed', 'lost') then
          -- (d) Mirrors closeJobAction: once a lead has a live (non-refunded)
          -- application, the homeowner must pick an applicant rather than
          -- force it closed/lost directly. A still-unassigned lead with NO
          -- applications is unaffected (closeJobAction's normal cancel path,
          -- and the app actually DELETEs there rather than updating status,
          -- but this guard covers the update path too for defense-in-depth).
          select exists (
            select 1 from lead_applications
            where lead_id = old.id and refunded_at is null
          ) into v_has_live_apps;
          if v_has_live_apps then
            new.status := old.status;
          end if;
        end if;
      end if;
      -- ---- end 0087 addition -----------------------------------------------
    end if;

    -- 0088 addition: closed_at is derived bookkeeping, never client-writable,
    -- and stamping must also work for privileged RPC writes (choose_applicant,
    -- rehire_pro, the CCPA-deletion RI cascade at any trigger depth), hence it
    -- runs for every UPDATE, privileged or not, at any trigger depth - it is
    -- NOT nested inside the `not v_privileged and pg_trigger_depth() <= 1`
    -- guard above. It MUST run here, at the very end of the UPDATE branch,
    -- immediately before return new, rather than at the top: it has to derive
    -- from the FINAL new.status, after 0087's anti-forgery guards above have
    -- already reverted any illegitimate status write, not from the tentative
    -- client-supplied new.status those guards haven't checked yet. Deriving
    -- from the tentative value would let a reverted forgery still corrupt
    -- closed_at - e.g. a contractor sends status = 'new' on their own closed
    -- lead; rule (c) above reverts new.status back to 'closed'; if this block
    -- ran first (against the pre-revert 'new'), it would have already nulled
    -- closed_at, leaving a final row of status = 'closed' with
    -- closed_at = null and the hold clock silently erased. Running last means
    -- this block only ever sees the status the row will actually end up with.
    -- Always revert any client-supplied closed_at first, then derive from the
    -- real (final) transition. Clearing closed_at on un-close means a pro
    -- un-marking a mistaken Won (back to 'accepted', per 0087's own allowed
    -- reversal) restarts the hold clock honestly rather than keeping a stale
    -- timestamp from the earlier, later-undone close.
    new.closed_at := old.closed_at;
    if new.status = 'closed' and old.status is distinct from 'closed' then
      new.closed_at := now();
    elsif new.status is distinct from 'closed' and old.status = 'closed' then
      new.closed_at := null;
    end if;

    return new;
  end if;

  return new;
end;
$$;

-- The trigger itself (0077 line 215) is unchanged and still bound to this
-- function by name, so no CREATE TRIGGER is needed here.


-- =============================================================================
-- Part 2 (0119): grant EXECUTE on current_user_has_password() to authenticated
-- =============================================================================
-- 0118 Part 4 created public.current_user_has_password() (SECURITY DEFINER,
-- STABLE, no arguments) and granted EXECUTE to service_role ONLY. But the H3
-- fix in src/lib/auth.ts (realHasPassword) calls this RPC through the
-- REQUEST-SCOPED authenticated client on purpose: the function keys off
-- auth.uid(), and only the end user's forwarded JWT makes auth.uid() resolve to
-- the caller. Under the 0118 grant the authenticated call gets "permission
-- denied", the code swallows it as an error and falls back to the OAuth
-- heuristic, so H3 never actually activates. Granting EXECUTE to authenticated
-- turns that call into a real boolean.
--
-- WHY THIS IS SAFE: the function is SECURITY DEFINER but takes NO argument and
-- is hard-scoped to auth.uid() (`where u.id = auth.uid()`), so a caller can
-- only ever learn whether THEY THEMSELVES have a password - never another
-- account's state, and never any other column of auth.users. That single bit is
-- already visible to the same user in the account-security UI (it decides
-- whether the change-password form or the set-password card is shown). It
-- returns false (not an error) when auth.uid() is null, so exposing it to
-- authenticated widens nothing an anon caller could exploit: with no session
-- there is no auth.uid() and no row. anon stays revoked (0118 line 132).
--
-- Idempotent: a grant is a set-to-state operation, safe to re-run. The 0118
-- service_role grant is left in place so any future server-side caller holding
-- the service-role key with a forwarded JWT still resolves.
grant execute on function public.current_user_has_password() to authenticated;


-- <<<<<<<<<< END 0119_lock_lead_homeowner_fields.sql <<<<<<<<<<

