-- =============================================================================
-- Hearth - lock contractor_leads protected columns (0077)
-- RUN THIS AGAINST THE LIVE DATABASE (Supabase SQL editor); editing repo SQL
-- alone does NOT change the already-deployed database.
--
-- THE HOLE (confirmed by three independent audits): contractor_leads has
-- row-level-only RLS.
--   - "contractor_leads owner all" (0002) lets a homeowner INSERT/UPDATE/
--     SELECT/DELETE ANY column on a lead attached to a property they own -
--     there is no column-level restriction at all.
--   - "leads contractor update" (0005) similarly puts no column restriction
--     on a pro's update of a lead already assigned to them.
-- The intended flow is that contractor_id, paid, paid_at, and payout_amount
-- are only ever supposed to move through the SECURITY DEFINER RPCs
-- (apply_to_lead, choose_applicant, charge_lead, rehire_pro), which price
-- the fee, take the wallet money, and assign the pro atomically. But because
-- RLS here is row-only, a raw PostgREST call authenticated as an ordinary
-- homeowner can bypass every one of those RPCs and, on a lead they own:
--   * INSERT a lead pre-assigned to any contractor_id with paid = true and
--     payout_amount = 0.01 - a pro gets "hired" and unlocked with no
--     apply_to_lead fee ever charged. This is a direct hole in the
--     marketplace's only revenue mechanism.
--   * UPDATE contractor_id on an existing open lead to assign a pro for
--     free, same bypass.
--   * UPDATE payout_amount down to $0.01 (or category up to a pricier tier
--     while leaving payout_amount at the old cheap tier) before a pro
--     applies, so apply_to_lead's lead_fee_cents() prices the apply fee off
--     a forged number.
--   * UPDATE paid / paid_at directly to fake a payment that was never
--     charged.
--   * UPDATE status to an arbitrary string - there is no CHECK constraint
--     on it today.
--
-- THE FIX, two parts:
--
--  1. A CHECK constraint on status, so it can only ever be one of the four
--     values the app actually uses (src/lib/constants.ts LEAD_STATUSES:
--     new, accepted, closed, lost - confirmed by grepping every
--     contractor_leads.status write/read across the migrations and the app).
--     Added NOT VALID deliberately: this enforces the rule on every new
--     write from the moment this migration runs, without requiring a scan of
--     every existing row to succeed first (a live table may have legacy rows
--     this migration's author cannot see). See the RISK note at the bottom
--     for the required follow-up.
--
--     status is intentionally NOT locked behind the privileged-context
--     trigger below: updateLeadStatusAction (src/app/pro/actions.ts) updates
--     contractor_leads.status directly from client code, outside any RPC,
--     whenever a pro moves a job through New -> Accepted -> Closed/Lost.
--     That is a real, currently-shipped, RLS-guarded flow (the pro can only
--     touch a lead already assigned to them), not a bug, so this migration
--     must not break it. The CHECK constraint closes the "arbitrary string"
--     part of the hole without touching that flow. See the RISK note below
--     for what this deliberately leaves open.
--
--  2. A BEFORE INSERT OR UPDATE trigger, enforce_contractor_leads_locked(),
--     that strips forged values from the four columns that must only ever
--     move through the RPCs: contractor_id, paid, paid_at, and
--     payout_amount. It runs before RLS's WITH CHECK is evaluated, so by the
--     time the policy checks the row, any forged value has already been
--     neutralized:
--       - INSERT, not from a privileged RPC: contractor_id -> null,
--         paid -> false, paid_at -> null, status -> 'new', payout_amount ->
--         the server-computed fee for the category. This exactly reproduces
--         what postJobAction (src/app/(app)/contractors/actions.ts) already
--         sends, so a legitimate post is unaffected; a forged insert has its
--         forged columns silently overwritten with the safe values instead.
--       - UPDATE, not from a privileged RPC: contractor_id / paid / paid_at
--         are reset to their OLD value if a client tried to change them
--         (verified no legitimate client code updates these three directly -
--         only the RPCs do). payout_amount is recomputed from the
--         server-side fee table whenever category OR payout_amount changed,
--         which both closes the "set payout_amount to $0.01" hole AND
--         reproduces updateJobAction's existing behavior (it already sends
--         payout_amount = leadFeeFor(category) on a category edit, so the
--         recomputed value matches what the client sent). Critically, this
--         is conditional on a real change: a status-only update (the pro's
--         updateLeadStatusAction) leaves category/payout_amount untouched,
--         so it does NOT get recomputed - this preserves rehire_pro's
--         intentionally-free ($0) repeat leads, which would otherwise be
--         corrupted back to a paid tier the first time the pro touched their
--         status.
--     "Privileged" means the current transaction has set
--     current_setting('hearth.lead_write', true) = 'on', which only the four
--     SECURITY DEFINER RPCs below do, via set_config(..., true) (transaction-
--     local, so it can never leak into an unrelated later statement on a
--     pooled connection).
--
-- RPCs updated to mark themselves privileged (one added line each, bodies
-- otherwise byte-for-byte identical to their current live definitions):
--   - apply_to_lead   (latest body: 0065_wallet_lock_on_charge.sql). It does
--     not actually INSERT/UPDATE contractor_leads today (only a SELECT ...
--     FOR UPDATE lock), so the flag is a no-op for it right now, added for
--     parity/future-proofing per the review brief.
--   - choose_applicant (latest body: 0065). Sets contractor_id, status,
--     paid, paid_at on the lead it assigns - needs the flag.
--   - charge_lead      (latest body: 0065; service_role only since 0059).
--     Sets paid, paid_at - needs the flag.
--   - rehire_pro       (latest body: 0030_rehire.sql). NOT in the review
--     brief's list of three, but discovered during investigation: it INSERTs
--     a lead pre-assigned to a contractor (contractor_id set, status =
--     'accepted', paid = true, paid_at = now(), payout_amount = 0, the free
--     repeat-hire flow). Without the flag, the INSERT branch of the trigger
--     would force this row back to unassigned/unpaid/status='new' and
--     overwrite the intentional $0 fee with a real tier price, silently
--     breaking "My Pros" rehiring. Added here as a necessary correctness fix,
--     not an optional extra - flagged prominently for the reviewer.
--
-- Idempotent: function/trigger CREATE OR REPLACE, constraint DROP then ADD,
-- trigger DROP IF EXISTS then CREATE. Safe to re-run.
-- =============================================================================

