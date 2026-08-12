-- =============================================================================
-- Hearth - aging-lead deals
-- RUN THIS AGAINST THE LIVE DATABASE (Supabase SQL editor).
--
-- A job that sits unclaimed gets an automatic markdown on the per-apply fee, so
-- pros get a deal and stale inventory clears. The charged fee is computed from
-- the job's age at apply time. Keep these tiers in sync with the app helper in
-- src/lib/leadPricing.ts (agingDiscountPct):
--   0-2 days open: full price
--   3-6 days open: 25% off
--   7+  days open: 40% off
--
-- Only apply_to_lead changes behavior: v_price now comes from lead_fee_cents()
-- instead of round(payout_amount * 100). All wallet math, idempotency, and the
-- insufficient-balance path are unchanged.
-- =============================================================================

-- Effective apply fee (cents) for a lead, after the aging markdown.
create or replace function public.lead_fee_cents(p_payout numeric, p_created timestamptz)
returns bigint language sql stable set search_path = public as $$
  select greatest(0, round(
    coalesce(p_payout, 0) * 100 * case
      when p_created is null then 1.0
      when now() - p_created >= interval '7 days' then 0.60  -- 40% off
      when now() - p_created >= interval '3 days' then 0.75  -- 25% off
      else 1.0
    end
  ))::bigint;
$$;

-- Apply to a job: charge the aged per-category fee (cash first, then bonus).
-- Returns true if applied (or already applied), false if the balance is short.
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
  select contractor_id, status, category,
         public.lead_fee_cents(payout_amount, created_at)
    into v_lead_contractor, v_status, v_category, v_price
    from contractor_leads where id = p_lead;
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
