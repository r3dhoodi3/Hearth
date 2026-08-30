-- =============================================================================
-- Hearth - pro product feedback, and the one-time $5 lead credit that thanks
-- a pro for sending it.
-- RUN THIS AGAINST THE LIVE DATABASE (Supabase SQL editor).
--
-- WHAT THIS IS NOT. This is NOT a rating, a public review, or an App Store /
-- Play review, and no reward here may ever be attached to one. App Store
-- Review Guidelines 1.1.7 / 3.2.2 and Google Play policy both forbid paying
-- for ratings, and the FTC treats an undisclosed incentivised review as
-- deceptive. Migration 0142 and src/lib/reviewPrompt.ts say the same thing at
-- length about app_feedback's rating kinds (prompt_shown / rate_clicked /
-- rated / loved / not_really). NOTHING in this file touches app_feedback.
--
-- What IS paid for is a private note about the product, sent through a form
-- only the pro and Hearth ever see, stored on its own table. That is a paid
-- research response, not a paid review.
--
-- Two objects:
--
--   public.pro_feedback        one note per contractor, ever. score 1-5,
--                              message 20..2000 chars, optional
--                              "you may contact me" flag.
--   grant_feedback_credit()    the atomic, once-ever $5 bonus credit.
--
-- The credit is BONUS credit: the non-cash, lead-fee-only kind, granted as a
-- bonus_grants tranche plus the wallet counter plus a ledger row, exactly like
-- grant_membership_credit (0037), grant_winback_credit (0041) and
-- grant_referral_rewards (0091). It can never pay for a Hearth Pro membership:
-- the Pro checkout is Stripe-only and never reads the wallet.
--
-- Depends on: 0010 (wallets / bonus_grants / wallet_transactions /
-- get_or_create_wallet / wallet_config) and 0073 (promo_claims).
--
-- Safe to re-run.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. The table
-- ---------------------------------------------------------------------------
create table if not exists public.pro_feedback (
  id            uuid primary key default gen_random_uuid(),
  -- One note per BUSINESS, not per user: the credit lands in the business's
  -- wallet, so the business is the thing that can only be paid once. Unique,
  -- which is also what makes a double submit a plain 23505 instead of a race.
  contractor_id uuid not null unique
                  references public.contractors (id) on delete cascade,
  user_id       uuid not null references auth.users (id) on delete cascade,
  score         smallint not null check (score between 1 and 5),
  -- A note short enough to be a shrug is not feedback. The app states the
  -- floor before the tap; this is the database saying the same thing.
  message       text not null check (
                  char_length(btrim(message)) between 20 and 2000
                ),
  contact_ok    boolean not null default false,
  created_at    timestamptz not null default now()
);

create index if not exists pro_feedback_user_idx
  on public.pro_feedback (user_id);
create index if not exists pro_feedback_created_idx
  on public.pro_feedback (created_at desc);

comment on table public.pro_feedback is
  'One private product-feedback note per contractor, and the row grant_feedback_credit pays a one-time $5 bonus lead credit against. NOT a rating and NOT a store review: no row here may ever be tied to app_feedback''s rating kinds. See migration 0142 and src/lib/reviewPrompt.ts.';

alter table public.pro_feedback enable row level security;

-- Insert your own row, read your own row back. The app writes through the
-- service role (so it can grant the credit in the same request), but a pro
-- being able to see what they sent is the difference between a form and a
-- black hole, and there is nothing private about their own words.
drop policy if exists "pro_feedback self insert" on public.pro_feedback;
create policy "pro_feedback self insert" on public.pro_feedback
  for insert to authenticated
  with check (user_id = auth.uid());

drop policy if exists "pro_feedback self select" on public.pro_feedback;
create policy "pro_feedback self select" on public.pro_feedback
  for select to authenticated
  using (user_id = auth.uid());

-- No update and no delete policy, deliberately: feedback is a sent message,
-- not a document. Nobody edits it after the credit has been paid against it.

