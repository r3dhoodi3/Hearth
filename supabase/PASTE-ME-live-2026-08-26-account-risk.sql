-- ============================================================================
-- HEARTH LIVE-DB BUNDLE: migration 0130 (2026-08-26)
-- Paste this WHOLE file into the Supabase SQL editor and run it ONCE.
-- Safe to re-run: every statement is idempotent.
-- Live DB should be at 0129 before this. After running, live is at 0130.
--
-- WHAT THIS IS: the trial-abuse risk score. Four service-role-only tables
-- (account_signals, account_risk, abuse_flags, risk_overrides) plus one helper
-- function (linked_accounts), so the app can tell when a "new" account is the
-- same person coming back for another 3-day free trial.
--
-- NOTHING BREAKS IF YOU DELAY THIS. Every read and write from the app goes
-- through src/lib/risk/*, which is written to fail OPEN: if the tables are not
-- there, recording a signal is a no-op and trialDecision() returns
-- allowTrial/allowCheckout true, exactly the behaviour that shipped before this
-- migration existed. Until it runs, nothing is recorded and nobody is refused.
--
-- NO DATA CHANGES to any existing table. Four new tables, one new function, no
-- backfill, no trigger on anything that already exists.
--
-- BEFORE YOU RUN IT: set RISK_HASH_SALT in the Vercel environment (any long
-- random string, 16+ characters, see docs/GO-LIVE-WIRING.md). There is NO
-- fallback salt: without that variable the app records no signals at all and
-- logs an error. Never change it after launch - the hashes are salted with it.
--
-- AFTER YOU RUN IT: leave RISK_ENFORCE unset (or "false") for the first week.
-- In that mode the score is computed and stored on every checkout but the free
-- trial is always granted, so the level-distribution query at the bottom of
-- this file shows you what the score WOULD have done to real customers before
-- it is allowed to do it. Set RISK_ENFORCE=true only once that distribution
-- looks sane.
-- ============================================================================

-- >>>>>>>>>> BEGIN 0130_account_risk.sql >>>>>>>>>>

-- =============================================================================
-- Hearth - trial-abuse risk scoring (0130)
-- RUN THIS AGAINST THE LIVE DATABASE (Supabase SQL editor); editing repo SQL
-- alone does NOT change the already-deployed database.
--
-- WHY THIS EXISTS
-- Both memberships hand out a 3-day free trial with a card on file: homeowner
-- Hearth Plus monthly, and Hearth Pro on either cadence. The only thing stopping
-- one person from farming that trial forever is the per-account check in
-- src/lib/subscription.ts (isProTrialEligible / hasClaimedPromo), and both of
-- those reset the moment somebody makes a new account with a new email. Three
-- days of Pro perks per throwaway inbox is a real, cheap attack.
--
-- These three tables give the app a way to notice that a "new" account is the
-- same person: same card, same device, same network, same house, same company
-- name, same email with the dots moved around. Nothing here blocks anyone by
-- itself - src/lib/risk/score.ts turns the signals into a 0-100 score and
-- src/lib/risk/decision.ts decides what to do about it (medium: no trial, pay
-- from day one; high: no checkout at all).
--
-- WHAT IS STORED, AND WHAT IS NOT
-- Only salted SHA-256 hashes. No raw IP address, no raw device id, no raw card
-- fingerprint, no raw email ever lands in account_signals. The salt lives in
-- the RISK_HASH_SALT environment variable (see docs/GO-LIVE-WIRING.md), so the
-- table on its own is not a lookup table for anybody's browsing history: without
-- the salt a hash cannot be walked back to a value, and the app never needs the
-- raw value again - every question it asks is "do two accounts share this?",
-- which equality over hashes answers perfectly well.
--
-- PRIVACY POSTURE
-- All three tables are SERVICE ROLE ONLY. RLS is on and there are deliberately
-- NO policies for `authenticated` or `anon`, and the table privileges are
-- revoked from both roles on top of that (belt and braces: Supabase grants
-- table privileges to those roles by default, and RLS with no policy already
-- denies everything, but a future policy added by accident should not be able
-- to open a hole on its own). Nobody can read their own risk row, and nobody
-- can read anybody else's. An abuse score is exactly the kind of thing that
-- becomes an attack surface the moment it is readable: a farmer who can see
-- their own score can binary-search their way around it.
--
-- Safe to re-run: every statement is idempotent.
-- =============================================================================

-- ---- 1. account_signals -----------------------------------------------------
-- One row per (account, kind of signal, hashed value). Deliberately NOT one row
-- per observation: this is a "has this account ever been seen with this value"
-- ledger, not an event log, so it does not grow with traffic and there is no
-- browsing history in it. first_seen/last_seen carry the time window the
-- scorer needs (e.g. "3 accounts on this IP within 7 days").
--
-- `context` is a short free-text note about WHERE the signal was captured
-- ('signup', 'plus_checkout', 'pro_checkout', 'claim_property', ...), for
-- support to make sense of a decision later. Never user-supplied text.
create table if not exists public.account_signals (
  user_id    uuid not null references auth.users (id) on delete cascade,
  kind       text not null check (
               kind in (
                 'device',
                 'fingerprint',
                 'ip',
                 'card',
                 'email_norm',
                 'email_domain',
                 'phone',
                 'parcel',
                 'company_name'
               )
             ),
  value_hash text not null,
  -- Which salt generation produced value_hash (src/lib/risk/hash.ts's
  -- SALT_VERSION). RISK_HASH_SALT is never supposed to change, but if it ever
  -- has to, this is what turns a rotation into a migration - re-hash what can be
  -- re-derived, expire the rest - instead of silent amnesia where every stored
  -- hash quietly stops matching and every repeat offender reads as brand new.
  salt_version smallint not null default 1,
  first_seen timestamptz not null default now(),
  last_seen  timestamptz not null default now(),
  context    text,
  primary key (user_id, kind, value_hash)
);
-- Self-healing for a database that already carried an earlier draft of this
-- table without the column: CREATE TABLE IF NOT EXISTS would skip it silently.
alter table public.account_signals
  add column if not exists salt_version smallint not null default 1;

-- The lookup that matters: "which OTHER accounts carry this same value". The
-- primary key is (user_id, kind, value_hash), which answers the per-user
-- question but cannot answer this one without a full scan.
create index if not exists account_signals_kind_value_idx
  on public.account_signals (kind, value_hash);

alter table public.account_signals enable row level security;
revoke all on public.account_signals from anon, authenticated;
grant all on public.account_signals to service_role;

comment on table public.account_signals is
  'Salted hashes of identifiers shared between accounts (device, network, card, email, phone, parcel, company name), used only to detect free-trial farming. Service role only: RLS is on with no policies, and privileges are revoked from anon/authenticated. Never stores a raw value.';

-- ---- 2. account_risk --------------------------------------------------------
-- The computed verdict, one row per account, overwritten on every recompute.
-- `reasons` is the human-readable breakdown (an array of {code, points}) so a
-- support person can answer "why was I refused" without re-running anything.
create table if not exists public.account_risk (
  user_id     uuid primary key references auth.users (id) on delete cascade,
  score       int not null default 0,
  level       text not null default 'low' check (level in ('low', 'medium', 'high')),
  reasons     jsonb not null default '[]'::jsonb,
  computed_at timestamptz not null default now()
);

alter table public.account_risk enable row level security;
revoke all on public.account_risk from anon, authenticated;
grant all on public.account_risk to service_role;

comment on table public.account_risk is
  'Computed trial-abuse risk score per account. Service role only, with no RLS policies for anon/authenticated on purpose: an account that can read its own score can binary-search its way around the score.';

-- ---- 3. abuse_flags ---------------------------------------------------------
-- The sticky part. A signal fades (people change phones, IPs rotate), but a
-- confirmed abuse event should keep costing the accounts that share hardware or
-- a card with it. Written automatically by the Stripe webhook: 'trial_abuse'
-- when a subscription is cancelled while it was still trialing, 'chargeback' on
-- charge.dispute.created. 'manual' is for a human decision.
--
-- One row per (user, kind) so a repeat event updates rather than piles up.
--
-- cleared_at is the resolution half of that, and it is what makes a flag safe
-- to ENFORCE rather than merely score. 0132 gates apply_to_lead and
-- unlock_direct_request on has_open_chargeback(), which refuses to let a pro
-- spend while a dispute is open. A dispute that is won, withdrawn, or filed by
-- mistake has to be closable, and with one row per (user, kind) deleting the
-- row would also erase the history that it ever happened - exactly the history
-- support needs the next time this account comes up. So the row stays and gets
-- a timestamp: null means open, a time means somebody resolved it and when.
-- Only the service role can write it (see the grants below), so a pro cannot
-- clear their own dispute.
create table if not exists public.abuse_flags (
  user_id    uuid not null references auth.users (id) on delete cascade,
  kind       text not null check (kind in ('trial_abuse', 'chargeback', 'manual')),
  note       text,
  created_at timestamptz not null default now(),
  cleared_at timestamptz,
  primary key (user_id, kind)
);
-- Self-healing for a database that already carried an earlier draft of this
-- table without the column: CREATE TABLE IF NOT EXISTS would skip it silently,
-- same pattern as account_signals.salt_version above.
alter table public.abuse_flags
  add column if not exists cleared_at timestamptz;

alter table public.abuse_flags enable row level security;
revoke all on public.abuse_flags from anon, authenticated;
grant all on public.abuse_flags to service_role;

comment on table public.abuse_flags is
  'Confirmed abuse events per account (trial cancelled inside the trial window, chargeback, manual). cleared_at null means still open; a timestamp means resolved, and the row is kept either way so the history survives. Service role only, same reasoning as account_risk: this is the input to a block decision, so it must not be readable or writable by the account it describes.';

-- ---- 4. linked_accounts(p_user) ---------------------------------------------
-- Every OTHER account that shares at least one signal value with p_user, with
-- the kind of signal that links them. The scorer calls this once and does all
-- of its counting in application code.
--
-- 'email_domain' is deliberately EXCLUDED from the join. It is stored (the
-- scorer needs it to spot a disposable-inbox provider) but it is not a link:
-- joining on it would connect every gmail.com account to every other gmail.com
-- account and return the entire user table. Every other kind is specific enough
-- that a shared value means something.
--
-- 'ip' is WINDOWED to 7 days, on BOTH sides of the join. Every other kind is
-- unwindowed, because a card, a device cookie, a phone number and a parcel mean
-- the same thing a year later. An IP address does not: residential addresses
-- recycle on a DHCP lease, and a carrier NAT egress is shared with thousands of
-- strangers at once. Without the window, one address handed to a stranger last
-- December links the two of them forever, and the score reads it as evidence.
-- The 7 days matches the window facts.ts already applies to the IP COUNT, so
-- the "who am I linked to" and "how many of us are there" questions finally
-- agree with each other.
--
-- ORDERED BY LINK STRENGTH before the limit. A card link is the one that
-- decides anything; an IP link is the one that is most likely to be noise and
-- most likely to be numerous. Without an explicit order the 500-row cut is
-- whatever the planner happened to emit, so the same account could score
-- differently on two consecutive runs - and the rows most likely to be dropped
-- were the ones that matter. Ordering makes the truncation deterministic and
-- makes it drop the weakest evidence first.
--
-- security definer because the three tables above are service-role only and
-- this function is the one supported way to ask the question. Execute is
-- granted to service_role ONLY - the app calls it through the admin client, the
-- same trusted-server pattern claim_promo (0073) uses.
--
-- LIMIT 500 is a blast-radius cap, not a correctness rule: a shared office IP
-- or a carrier NAT range can legitimately link a lot of accounts, and the
-- scorer's thresholds all top out well below 500, so truncating there changes
-- no decision while keeping one pathological value from dragging a checkout.
create or replace function public.linked_accounts(p_user uuid)
returns table (user_id uuid, kind text)
language sql
stable
security definer
set search_path = public
as $$
  select l.user_id, l.kind
    from (
      select distinct other.user_id, other.kind,
             case other.kind
               when 'card' then 1
               when 'device' then 2
               when 'email_norm' then 3
               when 'phone' then 4
               when 'parcel' then 5
               when 'company_name' then 6
               when 'fingerprint' then 7
               else 8
             end as strength
        from public.account_signals mine
        join public.account_signals other
          on other.kind = mine.kind
         and other.value_hash = mine.value_hash
         and other.user_id <> mine.user_id
         and (other.kind <> 'ip' or other.last_seen > now() - interval '7 days')
       where mine.user_id = p_user
         and mine.kind <> 'email_domain'
         and (mine.kind <> 'ip' or mine.last_seen > now() - interval '7 days')
    ) l
   order by l.strength, l.user_id
   limit 500;
$$;

revoke all on function public.linked_accounts(uuid) from public, anon, authenticated;
grant execute on function public.linked_accounts(uuid) to service_role;

comment on function public.linked_accounts(uuid) is
  'Other accounts sharing any non-email_domain signal value with p_user, IP links windowed to 7 days, ordered strongest link kind first. Service role only.';

-- ---- 5. risk_overrides ------------------------------------------------------
-- The manual escape hatch, and the reason there is no admin page.
--
-- Every scoring system needs a way for a human to say "this one is fine" (or
-- "this one is not") without redeploying, and the honest version of that for a
-- one-person team is a row you insert from the Supabase SQL editor:
--
--   insert into public.risk_overrides (user_id, allow_trial, note)
--   values ('<uuid>', true, 'Spouse of an existing member, emailed 2026-08-26')
--   on conflict (user_id) do update
--     set allow_trial = excluded.allow_trial, note = excluded.note;
--
-- trialDecision (src/lib/risk/decision.ts) checks this FIRST and returns it
-- without computing anything else, so an override is absolute in both
-- directions. `note` is required by convention, not by constraint: a decision
-- nobody wrote a reason for is one nobody can review later.
create table if not exists public.risk_overrides (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  allow_trial boolean not null,
  note       text,
  created_at timestamptz not null default now()
);

alter table public.risk_overrides enable row level security;
revoke all on public.risk_overrides from anon, authenticated;
grant all on public.risk_overrides to service_role;

comment on table public.risk_overrides is
  'Manual per-account override of the trial-abuse decision, checked before the score is computed. Service role only, same reasoning as account_risk: an account that could write its own override would not need the score at all.';

-- <<<<<<<<<< END 0130_account_risk.sql <<<<<<<<<<

-- ============================================================================
-- VERIFY (run these after the block above; expected results in the comments)
-- ============================================================================

-- 1. All four tables exist and RLS is ON for each.
--    Expected: 4 rows, rowsecurity = true on all four.
--   select relname, relrowsecurity as rowsecurity
--     from pg_class
--    where relnamespace = 'public'::regnamespace
--      and relname in ('account_signals', 'account_risk', 'abuse_flags', 'risk_overrides')
--    order by relname;

-- 2. NO policies exist on any of them. Expected: 0 rows.
--    (RLS on + zero policies = nothing but the service role can touch them.)
--   select tablename, policyname
--     from pg_policies
--    where schemaname = 'public'
--      and tablename in ('account_signals', 'account_risk', 'abuse_flags', 'risk_overrides');

-- 3. anon and authenticated hold NO table privileges. Expected: 0 rows.
--   select table_name, grantee, privilege_type
--     from information_schema.role_table_grants
--    where table_schema = 'public'
--      and table_name in ('account_signals', 'account_risk', 'abuse_flags', 'risk_overrides')
--      and grantee in ('anon', 'authenticated');

-- 4. service_role DOES hold privileges on all four. Expected: 4 rows, each with
--    a count of 7 (select/insert/update/delete/truncate/references/trigger).
--   select table_name, count(*) as privileges
--     from information_schema.role_table_grants
--    where table_schema = 'public'
--      and table_name in ('account_signals', 'account_risk', 'abuse_flags', 'risk_overrides')
--      and grantee = 'service_role'
--    group by table_name
--    order by table_name;

-- 5. The lookup index is there. Expected: 1 row, account_signals_kind_value_idx.
--   select indexname
--     from pg_indexes
--    where schemaname = 'public'
--      and tablename = 'account_signals'
--      and indexname = 'account_signals_kind_value_idx';

-- 6. salt_version is present, not null, default 1.
--    Expected: 1 row, smallint | NO | 1.
--   select data_type, is_nullable, column_default
--     from information_schema.columns
--    where table_schema = 'public' and table_name = 'account_signals'
--      and column_name = 'salt_version';

-- 7. linked_accounts exists, is security definer, and is executable by
--    service_role only. Expected: 1 row, prosecdef = true.
--   select p.proname, p.prosecdef,
--          array(select unnest(p.proacl)::text) as acl
--     from pg_proc p
--    where p.pronamespace = 'public'::regnamespace
--      and p.proname = 'linked_accounts';

-- 8. Smoke test: no rows yet, and the function runs. Expected: 0, 0, 0, 0, 0 rows.
--   select count(*) from public.account_signals;
--   select count(*) from public.account_risk;
--   select count(*) from public.abuse_flags;
--   select count(*) from public.risk_overrides;
--   select * from public.linked_accounts('00000000-0000-0000-0000-000000000000');

-- ============================================================================
-- SAVED QUERIES (keep these; they are the whole admin surface)
-- ============================================================================

-- A. LEVEL DISTRIBUTION, LAST 7 DAYS. Run this every day of the log-only week.
--    What you want to see: low overwhelmingly dominant, medium a small
--    single-digit percentage, high close to zero. If medium is more than about
--    5% of scored checkouts, the weights are too hot for the real customer base
--    and RISK_ENFORCE should stay off until they are retuned.
--   select level,
--          count(*) as accounts,
--          round(100.0 * count(*) / sum(count(*)) over (), 1) as pct,
--          min(score) as min_score,
--          round(avg(score), 1) as avg_score,
--          max(score) as max_score
--     from public.account_risk
--    where computed_at > now() - interval '7 days'
--    group by level
--    order by case level when 'high' then 1 when 'medium' then 2 else 3 end;

-- B. TOP REASONS, LAST 7 DAYS, among accounts that lost the trial. This is the
--    one that tells you WHY. A reason code that dominates this list is either
--    the system working or the false positive you are about to ship: if
--    parcel_shared or ip_cluster is at the top, you are scoring households and
--    carrier NAT, not farmers.
--   select r.value ->> 'code' as reason,
--          count(*) as hits,
--          round(avg((r.value ->> 'points')::int), 1) as avg_points
--     from public.account_risk ar
--     cross join lateral jsonb_array_elements(ar.reasons) as r(value)
--    where ar.computed_at > now() - interval '7 days'
--      and ar.level in ('medium', 'high')
--    group by 1
--    order by hits desc;

-- C. THE HIGH LIST, with reasons, newest first. Short enough to read by hand.
--    Every row here is somebody who did not get a free trial they asked for.
--   select ar.user_id, u.email, ar.score, ar.computed_at,
--          jsonb_pretty(ar.reasons) as reasons
--     from public.account_risk ar
--     left join auth.users u on u.id = ar.user_id
--    where ar.level = 'high'
--    order by ar.computed_at desc
--    limit 50;

-- D. GRANT SOMEBODY THEIR TRIAL BACK (or take it away). Absolute in both
--    directions: trialDecision checks this before it computes anything.
--   insert into public.risk_overrides (user_id, allow_trial, note)
--   values ('00000000-0000-0000-0000-000000000000', true, 'why, and who decided')
--   on conflict (user_id) do update
--     set allow_trial = excluded.allow_trial, note = excluded.note;

-- E. WHAT THE FLAGS LOOK LIKE. A pile of trial_abuse rows with no chargeback
--    rows anywhere means the corroboration gate in the webhook is too loose and
--    honest tyre-kickers are being marked.
--   select kind, count(*) from public.abuse_flags group by kind order by 2 desc;
