-- =============================================================================
-- PASTE-ME-ALL-PENDING (rebuilt by Fable 2026-09-08 02:10 after the red team)
--
-- THE ONE FILE for tonight's migrations, in dependency order: 0155, 0156, 0157,
-- 0158, 0160, 0161, then 0162 last (see its note). 0159 was retired in the
-- renumber; nothing is missing.
-- BEFORE THIS FILE: live must be through 0154. Paste
-- supabase/PASTE-ME-ALL-PENDING-2026-09-03.sql (0154, the Hearth -> OakTend
-- rename in DB text) first if you have not.
--
-- Each section is idempotent or carries its own PRECHECK that raises and
-- applies nothing if the database is not in the expected state. The SQL editor
-- runs the whole file as ONE transaction: if any section raises, NOTHING from
-- the file is applied. Read the message, fix the cause, re-run the whole file.
--
-- Sections:
--   1. 0155: open_jobs_for_me() gains homeowner_display (First L.) so pros never see the full name before applying. drop+create. Precheck: 0138 body present.
--   2. 0156: home_systems.other_label: free-text name for an 'Other' system (B7). Precheck inside.
--   3. 0157: pro_feedback bug reports: status pending by default, no automatic $5; credit up to $15 only via verify_pro_feedback() run by hand.
--   4. 0158: two pro CRM indexes (pro_clients, pro_client_notes). Index-only, if not exists.
--   5. 0160: native_push_tokens table for the Capacitor app (APNs/FCM). RLS self-only. if not exists.
--   6. 0161: pros never see or apply to their own posted job (SEC-1). Depends on 0155 and 0153; prechecks inside.
--   7. 0162: one owner per normalized address (B8). LAST ON PURPOSE: it RAISES if two accounts already own the same address (tonight's hearth-test-* accounts can trip it). If it raises, delete the test accounts (SQL in the morning report), then re-run this file; sections 1-6 are safe to repeat.
-- =============================================================================


-- =============================================================================
-- SECTION 1 of 7: 0155_lead_apply_homeowner_display.sql
-- open_jobs_for_me() gains homeowner_display (First L.) so pros never see the full name before applying. drop+create. Precheck: 0138 body present.
-- =============================================================================

-- ---- PRECHECK (0155) ------------------------------------------------------
do $precheck$
begin
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'open_jobs_for_me'
  ) then
    raise exception 'PRECHECK (0155): public.open_jobs_for_me() does not exist yet. Paste the earlier pending migrations (through 0154) first. Nothing was changed.';
  end if;
end
$precheck$;