-- ---- 1. Server-side fee source of truth ---------------------------------------
-- Mirrors LEAD_FEES / leadFeeFor in src/lib/constants.ts exactly (verified by
-- reading that file directly): tier 3 ($90) roof/structural/remodeling,
-- tier 2 ($50) hvac/plumbing/electrical/windows/home_inspection/garage_door/
-- pest, tier 1 ($25) landscaping/cleaning/painting/handyman, and $25 (the
-- "other"/tier-1 fallback) for anything else - an unrecognized or future
-- category must never resolve to $0. This is the ONLY place, besides
-- constants.ts, that a lead's dollar fee may be computed from; the trigger
-- below never trusts a client-supplied payout_amount.
create or replace function public.contractor_lead_base_fee(p_category text)
returns numeric
language sql
stable
set search_path = public
as $$
  select case p_category
    when 'roof'            then 90
    when 'structural'       then 90
    when 'remodeling'       then 90
    when 'hvac'             then 50
    when 'plumbing'         then 50
    when 'electrical'       then 50
    when 'windows'          then 50
    when 'home_inspection'  then 50
    when 'garage_door'      then 50
    when 'pest'             then 50
    when 'landscaping'      then 25
    when 'cleaning'         then 25
    when 'painting'         then 25
    when 'handyman'         then 25
    else 25
  end::numeric;
$$;

-- ---- 2. status: only the four values the app ever writes -----------------------
-- NOT VALID: enforced on every write from now on, but does not require
-- scanning/validating pre-existing rows for this migration to apply cleanly.
-- See the RISK note at the end of this file.
alter table public.contractor_leads
  drop constraint if exists contractor_leads_status_valid;
alter table public.contractor_leads
  add constraint contractor_leads_status_valid
  check (status in ('new', 'accepted', 'closed', 'lost'))
  not valid;

