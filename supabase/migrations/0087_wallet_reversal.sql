-- =============================================================================
-- Hearth - wallet reversal for Stripe disputes/refunds (0085)
-- RUN THIS AGAINST THE LIVE DATABASE (Supabase SQL editor) before Stripe live
-- mode carries real chargebacks. Idempotent and safe to re-run.
--
-- BUG (security audit 2026-07-19, finding #2): the Stripe webhook has never
-- handled charge.dispute.created / charge.dispute.funds_withdrawn /
-- charge.refunded. A pro can deposit, spend the wallet down on lead fees,
-- then chargeback the card: Stripe pulls the money back and the wallet is
-- never touched, so the pro keeps both the spent leads and the deposit.
--
-- FIX: a SECURITY DEFINER reversal function the webhook calls once it
-- resolves a disputed/refunded charge back to the deposit it paid for. Mirrors
-- apply_deposit's (0058) event-keyed idempotency exactly, against the SAME
-- processed_stripe_events claim table: a Stripe event id is globally unique
-- across every event type, so a dispute/refund event can never collide with
-- the deposit event it is reversing, and a redelivered dispute/refund event
-- is a provable no-op the second time.
--
-- The debit clamps at 0 on both buckets (cash first, then bonus) rather than
-- going negative: by the time a chargeback lands the pro may have already
-- spent the deposit on lead fees, and there is no negative-balance recovery
-- flow. Clamping means a wallet that's already been drawn down absorbs as
-- much of the reversal as it can and no more - the unrecoverable remainder is
-- a cost of the chargeback, same as it would be for any other business.
--
-- BUG FIX (2026-07-19, follow-up): the original version above dedupes ONLY on
-- the Stripe event id. That is wrong, because ONE underlying chargeback or
-- refund produces MULTIPLE distinct events with DIFFERENT event ids covering
-- the SAME money: charge.dispute.created and charge.dispute.funds_withdrawn
-- both carry the full dispute.amount, and charge.refunded fires once per
-- partial refund with a CUMULATIVE amount_refunded. Event-id dedup lets each
-- of those events debit the wallet again, over-reversing it - and since the
-- debit is against the wallet, not the charge, a legit new deposit made while
-- a dispute is in flight can get eaten by the second event's debit.
--
-- FIX: track a cumulative reversed_cents PER CHARGE (deposit_reversals,
-- keyed on the payment_intent id) and only ever debit the wallet by the
-- INCREMENT between the new reported total and what has already been
-- reversed for that charge. processed_stripe_events remains the OUTER guard
-- (a redelivery of the exact same event is still a no-op); deposit_reversals
-- is the inner guard that makes a second, different event covering the same
-- money a no-op too.
-- =============================================================================

-- One row per disputed/refunded charge (keyed by payment_intent id), holding
-- the cumulative cents already clawed back for that charge. reverse_deposit
-- reads this under a row lock to compute the increment still owed, so a
-- dispute.created + dispute.funds_withdrawn pair (same amount) or a run of
-- cumulative partial refunds only ever debits the wallet for the delta.
-- Touched only by reverse_deposit (service role); no client policy.
create table if not exists public.deposit_reversals (
  payment_intent_id text primary key,
  reversed_cents     bigint not null default 0,
  updated_at         timestamptz not null default now()
);
alter table public.deposit_reversals enable row level security;
-- No policies: only the SECURITY DEFINER RPC (via service_role) touches it.

-- Replacing the signature entirely (payment intent + reported/deposit cents
-- instead of a single amount): drop the old 4-arg version first so there is
-- no ambiguity or stale overload left behind.
drop function if exists public.reverse_deposit(text, uuid, int, text);

create or replace function public.reverse_deposit(
  p_event_id text,
  p_contractor_id uuid,
  p_payment_intent text,
  p_reported_cents int,
  p_deposit_cents int,
  p_reason text
)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_wallet uuid;
  v_already bigint;
  v_target bigint;
  v_delta bigint;
  v_cash bigint;
  v_bonus bigint;
  v_from_cash bigint;
  v_from_bonus bigint;
  v_remaining bigint;
  v_grant record;
  v_cash_after bigint;
  v_bonus_after bigint;
begin
  -- Outer guard: claim the event id up front, exactly like apply_deposit.
  -- processed_stripe_events is keyed on the Stripe event id alone, which is
  -- globally unique across every event type, so this claim can never collide
  -- with the deposit event (or any other event) being reversed. If another
  -- delivery of THIS SAME event already claimed it, bow out without touching
  -- the wallet - a replayed dispute/refund event is a no-op, not a double
  -- debit. This does NOT catch a different event (e.g.
  -- dispute.funds_withdrawn after dispute.created) covering the same money -
  -- that's what deposit_reversals below is for.
  if p_event_id is null or btrim(p_event_id) = '' then
    raise exception 'reverse_deposit requires an event id';
  end if;
  if p_payment_intent is null or btrim(p_payment_intent) = '' then
    raise exception 'reverse_deposit requires a payment_intent id';
  end if;

  insert into processed_stripe_events (event_id, kind)
    values (p_event_id, 'chargeback_reversal')
    on conflict (event_id) do nothing;
  if not found then
    return;
  end if;

  -- Inner guard: lock the per-charge cumulative-reversed row (creating it on
  -- first sight of this payment_intent) and compute the increment still owed.
  -- p_reported_cents is whatever the event reports as the running total for
  -- this charge (dispute.amount, or refund's cumulative amount_refunded);
  -- capping the target at p_deposit_cents means a reversal can never claw
  -- back more than this charge actually deposited, no matter what Stripe
  -- reports. v_delta is 0 (a provable no-op) once a prior event has already
  -- reversed up to the same target - e.g. dispute.created and
  -- dispute.funds_withdrawn reporting the same dispute.amount.
  insert into deposit_reversals (payment_intent_id)
    values (p_payment_intent)
    on conflict (payment_intent_id) do nothing;

  select reversed_cents into v_already
    from deposit_reversals where payment_intent_id = p_payment_intent
    for update;
  v_already := coalesce(v_already, 0);

  v_target := least(greatest(coalesce(p_reported_cents, 0), 0), greatest(coalesce(p_deposit_cents, 0), 0));
  v_delta := greatest(v_target - v_already, 0);
  if v_delta = 0 then
    return;
  end if;

  v_wallet := get_or_create_wallet(p_contractor_id);

  -- Lock the wallet row before reading it, same as every other charge path
  -- since 0065, so a reversal can't race a concurrent deposit/charge and read
  -- a stale balance.
  select cash_balance_cents, bonus_balance_cents into v_cash, v_bonus
    from wallets where id = v_wallet
    for update;
  v_cash := coalesce(v_cash, 0);
  v_bonus := coalesce(v_bonus, 0);

  -- Debit cash first, then bonus, clamped so neither bucket can go negative:
  -- the delta may exceed what's left in the wallet if it was already spent on
  -- lead fees (or, now, on a legit deposit made mid-dispute that's since been
  -- spent).
  v_from_cash := least(v_cash, v_delta);
  v_from_bonus := least(v_bonus, v_delta - v_from_cash);

  if v_from_bonus > 0 then
    v_remaining := v_from_bonus;
    for v_grant in
      select * from bonus_grants
      where wallet_id = v_wallet and remaining_cents > 0
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
    -- No "remaining > 0" safety-net bail here (unlike the spend paths): a
    -- reversal must always land, even if live bonus_grants can't fully back
    -- v_from_bonus (e.g. the backing grant already expired and was swept by
    -- expire_bonus). The wallet counter below is still debited by
    -- v_from_bonus; grants simply can't be drawn past zero.
  end if;

  update wallets
     set cash_balance_cents  = cash_balance_cents  - v_from_cash,
         bonus_balance_cents = bonus_balance_cents - v_from_bonus,
         updated_at = now()
   where id = v_wallet
   returning cash_balance_cents, bonus_balance_cents into v_cash_after, v_bonus_after;

  -- Record the new cumulative total for this charge BEFORE inserting the
  -- ledger row, so a crash between the two never leaves reversed_cents behind
  -- the money that already left the wallet.
  update deposit_reversals
     set reversed_cents = v_target, updated_at = now()
   where payment_intent_id = p_payment_intent;

  insert into wallet_transactions
    (wallet_id, type, cash_delta_cents, bonus_delta_cents,
     cash_balance_after_cents, bonus_balance_after_cents, note)
    values (v_wallet, 'chargeback_reversal', -v_from_cash, -v_from_bonus,
            v_cash_after, v_bonus_after,
            coalesce(nullif(btrim(p_reason), ''), 'Deposit reversed (chargeback/refund)'));
end; $$;

-- Service-role only: called exclusively from the Stripe webhook (verified
-- signature), never from client code.
revoke all on function public.reverse_deposit(text, uuid, text, int, int, text) from public;
revoke all on function public.reverse_deposit(text, uuid, text, int, int, text) from anon;
revoke all on function public.reverse_deposit(text, uuid, text, int, int, text) from authenticated;
grant execute on function public.reverse_deposit(text, uuid, text, int, int, text) to service_role;
