-- =============================================================================
-- Hearth - Pro membership wallet credit (0034)
-- RUN THIS AGAINST THE LIVE DATABASE (Supabase SQL editor).
--
-- The recurring Pro perk with money attached: every paid billing cycle grants
-- bonus lead credit to the member's wallet. The Stripe webhook (service role)
-- calls grant_membership_credit() when a subscription invoice is paid:
-- $10 (1000 cents) per monthly cycle with the standard bonus expiry, and
-- $120 (12000 cents) once per yearly cycle with a 400-day expiry so it lasts
-- the whole membership year. Amounts are keyed off the PLAN, never the amount
-- paid: the $9.99 intro first month earns the full $10 on purpose.
--
-- Idempotent per billing period: the caller passes a period key (the Stripe
-- invoice id) and the ledger note is written as the fully deterministic
-- 'Pro membership credit ' || p_period_key. A repeat call with a key already
-- on a 'membership_credit' row for that wallet (exact note match) is a no-op
-- that returns false. Duplicate webhook deliveries and retries can never
-- double-grant.
--
-- Safe to re-run.
-- =============================================================================

-- Grant one billing cycle's membership credit as expiring bonus.
-- Returns true iff it granted; false on a repeat period key, an unknown user,
-- or a non-positive amount. Called only by the Stripe webhook (service role).
create or replace function public.grant_membership_credit(
  p_user uuid,
  p_amount_cents bigint,
  p_period_key text,
  p_expiry_days int default 60
)
returns boolean language plpgsql security definer set search_path = public as $$
declare
  v_contractor uuid;
  v_wallet uuid;
  v_cash_after bigint;
  v_bonus_after bigint;
begin
  if coalesce(p_amount_cents, 0) <= 0
     or p_period_key is null
     or btrim(p_period_key) = '' then
    return false;
  end if;

  select id into v_contractor from contractors where user_id = p_user;
  if v_contractor is null then return false; end if;

  v_wallet := get_or_create_wallet(v_contractor);

  -- Serialize concurrent calls for the same wallet: two duplicate webhook
  -- deliveries landing at once both reach the guard below, and without this
  -- lock both could pass it. The second waits here, then sees the first's
  -- ledger row.
  perform 1 from wallets where id = v_wallet for update;

  -- Idempotency guard: one grant per period key, ever. The note below is
  -- fully deterministic ('Pro membership credit ' || key), so exact equality
  -- here matches precisely the row this key wrote: a re-run, a replayed
  -- event, or a duplicate delivery for the same invoice finds it and bows
  -- out, and one key can never shadow another that merely contains it.
  if exists (
    select 1 from wallet_transactions
    where wallet_id = v_wallet
      and type = 'membership_credit'
      and note = 'Pro membership credit ' || p_period_key
  ) then
    return false;
  end if;

  -- Granted bonus behaves like bonus everywhere else: a tranche that expires
  -- (drawn FIFO by the spend paths) plus the wallet counter plus a ledger row.
  insert into bonus_grants (wallet_id, amount_cents, remaining_cents, expires_at)
    values (v_wallet, p_amount_cents, p_amount_cents,
            now() + (coalesce(p_expiry_days, 60) || ' days')::interval);

  update wallets
     set bonus_balance_cents = bonus_balance_cents + p_amount_cents,
         updated_at = now()
   where id = v_wallet
   returning cash_balance_cents, bonus_balance_cents into v_cash_after, v_bonus_after;

  insert into wallet_transactions
    (wallet_id, type, bonus_delta_cents,
     cash_balance_after_cents, bonus_balance_after_cents, note)
    values (v_wallet, 'membership_credit', p_amount_cents,
            v_cash_after, v_bonus_after,
            'Pro membership credit ' || p_period_key);

  return true;
end; $$;

-- Webhook-only entry point: no auth.uid() check inside, so client roles must
-- never be able to call it (same treatment as apply_deposit in 0019/0032).
revoke all on function public.grant_membership_credit(uuid, bigint, text, int) from public;
revoke all on function public.grant_membership_credit(uuid, bigint, text, int) from anon;
revoke all on function public.grant_membership_credit(uuid, bigint, text, int) from authenticated;
grant execute on function public.grant_membership_credit(uuid, bigint, text, int) to service_role;