-- ---- 3. Lock contractor_id / paid / paid_at / payout_amount to the RPCs --------
create or replace function public.enforce_contractor_leads_locked()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_privileged boolean := coalesce(current_setting('hearth.lead_write', true), '') = 'on';
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
    if not v_privileged then
      if new.contractor_id is distinct from old.contractor_id then
        new.contractor_id := old.contractor_id;
      end if;
      if new.paid is distinct from old.paid then
        new.paid := old.paid;
      end if;
      if new.paid_at is distinct from old.paid_at then
        new.paid_at := old.paid_at;
      end if;
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
    end if;
    return new;
  end if;

  return new;
end;
$$;

drop trigger if exists contractor_leads_locked on public.contractor_leads;
create trigger contractor_leads_locked
  before insert or update on public.contractor_leads
  for each row execute function public.enforce_contractor_leads_locked();

-- ---- 4. Mark the SECURITY DEFINER entry points privileged -----------------------
-- Each body below is byte-for-byte identical to its current live definition
-- (apply_to_lead/choose_applicant/charge_lead: 0065_wallet_lock_on_charge.sql;
-- rehire_pro: 0030_rehire.sql - confirmed as the latest definition of each by
-- grepping every migration for "create or replace function public.<name>"),
-- plus one added line at the top of the body:
--   perform set_config('hearth.lead_write', 'on', true);
-- `true` (is_local) scopes it to the current transaction only, so it can
-- never bleed into an unrelated statement on a pooled connection. Signatures
-- are unchanged, so CREATE OR REPLACE preserves each function's existing
-- EXECUTE grants (including charge_lead's service_role-only lockdown from
-- 0059/0065 - not re-stated here since this migration does not touch grants).

-- ---- apply_to_lead --------------------------------------------------------------
create or replace function public.apply_to_lead(p_lead uuid, p_message text)
returns boolean language plpgsql security definer set search_path = public as $$
declare
  v_contractor uuid; v_wallet uuid; v_cats text[];
  v_lead_contractor uuid; v_status text; v_category text; v_price bigint;
  v_property uuid; v_owner uuid;
  v_cash bigint; v_bonus bigint; v_grant_sum bigint; v_bonus_avail bigint;
  v_from_cash bigint; v_from_bonus bigint;
  v_remaining bigint; v_grant record; v_cash_first boolean;
  v_cash_after bigint; v_bonus_after bigint;