-- 0155: applying to a lead currently shows nothing about who is posting it
-- until after the homeowner accepts. Tester feedback C4 (2026-09-07): show a
-- first name + last initial (e.g. "Sarah M.") on the open-job card BEFORE a
-- pro applies, so they know who they're applying to, without exposing
-- anything more. Full contact info still only unlocks after acceptance
-- (contractor_leads.homeowner_name / homeowner_email / homeowner_phone, read
-- only off the ASSIGNED_* columns in src/app/pro/leads/page.tsx).
--
-- open_jobs_for_me() (0138's latest body) never selected homeowner_name at
-- all. This is COPY-ONLY of that body plus one new computed column: the raw
-- full name never crosses the wire pre-application, only the truncated
-- display string computed here.
--
-- DROP + CREATE, not CREATE OR REPLACE: adding a column to a RETURNS TABLE
-- changes the function's return type, and Postgres refuses that on a replace
-- ("cannot change return type of existing function", 42P13). Every prior
-- column addition to this function did the same (0096, 0104, 0116).
--
-- GRANTS: dropping a function drops its grants, but open_jobs_for_me() has
-- never had an explicit grant or revoke in any migration. It runs on the
-- default CREATE FUNCTION posture (EXECUTE to PUBLIC, which authenticated
-- inherits), documented as deliberate in 0019 and re-stated in 0096: the
-- body derives the caller from auth.uid() through the contractors join, so
-- an anon call returns nothing. Re-running CREATE FUNCTION reproduces that
-- exact posture, so no grant statement is needed here either.
--
-- Idempotent: DROP FUNCTION IF EXISTS + CREATE FUNCTION. Safe to re-run.

drop function if exists public.open_jobs_for_me();
create function public.open_jobs_for_me()
returns table (
  id                 uuid,
  category           text,
  timing             text,
  issue_description  text,
  issue_severity     text,
  payout_amount      numeric,
  created_at         timestamptz,
  application_count  bigint,
  has_photos         boolean,
  plus_poster        boolean,
  budget_range       text,
  city               text,
  ownership_verified boolean,
  photo_urls         text[],
  square_footage     integer,
  material_notes     text,
  has_plans_permits  boolean,
  homeowner_display  text
) language sql security definer set search_path = public as $$
  select cl.id, cl.category, cl.timing, cl.issue_description,
         cl.issue_severity, cl.payout_amount, cl.created_at,
         (select count(*) from lead_applications la
           where la.lead_id = cl.id and la.refunded_at is null),
         (cl.issue_id is not null and exists (
           select 1 from photos p
           where p.related_type = 'issue' and p.related_id = cl.issue_id)),
         exists (
           select 1
           from subscriptions s
           where s.user_id = pr.user_id
             and (s.side = 'homeowner'
                  or s.plan is null
                  or s.plan not like 'pro\_%' escape '\')
             and s.status in ('active', 'trialing')
             and (s.current_period_end is null or s.current_period_end > now())
         ) as plus_poster,
         cl.budget_range,
         pr.city,
         coalesce(pr.ownership_status = 'verified', false) as ownership_verified,
         (select array_agg(p.url order by p.uploaded_at)
            from photos p
           where p.related_type = 'issue'
             and p.related_id = cl.issue_id) as photo_urls,
         cl.square_footage,
         cl.material_notes,
         cl.has_plans_permits,
         -- First name + last initial only (C4): never the full name before a
         -- pro has applied and the homeowner has accepted them.
         case
           when cl.homeowner_name is null or btrim(cl.homeowner_name) = '' then null
           else (
             -- First name capped at 40 chars: homeowner_name has no length
             -- limit at the source (see the same cap in
             -- src/app/(app)/contractors/actions.ts), and this string is
             -- printed on a card, not a place for a 500-char "name".
             select case when array_length(parts, 1) > 1
                      then left(parts[1], 40) || ' '
                           || left(parts[array_length(parts, 1)], 1) || '.'
                      else left(parts[1], 40)
                    end
             from (select regexp_split_to_array(btrim(cl.homeowner_name), '\s+') as parts) s
           )
         end as homeowner_display
  from contractor_leads cl
  join contractors c on c.user_id = auth.uid()
  left join properties pr on pr.id = cl.property_id
  where cl.contractor_id is null
    and cl.status = 'new'
    and cl.direct_to is null
    and (c.categories is null or cl.category = any (c.categories))
    and (c.service_state is null
         or pr.state is null
         or upper(btrim(pr.state)) = upper(btrim(c.service_state)))
    and c.serves_orange_county = true
    and public.launch_city_for_zip(pr.zip) = any (c.launch_cities)
    and not exists (
      select 1 from user_blocks b
      where (b.blocker_user_id = auth.uid() and b.blocked_user_id = pr.user_id)
         or (b.blocker_user_id = pr.user_id and b.blocked_user_id = auth.uid())
    )
    and not exists (
      select 1 from lead_applications la
      where la.lead_id = cl.id and la.contractor_id = c.id
    )
  order by plus_poster desc, cl.created_at desc
  limit 200;
$$;

-- =============================================================================
-- SECTION 2 of 7: 0156_home_systems_other_label.sql
-- home_systems.other_label: free-text name for an 'Other' system (B7). Precheck inside.
-- =============================================================================

-- =============================================================================
-- OakTend - "Other" home system with a free-text name (0156)
-- RUN THIS AGAINST THE LIVE DATABASE (Supabase SQL editor).
--
-- Tester feedback B7 (2026-09-07): "Add a system" only offers a fixed list of
-- types (roof, HVAC, water heater, ...). A homeowner with something not on
-- that list (a pool pump, a septic pump, a whole-house generator) had no way
-- to add it at all. This adds an "Other" SYSTEM_TYPES option
-- (src/lib/constants.ts) whose free-text name is stored here.
--
-- home_systems.system_type stays a plain `text` column with NO check
-- constraint (confirmed against 0001_initial_schema.sql before choosing this
-- approach) - it is used as an exact-match key all over the app
-- (SYSTEM_SCHEDULE, REPLACEMENT_INFO, DEFAULT_LIFESPANS, system_lifespans,
-- categoryForSystem, ...), so "other" joins that list as one more known key
-- rather than system_type itself carrying free text. The owner's actual words
-- ("Pool pump", "Septic lift station") live in this new column instead, read
-- back by systemDisplayLabel() (src/lib/constants.ts) which falls back to the
-- plain "Other" label when this column is null, empty, or (until this file is
-- run) simply doesn't exist yet - src/app/(app)/profile/actions.ts writes it
-- through the same "retry the insert/update without the optional columns"
-- fallback the HVAC filter fields and model_number/capacity already use, so
-- adding or editing a system never breaks on a database still behind this
-- migration.
--
-- Safe to re-run.
-- =============================================================================

-- ---- PRECHECK: refuse to run against a database that isn't caught up -------
do $$
begin
  if not exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'home_systems'
  ) then
    raise exception 'PRECHECK: public.home_systems is missing. Apply migration 0001 before this file. Nothing was changed.';
  end if;
end
$$;

alter table public.home_systems
  add column if not exists other_label text;

comment on column public.home_systems.other_label is
  'Owner-entered free-text name for a system_type = ''other'' row (e.g. "Pool pump"). Ignored for every other system_type. Null-safe: systemDisplayLabel() in src/lib/constants.ts falls back to the plain "Other" label when this is null or blank.';

-- Same 80-character ceiling the app enforces (SystemForm.tsx / SystemRow.tsx
-- maxLength, profile/actions.ts server cap): a belt-and-suspenders backstop,
-- not the primary guard, so a pre-existing longer value (there can't be one
-- yet, but a future direct SQL edit could) is never silently truncated by
-- this migration - only new writes going through the app are capped.
alter table public.home_systems
  drop constraint if exists home_systems_other_label_length;
alter table public.home_systems
  add constraint home_systems_other_label_length check (
    other_label is null or char_length(other_label) <= 80
  );

-- No RLS change: home_systems already has "home_systems owner all" (0002,
-- extended to active household members by 0051, both gated by
-- owns_property()), which covers this new column with no changes.

-- ---- VERIFY -----------------------------------------------------------------
-- select column_name, data_type from information_schema.columns
--   where table_schema = 'public' and table_name = 'home_systems' and column_name = 'other_label';
-- -- expect one row: other_label | text

-- =============================================================================
-- SECTION 3 of 7: 0157_pro_feedback_verified_credit.sql
-- pro_feedback bug reports: status pending by default, no automatic $5; credit up to $15 only via verify_pro_feedback() run by hand.
-- =============================================================================

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

-- =============================================================================
-- SECTION 4 of 7: 0158_perf_indexes_2.sql
-- two pro CRM indexes (pro_clients, pro_client_notes). Index-only, if not exists.
-- =============================================================================

-- 0158: two more filter-then-sort indexes, same shape and reasoning as
-- 0148_perf_indexes.sql. 0148 covered nine tables filtered by an id and
-- ordered by created_at with no index carrying the sort column; these two
-- were introduced by the pro CRM (0052/0055) and missed that pass.
--
-- No new tables, columns, functions, policies or grants. Every statement is
-- `create index if not exists`, so this file is safe to run twice and safe to
-- run on a database that already has some of it.
--
-- WHY NOT `create index concurrently`: same reasoning as 0148 - it cannot run
-- inside a transaction block, both the Supabase SQL editor and `supabase db
-- push` wrap a migration in one, and both tables are small today.

-- ---------------------------------------------------------------------------
-- pro_clients: the CRM pipeline list, newest first
-- ---------------------------------------------------------------------------
-- src/app/pro/crm/page.tsx  contractor_id = ? order by created_at desc
-- (ran twice per request until this wave's fix removed the second, redundant
-- ilike-filtered query that duplicated this same read - see the page's own
-- comment. The one remaining read still benefits from the sort being in the
-- index.)
-- Existing: pro_clients_contractor_idx (contractor_id) - filter only.
create index if not exists pro_clients_contractor_created_idx
  on public.pro_clients (contractor_id, created_at desc);

-- ---------------------------------------------------------------------------
-- pro_client_notes: a client's note timeline, newest first
-- ---------------------------------------------------------------------------
-- src/app/pro/crm/page.tsx  client_id in (...) order by created_at desc
-- Existing: pro_client_notes_client_idx (client_id) - filter only.
create index if not exists pro_client_notes_client_created_idx
  on public.pro_client_notes (client_id, created_at desc);

-- =============================================================================
-- SECTION 5 of 7: 0160_native_push_tokens.sql
-- native_push_tokens table for the Capacitor app (APNs/FCM). RLS self-only. if not exists.
-- =============================================================================

-- =============================================================================
-- OakTend - native push tokens (0160), 2026-09-07 appstore-execute.
-- NOTE: filed as 0156 originally, renamed to 0160 to dodge a same-night numbering
-- collision with two other agents' concurrent 0156/0157 migrations. Verify the
-- final sequence number against whatever supabase/migrations/ looks like once
-- every stream's work lands - a Fable/verifier renumber pass may still move this.
-- RUN THIS AGAINST THE LIVE DATABASE (Supabase SQL editor); editing repo SQL
-- alone does NOT change the already-deployed database. Included as section 5
-- of supabase/PASTE-ME-ALL-PENDING-2026-09-07.sql (renumbered 0160 by Fable).
-- Safe to apply before the native app exists: nothing in the web app reads or
-- writes this table until the Capacitor build registers a token (see the
-- native branch in src/app/api/push/subscribe/route.ts).
--
-- WHY A SEPARATE TABLE, NOT A COLUMN ON public.push_subscriptions. That
-- table's endpoint/p256dh/auth columns are NOT NULL and web-push-specific
-- (see 0143's own header comment) - a Capacitor push-notifications APNs/FCM
-- token has none of those three fields, so bolting native support onto that
-- table would mean either loosening real NOT NULL constraints the Web Push
-- code depends on, or writing junk placeholder values into columns that are
-- supposed to be real cryptographic material. A parallel table with its own
-- shape is the honest fix.
--
-- WHAT THIS DOES NOT DO YET: nothing in src/lib/push.ts sends to a row in
-- this table - that is real APNs/FCM delivery work (a different signing
-- flow than web-push's VAPID keys entirely) not done in this pass. This
-- migration only makes the STORAGE side ready so
-- src/app/api/push/subscribe/route.ts's native branch has somewhere to
-- write, once a device registers - see that route and
-- src/lib/native/push.ts.
--
-- Safe to re-run: every statement is idempotent.
-- =============================================================================

create table if not exists public.native_push_tokens (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  side        text check (side in ('homeowner', 'pro')),
  platform    text not null check (platform in ('ios', 'android')),
  -- The raw APNs device token (iOS) or FCM registration token (Android).
  -- Unique per device/registration, same "upsert on the token" idea as
  -- push_subscriptions' unique endpoint - a device that re-registers (app
  -- reinstall, OS-issued token rotation) upserts onto the same row instead
  -- of piling up duplicates.
  token       text not null unique,
  created_at  timestamptz not null default now(),
  last_used_at timestamptz
);

create index if not exists native_push_tokens_user_id_idx
  on public.native_push_tokens (user_id);

alter table public.native_push_tokens enable row level security;

drop policy if exists "native_push_tokens self select" on public.native_push_tokens;
create policy "native_push_tokens self select" on public.native_push_tokens
  for select to authenticated
  using (user_id = auth.uid());

drop policy if exists "native_push_tokens self insert" on public.native_push_tokens;
create policy "native_push_tokens self insert" on public.native_push_tokens
  for insert to authenticated
  with check (user_id = auth.uid());

drop policy if exists "native_push_tokens self update" on public.native_push_tokens;
create policy "native_push_tokens self update" on public.native_push_tokens
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists "native_push_tokens self delete" on public.native_push_tokens;
create policy "native_push_tokens self delete" on public.native_push_tokens
  for delete to authenticated
  using (user_id = auth.uid());

revoke all on public.native_push_tokens from anon;
grant select, insert, update, delete on public.native_push_tokens to authenticated;
grant all on public.native_push_tokens to service_role;

comment on table public.native_push_tokens is
  'One row per DEVICE that has registered for native push (APNs on iOS, FCM on Android) via @capacitor/push-notifications. Separate from public.push_subscriptions (Web Push/VAPID) because the token shape is different - see the migration header comment. Self-scoped RLS, same pattern as push_subscriptions.';

-- =============================================================================
-- SECTION 6 of 7: 0161_lead_owner_exclusion.sql
-- pros never see or apply to their own posted job (SEC-1). Depends on 0155 and 0153; prechecks inside.
-- =============================================================================

-- 0161: SEC-1 - a dual-side account (homeowner AND pro on the same auth user)
-- can see, and pay to apply to, its OWN posted job. Reported in
-- fix-homeowner-flows-verify.md SEC-1 (2026-09-07 overnight wave): neither
-- open_jobs_for_me() nor apply_to_lead() ever compares the property owner to
-- auth.uid(). Harm is mostly confusion and a wasted wallet charge, not theft
-- (a pro pays themselves nothing of value), but it is the mechanism that put
-- pro pricing copy in front of someone who had just posted a job as a
-- homeowner (see the B5 report the same file names).
--
-- FIX: one owner-exclusion predicate in each function.
--   * open_jobs_for_me(): the job board itself must not list a self-posted
--     job. Added to the WHERE clause: `and pr.user_id is distinct from
--     auth.uid()`. `is distinct from` reads correctly even when pr.user_id
--     is null (a property row that failed to join) - it never hides a job
--     it shouldn't, it only ever hides the caller's own.
--   * apply_to_lead(): the charge path itself must refuse, not just the
--     board. Guard added immediately after `select pr.user_id into v_owner`
--     resolves (same line the 0138 block check and the 0060 relationship
--     check already key off of), before the block check, before any wallet
--     read, and before any row is written - so a refused self-apply moves no
--     money. Raises 'You cannot apply to your own job.', which
--     src/app/pro/actions.ts (applyToJobAction) matches on for a friendly
--     message; the SQL raise is the real enforcement (EXECUTE stays granted
--     to `authenticated`, so a signed-in pro can call apply_to_lead straight
--     over PostgREST with their own JWT, never touching that action - same
--     reasoning 0153's header gives for why its own gate has to live in SQL).
--
-- open_jobs_for_me(): DROP + CREATE, not CREATE OR REPLACE. This function's
-- RETURNS TABLE shape is unchanged here (same columns as 0155), but the
-- convention in this file is drop+create anyway - CREATE OR REPLACE only
-- works when the return type is byte-identical, and the next column this
-- function gains will need drop+create regardless (0096, 0104, 0116, 0155
-- all did). GRANTS: same posture as 0155 - open_jobs_for_me() has never had
-- an explicit grant or revoke; re-running CREATE FUNCTION reproduces the
-- default EXECUTE-to-PUBLIC posture (documented in 0019, re-stated in 0096
-- and 0155), so no grant statement is needed here.
--
-- apply_to_lead(): CREATE OR REPLACE. Signature (uuid, text) -> boolean is
-- unchanged, so this preserves its existing EXECUTE grant to `authenticated`
-- exactly as 0149 and 0153 both did for the same reason.
--
-- COPY-ONLY discipline, same as 0140/0141/0149/0153:
--   * open_jobs_for_me below is 0155's body (the latest in this folder,
--     migration 0155_lead_apply_homeowner_display.sql), byte-identical,
--     plus the one predicate above. Nothing else moved.
--   * apply_to_lead below is 0153's body (the latest in this folder,
--     migration 0153_major_job_insurance_gate.sql, Part 1), byte-identical,
--     plus the one guard block above. Nothing else moved.
--
-- DEPENDS ON 0155 (open_jobs_for_me with homeowner_display) and 0153
-- (apply_to_lead with the insurance gate). This is a TEMPORARY migration
-- number - Fable renumbers 0155-0160+ once tonight's collisions settle and
-- rebuilds supabase/PASTE-ME-ALL-PENDING-2026-09-07.sql; this file's
-- position in that rebuild must stay AFTER both 0155 and 0153.
--
-- Idempotent: DROP FUNCTION IF EXISTS + CREATE FUNCTION for
-- open_jobs_for_me, CREATE OR REPLACE for apply_to_lead. Safe to re-run.

-- ---- PRECHECK: refuse to run against a database that is not ready --------
do $precheck$
begin
  if not exists (
    select 1 from pg_proc
    where proname = 'open_jobs_for_me' and pronamespace = 'public'::regnamespace
      and prosrc like '%homeowner_display%'
  ) then
    raise exception 'PRECHECK: public.open_jobs_for_me() does not carry homeowner_display yet (migration 0155). Apply 0155 before this file. Nothing was changed.';
  end if;
  if not exists (
    select 1 from pg_proc
    where proname = 'apply_to_lead' and pronamespace = 'public'::regnamespace
      and prosrc like '%Insurance required for big jobs%'
  ) then
    raise exception 'PRECHECK: public.apply_to_lead() does not carry the big-job insurance gate yet (migration 0153). Apply 0153 before this file. Nothing was changed.';
  end if;
end;
$precheck$;

-- =============================================================================
-- Part 1: open_jobs_for_me() - 0155's body, plus the owner-exclusion predicate
-- =============================================================================
drop function if exists public.open_jobs_for_me();
create function public.open_jobs_for_me()
returns table (
  id                 uuid,
  category           text,
  timing             text,
  issue_description  text,
  issue_severity     text,
  payout_amount      numeric,
  created_at         timestamptz,
  application_count  bigint,
  has_photos         boolean,
  plus_poster        boolean,
  budget_range       text,
  city               text,
  ownership_verified boolean,
  photo_urls         text[],
  square_footage     integer,
  material_notes     text,
  has_plans_permits  boolean,
  homeowner_display  text
) language sql security definer set search_path = public as $$
  select cl.id, cl.category, cl.timing, cl.issue_description,
         cl.issue_severity, cl.payout_amount, cl.created_at,
         (select count(*) from lead_applications la
           where la.lead_id = cl.id and la.refunded_at is null),
         (cl.issue_id is not null and exists (
           select 1 from photos p
           where p.related_type = 'issue' and p.related_id = cl.issue_id)),
         exists (
           select 1
           from subscriptions s
           where s.user_id = pr.user_id
             and (s.side = 'homeowner'
                  or s.plan is null
                  or s.plan not like 'pro\_%' escape '\')
             and s.status in ('active', 'trialing')
             and (s.current_period_end is null or s.current_period_end > now())
         ) as plus_poster,
         cl.budget_range,
         pr.city,
         coalesce(pr.ownership_status = 'verified', false) as ownership_verified,
         (select array_agg(p.url order by p.uploaded_at)
            from photos p
           where p.related_type = 'issue'
             and p.related_id = cl.issue_id) as photo_urls,
         cl.square_footage,
         cl.material_notes,
         cl.has_plans_permits,
         -- First name + last initial only (C4): never the full name before a
         -- pro has applied and the homeowner has accepted them.
         case
           when cl.homeowner_name is null or btrim(cl.homeowner_name) = '' then null
           else (
             -- First name capped at 40 chars: homeowner_name has no length
             -- limit at the source (see the same cap in
             -- src/app/(app)/contractors/actions.ts), and this string is
             -- printed on a card, not a place for a 500-char "name".
             select case when array_length(parts, 1) > 1
                      then left(parts[1], 40) || ' '
                           || left(parts[array_length(parts, 1)], 1) || '.'
                      else left(parts[1], 40)
                    end
             from (select regexp_split_to_array(btrim(cl.homeowner_name), '\s+') as parts) s
           )
         end as homeowner_display
  from contractor_leads cl
  join contractors c on c.user_id = auth.uid()
  left join properties pr on pr.id = cl.property_id
  where cl.contractor_id is null
    and cl.status = 'new'
    and cl.direct_to is null
    -- 0161 SEC-1: never list a job the caller posted as a homeowner. A dual-
    -- side account (a contractors row AND a properties row on the same auth
    -- user) must not see, apply to, or pay to apply to its own job. `is
    -- distinct from` reads correctly even when pr.user_id is null (a
    -- property that failed to join): it only ever excludes the caller's own
    -- row, never anyone else's.
    and pr.user_id is distinct from auth.uid()
    and (c.categories is null or cl.category = any (c.categories))
    and (c.service_state is null
         or pr.state is null
         or upper(btrim(pr.state)) = upper(btrim(c.service_state)))
    and c.serves_orange_county = true
    and public.launch_city_for_zip(pr.zip) = any (c.launch_cities)
    and not exists (
      select 1 from user_blocks b
      where (b.blocker_user_id = auth.uid() and b.blocked_user_id = pr.user_id)
         or (b.blocker_user_id = pr.user_id and b.blocked_user_id = auth.uid())
    )
    and not exists (
      select 1 from lead_applications la
      where la.lead_id = cl.id and la.contractor_id = c.id
    )
  order by plus_poster desc, cl.created_at desc
  limit 200;
$$;

comment on function public.open_jobs_for_me() is
  'Open job board for the signed-in pro (0012, latest body 0161). 0161 adds '
  'the SEC-1 owner-exclusion predicate: a job whose property.user_id matches '
  'the caller (a dual-side account viewing its own posted job) is never '
  'listed. 0155''s homeowner_display column is unchanged.';

-- =============================================================================
-- Part 2: apply_to_lead - 0153's body, plus the SEC-1 self-apply guard
-- =============================================================================
create or replace function public.apply_to_lead(p_lead uuid, p_message text)
returns boolean language plpgsql security definer set search_path = public as $$
declare
  v_contractor uuid; v_wallet uuid; v_cats text[]; v_oc boolean;
  v_launch_cities text[]; v_lead_city text;
  v_lead_contractor uuid; v_status text; v_category text; v_price bigint;
  v_property uuid; v_owner uuid;
  v_cash bigint; v_bonus bigint; v_grant_sum bigint; v_bonus_avail bigint;
  v_from_cash bigint; v_from_bonus bigint;
  v_remaining bigint; v_grant record; v_cash_first boolean;
  v_cash_after bigint; v_bonus_after bigint;
  -- 0149: raw job age/price inputs, this pro's membership, and the pricing
  -- verdict recorded on the application row.
  v_payout numeric; v_created timestamptz;
  v_is_member boolean; v_aging_pct int; v_member_pct int;
  v_discount_kind text; v_price_before_intro bigint;
  -- 0153: this pro's insurance expiry (compliance calendar, 0051), for the
  -- big-job gate below.
  v_insurance_expires date;
begin
  perform set_config('hearth.lead_write', 'on', true);

  -- 0153: insurance_expires rides the contractors select this function
  -- already makes, so the gate costs no extra query.
  select id, categories, serves_orange_county, launch_cities, insurance_expires
    into v_contractor, v_cats, v_oc, v_launch_cities, v_insurance_expires
    from contractors where user_id = auth.uid();
  if v_contractor is null then raise exception 'Not a contractor'; end if;

  -- 0132: an open payment dispute freezes spending. has_open_chargeback() is
  -- true only while this pro's account carries an uncleared abuse_flags row of
  -- kind 'chargeback' (written by the Stripe webhook on
  -- charge.dispute.created). Placed here, immediately after the contractor
  -- resolves and BEFORE the job is read, before any wallet lock, and before a
  -- single cent moves: a pro who has charged back a wallet top-up is spending
  -- money the platform has already lost, and the wallet balance still says it
  -- is there. Cleared by setting abuse_flags.cleared_at (service role only), so
  -- a dispute that is won or withdrawn unfreezes the account without erasing
  -- that it happened.
  if public.has_open_chargeback(v_contractor) then
    raise exception 'There is an unresolved payment dispute on your account. Contact support.';
  end if;

  -- 0087 fix (MED): reproduce open_jobs_for_me()'s hard Orange County launch
  -- gate here too, so a pro who never confirmed serves_orange_county can't
  -- bypass the board by applying directly against a leaked/guessed lead id.
  if not coalesce(v_oc, false) then
    raise exception 'Confirm the cities you serve in your profile before applying to jobs';
  end if;

  -- 0149: read the raw price inputs instead of pre-pricing with
  -- lead_fee_cents (aging only) here - the pricing block right below needs
  -- this pro's membership too, and FOR UPDATE still serializes concurrent
  -- applies to the same job so the applicant cap below can't be raced past 3.
  select contractor_id, status, category, property_id, payout_amount, created_at
    into v_lead_contractor, v_status, v_category, v_property, v_payout, v_created
    from contractor_leads where id = p_lead
    for update;
  if v_category is null then raise exception 'Job not found'; end if;

  -- 0149: price this lead with the best SINGLE discount available - this
  -- pro's own OakTend Pro membership (10%) or the aging markdown, never both.
  -- is_pro_member mirrors isLiveProPlanRow() in src/lib/subscription.ts;
  -- lead_aging_pct is the same tiers lead_fee_cents (0031) already charges,
  -- as a bare percent. discount_kind is recorded on the application row
  -- below so the receipt and the board can both say what actually happened;
  -- ties (both 0) record null, and the flat member percent can never
  -- literally tie a nonzero aging tier at today's numbers, but the >=
  -- comparison keeps aging as the deterministic winner if it ever does.
  v_is_member := public.is_pro_member(auth.uid());
  v_aging_pct := public.lead_aging_pct(v_created);
  v_member_pct := case when v_is_member then 10 else 0 end;
  if v_aging_pct = 0 and v_member_pct = 0 then
    v_discount_kind := null;
  elsif v_aging_pct >= v_member_pct then
    v_discount_kind := 'aging';
  else
    v_discount_kind := 'member';
  end if;
  v_price := public.pro_lead_fee_cents(v_payout, v_created, v_is_member);

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

  -- 0153: big jobs need current insurance on file. The three categories are
  -- the major tier (mirror LEAD_FEES in src/lib/constants.ts and
  -- major_lead_price_cents, 0113); the date rule mirrors hasCurrentInsurance
  -- in src/lib/insuranceGate.ts (a date today or later passes, nothing on
  -- file or a past date fails). Deliberately AFTER the idempotent
  -- already-applied return above - a pro who already paid for this lead keeps
  -- the honest `true` on a retry even if their insurance lapsed since (same
  -- reasoning as 0124's launch-city gate placement) - and BEFORE any wallet
  -- read or write, so a refused apply moves no money. The raise text is what
  -- applyToJobAction matches on (isInsuranceGateSqlError) to show the
  -- friendly message; keep it stable.
  if v_category in ('roof', 'structural', 'remodeling')
     and (v_insurance_expires is null or v_insurance_expires < current_date) then
    raise exception 'Insurance required for big jobs';
  end if;

  -- 0124: the per-city half of the launch gate, mirroring the identical line
  -- open_jobs_for_me() filters the board on. Deliberately AFTER the
  -- already-applied idempotent return above: a pro who paid for this lead and
  -- later narrowed their launch_cities still gets the honest `true` on a
  -- retry, never a geography error for a job they already hold. Still before
  -- any money moves or any row is written.
  select public.launch_city_for_zip(p.zip) into v_lead_city
    from properties p where p.id = v_property;
  if v_lead_city is null or not (v_lead_city = any (coalesce(v_launch_cities, '{}'))) then
    raise exception 'This job is outside the cities you serve. Update your service area in your profile.';
  end if;

  -- One live lead per relationship (0060's rule): refuse when the pro already
  -- has an active job (not closed/lost) in this category on a property with
  -- the same owner. Closed/lost jobs never block, so rehires and repeat
  -- business stay wide open.
  select pr.user_id into v_owner from properties pr where pr.id = v_property;

  -- 0161 SEC-1: a dual-side account (homeowner AND pro on the same auth user)
  -- must not be able to pay to apply to its own posted job. Placed
  -- immediately after v_owner resolves - the earliest point this function
  -- knows who the property owner is - and before the block check, before
  -- any wallet read, and before any row is written, so a refused self-apply
  -- moves no money. Raised text is matched by applyToJobAction in
  -- src/app/pro/actions.ts for a friendly message; this SQL raise is the
  -- real enforcement (see this file's header for why it must live here and
  -- not only in the server action).
  if v_owner is not null and v_owner = auth.uid() then
    raise exception 'You cannot apply to your own job.';
  end if;

  -- 0138: a block between these two people. Symmetric, and worded without
  -- saying which side blocked whom - the pro must not be able to use this
  -- error to learn that a particular homeowner blocked them. Placed on the
  -- first line that knows who the homeowner is, and still before every wallet
  -- read, every debit, and every insert.
  if v_owner is not null and public.blocked_between(auth.uid(), v_owner) then
    raise exception 'This job is not available to you.';
  end if;

  if v_owner is not null and exists (
    select 1
    from contractor_leads active
    join properties ap on ap.id = active.property_id
    where active.contractor_id = v_contractor
      and active.category = v_category
      and active.status not in ('closed', 'lost')
      and ap.user_id = v_owner
  ) then
    raise exception 'Already working with this homeowner';
  end if;

  -- Applicant cap: 3 live (non-refunded) applications fill a job. Keep in sync
  -- with MAX_APPLICANTS_PER_JOB in src/lib/constants.ts.
  if (select count(*) from lead_applications
      where lead_id = p_lead and refunded_at is null) >= 3 then
    raise exception 'Job is full';
  end if;

  v_wallet := get_or_create_wallet(v_contractor);
  -- 0065 fix: FOR UPDATE so a concurrent charge against this same wallet
  -- (a different lead, or a ghost recharge) can't read a stale balance and
  -- push cash/bonus negative. See migration header for the race.
  select cash_balance_cents, bonus_balance_cents into v_cash, v_bonus
    from wallets where id = v_wallet
    for update;
  v_cash := coalesce(v_cash, 0);
  v_bonus := coalesce(v_bonus, 0);

  -- 0113: first big-ticket lead intro price. Deliberately placed AFTER the
  -- wallet FOR UPDATE above: all of a pro's charges serialize on that lock,
  -- so two racing major applies can never both read "no prior major payment"
  -- (see 0113's header). No-op for non-major categories and for any pro who
  -- has ever paid for a major lead.
  --
  -- 0149: the intro price is fixed and never further discounted by the
  -- member/aging pricing above - least() inside major_lead_price_cents just
  -- takes whichever is lower, so it can only ever push the charge DOWN to
  -- 4999, never below it. When it does undercut the member/aging price,
  -- discount_kind flips to 'intro' so the receipt names the real reason,
  -- not the discount it overrode.
  v_price_before_intro := v_price;
  v_price := public.major_lead_price_cents(v_contractor, v_category, v_price);
  if v_price < v_price_before_intro then
    v_discount_kind := 'intro';
  end if;

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

  insert into lead_applications (lead_id, contractor_id, message, status, fee_cents, discount_kind)
    values (p_lead, v_contractor, nullif(btrim(p_message), ''), 'applied', v_price, v_discount_kind);

  insert into wallet_transactions
    (wallet_id, type, cash_delta_cents, bonus_delta_cents,
     cash_balance_after_cents, bonus_balance_after_cents, lead_id, note)
    values (v_wallet, 'apply_fee', -v_from_cash, -v_from_bonus,
            v_cash_after, v_bonus_after, p_lead, 'Applied to job');

  return true;
end; $$;

comment on function public.apply_to_lead(uuid, text) is
  'Charges the lead fee and records an application (0012, latest body 0161). '
  '0153 added the big-job insurance gate; 0161 adds the SEC-1 self-apply '
  'guard: raises ''You cannot apply to your own job.'' when the resolved '
  'property owner (v_owner) equals auth.uid(), placed immediately after '
  'v_owner resolves and before any wallet read or write.';

-- =============================================================================
-- VERIFY (run after applying; each should come back as described)
-- =============================================================================

-- 1. The board excludes self-posted jobs.
--   select prosrc like '%pr.user_id is distinct from auth.uid()%'
--     from pg_proc
--    where proname = 'open_jobs_for_me' and pronamespace = 'public'::regnamespace;
--   -> t

-- 2. apply_to_lead carries the guard, with its exact raise text.
--   select prosrc like '%You cannot apply to your own job.%'
--     from pg_proc
--    where proname = 'apply_to_lead' and pronamespace = 'public'::regnamespace;
--   -> t

-- 3. Both functions kept their grants (CREATE OR REPLACE preserves
--    apply_to_lead's; re-running CREATE FUNCTION on open_jobs_for_me
--    reproduces its always-been-default posture).
--   select routine_name, grantee, privilege_type
--     from information_schema.routine_privileges
--    where routine_schema = 'public'
--      and routine_name in ('open_jobs_for_me', 'apply_to_lead');
--   -> apply_to_lead includes authenticated | EXECUTE;
--      open_jobs_for_me includes PUBLIC | EXECUTE (or authenticated, which
--      inherits from PUBLIC - either is the unchanged default posture)

-- 4. Dry run, on a copy: as a dual-side account (a contractors row and a
--    properties row on the same auth user), post a job as the homeowner side,
--    then as the pro side call select public.open_jobs_for_me() - the job
--    must not appear. Then select public.apply_to_lead('<that lead id>', null)
--    - must raise 'You cannot apply to your own job.' and must not touch
--    wallets, lead_applications or wallet_transactions. A job posted by a
--    DIFFERENT homeowner must still appear on the board and apply normally.

-- =============================================================================
-- SECTION 7 of 7: 0162_properties_address_unique_global.sql
-- one owner per normalized address (B8). LAST ON PURPOSE: it RAISES if two accounts already own the same address (tonight's hearth-test-* accounts can trip it). If it raises, delete the test accounts (SQL in the morning report), then re-run this file; sections 1-6 are safe to repeat.
-- =============================================================================

-- =============================================================================
-- OakTend - lock a claimed address against a second owner (0162)
-- RUN THIS AGAINST THE LIVE DATABASE (Supabase SQL editor).
--
-- Tester feedback B8 (2026-09-07): once a homeowner claims their address,
-- nobody else should be able to claim the SAME address as its owner too.
-- Before this, two unrelated accounts could each end up with their own
-- properties row for one physical home, each one seeing themselves as the
-- owner - a second household simply invited to share the home is fine and
-- stays fine (that flow adds a household_members row against the EXISTING
-- property, never a second properties row), but a stranger creating a
-- competing "I own this too" row was never refused.
--
-- This is a DIFFERENT, narrower index than properties_owner_address_unique
-- (migration 0151): that one is scoped PER OWNER - (user_id, address, zip,
-- unit) - and only stops the SAME person double-claiming (a double-submit,
-- two open tabs). This index drops user_id from the key entirely, so it is
-- one home per (normalized street line, zip, unit) FULL STOP, across every
-- account. The app-level check-then-insert guard in
-- src/app/onboarding/actions.ts (claimPropertyAction, right above the
-- properties insert) is the primary guard and is what produces the plain
-- "This address is already registered..." message a homeowner actually
-- sees; this index is the database backstop against the same race
-- properties_owner_address_unique already guards for the per-owner case -
-- two truly concurrent claims of the one address from two different
-- accounts.
--
-- WHAT THIS DELIBERATELY REFUSES, so nobody is surprised by it later:
--   * A duplex, ADU, or granny flat where BOTH homes are entered with the
--     same street line and NO unit. The second one has to enter a unit
--     ("A"/"B"/"Rear"), which is what unit is in the key for. The refusal
--     copy in claimPropertyAction says so.
--   * A home that CHANGES HANDS. The previous owner's row keeps the address
--     forever, so a buyer cannot claim it themselves; they contact support
--     and a person moves the home. That is a deliberate trade (an address
--     lock is what the tester asked for) but it IS a manual path, and it
--     will happen in the real world - it needs an owner-facing transfer flow
--     before this product has any volume. Deleting the old account frees the
--     address automatically (properties cascades with the auth user).
--
-- Safe to re-run.
-- =============================================================================

-- ---- PRECHECK: refuse to run against a database that isn't caught up -------
do $$
begin
  if not exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'properties'
  ) then
    raise exception 'PRECHECK: public.properties is missing. Apply migration 0001 before this file. Nothing was changed.';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'properties' and column_name = 'unit'
  ) then
    raise exception 'PRECHECK: public.properties.unit is missing. Apply migration 0127 before this file. Nothing was changed.';
  end if;
end
$$;

-- Existing duplicate-address rows across DIFFERENT owners would make the
-- index build fail with a bare unique_violation. Check first and name them,
-- same courtesy 0151 gave the per-owner version of this index, so whoever
-- runs this gets a precise cleanup list instead of a cryptic Postgres error.
-- A duplicate here is not necessarily a bug to panic over - it may be two
-- accounts that should be merged into one household - but it does need a
-- human decision before this index can go on.
do $$
declare v_dupes int;
begin
  select count(*) into v_dupes from (
    select 1
    from public.properties
    group by lower(regexp_replace(btrim(address_line1), '\s+', ' ', 'g')),
             coalesce(zip, ''),
             lower(regexp_replace(btrim(coalesce(unit, '')), '\s+', ' ', 'g'))
    having count(*) > 1
  ) d;
  if v_dupes > 0 then
    raise exception
      'B8: % duplicate (address, zip, unit) group(s) already exist in public.properties across different owners, so this index cannot be built. NOTHING WAS CHANGED. To see them, run: select lower(regexp_replace(btrim(address_line1), ''\s+'', '' '', ''g'')) as street, coalesce(zip,'''') as zip, lower(regexp_replace(btrim(coalesce(unit,'''')), ''\s+'', '' '', ''g'')) as unit, count(*) as rows, array_agg(user_id) as accounts, array_agg(id) as property_ids from public.properties group by 1,2,3 having count(*) > 1; Then, for each group, keep ONE row and either delete the throwaway/test rows or move the second person onto the kept home as a household_members row. supabase/FIX-DUPLICATE-HOMES-2026-08-30.sql does the same job for the SAME-OWNER case (0151) and is a good template, but it is scoped per user_id and will NOT clear these - do this pass by hand.',
      v_dupes;
  end if;
end
$$;

-- The key expressions mirror the app-level guard in claimPropertyAction
-- CHARACTER FOR CHARACTER: trim, collapse internal whitespace, lowercase.
-- The first cut of this index used a bare lower(btrim(...)) with no
-- whitespace collapse and a raw coalesce(unit, ''), which left two ways to
-- walk straight past the lock that the app-level check would have caught:
-- "123  Main St" (two spaces) and "APT 2" vs "Apt 2" each hashed to a
-- different key. Every expression here is IMMUTABLE, which is what an index
-- expression requires.
create unique index if not exists properties_address_unique
  on public.properties (
    lower(regexp_replace(btrim(address_line1), '\s+', ' ', 'g')),
    coalesce(zip, ''),
    lower(regexp_replace(btrim(coalesce(unit, '')), '\s+', ' ', 'g'))
  );

comment on index public.properties_address_unique is
  'B8: one home per (normalized street line, zip, unit), across EVERY owner - '
  'not just per user like properties_owner_address_unique (0151). Backstop to '
  'the app-level address-lock guard in claimPropertyAction '
  '(src/app/onboarding/actions.ts) against two different accounts both '
  'claiming the same home as owner. Household invites are unaffected: they '
  'add a household_members row against the existing property, never a second '
  'properties row.';

-- ---- VERIFY -----------------------------------------------------------------
-- select indexname from pg_indexes
--   where schemaname = 'public' and tablename = 'properties'
--     and indexname = 'properties_address_unique';
-- -- expect one row.
--
-- -- Find any remaining duplicate-address groups the PRECHECK above would have
-- -- caught (should return zero rows once this file has applied cleanly):
-- select lower(regexp_replace(btrim(address_line1), '\s+', ' ', 'g')) as street,
--        coalesce(zip,'') as zip,
--        lower(regexp_replace(btrim(coalesce(unit,'')), '\s+', ' ', 'g')) as unit,
--        count(*) as owners, array_agg(user_id) as accounts, array_agg(id) as property_ids
-- from public.properties
-- group by 1, 2, 3
-- having count(*) > 1;


-- =============================================================================
-- VERIFY (read-only, run after the file):
-- =============================================================================
-- select proname from pg_proc where proname in ('open_jobs_for_me','apply_to_lead','verify_pro_feedback');
-- select column_name from information_schema.columns where table_name='home_systems' and column_name='other_label';
-- select column_name from information_schema.columns where table_name='pro_feedback' and column_name in ('status','credited_cents','credited_at','review_note');
-- select indexname from pg_indexes where indexname in ('pro_clients_contractor_created_idx','pro_client_notes_client_created_idx');
-- select tablename from pg_tables where tablename='native_push_tokens';
-- select indexname from pg_indexes where tablename='properties' and indexname like '%address%';
