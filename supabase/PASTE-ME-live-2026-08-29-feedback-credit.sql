-- ============================================================================
-- HEARTH LIVE-DB BUNDLE: migration 0144 (2026-08-29)
-- Paste this WHOLE file into the Supabase SQL editor and run it ONCE.
-- Safe to re-run: every statement is idempotent.
--
-- WHAT THIS IS: the pro side's product-feedback form and the one-time $5 of
-- BONUS lead credit that thanks a pro for filling it in. One new table
-- (public.pro_feedback) and one new function (grant_feedback_credit).
--
-- WHAT IT IS NOT: a rating, a review, or anything to do with the App Store or
-- Play Store. Paying for a store rating is forbidden by App Store Review
-- Guidelines 1.1.7 / 3.2.2 and Google Play policy, and the FTC treats an
-- undisclosed incentivised review as deceptive. Nothing in this file reads or
-- writes public.app_feedback, which is where the rating-prompt events live
-- (migrations 0133 and 0142). What is paid for here is a private note about
-- the product, which is a paid research response, not a paid review.
--
-- ORDER: run this AFTER the 0129-0143 files. It needs 0010 (wallets,
-- bonus_grants, wallet_transactions, get_or_create_wallet, wallet_config) and
-- 0073 (promo_claims), both of which are long live, plus public.contractors.
-- Nothing later depends on it.
--
-- IF YOU DELAY THIS: nothing breaks and nobody sees an error page. The card on
-- the pro Home tab still offers the credit and the form still opens; the
-- submit reports "That did not save", and no money moves. Once you run this,
-- a pro who already qualified gets their credit on the next Home render (the
-- page retries the grant when it sees feedback with no claim behind it).
--
-- NO CONTRACTORS-COLUMN GRANTS ARE NEEDED HERE, unlike 0141: this file adds no
-- column to an existing table. The new table is created with RLS and its own
-- policies, and the function is service-role only.
-- ============================================================================

-- >>>>>>>>>> BEGIN 0144_pro_feedback_credit.sql >>>>>>>>>>

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

-- <<<<<<<<<< END 0144_pro_feedback_credit.sql <<<<<<<<<<


-- ============================================================================
-- VERIFY. Run these after the bundle above; each says what it should return.
-- ============================================================================

-- 1. The table is there with the columns the app writes.
select column_name, data_type, is_nullable
  from information_schema.columns
 where table_schema = 'public'
   and table_name = 'pro_feedback'
 order by ordinal_position;
-- EXPECT: id | uuid | NO, contractor_id | uuid | NO, user_id | uuid | NO,
--         score | smallint | NO, message | text | NO,
--         contact_ok | boolean | NO, created_at | timestamp with time zone | NO

-- 2. One note per contractor, ever. THIS IS WHAT MAKES THE CREDIT ONCE-ONLY
--    ON THE FEEDBACK SIDE.
select conname, contype, convalidated
  from pg_constraint
 where conrelid = 'public.pro_feedback'::regclass
   and contype in ('u', 'c')
 order by conname;
-- EXPECT: three rows -> the score 1-5 check, the message-length check, and a
--         unique constraint on contractor_id. All with convalidated = t.

-- 3. RLS is on and both policies exist.
select policyname, cmd
  from pg_policies
 where schemaname = 'public'
   and tablename = 'pro_feedback'
 order by policyname;
-- EXPECT: two rows -> "pro_feedback self insert" | INSERT
--                     "pro_feedback self select" | SELECT
-- If this comes back empty, RLS policies did not apply. Re-run part 1.

-- 4. The function exists, is SECURITY DEFINER, and has a pinned search_path.
select p.proname, p.prosecdef, p.proconfig
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname = 'grant_feedback_credit';
-- EXPECT: one row -> grant_feedback_credit | t | {search_path=public}

-- 5. ONLY service_role may execute it. THIS IS THE ONE THAT CATCHES A
--    HALF-APPLIED RUN: if `authenticated` shows up here, the revoke did not
--    run and a signed-in pro could call the function directly.
select grantee, privilege_type
  from information_schema.routine_privileges
 where routine_schema = 'public'
   and routine_name = 'grant_feedback_credit'
 order by grantee;
-- EXPECT: service_role | EXECUTE (and postgres, which owns it). NOT anon,
--         NOT authenticated, NOT PUBLIC.

-- 6. Nothing existing was disturbed: no feedback and no credit yet.
select
  (select count(*) from public.pro_feedback) as notes,
  (select count(*) from public.promo_claims
    where promo_key = 'pro_feedback_credit') as credits_claimed,
  (select count(*) from public.wallet_transactions
    where type = 'feedback_credit') as credit_ledger_rows;
-- EXPECT: 0 | 0 | 0 right after applying. All three climb together as pros
--         send feedback; credits_claimed and credit_ledger_rows must ALWAYS
--         match each other (the grant writes both in one transaction), and
--         notes is greater than or equal to them (a pro who has not qualified
--         yet has sent a note with no credit behind it).
