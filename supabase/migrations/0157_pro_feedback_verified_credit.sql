-- =============================================================================
-- OakTend - pro bug reports go to manual review (C7, 2026-09-07 tester wave)
-- RUN THIS AGAINST THE LIVE DATABASE (Supabase SQL editor); editing repo SQL
-- alone does NOT change the already-deployed database.
--
-- WHY. Migration 0144 auto-credited $5 the moment the first report was sent
-- (gated only by isEstablishedPro in the app, no human ever looked at the
-- report first). Tester feedback: pay only after a real person confirms the
-- report is a real bug. New rule, stated on the form:
--   "Thanks. We review every report; verified bugs earn up to $15 in credit."
-- Every report now lands as status 'pending'. Nothing in the app grants a
-- credit automatically any more (src/app/pro/feedback/actions.ts and
-- src/app/pro/page.tsx both dropped their calls to grant_feedback_credit).
-- Money moves ONLY through verify_pro_feedback below, run by hand from the
-- Supabase SQL editor - this repo has no admin gate anywhere (see the header
-- note in src/app/api/cron/support-digest/route.ts), so a SQL note is the
-- established pattern here, not a new admin auth surface for one feature.
--
-- WHAT DOES NOT CHANGE: 0144's grant_feedback_credit() and its once-ever
-- promo_claims gate are left in place (harmless, simply no longer called from
-- the app) rather than dropped - this repo doesn't delete working, audited
-- money code it might want to reference again. 0152's "any number of reports
-- per business" stays true. RLS (insert-your-own, select-your-own, no
-- update/delete for the pro) is untouched.
--
-- Safe to re-run: every statement is idempotent.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Review state on each report.
-- ---------------------------------------------------------------------------
alter table public.pro_feedback
  add column if not exists status text not null default 'pending'
    check (status in ('pending', 'verified', 'rejected'));
alter table public.pro_feedback
  add column if not exists credited_cents bigint not null default 0
    check (credited_cents >= 0 and credited_cents <= 1500);
alter table public.pro_feedback
  add column if not exists credited_at timestamptz;
-- Free-text note for whoever reviewed it (what the bug was, why it did or
-- didn't qualify). Filled in by hand alongside the SQL that calls
-- verify_pro_feedback below; nothing in the app reads or writes this column.
alter table public.pro_feedback
  add column if not exists review_note text;

create index if not exists pro_feedback_status_idx
  on public.pro_feedback (status) where status = 'pending';

comment on table public.pro_feedback is
  'Bug reports and product-feedback notes from contractors, any number per business since 0152. Every report starts status=pending and pays nothing on its own; verify_pro_feedback (0157) is the only way credit moves, run by hand after a person confirms the report is real, up to $15. NOT a rating and NOT a store review: no row here may ever be tied to app_feedback''s rating kinds. See migrations 0142, 0144, 0152.';

-- ---------------------------------------------------------------------------
-- 2. The manual verify-and-credit function.
-- ---------------------------------------------------------------------------
-- Run from the Supabase SQL editor, by hand, once a person has read the
-- report and decided it's real:
--   select verify_pro_feedback('<pro_feedback.id>', 1000);  -- pays $10
--   update pro_feedback set review_note = 'confirmed: X was broken'
--     where id = '<pro_feedback.id>';
-- Pass 0 to mark a report verified (a real bug, thanked, worth recording)
-- with no credit attached - not every verified report has to pay.
--
-- Idempotent by construction: it only acts on a row still status='pending'
-- (locked with `for update` first), so running it twice on the same id is a
-- no-op the second time and can never double-pay. Same bonus_grants +
-- wallet_transactions shape as grant_feedback_credit (0144) so this credit
-- shows up on /pro/billing exactly like every other bonus grant.
create or replace function public.verify_pro_feedback(
  p_feedback_id uuid,
  p_amount_cents bigint default 0
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_contractor uuid;
  v_status text;
  v_wallet uuid;
  v_expiry_days int;
  v_cash_after bigint;
  v_bonus_after bigint;
begin
  -- Hard cap: the advertised ceiling is $15, service_role only or not.
  if p_feedback_id is null or coalesce(p_amount_cents, 0) < 0
     or p_amount_cents > 1500 then
    return false;
  end if;

  select contractor_id, status into v_contractor, v_status
    from pro_feedback
   where id = p_feedback_id
     for update;

  if v_contractor is null then
    return false; -- no such report
  end if;
  if v_status <> 'pending' then
    return false; -- already verified or rejected: never re-process
  end if;

  update pro_feedback
     set status = 'verified',
         credited_cents = p_amount_cents,
         credited_at = now()
   where id = p_feedback_id;

  -- A verified report worth $0 (a real bug, but no credit attached) stops
  -- here: reviewed, recorded, no wallet write.
  if p_amount_cents = 0 then
    return true;
  end if;

  v_wallet := get_or_create_wallet(v_contractor);
  perform 1 from wallets where id = v_wallet for update;

  select coalesce(bonus_expiry_days, 60) into v_expiry_days
    from wallet_config where id = 1;
  v_expiry_days := coalesce(v_expiry_days, 60);

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
            'Verified bug report credit');

  return true;
end;
$$;

comment on function public.verify_pro_feedback(uuid, bigint) is
  'Manual review step for a pro_feedback row (C7, 2026-09-07): marks it verified and optionally credits up to $15 of bonus lead credit. Run by hand from the Supabase SQL editor after a person confirms the report; idempotent (only acts on status=pending). Service role only.';

revoke all on function public.verify_pro_feedback(uuid, bigint)
  from public, anon, authenticated;
grant execute on function public.verify_pro_feedback(uuid, bigint)
  to service_role;
