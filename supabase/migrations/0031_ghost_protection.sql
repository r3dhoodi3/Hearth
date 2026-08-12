-- =============================================================================
-- Hearth - ghost protection, applicant cap, softer aging tiers
-- RUN THIS AGAINST THE LIVE DATABASE (Supabase SQL editor).
--
-- Three related changes to the job board's money mechanics:
--
-- 1. GHOST PROTECTION: if a pro pays to apply and the homeowner never engages
--    (no pick, no message) for 7 days while the job sits untouched, the apply
--    fee comes back automatically - restored exactly as it was charged (cash
--    back to cash, bonus back to bonus with a fresh 60-day grant). A daily cron
--    (src/app/api/cron/ghost-protection) calls ghost_refund_application(), which
--    re-checks everything atomically so re-runs and concurrent runs are safe.
--    If the homeowner later picks that pro anyway, choose_applicant() re-charges
--    the fee (the refund was for a dead lead, and the lead turned out alive).
--
-- 2. APPLICANT CAP: 3 live (non-refunded) applications fill a job. Pros stop
--    burning fees on crowded postings, and a ghost refund frees its spot. Keep
--    the cap in sync with MAX_APPLICANTS_PER_JOB in src/lib/constants.ts.
--
-- 3. AGING TIERS SOFTEN from 25/40% to 15/30% off: ghost protection now covers
--    dead-lead risk, so the deep discount double-compensated. Keep in sync with
--    AGING_LEAD_TIERS in src/lib/leadPricing.ts.
--
-- Safe to re-run.
-- =============================================================================

-- ---- Refund marker on applications ------------------------------------------
alter table public.lead_applications
  add column if not exists refunded_at timestamptz;

-- The cron scans for old, live, never-refunded applications.
create index if not exists lead_applications_ghost_idx
  on public.lead_applications (created_at)
  where refunded_at is null and status = 'applied';

-- ---- Aging markdown: 15% off at 3 days, 30% off at 7 -------------------------
create or replace function public.lead_fee_cents(p_payout numeric, p_created timestamptz)
returns bigint language sql stable set search_path = public as $$
  select greatest(0, round(
    coalesce(p_payout, 0) * 100 * case
      when p_created is null then 1.0
      when now() - p_created >= interval '7 days' then 0.70  -- 30% off
      when now() - p_created >= interval '3 days' then 0.85  -- 15% off
      else 1.0
    end
  ))::bigint;
$$;

