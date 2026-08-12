-- =============================================================================
-- Hearth - membership credit clawback for Stripe disputes/refunds (0090)
-- RUN THIS AGAINST THE LIVE DATABASE (Supabase SQL editor). This repo's
-- migrations run through 0089 - apply whatever is missing on the live DB
-- first, then this one, before relying on it.
--
-- BUG (money audit, 2026-07-19): grant_membership_credit (0034) gives a Pro
-- member $10/mo (1000 cents) or $120/yr (12000 cents) of bonus wallet credit
-- per paid billing cycle, keyed on the invoice id. reverse_deposit (0085)
-- claws back DEPOSIT chargebacks/refunds, but the webhook's
-- resolveDepositSession only matches charges whose checkout session carries
-- metadata.type = 'deposit'. A Pro MEMBERSHIP invoice charge is never a
-- Checkout Session at all (it's an Invoice-driven subscription charge), so it
-- has no such session/metadata: if a membership charge is refunded or
-- disputed, Stripe pulls the cash back but the bonus credit it earned stays
-- spendable in the wallet. This closes that gap with a second, parallel
-- reversal path for membership credit specifically.
--
-- FIX: reverse_membership_credit, a SECURITY DEFINER function the webhook
-- calls once it resolves a disputed/refunded charge back to a Pro membership
-- invoice (via the invoice's subscription -> subscriptions.user_id ->
-- contractors, the same chain invoice.payment_succeeded already walks to
-- grant the credit in the first place). It mirrors reverse_deposit's
-- machinery exactly:
--   - Outer guard: claims p_event_id in the SAME processed_stripe_events
--     table reverse_deposit uses (kind 'membership_reversal' instead of
--     'chargeback_reversal' - event ids are globally unique across every
--     Stripe event type, so the two kinds can never collide, and a replayed
--     dispute/refund event is a provable no-op).
--   - Inner guard: membership_reversals tracks a cumulative reversed_cents
--     PER REFERENCE (the invoice id), exactly like deposit_reversals tracks
--     it per payment_intent - because one underlying chargeback still fires
--     both charge.dispute.created and charge.dispute.funds_withdrawn (same
--     dispute.amount, different event ids), and charge.refunded fires once
--     per partial refund with a cumulative amount_refunded. Event-id dedup
--     alone would let each of those re-debit the wallet.
--   - Wallet row lock (for update) before reading balances, same as every
--     other charge path since 0065.
--   - Clamped debit: cash first, then bonus, neither bucket going negative -
--     same as reverse_deposit. A membership credit is granted as bonus, but
--     by the time a chargeback lands the pro may have spent it (mixed FIFO
--     with other bonus tranches) or the wallet may otherwise be thin; a spent
--     credit is partially unrecoverable, same acceptable cost as a spent
--     deposit.
--   - FIFO drain of bonus_grants for the bonus portion, oldest-expiry first.
--   - A wallet_transactions ledger row, type 'membership_credit_reversal',
--     with a negative bonus_delta (and negative cash_delta if cash absorbed
--     any of it).
--
-- The one real difference from reverse_deposit: reverse_deposit caps its
-- target at p_deposit_cents (the deposit itself - same bucket as what's being
-- reversed). Here the money being refunded/disputed is the MEMBERSHIP PRICE
-- (e.g. $19.99/mo), a different bucket than the BONUS CREDIT that price
-- earned ($10/mo). So the cap instead comes from the actual grant: this
-- function looks up the wallet's own 'membership_credit' ledger row for this
-- reference (note = 'Pro membership credit ' || p_reference - the exact
-- deterministic note grant_membership_credit writes, keyed on the same
-- invoice id) and never reverses more than that row's bonus_delta_cents, no
-- matter how large the reported refund/dispute amount is. If no such row can
-- be found (grant predates this reference, was never granted - e.g. the
-- best-effort renewal-cycle grant silently skipped or failed - or the note
-- can't be matched), there is no proof any credit was ever granted for this
-- reference, so the target is 0: nothing is reversed. p_amount_cents is the
-- membership PRICE, not the bonus credit, so falling back to it would claw
-- back 2-3x the credit that could ever have been granted, out of whatever
-- cash/bonus the wallet happens to hold (including unrelated deposit money) -
-- the wallet-balance clamp only stops the debit from going negative, it does
-- not stop this over-claw. Under-reversing on a no-match is the safe
-- direction, since a real grant always writes the matching note.
-- =============================================================================

-- One row per membership invoice being reversed (keyed by the reference the
-- caller passes - the same invoice id grant_membership_credit was keyed on),
-- holding the cumulative cents already clawed back for it. Mirrors
-- deposit_reversals exactly, just keyed on invoice id instead of
-- payment_intent id. Touched only by reverse_membership_credit (service
-- role); no client policy.
create table if not exists public.membership_reversals (
  reference   text primary key,
  reversed_cents bigint not null default 0,
  updated_at  timestamptz not null default now()
);
alter table public.membership_reversals enable row level security;
-- No policies: only the SECURITY DEFINER RPC (via service_role) touches it.

create or replace function public.reverse_membership_credit(
  p_event_id text,
  p_contractor_id uuid,
  p_reference text,
  p_amount_cents int,
  p_reason text
)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_wallet uuid;
  v_already bigint;
  v_granted bigint;
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
  -- Outer guard: claim the event id up front, exactly like reverse_deposit.
  -- processed_stripe_events is keyed on the Stripe event id alone (globally
  -- unique across every event type), so this claim can never collide with
  -- the invoice/dispute event being reversed or with a deposit reversal on
  -- the same processed_stripe_events table. A replayed delivery of THIS
  -- SAME event bows out without touching the wallet.
  if p_event_id is null or btrim(p_event_id) = '' then
    raise exception 'reverse_membership_credit requires an event id';
  end if;
  if p_reference is null or btrim(p_reference) = '' then
    raise exception 'reverse_membership_credit requires a reference (invoice id)';
  end if;

  insert into processed_stripe_events (event_id, kind)
    values (p_event_id, 'membership_reversal')
    on conflict (event_id) do nothing;
  if not found then
    return;
  end if;

  v_wallet := get_or_create_wallet(p_contractor_id);

  -- Inner guard: lock the per-reference cumulative-reversed row (creating it
  -- on first sight of this invoice id) and compute the increment still owed.
  -- Same mechanics as deposit_reversals: dispute.created and
  -- dispute.funds_withdrawn reporting the same dispute.amount, or a run of
  -- cumulative partial refunds, collapse to v_delta = 0 once already covered.
  insert into membership_reversals (reference)
    values (p_reference)
    on conflict (reference) do nothing;

  select reversed_cents into v_already
    from membership_reversals where reference = p_reference
    for update;
  v_already := coalesce(v_already, 0);

  -- Cap the target at what this reference actually granted, so a large
  -- refund/dispute on the membership PRICE can never claw back more than the
  -- much smaller BONUS CREDIT that price earned. The note is the exact
  -- deterministic string grant_membership_credit (0034) writes for this same
  -- reference (its p_period_key), so this matches precisely the one grant
  -- row this invoice created, if any.
  select bonus_delta_cents into v_granted
    from wallet_transactions
    where wallet_id = v_wallet
      and type = 'membership_credit'
      and note = 'Pro membership credit ' || p_reference
    limit 1;

  if v_granted is not null then
    v_target := least(greatest(coalesce(p_amount_cents, 0), 0), greatest(v_granted, 0));
  else
    -- No matched grant to cap against: reverse nothing, not the reported
    -- amount. Renewal-cycle grants (invoice.payment_succeeded) are
    -- best-effort and can silently skip or fail without ever writing a
    -- membership_credit ledger row, so this branch is reachable even when no
    -- credit was ever granted for this reference. Without a matching row we
    -- have no proof any credit exists to reverse, and p_amount_cents here is
    -- the membership PRICE, not the bonus credit - falling back to it would
    -- claw back 2-3x the credit that could ever have been granted, seizing
    -- unrelated cash (e.g. deposit funds) from the wallet. Under-reversing is
    -- the safe direction: a real grant always writes the matching note, so a
    -- true grant is always found by the matched branch above.
    v_target := 0;
  end if;

  v_delta := greatest(v_target - v_already, 0);
  if v_delta = 0 then
    return;
  end if;

  -- Lock the wallet row before reading it, same as every other charge path
  -- since 0065, so a reversal can't race a concurrent spend/grant and read a
  -- stale balance.
  select cash_balance_cents, bonus_balance_cents into v_cash, v_bonus
    from wallets where id = v_wallet
    for update;
  v_cash := coalesce(v_cash, 0);
  v_bonus := coalesce(v_bonus, 0);

  -- Debit cash first, then bonus, clamped so neither bucket can go negative:
  -- the delta may exceed what's left in the wallet if the credit (or other
  -- balance) was already spent on lead fees.
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
    -- v_from_bonus (e.g. the backing grant already expired and was swept).
    -- The wallet counter below is still debited by v_from_bonus; grants
    -- simply can't be drawn past zero.
  end if;

  update wallets
     set cash_balance_cents  = cash_balance_cents  - v_from_cash,
         bonus_balance_cents = bonus_balance_cents - v_from_bonus,
         updated_at = now()
   where id = v_wallet
   returning cash_balance_cents, bonus_balance_cents into v_cash_after, v_bonus_after;

  -- Record the new cumulative total for this reference BEFORE inserting the
  -- ledger row, so a crash between the two never leaves reversed_cents behind
  -- the money that already left the wallet.
  update membership_reversals
     set reversed_cents = v_target, updated_at = now()
   where reference = p_reference;

  insert into wallet_transactions
    (wallet_id, type, cash_delta_cents, bonus_delta_cents,
     cash_balance_after_cents, bonus_balance_after_cents, note)
    values (v_wallet, 'membership_credit_reversal', -v_from_cash, -v_from_bonus,
            v_cash_after, v_bonus_after,
            coalesce(nullif(btrim(p_reason), ''), 'Membership credit reversed (chargeback/refund)'));
end; $$;

-- Service-role only: called exclusively from the Stripe webhook (verified
-- signature), never from client code. Same treatment as reverse_deposit.
revoke all on function public.reverse_membership_credit(text, uuid, text, int, text) from public;
revoke all on function public.reverse_membership_credit(text, uuid, text, int, text) from anon;
revoke all on function public.reverse_membership_credit(text, uuid, text, int, text) from authenticated;
grant execute on function public.reverse_membership_credit(text, uuid, text, int, text) to service_role;
