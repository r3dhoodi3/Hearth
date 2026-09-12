-- =============================================================================
-- OakTend - rename the privileged-write GUC flags (0163)
-- RUN THIS AGAINST THE LIVE DATABASE (Supabase SQL editor). Apply after 0162.
--
-- WHY THIS EXISTS
--
-- The brand rename (Hearth -> OakTend) moves the two transaction-local GUC
-- flags the app checks from `hearth.lead_write` / `hearth.ownership_write`
-- to `oaktend.lead_write` / `oaktend.ownership_write`. New application code
-- (and any new SECURITY DEFINER RPC written from now on) sets only the new
-- names via set_config. This migration re-creates the two functions that
-- READ the flag so each one checks the new name first and falls back to the
-- old one, so the many already-deployed SECURITY DEFINER RPCs (apply_to_lead,
-- choose_applicant, charge_lead, rehire_pro, record_ownership_check, and
-- every other migration that calls
-- `perform set_config('hearth.lead_write', 'on', true)` or the ownership
-- equivalent) keep working exactly as before without themselves being
-- touched - those calls live inside migrations under supabase/migrations/,
-- which this rename never edits.
--
-- FUNCTIONS FOUND (grepped every migration for
-- "current_setting('hearth.lead_write'" / "...ownership_write'"; each one
-- re-created below from its LATEST live definition, confirmed by grepping
-- every migration for "create or replace function public.<name>"):
--   * public.enforce_contractor_leads_locked() - latest body: 0150
--     (pin_lead_created_at). Re-issued byte-for-byte from 0150 with only the
--     v_privileged line changed.
--   * public.enforce_properties_ownership_locked() - latest (only) body: 0095
--     (ownership_verification). Re-issued byte-for-byte from 0095 with only
--     the v_privileged line changed.
--
-- Neither function's signature or RETURNS type changes, so CREATE OR REPLACE
-- preserves the existing trigger bindings (contractor_leads_locked,
-- properties_ownership_locked) untouched - no DROP/CREATE TRIGGER needed.
--
-- CHECK EXPRESSION: coalesce(nullif(current_setting('oaktend.lead_write',
-- true), ''), current_setting('hearth.lead_write', true), '') = 'on'. Reads
-- the new GUC first; if it is unset or empty, falls back to the legacy GUC;
-- if both are unset, current_setting(..., true) returns null and the
-- trailing '' keeps the coalesce (and therefore v_privileged) from ever
-- evaluating to null, matching the original coalesce(current_setting(...),
-- '') = 'on' style exactly. Same shape for ownership_write.
--
-- Safe to re-run.
-- =============================================================================

-- ---- PRECHECK: refuse to run against a database that isn't caught up -------
do $$
begin
  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public' and indexname = 'properties_address_unique'
  ) then
    raise exception 'PRECHECK: index public.properties_address_unique is missing. Apply migration 0162 before this file. Nothing was changed.';
  end if;
end
$$;

-- ---- public.enforce_contractor_leads_locked() (latest body: 0150) ----------
create or replace function public.enforce_contractor_leads_locked()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_privileged boolean := coalesce(nullif(current_setting('oaktend.lead_write', true), ''), current_setting('hearth.lead_write', true), '') = 'on';
  v_is_party   boolean;
  v_has_live_apps boolean;
begin
  if tg_op = 'INSERT' then
    -- ---- 0131 addition: issue_id must belong to this lead's own property ---
    -- "contractor_leads owner all" (0002) checks property_id and nothing else,
    -- so without this a raw PostgREST insert attaches another homeowner's
    -- issue to a lead on a property this account owns. open_jobs_for_me
    -- aggregates photo_urls by issue_id, and can_view_job_photo_full binds a
    -- signed url to the lead through it, so that forgery republishes the other
    -- home's photo keys and unlocks them full resolution.
    if new.issue_id is not null
       and not exists (
         select 1
           from public.issues i
          where i.id = new.issue_id
            and i.property_id = new.property_id
       )
    then
      new.issue_id := null;
    end if;
    -- ---- end 0131 addition ------------------------------------------------

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
      -- 0150: the posting time is money (the aging markdown prices off it),
      -- so a caller cannot back-date a brand new lead either.
      new.created_at := now();
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
      -- 0150: created_at is pinned like property_id. See the header.
      new.created_at  := old.created_at;

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

-- ---- public.enforce_properties_ownership_locked() (latest body: 0095) -----
create or replace function public.enforce_properties_ownership_locked()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_privileged boolean := coalesce(nullif(current_setting('oaktend.ownership_write', true), ''), current_setting('hearth.ownership_write', true), '') = 'on';
begin
  if tg_op = 'INSERT' then
    if not v_privileged then
      -- A forged insert (claimPropertyAction's extendedRow/baseRow are built
      -- from client-submitted form fields - see the comment in
      -- src/app/onboarding/actions.ts) never gets to claim verified
      -- ownership up front: every new property starts unverified/unchecked
      -- regardless of what the insert statement asked for.
      new.ownership_status := 'unverified';
      new.ownership_owner_names := null;
      new.ownership_owner_type := null;
      new.ownership_owner_occupied := null;
      new.ownership_checked_at := null;
      new.ownership_verified := false;
    end if;
    return new;
  end if;

  if tg_op = 'UPDATE' then
    if not v_privileged then
      if new.ownership_status is distinct from old.ownership_status then
        new.ownership_status := old.ownership_status;
      end if;
      if new.ownership_owner_names is distinct from old.ownership_owner_names then
        new.ownership_owner_names := old.ownership_owner_names;
      end if;
      if new.ownership_owner_type is distinct from old.ownership_owner_type then
        new.ownership_owner_type := old.ownership_owner_type;
      end if;
      if new.ownership_owner_occupied is distinct from old.ownership_owner_occupied then
        new.ownership_owner_occupied := old.ownership_owner_occupied;
      end if;
      if new.ownership_checked_at is distinct from old.ownership_checked_at then
        new.ownership_checked_at := old.ownership_checked_at;
      end if;
      if new.ownership_verified is distinct from old.ownership_verified then
        new.ownership_verified := old.ownership_verified;
      end if;
    end if;
    return new;
  end if;

  return new;
end;
$$;

-- No trigger changes needed: contractor_leads_locked and
-- properties_ownership_locked already point at these two function names
-- (bound in 0079/0095) and neither function's signature changed here.