-- ---- Ghost refund: give a ghosted pro their apply fee back --------------------
-- Called only by the daily cron (service role). Returns true iff it refunded.
-- Every eligibility rule is re-checked in here, and the refunded_at-is-null
-- guard on the claiming UPDATE means two concurrent runs can never both refund.
create or replace function public.ghost_refund_application(p_application uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare
  v_app record; v_claimed uuid; v_wallet uuid; v_txn record;
  v_cash_back bigint := 0; v_bonus_back bigint := 0; v_days int;
  v_cash_after bigint; v_bonus_after bigint;
begin
  -- Eligibility: a real, paid, still-waiting application at least 7 days old.
  select la.id, la.lead_id, la.contractor_id, la.fee_cents, la.created_at
    into v_app
    from lead_applications la
    where la.id = p_application
      and la.refunded_at is null
      and la.status = 'applied'
      and la.fee_cents > 0
      and la.created_at <= now() - interval '7 days';
  if v_app.id is null then return false; end if;

  -- The job must still be sitting untouched: nobody picked, still open.
  if not exists (
    select 1 from contractor_leads cl
    where cl.id = v_app.lead_id and cl.contractor_id is null and cl.status = 'new'
  ) then return false; end if;

  -- Any homeowner message in the job's thread after the application counts as
  -- engagement, so no refund. (The thread is per-lead; sender_role marks the
  -- side, so this catches homeowner replies regardless of sender_id.)
  if exists (
    select 1 from messages m
    where m.lead_id = v_app.lead_id
      and m.sender_role = 'homeowner'
      and m.created_at > v_app.created_at
  ) then return false; end if;

  -- Claim the refund atomically before touching money. The status recheck in
  -- the WHERE matters: if choose_applicant flips this row to 'chosen' while we
  -- were reading the (older) snapshot above, this update re-evaluates against
  -- the fresh row after the lock and correctly claims nothing.
  update lead_applications set refunded_at = now()
   where id = p_application and refunded_at is null and status = 'applied'
   returning id into v_claimed;
  if v_claimed is null then return false; end if;

  v_wallet := get_or_create_wallet(v_app.contractor_id);

  -- Restore EXACTLY what was charged: split cash/bonus from the original fee
  -- ledger row (deltas were stored negative). If that row is somehow missing,
  -- fall back to refunding the whole fee as cash - never short the pro.
  select cash_delta_cents, bonus_delta_cents into v_txn
    from wallet_transactions
    where wallet_id = v_wallet and lead_id = v_app.lead_id and type = 'apply_fee'
    order by created_at asc
    limit 1;
  if v_txn.cash_delta_cents is not null then
    v_cash_back  := greatest(0, -v_txn.cash_delta_cents);
    v_bonus_back := greatest(0, -v_txn.bonus_delta_cents);
  else
    v_cash_back := v_app.fee_cents;
  end if;

  update wallets
     set cash_balance_cents  = cash_balance_cents  + v_cash_back,
         bonus_balance_cents = bonus_balance_cents + v_bonus_back,
         updated_at = now()
   where id = v_wallet
   returning cash_balance_cents, bonus_balance_cents into v_cash_after, v_bonus_after;

  -- Restored bonus behaves like bonus: a fresh grant, expiring like the
  -- deposit flow's grants (wallet_config.bonus_expiry_days, default 60).
  if v_bonus_back > 0 then
    select bonus_expiry_days into v_days from wallet_config where id = 1;
    insert into bonus_grants (wallet_id, amount_cents, remaining_cents, expires_at)
      values (v_wallet, v_bonus_back, v_bonus_back,
              now() + (coalesce(v_days, 60) || ' days')::interval);
  end if;

  insert into wallet_transactions
    (wallet_id, type, cash_delta_cents, bonus_delta_cents,
     cash_balance_after_cents, bonus_balance_after_cents, lead_id, note)
    values (v_wallet, 'ghost_refund', v_cash_back, v_bonus_back,
            v_cash_after, v_bonus_after, v_app.lead_id,
            'Ghost protection: homeowner never responded');

  return true;
end; $$;

-- Cron-only entry point: no auth.uid() check inside, so client roles must
-- never be able to call it (same treatment as apply_deposit in 0019).
revoke all on function public.ghost_refund_application(uuid) from public;
revoke all on function public.ghost_refund_application(uuid) from anon;
revoke all on function public.ghost_refund_application(uuid) from authenticated;
grant execute on function public.ghost_refund_application(uuid) to service_role;

-- ---- apply_to_lead: 0025's logic + the 3-spot applicant cap -------------------
-- Only the cap block is new (marked below). Raised as an exception, not
-- returned false, so the UI can tell "full" apart from "insufficient balance".
create or replace function public.apply_to_lead(p_lead uuid, p_message text)
returns boolean language plpgsql security definer set search_path = public as $$
declare
  v_contractor uuid; v_wallet uuid; v_cats text[];
  v_lead_contractor uuid; v_status text; v_category text; v_price bigint;
  v_cash bigint; v_bonus bigint; v_from_cash bigint; v_from_bonus bigint;
  v_remaining bigint; v_grant record; v_cash_first boolean;
  v_cash_after bigint; v_bonus_after bigint;
begin
  select id, categories into v_contractor, v_cats
    from contractors where user_id = auth.uid();
  if v_contractor is null then raise exception 'Not a contractor'; end if;

  -- Price the fee from the job's age at apply time (the aging deal).
  -- FOR UPDATE serializes concurrent applies to the same job, so the cap
  -- count below can't be raced past 3 by simultaneous applicants.
  select contractor_id, status, category,
         public.lead_fee_cents(payout_amount, created_at)
    into v_lead_contractor, v_status, v_category, v_price
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

  -- NEW: applicant cap. 3 live applications fill a job; a ghost refund frees
  -- its spot (refunded rows don't count). Keep in sync with
  -- MAX_APPLICANTS_PER_JOB in src/lib/constants.ts.
  if (select count(*) from lead_applications
      where lead_id = p_lead and refunded_at is null) >= 3 then
    raise exception 'Job is full';
  end if;

  v_wallet := get_or_create_wallet(v_contractor);
  select cash_balance_cents, bonus_balance_cents into v_cash, v_bonus
    from wallets where id = v_wallet;
  if coalesce(v_cash, 0) + coalesce(v_bonus, 0) < v_price then
    return false;  -- insufficient: prompt a deposit
  end if;

  select spend_cash_first into v_cash_first from wallet_config where id = 1;
  if v_cash_first then
    v_from_cash := least(v_cash, v_price);
    v_from_bonus := v_price - v_from_cash;
  else
    v_from_bonus := least(v_bonus, v_price);
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
    if v_remaining > 0 then return false; end if;  -- safety
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

-- ---- choose_applicant: 0012's behavior + revival re-charge --------------------
-- Everything through "declines the rest" is unchanged. New: if the chosen
-- application had been ghost-refunded, the lead turned out alive after all, so
-- the fee is owed again. Charge it (cash first, then bonus, same order as
-- apply_to_lead); if the wallet can't cover it, the homeowner still gets their
-- pro (homeowner-positive) and a zero-delta 'ghost_recharge_waived' ledger row
-- records the miss.
create or replace function public.choose_applicant(p_application uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_lead uuid; v_contractor uuid; v_owns boolean;
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

  update contractor_leads
     set contractor_id = v_contractor, status = 'accepted',
         paid = true, paid_at = now()
   where id = v_lead;

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
    select cash_balance_cents, bonus_balance_cents into v_cash, v_bonus
      from wallets where id = v_wallet;
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

-- ---- open_jobs_for_me: spots taken + a photos signal --------------------------
-- application_count now counts only LIVE (non-refunded) applications, so it is
-- exactly "spots taken" out of the 3-spot cap. has_photos powers a quality chip
-- on the job card (photos ride on the originating issue). Return type changes,
-- so drop + recreate; CREATE re-grants EXECUTE to authenticated by default,
-- which 0019 documents as intentional for this function.
drop function if exists public.open_jobs_for_me();
create function public.open_jobs_for_me()
returns table (
  id                uuid,
  category          text,
  timing            text,
  issue_description text,
  issue_severity    text,
  payout_amount     numeric,
  created_at        timestamptz,
  application_count bigint,
  has_photos        boolean
) language sql security definer set search_path = public as $$
  select cl.id, cl.category, cl.timing, cl.issue_description,
         cl.issue_severity, cl.payout_amount, cl.created_at,
         (select count(*) from lead_applications la
           where la.lead_id = cl.id and la.refunded_at is null),
         (cl.issue_id is not null and exists (
           select 1 from photos p
           where p.related_type = 'issue' and p.related_id = cl.issue_id))
  from contractor_leads cl
  join contractors c on c.user_id = auth.uid()
  where cl.contractor_id is null
    and cl.status = 'new'
    and (c.categories is null or cl.category = any (c.categories))
    and not exists (
      select 1 from lead_applications la
      where la.lead_id = cl.id and la.contractor_id = c.id
    )
  order by cl.created_at desc;
$$;

-- ---- my_applications: expose refunded_at -------------------------------------
-- The pro's pending list shows a "Fee returned" chip on refunded applications.
-- Return type changes, so drop + recreate (same grant note as above).
drop function if exists public.my_applications();
create function public.my_applications()
returns table (
  application_id    uuid,
  lead_id           uuid,
  status            text,
  fee_cents         bigint,
  applied_at        timestamptz,
  category          text,
  timing            text,
  issue_description text,
  issue_severity    text,
  payout_amount     numeric,
  lead_status       text,
  refunded_at       timestamptz
) language sql security definer set search_path = public as $$
  select la.id, la.lead_id, la.status, la.fee_cents, la.created_at,
         cl.category, cl.timing, cl.issue_description, cl.issue_severity,
         cl.payout_amount, cl.status, la.refunded_at
  from lead_applications la
  join contractors c on c.id = la.contractor_id and c.user_id = auth.uid()
  join contractor_leads cl on cl.id = la.lead_id
  order by la.created_at desc;
$$;
