-- ============================================================================
-- HEARTH LIVE-DB PASTE: migration 0150 (2026-08-30)
-- Paste this WHOLE file into the Supabase SQL editor and run it ONCE, after
-- the 0147-0149 bundle. Safe to re-run.
-- PRECHECK: refuses to run if the lock trigger function is missing.
-- ============================================================================
do $$
begin
  if not exists (
    select 1 from pg_proc
    where proname = 'enforce_contractor_leads_locked' and pronamespace = 'public'::regnamespace
  ) then
    raise exception 'PRECHECK: public.enforce_contractor_leads_locked() is missing. Apply migrations through 0131 first. Nothing was changed.';
  end if;
end
$$;

-- =============================================================================
-- Hearth - pin contractor_leads.created_at (0150)
-- RUN THIS AGAINST THE LIVE DATABASE (Supabase SQL editor); editing repo SQL
-- alone does NOT change the already-deployed database. Apply after 0149.
--
-- WHY THIS EXISTS (red team H1, 2026-08-30, proven on live)
--
-- The homeowner who posted a lead holds full UPDATE on their own row through
-- RLS policy "contractor_leads owner all" (0002), and the lock trigger
-- enforce_contractor_leads_locked() pins property_id, issue_id, direct_to,
-- payout_amount, paid, status and the homeowner fields, but never created_at.
-- Meanwhile apply_to_lead prices the lead fee from that column: 15% off after
-- 3 days, 30% off after 7 (lead_aging_pct, 0149; lead_fee_cents before it).
-- So a homeowner, or a dual-side account, or a pro who talks a homeowner into
-- it, could run one plain update that sets created_at nine days into the past
-- and buy the lead at the maximum markdown on the day it was posted. Hearth
-- loses up to 30% of the fee on every such apply, and because the aging
-- markdown always beats the 10% member discount, membership no longer matters
-- for pricing that lead.
--
-- WHAT THIS CHANGES
--
-- One function, re-issued byte-for-byte from 0131 with two added lines:
--   INSERT (unprivileged): created_at := now(), so a back-dated insert is
--     impossible too (the column defaults to now(); this closes the explicit
--     override).
--   UPDATE (unprivileged, depth <= 1): created_at := old.created_at, in the
--     same block that already pins property_id and issue_id.
-- The privileged path (hearth.lead_write = on, set only inside the SECURITY
-- DEFINER RPCs) is untouched, and no RPC writes created_at anyway. No app code
-- writes created_at on contractor_leads (checked: nothing in src does), so
-- nothing legitimate changes.
--
-- No RLS change, no grant change, no new column. Idempotent: create or
-- replace. The trigger binding from 0121/0131 stays as it is; only the
-- function body changes.
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

-- =============================================================================
-- VERIFY (run after applying)
-- =============================================================================
-- 1. The function body carries both pins.
--   select position('new.created_at  := old.created_at' in pg_get_functiondef('public.enforce_contractor_leads_locked'::regproc)) > 0 as update_pinned,
--          position('new.created_at := now()' in pg_get_functiondef('public.enforce_contractor_leads_locked'::regproc)) > 0 as insert_pinned;
--   -> true | true
-- 2. As a homeowner (RLS client), inside a transaction you roll back:
--   begin;
--     update public.contractor_leads set created_at = now() - interval '9 days'
--      where id = '<a lead you own>';
--     select created_at from public.contractor_leads where id = '<same id>';
--     -- expect: the ORIGINAL timestamp, unchanged
--   rollback;