begin
  perform set_config('hearth.lead_write', 'on', true);

  select id, categories into v_contractor, v_cats
    from contractors where user_id = auth.uid();
  if v_contractor is null then raise exception 'Not a contractor'; end if;

  -- Price the fee from the job's age at apply time (the aging deal). FOR UPDATE
  -- serializes concurrent applies to the same job so the cap below can't be
  -- raced past 3.
  select contractor_id, status, category, property_id,
         public.lead_fee_cents(payout_amount, created_at)
    into v_lead_contractor, v_status, v_category, v_property, v_price
    from contractor_leads where id = p_lead
    for update;
  if v_category is null then raise exception 'Job not found'; end if;
  if v_lead_contractor is not null then return false; end if;  -- already assigned
  if v_status <> 'new' then return false; end if;              -- not open
  if v_cats is not null and not (v_category = any (v_cats)) then
    raise exception 'Job is not in your categories';
  end if;
  if exists (
    select 1 from lead_applications
    where lead_id = p_lead and contractor_id = v_contractor
  ) then
    return true;  -- idempotent: already applied
  end if;

  -- One live lead per relationship (0060's rule): refuse when the pro already
  -- has an active job (not closed/lost) in this category on a property with
  -- the same owner. Closed/lost jobs never block, so rehires and repeat
  -- business stay wide open.
  select pr.user_id into v_owner from properties pr where pr.id = v_property;
  if v_owner is not null and exists (
    select 1
    from contractor_leads active
    join properties ap on ap.id = active.property_id
    where active.contractor_id = v_contractor
      and active.category = v_category
      and active.status not in ('closed', 'lost')
      and ap.user_id = v_owner
  ) then
    raise exception 'Already working with this homeowner';
  end if;

  -- Applicant cap: 3 live (non-refunded) applications fill a job. Keep in sync
  -- with MAX_APPLICANTS_PER_JOB in src/lib/constants.ts.
  if (select count(*) from lead_applications
      where lead_id = p_lead and refunded_at is null) >= 3 then
    raise exception 'Job is full';
  end if;

  v_wallet := get_or_create_wallet(v_contractor);
  -- 0065 fix: FOR UPDATE so a concurrent charge against this same wallet
  -- (a different lead, or a ghost recharge) can't read a stale balance and
  -- push cash/bonus negative. See migration header for the race.
  select cash_balance_cents, bonus_balance_cents into v_cash, v_bonus
    from wallets where id = v_wallet
    for update;
  v_cash := coalesce(v_cash, 0);
  v_bonus := coalesce(v_bonus, 0);

  -- Only bonus backed by live, unexpired grants is spendable. Capping at the
  -- grant sum makes the insufficient check honest and guarantees the FIFO drain
  -- below finds enough, so it can never zero out grants and then bail.
  select coalesce(sum(remaining_cents), 0) into v_grant_sum
    from bonus_grants
    where wallet_id = v_wallet and remaining_cents > 0 and expires_at > now();
  v_bonus_avail := least(v_bonus, v_grant_sum);

  if v_cash + v_bonus_avail < v_price then
    return false;  -- insufficient: prompt a deposit
  end if;

  select spend_cash_first into v_cash_first from wallet_config where id = 1;
  if v_cash_first then
    v_from_cash := least(v_cash, v_price);
    v_from_bonus := v_price - v_from_cash;
  else
    v_from_bonus := least(v_bonus_avail, v_price);
    v_from_cash := v_price - v_from_bonus;
  end if;

  if v_from_bonus > 0 then
    v_remaining := v_from_bonus;
    for v_grant in
      select * from bonus_grants
      where wallet_id = v_wallet and remaining_cents > 0 and expires_at > now()
      order by expires_at asc, created_at asc
    loop
      exit when v_remaining <= 0;
      if v_grant.remaining_cents >= v_remaining then
        update bonus_grants set remaining_cents = remaining_cents - v_remaining
         where id = v_grant.id;
        v_remaining := 0;
      else
        v_remaining := v_remaining - v_grant.remaining_cents;
        update bonus_grants set remaining_cents = 0 where id = v_grant.id;
      end if;
    end loop;
    if v_remaining > 0 then return false; end if;  -- unreachable safety net
  end if;

  update wallets
     set cash_balance_cents  = cash_balance_cents  - v_from_cash,
         bonus_balance_cents = bonus_balance_cents - v_from_bonus,
         updated_at = now()
   where id = v_wallet
   returning cash_balance_cents, bonus_balance_cents into v_cash_after, v_bonus_after;

  insert into lead_applications (lead_id, contractor_id, message, status, fee_cents)
    values (p_lead, v_contractor, nullif(btrim(p_message), ''), 'applied', v_price);

  insert into wallet_transactions
    (wallet_id, type, cash_delta_cents, bonus_delta_cents,
     cash_balance_after_cents, bonus_balance_after_cents, lead_id, note)
    values (v_wallet, 'apply_fee', -v_from_cash, -v_from_bonus,
            v_cash_after, v_bonus_after, p_lead, 'Applied to job');

  return true;
end; $$;

-- ---- choose_applicant -------------------------------------------------------------
create or replace function public.choose_applicant(p_application uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_lead uuid; v_contractor uuid; v_owns boolean;
  v_lead_contractor uuid; v_lead_status text;
  v_fee bigint; v_refunded timestamptz;
  v_wallet uuid; v_cash bigint; v_bonus bigint; v_bonus_avail bigint;
  v_grant_sum bigint; v_cash_first boolean;
  v_from_cash bigint; v_from_bonus bigint;
  v_remaining bigint; v_grant record;
  v_cash_after bigint; v_bonus_after bigint;
begin
  perform set_config('hearth.lead_write', 'on', true);

  select lead_id, contractor_id into v_lead, v_contractor
    from lead_applications where id = p_application;
  if v_lead is null then raise exception 'Application not found'; end if;

  select public.owns_property(cl.property_id) into v_owns
    from contractor_leads cl where cl.id = v_lead;
  if not coalesce(v_owns, false) then raise exception 'Not your job'; end if;

  -- Lock the lead so two picks serialize, and read its live assignment state.
  select contractor_id, status into v_lead_contractor, v_lead_status
    from contractor_leads where id = v_lead for update;

  -- Already assigned? A repeat pick of the same pro is an idempotent no-op;
  -- anything else means the job is taken and must not be silently reassigned.
  if v_lead_contractor is not null or coalesce(v_lead_status, 'new') <> 'new' then
    if v_lead_contractor = v_contractor then
      return;
    end if;
    raise exception 'This job has already been assigned';
  end if;

  update contractor_leads
     set contractor_id = v_contractor, status = 'accepted',
         paid = true, paid_at = now()
   where id = v_lead and contractor_id is null and status = 'new';

  -- RETURNING (not the earlier snapshot) decides the re-charge: if the ghost
  -- cron refunded this row a moment ago, the post-lock values show it and the
  -- fee gets charged again below instead of being missed.
  update lead_applications set status = 'chosen'
   where id = p_application
   returning fee_cents, refunded_at into v_fee, v_refunded;
  update lead_applications set status = 'declined'
   where lead_id = v_lead and id <> p_application and status = 'applied';

  -- Revival re-charge (ghost protection).
  if v_refunded is not null and coalesce(v_fee, 0) > 0 then
    v_wallet := get_or_create_wallet(v_contractor);
    -- 0065 fix: FOR UPDATE so this recharge can't race a concurrent apply_to_lead
    -- (or another recharge) against the same wallet and read a stale balance.
    select cash_balance_cents, bonus_balance_cents into v_cash, v_bonus
      from wallets where id = v_wallet
      for update;
    v_cash := coalesce(v_cash, 0);
    v_bonus := coalesce(v_bonus, 0);

    -- Only bonus backed by live grants is spendable; capping at the grant sum
    -- means the FIFO drain below can never come up short mid-charge.
    select coalesce(sum(remaining_cents), 0) into v_grant_sum
      from bonus_grants
      where wallet_id = v_wallet and remaining_cents > 0 and expires_at > now();
    v_bonus_avail := least(v_bonus, v_grant_sum);

    if v_cash + v_bonus_avail >= v_fee then
      select spend_cash_first into v_cash_first from wallet_config where id = 1;
      if v_cash_first then
        v_from_cash := least(v_cash, v_fee);
        v_from_bonus := v_fee - v_from_cash;
      else
        v_from_bonus := least(v_bonus_avail, v_fee);
        v_from_cash := v_fee - v_from_bonus;
      end if;

      if v_from_bonus > 0 then
        v_remaining := v_from_bonus;
        for v_grant in
          select * from bonus_grants
          where wallet_id = v_wallet and remaining_cents > 0 and expires_at > now()
          order by expires_at asc, created_at asc
        loop
          exit when v_remaining <= 0;
          if v_grant.remaining_cents >= v_remaining then
            update bonus_grants set remaining_cents = remaining_cents - v_remaining
             where id = v_grant.id;
            v_remaining := 0;
          else
            v_remaining := v_remaining - v_grant.remaining_cents;
            update bonus_grants set remaining_cents = 0 where id = v_grant.id;
          end if;
        end loop;
      end if;

      update wallets
         set cash_balance_cents  = cash_balance_cents  - v_from_cash,
             bonus_balance_cents = bonus_balance_cents - v_from_bonus,
             updated_at = now()
       where id = v_wallet
       returning cash_balance_cents, bonus_balance_cents into v_cash_after, v_bonus_after;

      insert into wallet_transactions
        (wallet_id, type, cash_delta_cents, bonus_delta_cents,
         cash_balance_after_cents, bonus_balance_after_cents, lead_id, note)
        values (v_wallet, 'ghost_recharge', -v_from_cash, -v_from_bonus,
                v_cash_after, v_bonus_after, v_lead,
                'Fee re-charged: homeowner picked you after a ghost refund');

      -- The refund is paid back, so the application is a normal paid one again.
      update lead_applications set refunded_at = null where id = p_application;
    else
      insert into wallet_transactions
        (wallet_id, type, cash_delta_cents, bonus_delta_cents,
         cash_balance_after_cents, bonus_balance_after_cents, lead_id, note)
        values (v_wallet, 'ghost_recharge_waived', 0, 0,
                v_cash, v_bonus, v_lead,
                'Ghost re-charge waived: wallet could not cover the fee');
    end if;
  end if;
end; $$;

-- ---- charge_lead -----------------------------------------------------------------
create or replace function public.charge_lead(p_lead uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare
  v_contractor uuid; v_wallet uuid;
  v_price bigint; v_paid boolean;
  v_cash bigint; v_bonus bigint; v_grant_sum bigint; v_bonus_avail bigint;
  v_from_cash bigint; v_from_bonus bigint;
  v_remaining bigint; v_grant record;
  v_cash_first boolean;
  v_cash_after bigint; v_bonus_after bigint;
begin
  perform set_config('hearth.lead_write', 'on', true);

  select id into v_contractor from contractors where user_id = auth.uid();
  if v_contractor is null then raise exception 'Not a contractor'; end if;

  select round(payout_amount * 100)::bigint, paid into v_price, v_paid
    from contractor_leads where id = p_lead and contractor_id = v_contractor;
  if v_price is null then raise exception 'Lead not found'; end if;
  if v_paid then return true; end if;

  v_wallet := get_or_create_wallet(v_contractor);
  -- 0065 fix: FOR UPDATE, matching apply_to_lead / choose_applicant.
  select cash_balance_cents, bonus_balance_cents into v_cash, v_bonus
    from wallets where id = v_wallet
    for update;
  v_cash := coalesce(v_cash, 0);
  v_bonus := coalesce(v_bonus, 0);

  -- Only bonus backed by live, unexpired grants is spendable. Capping at the
  -- grant sum makes the insufficient check honest and guarantees the FIFO
  -- drain below finds enough, so it can never zero out grants and then bail
  -- without charging (the pre-0059 bug).
  select coalesce(sum(remaining_cents), 0) into v_grant_sum
    from bonus_grants
    where wallet_id = v_wallet and remaining_cents > 0 and expires_at > now();
  v_bonus_avail := least(v_bonus, v_grant_sum);

  if v_cash + v_bonus_avail < v_price then
    return false;  -- insufficient: caller should prompt a deposit
  end if;

  select spend_cash_first into v_cash_first from wallet_config where id = 1;

  if v_cash_first then
    v_from_cash := least(v_cash, v_price);
    v_from_bonus := v_price - v_from_cash;
  else
    v_from_bonus := least(v_bonus_avail, v_price);
    v_from_cash := v_price - v_from_bonus;
  end if;

  if v_from_bonus > 0 then
    v_remaining := v_from_bonus;
    for v_grant in
      select * from bonus_grants
      where wallet_id = v_wallet and remaining_cents > 0 and expires_at > now()
      order by expires_at asc, created_at asc
    loop
      exit when v_remaining <= 0;
      if v_grant.remaining_cents >= v_remaining then
        update bonus_grants set remaining_cents = remaining_cents - v_remaining
         where id = v_grant.id;
        v_remaining := 0;
      else
        v_remaining := v_remaining - v_grant.remaining_cents;
        update bonus_grants set remaining_cents = 0 where id = v_grant.id;
      end if;
    end loop;
    if v_remaining > 0 then return false; end if;  -- unreachable safety net
  end if;

  update wallets
     set cash_balance_cents  = cash_balance_cents  - v_from_cash,
         bonus_balance_cents = bonus_balance_cents - v_from_bonus,
         updated_at = now()
   where id = v_wallet
   returning cash_balance_cents, bonus_balance_cents into v_cash_after, v_bonus_after;

  update contractor_leads set paid = true, paid_at = now() where id = p_lead;

  insert into wallet_transactions
    (wallet_id, type, cash_delta_cents, bonus_delta_cents,
     cash_balance_after_cents, bonus_balance_after_cents, lead_id, note)
    values (v_wallet, 'lead_charge', -v_from_cash, -v_from_bonus,
            v_cash_after, v_bonus_after, p_lead, 'Lead unlocked');

  return true;
end; $$;

-- Restate charge_lead's client-role lockdown for standalone re-runnability
-- (CREATE OR REPLACE does not change grants when the signature is
-- unchanged, and this migration otherwise makes no grant changes).
revoke all on function public.charge_lead(uuid) from public;
revoke all on function public.charge_lead(uuid) from anon;
revoke all on function public.charge_lead(uuid) from authenticated;
grant execute on function public.charge_lead(uuid) to service_role;

-- ---- rehire_pro (not in the original 3-RPC list - see header) --------------------
create or replace function public.rehire_pro(
  p_property    uuid,
  p_contractor  uuid,
  p_category    text,
  p_description text,
  p_timing      text default null
)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_has_history boolean;
  v_name        text;
  v_email       text;
  v_phone       text;
  v_address1    text;
  v_city        text;
  v_state       text;
  v_address     text;
  v_lead_id     uuid;
begin
  perform set_config('hearth.lead_write', 'on', true);

  if not coalesce(public.owns_property(p_property), false) then
    raise exception 'Not your property';
  end if;

  -- Prior-hire check: the homeowner must have had this pro assigned to a job
  -- (accepted = active, closed = completed) on any property they own. Not
  -- restricted to the current property, since "my pros" spans the household.
  select exists (
    select 1
    from contractor_leads cl
    join properties p on p.id = cl.property_id
    where p.user_id = auth.uid()
      and cl.contractor_id = p_contractor
      and cl.status in ('accepted', 'closed')
  ) into v_has_history;
  if not v_has_history then
    raise exception 'You have not hired this pro before';
  end if;

  -- Contact + address snapshot, same fields a normal posted job carries, so the
  -- new lead renders in the pro's pipeline exactly like any other assigned job.
  select full_name, email, phone into v_name, v_email, v_phone
    from users where id = auth.uid();
  select address_line1, city, state into v_address1, v_city, v_state
    from properties where id = p_property;
  v_address := concat_ws(', ', v_address1, v_city, v_state);

  insert into contractor_leads (
    property_id, issue_id, contractor_id, category, status, payout_amount,
    homeowner_name, homeowner_email, homeowner_phone, property_address,
    issue_description, issue_severity, timing, paid, paid_at
  ) values (
    p_property, null, p_contractor, p_category, 'accepted', 0,
    v_name, v_email, v_phone, v_address,
    p_description, null, p_timing, true, now()
  ) returning id into v_lead_id;

  return v_lead_id;
end; $$;

-- =============================================================================
-- RISK - READ BEFORE APPLYING
--
-- 1. The status CHECK constraint is added NOT VALID, so it will not fail to
--    apply even if some existing row already has an out-of-vocabulary status,
--    but it WILL start rejecting any INSERT/UPDATE that touches such a row
--    with anything other than a fix to a valid value (and will reject any
--    write introducing a new bad value anywhere). Before or right after
--    applying, run:
--      select id, status from public.contractor_leads
--      where status not in ('new','accepted','closed','lost');
--    and, once clean, run
--      alter table public.contractor_leads validate constraint contractor_leads_status_valid;
--    so the guarantee actually covers every row, not just new writes.
--
-- 2. status itself is deliberately left updatable directly by whichever
--    party RLS already lets touch the row (a pro on their own assigned
--    lead via updateLeadStatusAction; a homeowner on their own lead via the
--    "contractor_leads owner all" policy, which has no column restriction).
--    This migration does not change that. A malicious homeowner can still,
--    via a raw PostgREST call, set their own lead's status to any OTHER
--    valid value out of the app's normal sequence (e.g. flip an open,
--    actively-applied-to job straight to 'closed' or 'lost' without going
--    through closeJobAction's "no cancel once a pro applied" guard, or set
--    it to 'accepted' with contractor_id still null). contractor_id / paid /
--    paid_at stay locked either way, so this cannot be turned into a free
--    assignment or a faked payment - the money-and-assignment hole this
--    migration targets is closed - but it can still corrupt a job's
--    displayed lifecycle state or interfere with the ghost-protection /
--    applicant-nudge crons, which key off status. If that turns out to
--    matter, the follow-up is a second trigger (or extending this one) that
--    only allows a status transition when the row's contractor_id already
--    equals the caller's own contractor id (mirroring what the "leads
--    contractor update" policy already intends), which would need
--    coordination with whoever owns src/app/pro/actions.ts since
--    updateLeadStatusAction is the only legitimate direct-client writer.
--
-- 3. This migration was written and reasoned about, but NOT executed against
--    any database (per instructions). Please dry-run it against a staging
--    copy of the live schema before applying to production, in particular
--    to confirm the NOT VALID status check and the four CREATE OR REPLACE
--    function bodies match what actually exists live (this was written from
--    a read of 0065_wallet_lock_on_charge.sql / 0030_rehire.sql as the
--    latest definitions in the migrations directory, confirmed by grepping
--    for every "create or replace function public.<name>" across all 76
--    prior migrations - but the live DB's actual current state was not and
--    could not be queried directly).
-- =============================================================================