-- ---------------------------------------------------------------------------
-- 2. The grant
-- ---------------------------------------------------------------------------
-- Once per contractor account, ever, and ATOMIC.
--
-- HOW ONCE-EVER IS ENFORCED. The insert into promo_claims is the gate: its
-- primary key is (user_id, promo_key), so exactly one call can ever land the
-- row, and `found` tells that caller it won. Everything after that insert
-- happens in the same transaction, so a second call - a double tap, two tabs,
-- the Home tab's retry - takes the `on conflict do nothing` path, returns
-- false, and moves no money. Same primitive as claim_promo (0073), inlined
-- here so the claim and the credit cannot end up in two transactions.
--
-- SECURITY DEFINER, unlike the newer claim_free_ai_taste (0135, invoker): this
-- one writes wallets, bonus_grants, wallet_transactions and promo_claims, all
-- of which the calling role must not be able to write directly. Definer is
-- what the other money functions use for exactly that reason. `set search_path
-- = public` pins the schema this body resolves against. EXECUTE is granted to
-- service_role only, and revoked from everyone else, as the last word below.
create or replace function public.grant_feedback_credit(
  p_contractor uuid,
  p_amount_cents bigint default 500
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid;
  v_wallet uuid;
  v_expiry_days int;
  v_cash_after bigint;
  v_bonus_after bigint;
  v_claimed boolean;
begin
  -- The amount is server-chosen (service_role only), but a future caller
  -- bug must not be able to mint more than the advertised $5. Hard cap here,
  -- in the one place that actually moves credit.
  if p_contractor is null or coalesce(p_amount_cents, 0) <= 0
     or p_amount_cents > 500 then
    return false;
  end if;

  -- The wallet belongs to the contractor; the promo claim belongs to the user
  -- behind it, so a pro who deletes and rebuilds their company row cannot
  -- collect twice.
  select user_id into v_user from contractors where id = p_contractor;
  if v_user is null then
    return false;
  end if;

  -- The note has to exist first. Without this the credit could be claimed by
  -- calling the function directly, with no feedback ever sent.
  if not exists (select 1 from pro_feedback where contractor_id = p_contractor) then
    return false;
  end if;

  v_wallet := get_or_create_wallet(p_contractor);

  -- Serialize concurrent calls for this wallet before the claim, the same
  -- order grant_membership_credit uses: two requests arriving together both
  -- reach the insert below, and the loser must wait here rather than race the
  -- balance update.
  perform 1 from wallets where id = v_wallet for update;

  insert into promo_claims (user_id, promo_key, ref)
    values (v_user, 'pro_feedback_credit', p_contractor::text)
    on conflict (user_id, promo_key) do nothing;
  v_claimed := found;

  -- Somebody else already claimed it (or this is a retry). Nothing moves.
  if not v_claimed then
    return false;
  end if;

  select coalesce(bonus_expiry_days, 60) into v_expiry_days
    from wallet_config where id = 1;
  v_expiry_days := coalesce(v_expiry_days, 60);

  -- Granted bonus behaves like bonus everywhere else: a tranche that expires
  -- (drawn FIFO by the spend paths) plus the wallet counter plus a ledger row.
  insert into bonus_grants (wallet_id, amount_cents, remaining_cents, expires_at)
    values (v_wallet, p_amount_cents, p_amount_cents,
            now() + (v_expiry_days || ' days')::interval);

  update wallets
     set bonus_balance_cents = bonus_balance_cents + p_amount_cents,
         updated_at = now()
   where id = v_wallet
   returning cash_balance_cents, bonus_balance_cents
   into v_cash_after, v_bonus_after;

  insert into wallet_transactions
    (wallet_id, type, bonus_delta_cents,
     cash_balance_after_cents, bonus_balance_after_cents, note)
    values (v_wallet, 'feedback_credit', p_amount_cents,
            v_cash_after, v_bonus_after,
            'Feedback thank-you credit');

  return true;
end;
$$;

comment on function public.grant_feedback_credit(uuid, bigint) is
  'One-time $5 bonus lead credit for a contractor who sent product feedback (public.pro_feedback). Atomic and idempotent through promo_claims'' (user_id, promo_key) primary key: a second call returns false and moves no money. Never tied to an app-store rating. Service role only.';

-- The grant is the LAST thing said about this function, deliberately: whoever
-- reads or edits this block should see the full role list with nothing after
-- it that could be mistaken for a second grant.
revoke all on function public.grant_feedback_credit(uuid, bigint)
  from public, anon, authenticated;
grant execute on function public.grant_feedback_credit(uuid, bigint)
  to service_role;
