-- =============================================================================
-- Hearth - money-safety fixes (0058)
-- RUN THIS AGAINST THE LIVE DATABASE (Supabase SQL editor) before Stripe live
-- mode is turned on. Every change here is idempotent and safe to re-run.
--
-- Four confirmed wallet-money bugs, all verified against the authoritative SQL:
--
--  1. DEPOSIT IDEMPOTENCY (critical). The Stripe deposit webhook called
--     apply_deposit with no dedup, so a duplicated checkout.session.completed
--     delivery double-credited cash and granted the tier bonus twice. This
--     adds a processed_stripe_events claim table and threads a p_event_id key
--     through apply_deposit, exactly like grant_membership_credit (0034) is
--     already keyed on the invoice id. A replayed event becomes a no-op.
--
--  2. BONUS DRAIN (apply_to_lead). It gated on the raw wallets.bonus_balance_cents
--     counter, then drained bonus_grants FIFO, and on a short fall returned
--     false AFTER the drain already ran. A plain PL/pgSQL return does not roll
--     back, so the drain committed and the pro lost bonus with no application.
--     Reachable whenever the counter is higher than the live grant sum (e.g.
--     expired grants still counted; see #4 of the launch runbook). Fixed by
--     capping spendable bonus at the live grant sum up front, the same way
--     choose_applicant already does, so the insufficient-funds check is honest
--     and the FIFO drain can never come up short.
--
--  3. DOUBLE-ASSIGN (choose_applicant). It reassigned the lead unconditionally,
--     with no row lock and no "still open" guard, so two picks on the same job
--     left two 'chosen' rows and reassigned it. The first pro paid and silently
--     lost the job. Fixed by locking the lead FOR UPDATE and only assigning
--     while it is still unclaimed; a repeat pick of the same pro is a no-op and
--     a pick of a different pro on an already-assigned job is refused.
--
-- (expire_bonus, the fourth wallet bug, needed no SQL: the 0010 function is
--  already granted to service_role by 0019. It only lacked a schedule, which
--  the new /api/cron/expire-bonus route + vercel.json entry now provide.)
-- =============================================================================

-- ---- 1. Idempotency claim table + event-keyed apply_deposit ------------------

-- One row per Stripe event we have processed. The deposit path claims the
-- event id here inside the same transaction that credits the wallet, so a
-- duplicate or replayed delivery finds the row and bows out. Touched only by
-- the security-definer function below and the service role; no client policy.
create table if not exists public.processed_stripe_events (
  event_id     text primary key,
  kind         text,
  processed_at timestamptz not null default now()
);
alter table public.processed_stripe_events enable row level security;

-- Replacing the signature (adding p_event_id): drop the 0032 three-arg version
-- first, otherwise a 3-arg call would be ambiguous against the new function's
-- defaulted fourth parameter.
drop function if exists public.apply_deposit(uuid, bigint, int);

-- Apply a successful deposit: credit cash, grant the tier bonus, write the
-- ledger. Called by the Stripe webhook (service role). p_bonus_boost_pts is the
-- Pro membership boost (0 reproduces the base behavior). p_event_id is the
-- Stripe event id: when supplied, the deposit is applied at most once for that
-- event, ever. A null/blank key reproduces the pre-0058 (non-idempotent)
-- behavior so any older caller still works.
create or replace function public.apply_deposit(
  p_contractor uuid,
  p_deposit_cents bigint,
  p_bonus_boost_pts int default 0,
  p_event_id text default null
)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_wallet uuid;
  v_pct bigint;
  v_bonus bigint;
  v_days int;
  v_cash_after bigint;
  v_bonus_after bigint;
begin
  -- Idempotency: claim the event id up front. If another delivery already
  -- claimed it, this insert affects no row and we return without touching the
  -- wallet. The claim commits with the credit below (same transaction), and a
  -- concurrent duplicate blocks on the primary key until this one commits and
  -- then sees the conflict.
  if p_event_id is not null and btrim(p_event_id) <> '' then
    insert into processed_stripe_events (event_id, kind)
      values (p_event_id, 'deposit')
      on conflict (event_id) do nothing;
    if not found then
      return;
    end if;
  end if;

  v_wallet := get_or_create_wallet(p_contractor);

  -- Matched tier percentage (0 when the deposit is below every tier) plus the
  -- caller-supplied boost points.
  select coalesce((
    select bonus_pct
    from deposit_tiers
    where p_deposit_cents >= min_cents
      and (max_cents is null or p_deposit_cents <= max_cents)
    order by min_cents desc
    limit 1
  ), 0) into v_pct;
  v_pct := v_pct + greatest(coalesce(p_bonus_boost_pts, 0), 0);
  v_bonus := (p_deposit_cents * v_pct) / 100;

  select bonus_expiry_days into v_days from wallet_config where id = 1;

  update wallets
     set cash_balance_cents = cash_balance_cents + p_deposit_cents, updated_at = now()
   where id = v_wallet
   returning cash_balance_cents, bonus_balance_cents into v_cash_after, v_bonus_after;
  insert into wallet_transactions
    (wallet_id, type, cash_delta_cents, cash_balance_after_cents, bonus_balance_after_cents, note)
    values (v_wallet, 'deposit', p_deposit_cents, v_cash_after, v_bonus_after, 'Deposit');

  if v_bonus > 0 then
    update wallets
       set bonus_balance_cents = bonus_balance_cents + v_bonus, updated_at = now()
     where id = v_wallet
     returning cash_balance_cents, bonus_balance_cents into v_cash_after, v_bonus_after;
    insert into bonus_grants (wallet_id, amount_cents, remaining_cents, expires_at)
      values (v_wallet, v_bonus, v_bonus, now() + (v_days || ' days')::interval);
    insert into wallet_transactions
      (wallet_id, type, bonus_delta_cents, cash_balance_after_cents, bonus_balance_after_cents, note)
      values (v_wallet, 'bonus_grant', v_bonus, v_cash_after, v_bonus_after, 'Deposit bonus');
  end if;
end; $$;

-- Re-apply the 0019/0032 lockdown for the new signature: CREATE grants EXECUTE
-- to PUBLIC by default, and only the service role (Stripe webhook) may call it.
revoke all on function public.apply_deposit(uuid, bigint, int, text) from public;
revoke all on function public.apply_deposit(uuid, bigint, int, text) from anon;
revoke all on function public.apply_deposit(uuid, bigint, int, text) from authenticated;
grant execute on function public.apply_deposit(uuid, bigint, int, text) to service_role;

-- ---- 2. apply_to_lead: cap spendable bonus at the live grant sum -------------
-- Identical to the 0028 version except the balance gate now measures bonus by
-- the live grant sum (v_bonus_avail), not the raw wallet counter, so the
-- insufficient check is accurate and the FIFO drain can never run partway and
-- then return false. Signature is unchanged, so CREATE OR REPLACE preserves the
-- existing EXECUTE grant to authenticated.
create or replace function public.apply_to_lead(p_lead uuid, p_message text)
returns boolean language plpgsql security definer set search_path = public as $$
declare
  v_contractor uuid; v_wallet uuid; v_cats text[];
  v_lead_contractor uuid; v_status text; v_category text; v_price bigint;
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

  -- Applicant cap: 3 live (non-refunded) applications fill a job. Keep in sync
  -- with MAX_APPLICANTS_PER_JOB in src/lib/constants.ts.
  if (select count(*) from lead_applications
      where lead_id = p_lead and refunded_at is null) >= 3 then
    raise exception 'Job is full';
  end if;

  v_wallet := get_or_create_wallet(v_contractor);
  select cash_balance_cents, bonus_balance_cents into v_cash, v_bonus
    from wallets where id = v_wallet;
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

-- ---- 3. choose_applicant: lock the lead and guard the assignment -------------
-- Identical to the 0028 version except the lead is locked FOR UPDATE and only
-- assigned while it is still unclaimed, so a double-pick can't reassign it or
-- leave two 'chosen' rows. Re-picking the same pro is a no-op; picking a
-- different pro on an already-assigned job is refused. The ghost-protection
-- revival re-charge below is unchanged. Signature unchanged, so CREATE OR
-- REPLACE preserves the existing EXECUTE grant to authenticated.
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
