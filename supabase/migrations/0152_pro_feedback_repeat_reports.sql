-- =============================================================================
-- Hearth - repeat bug reports on pro_feedback (0152)
-- RUN THIS AGAINST THE LIVE DATABASE (Supabase SQL editor); editing repo SQL
-- alone does NOT change the already-deployed database.
--
-- WHY. The owner's rule for the bug-report page: the FIRST report a business
-- ever sends earns the one-time $5 lead credit immediately, and every LATER
-- report is stored and read by a person but pays nothing automatically (a
-- discretionary thank-you of up to $15 is a human decision made outside the
-- app). Migration 0144 shipped the table with a UNIQUE constraint on
-- contractor_id - one note per business, EVER - which made a second report
-- impossible to store at all. This migration drops that cap so reports can
-- keep coming.
--
-- WHAT DOES NOT CHANGE, and why this is safe for the money:
--   * grant_feedback_credit() (0144) is untouched. Its once-ever gate never
--     was the unique row: it is promo_claims' primary key (user_id,
--     promo_key), inserted with `on conflict do nothing` inside the same
--     transaction that moves the credit, behind a wallet row lock. Two tabs
--     submitting at the same moment still pay exactly once.
--   * Its "a note must exist first" check (`if not exists (select 1 from
--     pro_feedback where contractor_id = ...)`) reads the same with one row
--     or fifty.
--   * The $5 hard cap inside the function is untouched.
--   * RLS is untouched: insert-your-own, select-your-own, no update/delete.
--
-- Safe to re-run: every statement is idempotent.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Drop the one-report-per-business unique constraint.
-- ---------------------------------------------------------------------------
-- Looked up by shape rather than hard-coding the auto-generated name
-- (pro_feedback_contractor_id_key on a fresh 0144, but a restored or renamed
-- database can differ). The primary key is contype 'p' and survives.
do $$
declare
  v_name text;
begin
  for v_name in
    select conname
      from pg_constraint
     where conrelid = 'public.pro_feedback'::regclass
       and contype = 'u'
  loop
    execute format(
      'alter table public.pro_feedback drop constraint %I', v_name
    );
  end loop;
end $$;

-- The unique index doubled as the lookup index for grant_feedback_credit's
-- exists-check and readFeedbackState's read. Replace it with a plain one.
create index if not exists pro_feedback_contractor_idx
  on public.pro_feedback (contractor_id);

-- ---------------------------------------------------------------------------
-- 2. Say what the table is now.
-- ---------------------------------------------------------------------------
comment on table public.pro_feedback is
  'Bug reports and product-feedback notes from contractors, any number per business since 0152. grant_feedback_credit pays a one-time $5 bonus lead credit against the FIRST one only, gated by promo_claims'' (user_id, promo_key) primary key; later rows never pay automatically. NOT a rating and NOT a store review: no row here may ever be tied to app_feedback''s rating kinds. See migrations 0142 and 0144.';
