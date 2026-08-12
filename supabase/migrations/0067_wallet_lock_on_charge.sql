-- =============================================================================
-- Hearth - lock the wallet row before charging it (0065)
-- RUN THIS AGAINST THE LIVE DATABASE (Supabase SQL editor); editing repo SQL
-- alone does NOT change the already-deployed database. Idempotent and safe to
-- re-run.
--
-- BUG: every charge path (apply_to_lead, choose_applicant's ghost-recharge,
-- charge_lead) reads wallets.cash_balance_cents / bonus_balance_cents with a
-- plain SELECT, checks affordability against that snapshot, then does a
-- relative UPDATE (cash_balance_cents = cash_balance_cents - v_from_cash).
-- The only row lock taken anywhere in these functions is on the
-- contractor_leads row for the ONE lead being charged (FOR UPDATE) - never on
-- the wallet itself. Two different leads (or a fresh apply racing a ghost
-- recharge) lock two different lead rows, so they never serialize against
-- each other, only against the wallet's own UPDATE statement, which happens
-- AFTER the affordability check.
--
-- Concretely: wallet has exactly $25 cash, $0 bonus. A pro fires two apply
-- requests for two different $25 jobs at nearly the same instant (double
-- click across two job cards, two tabs, or a fresh apply racing a ghost
-- recharge on another lead). Both transactions SELECT the balance before
-- either commits, both see cash=$25, both pass "25 + 0 >= 25", both proceed.
-- The two UPDATEs do serialize against EACH OTHER (Postgres locks the row
-- for the UPDATE itself), but neither re-checks affordability after
-- acquiring that lock - they just subtract. Second UPDATE reads the
-- already-decremented balance (0) and subtracts 25 again, landing at -2500.
-- There is no CHECK constraint on wallets.cash_balance_cents >= 0 (confirmed:
-- grep across every migration finds no such constraint), so nothing stops
-- this. Net effect: two leads get charged and assigned/applied from a wallet
-- that only ever held enough for one, and the balance goes negative - the
-- exact "insufficient funds must fail cleanly, not go negative" failure the
-- single-request path already guards against, just reachable via a race
-- instead of a single call.
--
-- FIX: SELECT ... FOR UPDATE the wallet row before reading its balance in
-- all three charge paths. This makes the second concurrent transaction block
-- on the wallet lock (not just the eventual UPDATE), and when it wakes up it
-- re-reads the POST-first-commit balance, so its own affordability check now
-- correctly sees $0 and returns false/waives instead of overdrawing. No
-- other logic changes: charge order (spend_cash_first), the FIFO bonus
-- drain, and every existing exception/return path are untouched.
--
-- Each function below is byte-for-byte identical to its prior version (0060
-- for apply_to_lead, 0058 for choose_applicant, 0059 for charge_lead) except
-- for the added "for update" on the wallet balance SELECT. Signatures are
-- unchanged, so CREATE OR REPLACE preserves existing EXECUTE grants.
-- =============================================================================

-- ---- apply_to_lead (was 0060) -------------------------------------------------
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

-- ---- choose_applicant (was 0058) ----------------------------------------------
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

-- ---- charge_lead (was 0059) ----------------------------------------------------
-- Retired (service_role only, no client code calls it), fixed for defense in
-- depth since it shares the exact same wallet-read pattern.
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

-- charge_lead's client-role revokes were already applied by 0059 and CREATE OR
-- REPLACE does not change grants when the signature is unchanged, but restate
-- them here so this migration is correct standalone and re-runnable even if
-- run before 0059 on some environment.
revoke all on function public.charge_lead(uuid) from public;
revoke all on function public.charge_lead(uuid) from anon;
revoke all on function public.charge_lead(uuid) from authenticated;
grant execute on function public.charge_lead(uuid) to service_role;
