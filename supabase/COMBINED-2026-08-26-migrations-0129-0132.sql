-- ============================================================================
-- HEARTH COMBINED LIVE-DB PASTE: migrations 0129, 0130, 0131, 0132 (2026-08-26)
-- Live DB must be at 0128 before this. After it runs, live is at 0132.
--
-- STEP 1: run PRECHECK-2026-08-26.sql (same folder) FIRST. Every query there must
--         return zero rows. If one returns rows, fix those rows as its FIX line
--         says, then come back.
-- STEP 2: paste this WHOLE file into the Supabase SQL editor and run it once.
--         In the Supabase SQL editor it runs as one transaction: if anything
--         fails, nothing is applied and the error names the statement; under
--         psql use -1. Every section is idempotent, so a re-run after a fix
--         is safe.
-- STEP 3: run the VERIFY queries at the bottom of each PASTE-ME-live-2026-08-26-*.sql
--         file (optional, read-only) to confirm.
-- ============================================================================


-- ############################ BEGIN 0129_all_orange_county.sql ############################
-- =============================================================================
-- Hearth - expand the launch area from 9 cities to all of Orange County (0129)
-- RUN THIS AGAINST THE LIVE DATABASE (Supabase SQL editor); editing repo SQL
-- alone does NOT change the already-deployed database.
--
-- WHY: 0129 is an owner decision, like 0126 was. 0126 widened the launch area
-- from two cities to the nine along the coast and the Santa Ana river. The
-- gate works on both sides: a homeowner outside the launch area cannot claim a
-- home, and a pro cannot see or apply to a job outside the cities they
-- checked. The launch area itself is now the whole county: all 34
-- incorporated Orange County cities plus the two unincorporated communities
-- with a ZIP of their own (Ladera Ranch, Midway City), 36 names. Every pro
-- who signed up attested to serving Orange
-- County, and every one of these places is in Orange County, so the supply
-- side already covers it; the homeowner side simply stops turning away the
-- rest of the county.
--
-- serves_orange_county keeps its meaning exactly, as in 0126: checking ANY
-- launch city is still a truthful yes to the 0074 attestation, and every gate
-- built on that boolean keeps working untouched. This migration only widens
-- the narrower, per-city half.
--
-- WHAT CHANGES:
--   1. The CHECK constraint on contractors.launch_cities is dropped and
--      re-added allowing a subset of the 36 names instead of nine. Widening
--      only - no value that was legal under 0126 becomes illegal.
--   2. launch_city_for_zip(text) is re-issued with the full ZIP map for the
--      whole county (91 ZIPs, all residential-delivery, exactly the
--      ORANGE_COUNTY_ZIPS set in src/lib/serviceArea.ts, which 0129 also grew
--      by two ZIPs it was missing: 92694 Ladera Ranch and 92832 Fullerton).
--      The 29 mappings 0126 made are unchanged. A ZIP maps to ONE city, so a
--      ZIP shared by two places goes to the incorporated one: 92705 (Santa
--      Ana / North Tustin) stays Santa Ana, 90720 (Los Alamitos / Rossmoor)
--      stays Los Alamitos, and 92679 (Coto de Caza / Dove Canyon / Robinson
--      Ranch) goes to Rancho Santa Margarita. That is why North Tustin,
--      Rossmoor and Coto de Caza are NOT in the allowlist: a name no ZIP
--      resolves to would give a pro who checked only it a silently empty
--      board. Annexed and unincorporated pockets go to the city that
--      surrounds or serves them (Capistrano Beach to Dana Point, Foothill
--      Ranch to Lake Forest, Silverado 92676 to Orange via Santiago Canyon
--      Road, Trabuco Canyon 92678 to Rancho Santa Margarita).
--   3. Backfill: every pro who attested serves_orange_county gets ALL 36
--      names, exactly as 0126's backfill gave them all nine. They attested to
--      Orange County broadly, so granting the whole county preserves the
--      spirit of that attestation precisely - and, as in 0126, this migration
--      must not silently narrow anyone. A pro who wants a narrower board
--      unchecks "All of Orange County" in their profile and picks cities.
--   4. The function comment is updated.
--
-- apply_to_lead() NEEDS NO CHANGE and is deliberately not re-issued here.
-- 0126 already generalized both of its refusal messages so they name no city,
-- and its logic reads launch_city_for_zip() and launch_cities, both of which
-- this migration updates underneath it. Same for open_jobs_for_me(), for the
-- same reason 0126 gave: its gate is the one line
-- `public.launch_city_for_zip(pr.zip) = any (c.launch_cities)`, and
-- re-issuing a function whose text does not change would only add risk.
-- browse_pros, unlock_direct_request, the wallet functions, the 0125 license
-- index: untouched.
--
-- WHAT ELSE DOES NOT CHANGE, deliberately: serves_orange_county and every gate
-- on it, the launch_cities column itself (0124 created it) and its column-level
-- grants (the constraint swap below does not disturb privileges), the aging
-- price, the 0115 intro price, the wallet lock, the cash-first split, the
-- FIFO bonus drain, the ledger row, the applicant cap, the relationship guard.
--
-- ORDER MATTERS: the CHECK constraint is widened BEFORE the backfill writes
-- the 36-name array, because the old nine-city constraint would reject every
-- one of those updates.
--
-- Idempotent: drop-then-add for the constraint, CREATE OR REPLACE for the
-- function, and a backfill guarded on `not (launch_cities @> <all 36>)` so a
-- second run updates zero rows. Safe to re-run.
-- =============================================================================

-- ---- 1. The launch-city allowlist ---------------------------------------------
-- Drop-then-add, the same shape 0124 and 0126 used and for the same reason: a
-- re-run cannot fail on an already-present constraint, and the next edit to
-- the city list lands just as cleanly. The 36 names are the canonical list, in
-- canonical order (incorporated cities alphabetically, then the communities),
-- mirrored by LAUNCH_CITY_NAMES in src/lib/serviceArea.ts (which the
-- signup/profile checkboxes re-export as LAUNCH_CITIES); the test in
-- src/lib/serviceArea.test.ts reads this file and fails if the two disagree.
alter table public.contractors
  drop constraint if exists contractors_launch_cities_subset;
alter table public.contractors
  add constraint contractors_launch_cities_subset
  check (launch_cities <@ array[
    'Aliso Viejo', 'Anaheim', 'Brea', 'Buena Park', 'Costa Mesa', 'Cypress',
    'Dana Point', 'Fountain Valley', 'Fullerton', 'Garden Grove',
    'Huntington Beach', 'Irvine', 'La Habra', 'La Palma', 'Laguna Beach',
    'Laguna Hills', 'Laguna Niguel', 'Laguna Woods', 'Lake Forest',
    'Los Alamitos', 'Mission Viejo', 'Newport Beach', 'Orange', 'Placentia',
    'Rancho Santa Margarita', 'San Clemente', 'San Juan Capistrano',
    'Santa Ana', 'Seal Beach', 'Stanton', 'Tustin', 'Villa Park',
    'Westminster', 'Yorba Linda',
    'Ladera Ranch', 'Midway City'
  ]::text[]);

comment on column public.contractors.launch_cities is
  'Which of the 36 launch cities (all of Orange County since 0129) this pro '
  'actually covers, from the signup / profile checkboxes (LAUNCH_CITY_NAMES in '
  'src/lib/serviceArea.ts, canonical order). open_jobs_for_me() and '
  'apply_to_lead() both filter on it: a job whose property ZIP maps '
  '(launch_city_for_zip) to a city NOT in this array is hidden from the board '
  'and refused at apply time. Empty means no city, so no jobs - narrower than '
  'serves_orange_county, which still has to be true as well.';

-- ---- 2. ZIP -> launch city, all of Orange County -------------------------------
-- The one canonical mapping, replacing 0126's nine-city version. OR REPLACE, so
-- the signature, the immutability, and the grant posture 0124 settled on
-- (REVOKE from public/anon, EXECUTE to authenticated + service_role) all carry
-- over untouched - which is why those grants are not restated here.
--
-- 90620 through 90743 route through 90xxx ZIPs: the OC/LA border overlap
-- ORANGE_COUNTY_ZIPS documents, not a mistake. Anything not listed is outside
-- the launch area and returns null, which every caller treats as "hide it".
-- Normalization matches launchCityForZip in src/lib/serviceArea.ts exactly:
-- trim, then take the first 5 characters, so a ZIP+4 and a padded ZIP both
-- resolve. The mapping below is LAUNCH_CITY_BY_ZIP in that file, entry for
-- entry, and src/lib/serviceArea.test.ts checks that it is.
create or replace function public.launch_city_for_zip(p_zip text)
returns text language sql immutable set search_path = public as $$
  select case left(btrim(coalesce(p_zip, '')), 5)
           -- Aliso Viejo
           when '92656' then 'Aliso Viejo'
           -- Anaheim, including Anaheim Hills (92807, 92808)
           when '92801' then 'Anaheim'
           when '92802' then 'Anaheim'
           when '92804' then 'Anaheim'
           when '92805' then 'Anaheim'
           when '92806' then 'Anaheim'
           when '92807' then 'Anaheim'
           when '92808' then 'Anaheim'
           -- Brea
           when '92821' then 'Brea'
           when '92823' then 'Brea'
           -- Buena Park
           when '90620' then 'Buena Park'
           when '90621' then 'Buena Park'
           -- Costa Mesa
           when '92626' then 'Costa Mesa'
           when '92627' then 'Costa Mesa'
           -- Cypress
           when '90630' then 'Cypress'
           -- Dana Point, including Capistrano Beach (92624)
           when '92624' then 'Dana Point'
           when '92629' then 'Dana Point'
           -- Fountain Valley
           when '92708' then 'Fountain Valley'
           -- Fullerton
           when '92831' then 'Fullerton'
           when '92832' then 'Fullerton'
           when '92833' then 'Fullerton'
           when '92835' then 'Fullerton'
           -- Garden Grove
           when '92840' then 'Garden Grove'
           when '92841' then 'Garden Grove'
           when '92843' then 'Garden Grove'
           when '92844' then 'Garden Grove'
           when '92845' then 'Garden Grove'
           -- Huntington Beach, including Sunset Beach (90742)
           when '92646' then 'Huntington Beach'
           when '92647' then 'Huntington Beach'
           when '92648' then 'Huntington Beach'
           when '92649' then 'Huntington Beach'
           when '90742' then 'Huntington Beach'
           -- Irvine
           when '92602' then 'Irvine'
           when '92603' then 'Irvine'
           when '92604' then 'Irvine'
           when '92606' then 'Irvine'
           when '92612' then 'Irvine'
           when '92614' then 'Irvine'
           when '92617' then 'Irvine'
           when '92618' then 'Irvine'
           when '92620' then 'Irvine'
           -- La Habra
           when '90631' then 'La Habra'
           -- La Palma
           when '90623' then 'La Palma'
           -- Laguna Beach
           when '92651' then 'Laguna Beach'
           -- Laguna Hills
           when '92653' then 'Laguna Hills'
           -- Laguna Niguel
           when '92677' then 'Laguna Niguel'
           -- Laguna Woods
           when '92637' then 'Laguna Woods'
           -- Lake Forest, including Foothill Ranch (92610)
           when '92610' then 'Lake Forest'
           when '92630' then 'Lake Forest'
           -- Los Alamitos (Rossmoor shares 90720)
           when '90720' then 'Los Alamitos'
           -- Mission Viejo
           when '92691' then 'Mission Viejo'
           when '92692' then 'Mission Viejo'
           -- Newport Beach, including Corona del Mar (92625), Newport Coast
           -- (92657) and Balboa Island (92662)
           when '92625' then 'Newport Beach'
           when '92657' then 'Newport Beach'
           when '92660' then 'Newport Beach'
           when '92661' then 'Newport Beach'
           when '92662' then 'Newport Beach'
           when '92663' then 'Newport Beach'
           -- Orange, plus Silverado / Modjeska Canyon (92676) up Santiago
           -- Canyon Road
           when '92676' then 'Orange'
           when '92856' then 'Orange'
           when '92864' then 'Orange'
           when '92865' then 'Orange'
           when '92866' then 'Orange'
           when '92867' then 'Orange'
           when '92868' then 'Orange'
           when '92869' then 'Orange'
           -- Placentia
           when '92870' then 'Placentia'
           -- Rancho Santa Margarita, including Dove Canyon and Robinson Ranch
           -- (92679, shared with Coto de Caza) and Trabuco Canyon proper (92678)
           when '92678' then 'Rancho Santa Margarita'
           when '92679' then 'Rancho Santa Margarita'
           when '92688' then 'Rancho Santa Margarita'
           -- San Clemente
           when '92672' then 'San Clemente'
           when '92673' then 'San Clemente'
           -- San Juan Capistrano
           when '92675' then 'San Juan Capistrano'
           -- Santa Ana (North Tustin shares 92705)
           when '92701' then 'Santa Ana'
           when '92703' then 'Santa Ana'
           when '92704' then 'Santa Ana'
           when '92705' then 'Santa Ana'
           when '92706' then 'Santa Ana'
           when '92707' then 'Santa Ana'
           -- Seal Beach, including Surfside (90743)
           when '90740' then 'Seal Beach'
           when '90743' then 'Seal Beach'
           -- Stanton
           when '90680' then 'Stanton'
           -- Tustin
           when '92780' then 'Tustin'
           when '92782' then 'Tustin'
           -- Villa Park
           when '92861' then 'Villa Park'
           -- Westminster
           when '92683' then 'Westminster'
           -- Yorba Linda
           when '92885' then 'Yorba Linda'
           when '92886' then 'Yorba Linda'
           when '92887' then 'Yorba Linda'
           -- Ladera Ranch (unincorporated, its own single ZIP)
           when '92694' then 'Ladera Ranch'
           -- Midway City (unincorporated, its own single ZIP)
           when '92655' then 'Midway City'
           else null
         end;
$$;

comment on function public.launch_city_for_zip(text) is
  'Maps a property ZIP to one of Hearth''s 36 launch cities (all of Orange '
  'County since 0129), or null when it is outside the county. Kept in sync '
  'with launchCityForZip() in src/lib/serviceArea.ts, and '
  'src/lib/serviceArea.test.ts reads this migration to check that it is. Read '
  'by open_jobs_for_me() and apply_to_lead().';

-- ---- 3. Backfill ---------------------------------------------------------------
-- Every pro who attested serves_orange_county (0074/0098) gets the whole
-- county, exactly as 0126's backfill gave them all nine cities that existed
-- then. The attestation they signed is "I serve Orange County", and this IS
-- Orange County, so the whole launch area is what that attestation already
-- says.
--
-- READ THIS BEFORE RUNNING: like 0126's backfill, this one is NOT restricted
-- to rows still at the default. A pro who narrowed their pick since 0126 has
-- that pick WIDENED back to the whole county. That is the owner's decision
-- (expand everyone into the new area rather than make them re-opt-in), and it
-- only ever grants access, never removes it. A pro who wants a narrower board
-- can uncheck "All of Orange County" in their profile at any time.
--
-- The `not (launch_cities @> array[...])` guard exists so a re-run right after
-- the first is a zero-row update rather than a rewrite of every contractors
-- row. It is NOT a promise to leave a later narrowing alone: a pro who trims
-- their cities tomorrow would be re-widened by a re-run, so run this once, at
-- expansion time, and never on a schedule.
update public.contractors
   set launch_cities = array[
         'Aliso Viejo', 'Anaheim', 'Brea', 'Buena Park', 'Costa Mesa',
         'Cypress', 'Dana Point', 'Fountain Valley', 'Fullerton',
         'Garden Grove', 'Huntington Beach', 'Irvine', 'La Habra', 'La Palma',
         'Laguna Beach', 'Laguna Hills', 'Laguna Niguel', 'Laguna Woods',
         'Lake Forest', 'Los Alamitos', 'Mission Viejo', 'Newport Beach',
         'Orange', 'Placentia', 'Rancho Santa Margarita', 'San Clemente',
         'San Juan Capistrano', 'Santa Ana', 'Seal Beach', 'Stanton',
         'Tustin', 'Villa Park', 'Westminster', 'Yorba Linda',
         'Ladera Ranch', 'Midway City'
       ]
 where serves_orange_county = true
   and not (launch_cities @> array[
         'Aliso Viejo', 'Anaheim', 'Brea', 'Buena Park', 'Costa Mesa',
         'Cypress', 'Dana Point', 'Fountain Valley', 'Fullerton',
         'Garden Grove', 'Huntington Beach', 'Irvine', 'La Habra', 'La Palma',
         'Laguna Beach', 'Laguna Hills', 'Laguna Niguel', 'Laguna Woods',
         'Lake Forest', 'Los Alamitos', 'Mission Viejo', 'Newport Beach',
         'Orange', 'Placentia', 'Rancho Santa Margarita', 'San Clemente',
         'San Juan Capistrano', 'Santa Ana', 'Seal Beach', 'Stanton',
         'Tustin', 'Villa Park', 'Westminster', 'Yorba Linda',
         'Ladera Ranch', 'Midway City'
       ]::text[]);

-- ############################ END 0129_all_orange_county.sql ##############################


-- ############################ BEGIN 0130_account_risk.sql ############################
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

-- ############################ END 0130_account_risk.sql ##############################


-- ############################ BEGIN 0131_db_layer_ownership.sql ############################
-- =============================================================================
-- Hearth - push the photo/issue ownership checks down into the database (0131)
-- RUN THIS AGAINST THE LIVE DATABASE (Supabase SQL editor); editing repo SQL
-- alone does NOT change the already-deployed database. 0130 is the last
-- migration in this folder, so this is the next one to apply, in order, with
-- no gaps.
--
-- WHY THIS EXISTS
-- An IDOR sweep added guards to the three server actions that write a
-- client-chosen storage key or row id (validPhotoUrls / issue_id in
-- src/app/(app)/contractors/actions.ts, system_id in
-- src/app/(app)/issues/actions.ts, photo_urls + system id in
-- src/app/(app)/profile/actions.ts). Those guards are correct and they stay.
-- They are also, on their own, not enough: Supabase publishes the same tables
-- over PostgREST with the public anon key and the caller's own session JWT, so
-- an attacker never has to call a server action at all. This is the same
-- threat model 0079 already wrote down for contractor_leads, applied to the
-- two writes that still reach the database with no check on either side.
--
-- THE TWO HOLES
--
--   A) photos.url is unbound. "photos owner all" (0002_rls_policies.sql:67)
--      constrains property_id and says nothing about url, and there is no
--      CHECK and no trigger on public.photos. So an ordinary homeowner can
--      POST /rest/v1/photos with property_id = a home they own, related_id =
--      an issue on that home, and url = ANOTHER property's object key.
--      can_view_job_photo_full (0104) then binds a signed url to a lead purely
--      by matching photos.url, and grants on owns_property(cl.property_id) -
--      both halves satisfied by the attacker's own rows. /api/job-photo signs
--      the result with the ADMIN client, which storage RLS does not apply to,
--      so the attacker downloads another property's private photo at full
--      resolution. The keys are not secret: open_jobs_for_me returns raw
--      photo_urls to every board-eligible pro and src/app/pro/page.tsx puts
--      them in the RSC payload.
--
--   B) contractor_leads.issue_id is unchecked on INSERT.
--      enforce_contractor_leads_locked() pins issue_id on UPDATE (0117's
--      addition, latest body 0121) but its INSERT branch never looks at it,
--      and "contractor_leads owner all" (0002:75) only checks property_id. So
--      a raw insert can attach another homeowner's issue_id to a lead on a
--      property this account owns, which republishes that home's photo keys
--      through open_jobs_for_me and unlocks them through the gate above.
--
-- WHAT THIS MIGRATION DOES
--   Part 1  storage_object_key(): the SQL twin of src/lib/storage.ts's
--           toObjectPath, so the database strips a stored value down to an
--           object key exactly the way the render path does.
--   Part 2  enforce_photo_url_owned(): BEFORE INSERT OR UPDATE trigger on
--           public.photos. The key must sit under new.property_id. Raises, so
--           a forged write fails loudly rather than landing silently.
--   Part 3  enforce_contractor_leads_locked() re-issued: byte-for-byte 0121
--           apart from ONE addition in the INSERT branch, which nulls an
--           issue_id that does not belong to the lead's own property.
--   Part 4  can_preview_job_photo / can_view_job_photo_full re-issued:
--           copy-only apart from ONE added predicate requiring the object
--           key's first segment to equal the lead's property_id. Defence in
--           depth, and it also neutralises any bad photos row written BEFORE
--           Part 2 existed.
--   Part 5  re-assert the 0020 EXECUTE posture on get_or_create_wallet and
--           recompute_contractor_rating.
--
-- WHAT DOES NOT CHANGE: no policy is added, dropped or altered; no money
-- moves; no price changes; no column is added or dropped. Every legitimate
-- write the app makes today already satisfies both new rules, because the
-- uploaders have always written `${propertyId}/...` keys and postJobAction now
-- verifies issue_id before it sends it.
--
-- BLAST RADIUS ON EXISTING ROWS: the Part 2 trigger is BEFORE INSERT OR
-- UPDATE, so rows already in public.photos are untouched and keep rendering.
-- A legacy row whose url does not sit under its property would fail on its
-- next UPDATE - nothing in the app updates photos rows (grep from("photos"):
-- three inserts, one delete, four selects), and the verify queries at the end
-- of the paste file count those rows so the operator can see the real number
-- before and after.
--
-- Idempotent: CREATE OR REPLACE throughout, DROP TRIGGER IF EXISTS before
-- CREATE TRIGGER, and grants are set-to-state. Safe to re-run.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- PART 1: storage_object_key(value) - the SQL twin of toObjectPath()
-- -----------------------------------------------------------------------------
-- src/lib/storage.ts:21-33 is the one reading of a stored value the whole app
-- agrees on: /api/img signs what it returns, and isOwnedStoragePath
-- (src/lib/ownedStoragePath.ts) checks what it returns. If the database
-- checked a DIFFERENT reading of the same string, an attacker would aim at the
-- gap between the two readings, so this reproduces it step for step:
--
--   1. cut at the first '?' or '#'. A stored value can be a getPublicUrl()
--      result (Supabase appends ?t=... for cache busting) or a signed url
--      carrying ?token=... . Left on, that suffix is attacker-controlled text
--      sitting inside what is supposed to be a plain key.
--   2. if '/home-photos/' appears, everything after the FIRST occurrence is
--      the key.
--   3. otherwise strip a leading 'home-photos/' if present.
--   4. empty reads as null, never as a zero-length key that would prefix-match
--      anything.
--
-- IMMUTABLE: it is pure string arithmetic on its argument, which lets Part 4's
-- gates call it inside a subquery without blocking inlining.
create or replace function public.storage_object_key(p_value text)
returns text
language sql
immutable
set search_path = public
as $$
  select nullif(
           case
             when position('/home-photos/' in v.clean) > 0
               then substring(
                      v.clean
                      from position('/home-photos/' in v.clean)
                           + length('/home-photos/')
                    )
             when v.clean like 'home-photos/%'
               then substring(v.clean from length('home-photos/') + 1)
             else v.clean
           end,
           ''
         )
    from (
      select case
               when p_value is null then null
               -- LEAST ignores NULLs, so a value carrying only one of the two
               -- separators still cuts at that one. nullif(...,0) turns "not
               -- found" into NULL rather than into position 0.
               when strpos(p_value, '?') > 0 or strpos(p_value, '#') > 0
                 then left(
                        p_value,
                        least(
                          nullif(strpos(p_value, '?'), 0) - 1,
                          nullif(strpos(p_value, '#'), 0) - 1
                        )
                      )
               else p_value
             end as clean
    ) v;
$$;

revoke all on function public.storage_object_key(text) from public;
revoke all on function public.storage_object_key(text) from anon;
grant execute on function public.storage_object_key(text) to authenticated;
grant execute on function public.storage_object_key(text) to service_role;


-- -----------------------------------------------------------------------------
-- PART 2: bind photos.url to photos.property_id
-- -----------------------------------------------------------------------------
-- The rule is the one src/lib/ownedStoragePath.ts already applies in
-- TypeScript: the key has to sit under the property the row belongs to, and it
-- must not be able to climb back out. Traversal is rejected in raw AND
-- percent-encoded form, because '<mine>/../<theirs>/x.png' starts with the
-- right prefix and resolves somewhere else entirely, and '%2e%2e' is the same
-- attack wearing a hat. Backslashes are not part of a storage key and only
-- ever show up in an attempt to confuse a normalizer.
--
-- RAISE, not silent correction: unlike contractor_leads (where 0079 chose to
-- quietly normalise a forged insert so the ordinary posting flow sees no
-- behaviour change), there is no honest reading of a photos row that points at
-- someone else's object. Nulling the url would leave a broken row; silently
-- rewriting it would be a guess. Every legitimate caller already sends a
-- conforming key, so the only writer that can trip this is one doing something
-- it should not.
--
-- errcode 42501 (insufficient_privilege) so PostgREST answers 403 rather than
-- 500, and so isMissingSchemaError() in src/lib/dbErrors.ts does not mistake
-- it for schema drift and retry.
create or replace function public.enforce_photo_url_owned()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_key    text;
  v_prefix text;
begin
  -- A row with no url stores no reference and can leak nothing.
  if new.url is null then
    return new;
  end if;

  if new.property_id is null then
    raise exception 'photos.url requires a property_id'
      using errcode = '42501';
  end if;

  -- Same ceiling as MAX_STORED_LENGTH in src/lib/ownedStoragePath.ts: an
  -- unbounded string has no business reaching a text column.
  if length(new.url) > 1000 then
    raise exception 'photos.url is not a storage key for this property'
      using errcode = '42501';
  end if;

  v_key    := public.storage_object_key(new.url);
  v_prefix := new.property_id::text || '/';

  if v_key is null
     or strpos(v_key, '..') > 0
     or strpos(v_key, chr(92)) > 0
     or strpos(lower(v_key), '%2e') > 0
     or strpos(lower(v_key), '%2f') > 0
     or strpos(lower(v_key), '%5c') > 0
     -- Strictly longer than the prefix: the bare folder key names no object.
     or length(v_key) <= length(v_prefix)
     or lower(left(v_key, length(v_prefix))) <> lower(v_prefix)
  then
    raise exception 'photos.url is not a storage key for this property'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

drop trigger if exists photos_url_owned on public.photos;
create trigger photos_url_owned
  before insert or update on public.photos
  for each row execute function public.enforce_photo_url_owned();


-- -----------------------------------------------------------------------------
-- PART 3: enforce_contractor_leads_locked() - check issue_id on INSERT too
-- -----------------------------------------------------------------------------
-- Latest body is 0121_lock_lead_homeowner_fields.sql (after 0079 -> 0086 ->
-- 0089 -> 0090 -> 0119 -> 0121); nothing between 0121 and 0130 redefines it.
-- Reproduced here byte-for-byte apart from the ONE marked addition in the
-- INSERT branch. The trigger itself (0079 line 215, bound by name) is
-- unchanged, so no CREATE TRIGGER is needed here.
--
-- The addition mirrors the UPDATE branch's existing reasoning. 0117 pinned
-- issue_id on UPDATE because "a lead's chat thread, its notifications, and the
-- job photos a paid pro can see are all resolved through property_id /
-- issue_id". That is exactly as true at INSERT time, and an insert has no OLD
-- row to revert to, so the check is against the issues table instead.
--
-- NULLED, not raised, because that matches what the surrounding branch already
-- does with every other forged column ("silently corrected instead of
-- rejected, so the ordinary posting flow sees no behavior change") and matches
-- what postJobAction now does in the app layer: a stale id posts a plain job
-- rather than failing in the owner's face.
--
-- Runs for the PRIVILEGED path too, deliberately, and it is placed before the
-- `if not v_privileged` block for that reason. Every money RPC that inserts a
-- lead (rehire_pro, the direct-request flows) derives issue_id from a lead the
-- caller already owns or from null, so none of them can be affected - but a
-- future privileged writer that got it wrong would be corrected rather than
-- trusted, and a lead pointed at a foreign issue is never something we want in
-- the table regardless of who wrote it.
create or replace function public.enforce_contractor_leads_locked()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_privileged boolean := coalesce(current_setting('hearth.lead_write', true), '') = 'on';
  v_is_party   boolean;
  v_has_live_apps boolean;
begin
  if tg_op = 'INSERT' then
    -- ---- 0131 addition: issue_id must belong to this lead's own property ---
    -- "contractor_leads owner all" (0002) checks property_id and nothing else,
    -- so without this a raw PostgREST insert attaches another homeowner's
    -- issue to a lead on a property this account owns. open_jobs_for_me
    -- aggregates photo_urls by issue_id, and can_view_job_photo_full binds a
    -- signed url to the lead through it, so that forgery republishes the other
    -- home's photo keys and unlocks them full resolution.
    if new.issue_id is not null
       and not exists (
         select 1
           from public.issues i
          where i.id = new.issue_id
            and i.property_id = new.property_id
       )
    then
      new.issue_id := null;
    end if;
    -- ---- end 0131 addition ------------------------------------------------

    if not v_privileged then
      -- Reproduces exactly what postJobAction already sends for a fresh,
      -- unassigned posting. A forged insert (contractor_id pre-set, paid =
      -- true, payout_amount lowballed) is silently corrected instead of
      -- rejected, so the ordinary posting flow sees no behavior change.
      new.contractor_id := null;
      new.paid := false;
      new.paid_at := null;
      new.status := 'new';
      new.payout_amount := public.contractor_lead_base_fee(new.category);
    end if;
    return new;
  end if;

  if tg_op = 'UPDATE' then
    -- 0084 fix (finding #5, unchanged): pg_trigger_depth() > 1 means this
    -- UPDATE was fired from inside another trigger - the FK's ON DELETE SET
    -- NULL action on contractor_leads.contractor_id when a contractors row
    -- is deleted (0005), a nested trigger invocation, not a direct client
    -- statement. Skip ALL anti-forgery stripping (including the status guard
    -- below) only for that RI-cascade case, so account deletion (CCPA erase)
    -- still works. Direct client writes are always depth = 1.
    if not v_privileged and pg_trigger_depth() <= 1 then
      if new.contractor_id is distinct from old.contractor_id then
        new.contractor_id := old.contractor_id;
      end if;
      if new.paid is distinct from old.paid then
        new.paid := old.paid;
      end if;
      if new.paid_at is distinct from old.paid_at then
        new.paid_at := old.paid_at;
      end if;

      -- ---- 0117 addition: pin the lead to its property, issue and target ---
      -- A lead's chat thread, its notifications, and the job photos a paid pro
      -- can see are all resolved through property_id / issue_id. Re-pointing
      -- either one moves a live lead into another homeowner's account. No
      -- application path ever updates them, so a flat revert is correct.
      new.property_id := old.property_id;
      new.issue_id    := old.issue_id;

      -- direct_to: revert every change EXCEPT the one legitimate transition,
      -- a homeowner clearing an already-set target on a still-unassigned lead
      -- so it becomes a plain public job (postDirectRequestAsJobAction). A
      -- flat revert would break that feature silently. Setting direct_to from
      -- null, or swapping it to a different pro, is always reverted: that is
      -- the actual hole, since the target pro gets a private unlock path into
      -- the lead.
      -- Nested rather than one flat AND chain on purpose: PostgreSQL does not
      -- promise left-to-right short-circuiting inside a single boolean
      -- expression, so a flat version could call owns_property() on EVERY
      -- non-privileged lead UPDATE, including the ones that never mention
      -- direct_to. The outer IF makes that impossible.
      if new.direct_to is distinct from old.direct_to then
        if not (
          old.direct_to is not null
          and new.direct_to is null
          and old.contractor_id is null
          and coalesce(public.owns_property(old.property_id), false)
        ) then
          new.direct_to := old.direct_to;
        end if;
      end if;
      -- ---- end 0117 addition ------------------------------------------------

      -- ---- 0119 addition: block the assigned pro from rewriting homeowner
      --      identity and job detail --------------------------------------
      -- The pro's UPDATE policy ("leads contractor update", 0005) re-checks
      -- only contractor_id, so without this the assigned pro could rewrite the
      -- homeowner's name/email/phone (name is shown to the homeowner and on the
      -- review share card - spoofable), the property address, and the job
      -- detail fields on the lead they were assigned. The owner writes these
      -- legitimately through updateJobAction / closeJobAction; the pro must
      -- not. owns_property(old.property_id) is TRUE for the homeowner and any
      -- household member (they reach this row via "contractor_leads owner all",
      -- 0002) and FALSE for the pro (who reaches it via the contractor policy),
      -- so it is the exact owner-vs-pro discriminator. SECURITY INVOKER, and
      -- owns_property is granted to authenticated (0048) and service_role
      -- (0118), so the call resolves for whichever role is writing.
      --
      -- Same nested shape as the direct_to block above, and for the same
      -- reason: the outer IF fires only when one of the protected columns
      -- actually changed, so owns_property() is never evaluated on the pro's
      -- ordinary status-only write (updateLeadStatusAction, the pro's ONLY
      -- legitimate non-privileged write), nor on any update that leaves these
      -- columns alone.
      --
      -- payout_amount is intentionally absent here: category is reverted for
      -- the non-owner, and 0117's recompute block just below derives
      -- payout_amount from the final category, so a pro-forged category and/or
      -- payout_amount still lands on the base fee for the ORIGINAL category
      -- without this block touching the money logic. This runs BEFORE that
      -- recompute so the recompute sees the reverted category.
      if new.homeowner_name    is distinct from old.homeowner_name
         or new.homeowner_email  is distinct from old.homeowner_email
         or new.homeowner_phone  is distinct from old.homeowner_phone
         or new.property_address is distinct from old.property_address
         or new.issue_description is distinct from old.issue_description
         or new.issue_severity   is distinct from old.issue_severity
         or new.budget_range     is distinct from old.budget_range
         or new.timing           is distinct from old.timing
         or new.square_footage   is distinct from old.square_footage
         or new.material_notes   is distinct from old.material_notes
         or new.has_plans_permits is distinct from old.has_plans_permits
         or new.category         is distinct from old.category
         or new.owner_closed_at  is distinct from old.owner_closed_at then
        if not coalesce(public.owns_property(old.property_id), false) then
          new.homeowner_name    := old.homeowner_name;
          new.homeowner_email   := old.homeowner_email;
          new.homeowner_phone   := old.homeowner_phone;
          new.property_address  := old.property_address;
          new.issue_description := old.issue_description;
          new.issue_severity    := old.issue_severity;
          new.budget_range      := old.budget_range;
          new.timing            := old.timing;
          new.square_footage    := old.square_footage;
          new.material_notes    := old.material_notes;
          new.has_plans_permits := old.has_plans_permits;
          new.category          := old.category;
          new.owner_closed_at   := old.owner_closed_at;
        end if;
      end if;
      -- ---- end 0119 addition ------------------------------------------------

      -- Recompute only when category or payout_amount actually changed, so a
      -- status-only update (the pro's updateLeadStatusAction) never touches
      -- payout_amount - this is what keeps rehire_pro's free ($0) leads from
      -- being corrupted back to a paid tier the next time their status
      -- changes. When it IS one of those two columns changing, recomputing
      -- from category reproduces updateJobAction's own
      -- payout_amount = leadFeeFor(category) and blocks a lowballed forgery.
      if new.category is distinct from old.category
         or new.payout_amount is distinct from old.payout_amount then
        new.payout_amount := public.contractor_lead_base_fee(new.category);
      end if;

      -- ---- 0087 addition: status transition guard -------------------------
      if new.status is distinct from old.status then
        v_is_party := coalesce(public.can_access_lead(old.id), false);
        if not v_is_party then
          -- Should be unreachable given RLS, but never let a non-party's
          -- status write through if this ever runs outside RLS's scope.
          new.status := old.status;
        elsif new.status = 'accepted' then
          -- (b) 'accepted' is normally set together with contractor_id by
          -- choose_applicant (privileged). A non-privileged write to 'accepted'
          -- is legitimate ONLY as a pro un-marking their OWN already-assigned
          -- lead from a mistaken 'closed'/'lost' back to active (the pro's
          -- JobStatusSelect dropdown offers exactly this). Allow that; block the
          -- real hole: a homeowner or stranger self-accepting an UNASSIGNED
          -- lead (contractor_id null), or anyone accepting a lead not assigned
          -- to their own contractor.
          if old.contractor_id is null
             or old.contractor_id not in (
               select id from public.contractors where user_id = auth.uid()
             )
             or old.status not in ('closed', 'lost') then
            new.status := old.status;
          end if;
        elsif old.status in ('accepted', 'closed', 'lost') and new.status = 'new' then
          -- (c) No moving a lead backward to 'new' once it has left that
          -- state.
          new.status := old.status;
        elsif old.contractor_id is null and old.status = 'new'
              and new.status in ('closed', 'lost') then
          -- (d) Mirrors closeJobAction: once a lead has a live (non-refunded)
          -- application, the homeowner must pick an applicant rather than
          -- force it closed/lost directly. A still-unassigned lead with NO
          -- applications is unaffected (closeJobAction's normal cancel path,
          -- and the app actually DELETEs there rather than updating status,
          -- but this guard covers the update path too for defense-in-depth).
          select exists (
            select 1 from lead_applications
            where lead_id = old.id and refunded_at is null
          ) into v_has_live_apps;
          if v_has_live_apps then
            new.status := old.status;
          end if;
        end if;
      end if;
      -- ---- end 0087 addition -----------------------------------------------
    end if;

    -- 0088 addition: closed_at is derived bookkeeping, never client-writable,
    -- and stamping must also work for privileged RPC writes (choose_applicant,
    -- rehire_pro, the CCPA-deletion RI cascade at any trigger depth), hence it
    -- runs for every UPDATE, privileged or not, at any trigger depth - it is
    -- NOT nested inside the `not v_privileged and pg_trigger_depth() <= 1`
    -- guard above. It MUST run here, at the very end of the UPDATE branch,
    -- immediately before return new, rather than at the top: it has to derive
    -- from the FINAL new.status, after 0087's anti-forgery guards above have
    -- already reverted any illegitimate status write, not from the tentative
    -- client-supplied new.status those guards haven't checked yet. Deriving
    -- from the tentative value would let a reverted forgery still corrupt
    -- closed_at - e.g. a contractor sends status = 'new' on their own closed
    -- lead; rule (c) above reverts new.status back to 'closed'; if this block
    -- ran first (against the pre-revert 'new'), it would have already nulled
    -- closed_at, leaving a final row of status = 'closed' with
    -- closed_at = null and the hold clock silently erased. Running last means
    -- this block only ever sees the status the row will actually end up with.
    -- Always revert any client-supplied closed_at first, then derive from the
    -- real (final) transition. Clearing closed_at on un-close means a pro
    -- un-marking a mistaken Won (back to 'accepted', per 0087's own allowed
    -- reversal) restarts the hold clock honestly rather than keeping a stale
    -- timestamp from the earlier, later-undone close.
    new.closed_at := old.closed_at;
    if new.status = 'closed' and old.status is distinct from 'closed' then
      new.closed_at := now();
    elsif new.status is distinct from 'closed' and old.status = 'closed' then
      new.closed_at := null;
    end if;

    return new;
  end if;

  return new;
end;
$$;


-- -----------------------------------------------------------------------------
-- PART 4: the two photo gates also require the key to sit under the lead's home
-- -----------------------------------------------------------------------------
-- Defence in depth behind Part 2, and the reason it is worth having anyway:
-- Part 2's trigger only sees writes made AFTER it is applied. Any photos row
-- already carrying a foreign key stays in the table, and these gates are what
-- decides whether /api/job-photo hands it to the admin client for signing. The
-- added predicate makes such a row unusable even if it exists.
--
-- can_preview_job_photo: latest body is 0105_direct_requests.sql:205 (0104's
-- version plus the direct-request branch). can_view_job_photo_full: latest
-- body is 0104_job_photos_for_pros.sql:184; 0105 does NOT redefine it.
-- Both reproduced copy-only apart from the ONE marked line in the binding
-- subquery. Both keep `security definer`, `stable`, `set search_path`, and
-- their grants are re-stated below because CREATE OR REPLACE preserves them
-- but re-stating costs nothing and makes the posture readable in one place.

create or replace function public.can_preview_job_photo(
  p_lead_id uuid,
  p_photo_url text
)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select
    (
      -- (a) board-eligible pro for this open lead (unchanged from 0103).
      exists (
        select 1
        from contractor_leads cl
        join contractors c on c.user_id = auth.uid()
        left join properties pr on pr.id = cl.property_id
        where cl.id = p_lead_id
          and cl.contractor_id is null
          and cl.status = 'new'
          and cl.direct_to is null
          and (c.categories is null or cl.category = any (c.categories))
          and (c.service_state is null
               or pr.state is null
               or upper(btrim(pr.state)) = upper(btrim(c.service_state)))
          and c.serves_orange_county = true
      )
      -- (b) NEW: the direct target of a pending request aimed at them.
      or exists (
        select 1
        from contractor_leads cl
        join contractors c on c.user_id = auth.uid()
        where cl.id = p_lead_id
          and cl.direct_to = c.id
          and cl.contractor_id is null
          and cl.status = 'new'
          and cl.direct_declined_at is null
      )
    )
    and exists (
      select 1
      from photos p
      join contractor_leads cl on cl.issue_id = p.related_id
      where cl.id = p_lead_id
        and p.related_type = 'issue'
        and p.url = p_photo_url
        -- 0131: the object key has to sit under the lead's OWN property, so a
        -- photos row that points somewhere else cannot be laundered into a
        -- signing request through a lead the caller is allowed to see.
        and lower(left(
              public.storage_object_key(p.url),
              length(cl.property_id::text) + 1
            )) = lower(cl.property_id::text || '/')
    );
$$;

grant execute on function public.can_preview_job_photo(uuid, text) to authenticated;

create or replace function public.can_view_job_photo_full(
  p_lead_id uuid,
  p_photo_url text
)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select
    exists (
      select 1
      from photos p
      join contractor_leads cl on cl.issue_id = p.related_id
      where cl.id = p_lead_id
        and p.related_type = 'issue'
        and p.url = p_photo_url
        -- 0131: same binding as can_preview_job_photo above. This is the gate
        -- that unlocks FULL resolution through the admin client, so it is the
        -- one the photos.url forgery was actually aimed at.
        and lower(left(
              public.storage_object_key(p.url),
              length(cl.property_id::text) + 1
            )) = lower(cl.property_id::text || '/')
    )
    and exists (
      select 1
      from contractor_leads cl
      where cl.id = p_lead_id
        and (
          public.owns_property(cl.property_id)
          or cl.contractor_id in (
            select id from contractors where user_id = auth.uid()
          )
          or exists (
            select 1
            from lead_applications la
            join contractors c on c.id = la.contractor_id
            where la.lead_id = cl.id
              and c.user_id = auth.uid()
          )
        )
    );
$$;

grant execute on function public.can_view_job_photo_full(uuid, text) to authenticated;


-- -----------------------------------------------------------------------------
-- PART 5: re-assert the EXECUTE posture on two SECURITY DEFINER helpers
-- -----------------------------------------------------------------------------
-- get_or_create_wallet(uuid) (0010:107) and recompute_contractor_rating(uuid)
-- (0016:16) are SECURITY DEFINER and take their target as a parameter without
-- consulting auth.uid(). Postgres grants EXECUTE on a new function to PUBLIC
-- by default, which is what made that dangerous.
--
-- HONEST NOTE: 0020_security_hardening.sql ALREADY revokes both from public,
-- anon and authenticated (its `lock_down` array names them explicitly) and
-- grants get_or_create_wallet back to service_role. Neither function has been
-- re-created since, and CREATE OR REPLACE does not reset grants, so on a
-- database that ran 0020 this part is a no-op. It is re-stated here because
-- 0020 is a DO block that SKIPS silently when a function is missing, this repo
-- has no schema_migrations bookkeeping, and the live database is believed to
-- have lagged the repo at various points - so "0020 ran" is an assumption, not
-- a fact, and re-asserting it costs one statement each.
--
-- recompute_contractor_rating deliberately gets NO grant back. Its only caller
-- is the reviews_sync_rating trigger function (0016:37), which is itself
-- SECURITY DEFINER and therefore runs as the owner, so revoking authenticated
-- does NOT break a homeowner writing a review.
revoke all on function public.get_or_create_wallet(uuid) from public;
revoke all on function public.get_or_create_wallet(uuid) from anon;
revoke all on function public.get_or_create_wallet(uuid) from authenticated;
grant execute on function public.get_or_create_wallet(uuid) to service_role;

revoke all on function public.recompute_contractor_rating(uuid) from public;
revoke all on function public.recompute_contractor_rating(uuid) from anon;
revoke all on function public.recompute_contractor_rating(uuid) from authenticated;

-- ############################ END 0131_db_layer_ownership.sql ##############################


-- ############################ BEGIN 0132_public_column_constraints.sql ############################
-- =============================================================================
-- Hearth - CHECK constraints on the columns a pro can write directly, an open
-- chargeback freeze, and two review-integrity gates (0132)
-- RUN THIS AGAINST THE LIVE DATABASE (Supabase SQL editor); editing repo SQL
-- alone does NOT change the already-deployed database. 0131 is the last
-- migration in this folder, so this is the next one to apply, in order, with
-- no gaps. 0130 in particular must be applied BEFORE this one: has_open_
-- chargeback() reads abuse_flags, and the leave_review gate reads
-- account_signals.
--
-- WHY THIS EXISTS
--
-- 1. THE APP-LAYER VALIDATORS ON contractors ARE OPTIONAL, AND ALWAYS WERE.
--    0085 revoked the table-level UPDATE on public.contractors and re-granted
--    it column by column; 0124 and 0128 extended that allowlist. What that
--    means in practice is that `authenticated` holds a DIRECT column UPDATE on
--    contractors.logo_url, contact_phone, name, about, yelp_url and
--    google_reviews_url. Supabase publishes the table over PostgREST with the
--    public anon key and the caller's own session JWT, so a pro never has to
--    call savePublicPageAction or saveCompanyAction at all:
--
--      PATCH /rest/v1/contractors?id=eq.<my id>
--      { "logo_url": "https://attacker.example/x.png" }
--
--    goes straight through. Every one of these fields is validated carefully
--    in src/app/pro/actions.ts and src/app/pro/profile/actions.ts, and every
--    one of those checks is skippable. isOwnedStoragePath, the reviewLinks.ts
--    host allowlist, the 200/1000-character caps: all of them are advice.
--
--    So the same rules are restated as CHECK constraints, which PostgREST
--    cannot skip. The point is not that the app checks are wrong - they are
--    right, and they stay, because they produce a friendly message instead of
--    a 400. The point is that until now nothing enforced them.
--
--    logo_url matters most: it is fetch()ed SERVER-SIDE by /api/win-card and
--    /api/review-card to inline the logo into a share image. A pro who can
--    write an arbitrary URL there has a server-side request forgery primitive
--    pointed at anything the Vercel function can reach. Those two routes now
--    also re-check the origin and refuse redirects, but the column being
--    unable to hold a foreign URL in the first place is the real fix.
--
--    ADDED NOT VALID FIRST, THEN VALIDATED as a separate statement, the same
--    shape 0128 used. NOT VALID takes a brief lock and starts enforcing on
--    every new and updated row immediately; VALIDATE then scans the existing
--    rows without blocking writes. If a legacy row breaks one of these rules,
--    the VALIDATE is the statement that FAILS, loudly, and that is deliberate:
--    a silent pass would leave the operator believing rows were checked when
--    they were not. The constraint still stands and still guards every future
--    write. Fix the row and re-run the one validate. The PASTE-ME file for
--    this migration carries a pre-check query per constraint that lists
--    exactly which rows would fail, so this can be settled before anything is
--    run.
--
-- 2. lead_previews IS STILL READABLE BY EVERY SIGNED-IN ACCOUNT.
--    0120 revoked the anon SELECT and stopped there, because that was the
--    finding at the time. The view runs with its OWNER's rights, so RLS on
--    contractor_leads does not apply to it, and it publishes a row per open
--    lead - including the lead id. Nothing in src/ has ever read it: the only
--    reference anywhere is the generated row type in database.types.ts. An
--    unused view that leaks real lead ids to every account on the platform is
--    not worth keeping open, and a lead id is the parameter every RPC in the
--    money path takes.
--
-- 3. A PRO CAN KEEP SPENDING WHILE A CHARGEBACK IS OPEN.
--    The Stripe webhook writes an abuse_flags row of kind 'chargeback' on
--    charge.dispute.created (0130). Nothing read it at the moment a pro buys
--    something. A wallet top-up that has been charged back is money the
--    platform has already lost, and the wallet balance still shows it, so the
--    disputed funds buy leads until somebody notices by hand.
--    has_open_chargeback() plus the two gates below close that. 0130 gains a
--    cleared_at column in the same pass so a dispute that is won or withdrawn
--    can be resolved without deleting the history that it happened.
--
-- 4. A PRO COULD REVIEW THEMSELVES FROM A SECOND ACCOUNT.
--    leave_review()'s bar was "a pro is assigned", and 0082 added "and the
--    reviewer is not literally the pro's own account". That second check is
--    one signup away from useless: make a second account, post a job, get
--    assigned to it, leave five stars. The rating on /p/<slug> is the number
--    homeowners choose on. ONE gate below closes it, using the account_signals
--    links (0130) the trial-abuse scorer already records - a shared card,
--    email or phone between reviewer and pro.
--
--    NOT ADDED, deliberately: a requirement that the job be 'closed' first. A
--    draft carried one. Only the PRO can set that status (it is a stage in
--    their own CRM), so the rule would have handed the reviewed party a veto
--    over their own reviews, and the pro least likely to close a job is the
--    one who did it worst. The full reasoning is in the function body.
--
-- 5. /p/<id> SERVED PAGES browse AND THE SITEMAP BOTH HIDE.
--    public_pro_profile() filtered on the contractor id alone, while
--    browse_pros() and src/app/sitemap.ts both also require user_id is not
--    null and serves_orange_county. So an unclaimed, seeded, or out-of-market
--    row still had a full public business page. The predicate moves into the
--    function, which is the one place every caller goes through.
--
-- WHAT DOES NOT CHANGE: no column is dropped, no data is rewritten, no RLS
-- policy is touched, no price moves, and every function re-issued below is a
-- COPY of its latest definition with the named lines added and nothing else
-- edited. Signatures are unchanged, so CREATE OR REPLACE preserves each
-- function's existing EXECUTE grants.
--
-- Idempotent: every constraint is added only when absent, REVOKE is naturally
-- re-runnable, and the functions are CREATE OR REPLACE. Safe to re-run.
-- =============================================================================


-- =============================================================================
-- Part 1: CHECK constraints on the pro-writable columns of public.contractors
-- =============================================================================
-- THE STORAGE HOST IS WRITTEN OUT LITERALLY, ON PURPOSE.
-- A CHECK constraint is stored as a parsed expression; it cannot read an
-- environment variable, and current_setting() would only move the problem to a
-- database setting nothing else in this schema uses. So the value below is the
-- project's own NEXT_PUBLIC_SUPABASE_URL, copied by hand:
--
--   https://tubkvvfkwggaddcmcjqv.supabase.co
--
-- IF THE SUPABASE PROJECT IS EVER MOVED OR RESTORED UNDER A NEW REF, THIS
-- CONSTRAINT HAS TO BE RE-ISSUED WITH THE NEW HOST, or every logo save starts
-- failing. That is the trade for having the rule enforced at all, and it is
-- the same host isOwnedStoragePath (src/app/pro/profile/actions.ts) derives
-- from the environment at runtime.
--
-- THREE SHAPES ARE ACCEPTED, NOT ONE.
-- savePublicPageAction writes the full public URL:
--   <supabase url>/storage/v1/object/public/pro-logos/<contractor id>/<key>
-- but LEGACY ROWS HOLD A BARE OBJECT PATH. That is not speculation: it is
-- written down in both card routes (src/app/api/win-card/[leadId]/route.tsx,
-- src/app/api/review-card/[reviewId]/route.tsx), whose absoluteLogoUrl()
-- exists specifically to turn a stored bare path into a fetchable URL, and it
-- strips a leading slash and an optional "pro-logos/" prefix on the way. A
-- constraint that accepted only the full URL would fail to VALIDATE against
-- every one of those rows, and the operator's only options would be to blank
-- a pro's logo or to skip the constraint.
--
-- So all three live shapes are allowed, and every one of them is still pinned
-- to THIS row's own contractor id:
--   https://<project>.supabase.co/storage/v1/object/public/pro-logos/<id>/...
--   pro-logos/<id>/...
--   <id>/...
-- ltrim(logo_url, '/') covers the leading-slash variants of the last two,
-- exactly as absoluteLogoUrl does. ltrim(text, text) is immutable, so it is
-- legal in a CHECK.
--
-- The trailing id and slash are what scope a logo to the pro who owns it, and
-- `id` inside a CHECK refers to this row's own id, so one constraint covers
-- every pro.
--
-- The "not like" clause is the traversal half. LIKE knows nothing about path
-- normalization, so without it a value ending in a parent-directory hop
-- satisfies the prefix and still resolves somewhere else entirely.
-- isOwnedStoragePath gets that for free by parsing with new URL(); a LIKE has
-- to say it out loud. It is applied to all three shapes.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.contractors'::regclass
      and conname = 'contractors_logo_url_owned'
  ) then
    alter table public.contractors
      add constraint contractors_logo_url_owned
      check (
        logo_url is null
        or (
          logo_url not like '%..%'
          and (
            logo_url like
              'https://tubkvvfkwggaddcmcjqv.supabase.co/storage/v1/object/public/pro-logos/'
              || id::text || '/%'
            or ltrim(logo_url, '/') like 'pro-logos/' || id::text || '/%'
            or ltrim(logo_url, '/') like id::text || '/%'
          )
        )
      ) not valid;
  end if;
end
$$;

alter table public.contractors validate constraint contractors_logo_url_owned;

-- contact_phone: a phone-shaped string or nothing. Digits, the punctuation a
-- person actually types, and a length window wide enough for a full
-- "+1 (714) 555-0100" and narrow enough that the column stops being a free
-- text field. saveCompanyAction caps this at 40 characters and checks nothing
-- else, so today it will happily store a sentence.
--
-- The hyphen is written LAST inside the bracket expression rather than
-- escaped: in a bracket expression a trailing hyphen is a literal hyphen, and
-- that sidesteps the question of how a backslash behaves inside brackets in
-- this dialect. The set is character for character the one the audit asked
-- for: digits, plus, parentheses, period, space, hyphen.
--
-- NOTE FOR THE OPERATOR: the app still caps this field at 40 characters
-- (cappedFieldOrNull in src/app/pro/actions.ts) while this constraint stops at
-- 20, and the app allows characters this does not (an "ext 12" suffix, for
-- instance). That gap is why the pre-check query in the PASTE-ME file matters:
-- this is the one constraint here that can refuse a value an honest pro typed.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.contractors'::regclass
      and conname = 'contractors_contact_phone_shape'
  ) then
    alter table public.contractors
      add constraint contractors_contact_phone_shape
      check (
        contact_phone is null
        or contact_phone ~ '^[0-9+(). -]{7,20}$'
      ) not valid;
  end if;
end
$$;

alter table public.contractors validate constraint contractors_contact_phone_shape;

-- yelp_url / google_reviews_url: the same host and path rules validateYelpUrl
-- and validateGoogleReviewsUrl apply in src/lib/reviewLinks.ts, plus that
-- file's MAX_LEN of 300. Matched case-insensitively because the JS check
-- lowercases the hostname before comparing but stores the string as typed, so
-- an uppercase host is a value the app accepts today.
--
-- These two are the columns 0128 handed `authenticated` a direct grant on, and
-- they render as outbound "See our reviews" buttons on the public page. An
-- unconstrained column here is an open redirect with a pro's name on it.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.contractors'::regclass
      and conname = 'contractors_yelp_url_shape'
  ) then
    alter table public.contractors
      add constraint contractors_yelp_url_shape
      check (
        yelp_url is null
        or (
          char_length(yelp_url) <= 300
          and yelp_url ~* '^https://(www\.|m\.)?yelp\.com/biz/'
        )
      ) not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.contractors'::regclass
      and conname = 'contractors_google_reviews_url_shape'
  ) then
    alter table public.contractors
      add constraint contractors_google_reviews_url_shape
      check (
        google_reviews_url is null
        or (
          char_length(google_reviews_url) <= 300
          and google_reviews_url ~*
            '^https://(www\.google\.com|google\.com|maps\.google\.com|maps\.app\.goo\.gl|g\.page|g\.co|share\.google)([/?#]|$)'
        )
      ) not valid;
  end if;
end
$$;

alter table public.contractors validate constraint contractors_yelp_url_shape;
alter table public.contractors validate constraint contractors_google_reviews_url_shape;

-- name and about: the caps the two server actions already apply (200 and
-- 1,000), restated where they cannot be skipped. Both strings are rendered
-- verbatim on the public /p/<slug> page, the browse cards and the share
-- images, so an unbounded paste lands in front of homeowners.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.contractors'::regclass
      and conname = 'contractors_name_len'
  ) then
    alter table public.contractors
      add constraint contractors_name_len
      check (char_length(name) <= 200) not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.contractors'::regclass
      and conname = 'contractors_about_len'
  ) then
    alter table public.contractors
      add constraint contractors_about_len
      check (about is null or char_length(about) <= 1000) not valid;
  end if;
end
$$;

alter table public.contractors validate constraint contractors_name_len;
alter table public.contractors validate constraint contractors_about_len;


-- =============================================================================
-- Part 2: lead_previews - revoke the authenticated SELECT grant
-- =============================================================================
-- 0006 granted SELECT to `anon, authenticated`. 0120 revoked anon and left
-- authenticated standing, "in case a signed-in surface ever wants it". No
-- signed-in surface has ever wanted it: a grep of src/ finds zero readers, the
-- only reference is the generated row type. Meanwhile the view runs with owner
-- rights over contractor_leads with no RLS behind it, and one of the columns
-- it publishes is the lead id - the parameter apply_to_lead,
-- unlock_direct_request, choose_applicant and leave_review all take. Handing
-- every signed-in account a list of live lead ids is a starting point for
-- every one of those, and the view earns nothing back.
--
-- Nothing else is dropped. The view stays defined so its history and its
-- warning comment survive, and re-granting it later is one line - by which
-- point somebody will have had to decide what reads it.
revoke select on public.lead_previews from authenticated;

comment on view public.lead_previews is
  'UNUSED public job-board feed, NOW READABLE BY NOBODY: the anon SELECT was '
  'revoked in 0120 and the authenticated SELECT in 0132. Nothing in src/ has '
  'ever read it. It runs with owner rights over contractor_leads with no RLS '
  'behind it and publishes real lead ids, which are the parameter every RPC in '
  'the money path takes. Do not re-grant without deciding what reads it and '
  'why. NEVER add homeowner_name, homeowner_email, homeowner_phone, '
  'property_address, property_id, issue_id or issue_description.';


-- =============================================================================
-- Part 3: has_open_chargeback(uuid)
-- =============================================================================
-- True while the account behind this contractor carries an abuse_flags row of
-- kind 'chargeback' that nobody has cleared. One question, asked in the two
-- places a pro spends money.
--
-- SECURITY DEFINER because abuse_flags is service-role only (0130: RLS on,
-- zero policies, privileges revoked from anon and authenticated). This
-- function is the one supported way to ask, and it returns a single boolean -
-- never the note, never the timestamp, never the row - so a pro cannot mine it
-- for what support wrote down.
--
-- EXECUTE is granted to service_role ONLY, matching linked_accounts (0130).
-- apply_to_lead and unlock_direct_request still call it fine: they are
-- themselves SECURITY DEFINER, so inside them the effective user is the
-- function owner, who owns this function too. `authenticated` cannot call it
-- directly over PostgREST, which is the point - a pro has no business polling
-- their own abuse status.
--
-- Guarded on abuse_flags existing so a database where 0130 has not been
-- applied gets `false` (fail open, nobody frozen) rather than an undefined
-- table error on every apply. Same posture src/lib/risk/* takes.
create or replace function public.has_open_chargeback(p_contractor uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_open boolean;
begin
  if to_regclass('public.abuse_flags') is null then
    return false;
  end if;

  select exists (
    select 1
      from public.abuse_flags f
      join public.contractors c on c.user_id = f.user_id
     where c.id = p_contractor
       and f.kind = 'chargeback'
       and f.cleared_at is null
  ) into v_open;

  return coalesce(v_open, false);
end;
$$;

revoke all on function public.has_open_chargeback(uuid) from public, anon, authenticated;
grant execute on function public.has_open_chargeback(uuid) to service_role;

comment on function public.has_open_chargeback(uuid) is
  'True while the account behind this contractor has an uncleared abuse_flags '
  'row of kind chargeback. Read by apply_to_lead and unlock_direct_request to '
  'freeze spending during a dispute. Service role only; returns a bare boolean '
  'and never any detail of the flag. Clear a dispute by setting '
  'abuse_flags.cleared_at, which only the service role can write.';


-- =============================================================================
-- Part 4: apply_to_lead - 0126's body, plus the chargeback gate
-- =============================================================================
-- COPY-ONLY. This is 0126's definition character for character with ONE block
-- added, immediately after v_contractor resolves. Nothing later than 0126
-- redefines apply_to_lead in this folder (checked across every migration), so
-- that is the live body. The signature is unchanged, so CREATE OR REPLACE
-- preserves the existing EXECUTE grant to `authenticated`.
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
begin
  perform set_config('hearth.lead_write', 'on', true);

  select id, categories, serves_orange_county, launch_cities
    into v_contractor, v_cats, v_oc, v_launch_cities
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

  -- Price the fee from the job's age at apply time (the aging deal). FOR UPDATE
  -- serializes concurrent applies to the same job so the cap below can't be
  -- raced past 3.
  select contractor_id, status, category, property_id,
         public.lead_fee_cents(payout_amount, created_at)
    into v_lead_contractor, v_status, v_category, v_property, v_price
    from contractor_leads where id = p_lead
    for update;
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
  v_price := public.major_lead_price_cents(v_contractor, v_category, v_price);

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

  insert into lead_applications (lead_id, contractor_id, message, status, fee_cents)
    values (p_lead, v_contractor, nullif(btrim(p_message), ''), 'applied', v_price);

  insert into wallet_transactions
    (wallet_id, type, cash_delta_cents, bonus_delta_cents,
     cash_balance_after_cents, bonus_balance_after_cents, lead_id, note)
    values (v_wallet, 'apply_fee', -v_from_cash, -v_from_bonus,
            v_cash_after, v_bonus_after, p_lead, 'Applied to job');

  return true;
end; $$;

-- =============================================================================
-- Part 5: unlock_direct_request - 0115's body, plus the same gate
-- =============================================================================
-- COPY-ONLY, same discipline as Part 4. 0115 is the latest definition of
-- unlock_direct_request in this folder (0105 created it, 0115 re-issued it for
-- the intro price, nothing since). One block added in the same position, for
-- the same reason: this is the other place a pro spends wallet money, and a
-- freeze that covered only the job board would just push a disputing pro
-- toward direct requests.
create or replace function public.unlock_direct_request(p_lead uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare
  v_contractor uuid; v_wallet uuid;
  v_direct_to uuid; v_lead_contractor uuid; v_status text; v_category text;
  v_declined timestamptz; v_unlocked timestamptz; v_price bigint;
  v_cash bigint; v_bonus bigint; v_grant_sum bigint; v_bonus_avail bigint;
  v_from_cash bigint; v_from_bonus bigint;
  v_remaining bigint; v_grant record; v_cash_first boolean;
  v_cash_after bigint; v_bonus_after bigint;
begin
  -- Privileged flag: the contractor_leads_locked trigger (0077, latest body
  -- 0088) strips any client write to contractor_id/paid/paid_at/status unless
  -- this session flag is set, exactly as apply_to_lead/choose_applicant do
  -- (0087). Without it, the final assignment UPDATE below would be silently
  -- reverted after the wallet was already debited. Must be the FIRST statement.
  perform set_config('hearth.lead_write', 'on', true);

  select id into v_contractor from contractors where user_id = auth.uid();
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

  -- Lock the lead and price the fee from its age, same as apply_to_lead.
  -- 0113: category is read too, so the intro price below can tell whether
  -- this is a major-tier request.
  select direct_to, contractor_id, status, category,
         direct_declined_at, direct_unlocked_at,
         public.lead_fee_cents(payout_amount, created_at)
    into v_direct_to, v_lead_contractor, v_status, v_category,
         v_declined, v_unlocked, v_price
    from contractor_leads where id = p_lead
    for update;
  if v_direct_to is null then raise exception 'Not a direct request'; end if;
  if v_direct_to <> v_contractor then raise exception 'Not your request'; end if;

  -- Already unlocked: by me -> idempotent success; otherwise impossible.
  if v_lead_contractor is not null then
    if v_lead_contractor = v_contractor then return true; end if;
    raise exception 'Request already assigned';
  end if;
  if v_declined is not null then raise exception 'Request was declined'; end if;
  if v_status <> 'new' then raise exception 'Request no longer available'; end if;

  v_wallet := get_or_create_wallet(v_contractor);
  -- 0065/0087 hardening: FOR UPDATE so a concurrent charge against this same
  -- wallet (a different lead, an apply, a ghost recharge) can't read a stale
  -- balance and push cash/bonus negative.
  select cash_balance_cents, bonus_balance_cents into v_cash, v_bonus
    from wallets where id = v_wallet
    for update;
  v_cash := coalesce(v_cash, 0);
  v_bonus := coalesce(v_bonus, 0);

  -- 0113: first big-ticket lead intro price, after the wallet lock for the
  -- same serialization reason as apply_to_lead (see 0113's header).
  v_price := public.major_lead_price_cents(v_contractor, v_category, v_price);

  -- Only bonus backed by live, unexpired grants is spendable. Capping at the
  -- grant sum makes the insufficient check honest and guarantees the FIFO drain
  -- below finds enough, so it can never zero out grants and then bail after the
  -- lead was already treated as unlockable (0087).
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
    if v_remaining > 0 then return false; end if;  -- safety
  end if;

  update wallets
     set cash_balance_cents  = cash_balance_cents  - v_from_cash,
         bonus_balance_cents = bonus_balance_cents - v_from_bonus,
         updated_at = now()
   where id = v_wallet
   returning cash_balance_cents, bonus_balance_cents into v_cash_after, v_bonus_after;

  -- History row for the paid unlock (also the row ghost_refund_direct marks).
  insert into lead_applications (lead_id, contractor_id, message, status, fee_cents)
    values (p_lead, v_contractor, null, 'chosen', v_price);

  insert into wallet_transactions
    (wallet_id, type, cash_delta_cents, bonus_delta_cents,
     cash_balance_after_cents, bonus_balance_after_cents, lead_id, note)
    values (v_wallet, 'direct_unlock', -v_from_cash, -v_from_bonus,
            v_cash_after, v_bonus_after, p_lead, 'Direct request unlocked');

  -- Assign + open chat: contractor_id set is what unlocks contact and messages.
  update contractor_leads
     set contractor_id = v_contractor, status = 'accepted',
         paid = true, paid_at = now(), direct_unlocked_at = now()
   where id = p_lead;

  return true;
end; $$;

-- =============================================================================
-- Part 6: leave_review - 0082's body, plus the linked-account gate
-- =============================================================================
-- COPY-ONLY, same discipline. 0082 is the latest definition (0017 created it,
-- 0082 added the self-review guard, nothing since). ONE gate added; every
-- other line is 0082's, and the SELECT reads the same two columns it always
-- did. 0082 recorded that leave_review keeps its
-- default PUBLIC/authenticated EXECUTE grant, and CREATE OR REPLACE on an
-- unchanged signature leaves that exactly as it is.
create or replace function public.leave_review(
  p_lead uuid, p_rating smallint, p_comment text
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_contractor uuid;
  v_property   uuid;
  v_pro_user   uuid;
  v_linked     boolean;
begin
  if p_rating is null or p_rating < 1 or p_rating > 5 then
    raise exception 'Rating must be between 1 and 5';
  end if;

  select contractor_id, property_id
    into v_contractor, v_property
    from contractor_leads
   where id = p_lead;

  if v_property is null then
    raise exception 'Job not found';
  end if;
  -- Only the homeowner who owns the job's property can review it.
  if not public.owns_property(v_property) then
    raise exception 'You can only review your own job';
  end if;
  -- And only once a pro was actually assigned to that job.
  if v_contractor is null then
    raise exception 'No pro was assigned to this job';
  end if;

  -- NO STATUS REQUIREMENT, DELIBERATELY. A draft of this migration also
  -- required contractor_leads.status = 'closed', on the reasoning that a
  -- review should mean work that finished. That was withdrawn, and the reason
  -- is worth writing down so nobody adds it back:
  --
  --   ONLY THE PRO CAN SET 'closed'. It is a stage in the pro's own CRM
  --   (src/app/pro/actions.ts). A rule that says "you may review once the job
  --   is closed" therefore hands the reviewed party a veto over their own
  --   reviews: a pro who never advances a job past 'accepted' can never be
  --   reviewed for it, and the pro most motivated to leave it there is exactly
  --   the one who did the worst job. That is a worse failure than the fake
  --   review it was meant to stop, because it is silent and it favours the bad
  --   actor.
  --
  -- The fake-review path it was aimed at is closed by the link gate below
  -- instead, which does not depend on anything the pro controls.
  --
  -- Self-review guard (0080): reject when the caller's account is the same
  -- one linked to the assigned contractor, i.e. an account that owns both
  -- the property and the pro company on this job.
  select user_id into v_pro_user from contractors where id = v_contractor;
  if v_pro_user is not null and v_pro_user = auth.uid() then
    raise exception 'You can not review your own company';
  end if;

  -- 0132's one new gate: the same person with two accounts. 0080 catches only
  -- the literal case - one account owning both sides - which is one signup
  -- away from useless. account_signals (0130) already knows when two accounts
  -- share a payment card, a normalized email address, or a phone number,
  -- because the trial-abuse scorer records exactly that.
  --
  -- Only those three kinds count here, and the choice is the whole point:
  --   card       - the same payment instrument is close to proof of one person
  --   email_norm - the same inbox with the dots and the +tag moved around
  --   phone      - the same number on both accounts
  -- 'device', 'fingerprint', 'ip' and 'parcel' are deliberately EXCLUDED. A
  -- homeowner reviewing the pro who just worked on their house is very likely
  -- to have shared a wifi network with them that afternoon, and a household
  -- shares every one of those signals. Blocking on them would refuse honest
  -- reviews constantly, and a refused honest review is worse than a missed
  -- fake one here: the honest reviewer has no appeal path.
  --
  -- Guarded on the table existing so this function still works on a database
  -- where 0130 has not been applied yet - it degrades to 0080's behaviour
  -- rather than throwing 42P01 at every reviewer. The same fail-open posture
  -- src/lib/risk/* takes.
  if v_pro_user is not null
     and to_regclass('public.account_signals') is not null then
    select exists (
      select 1
        from public.account_signals mine
        join public.account_signals theirs
          on theirs.kind = mine.kind
         and theirs.value_hash = mine.value_hash
       where mine.user_id = auth.uid()
         and theirs.user_id = v_pro_user
         and mine.kind in ('card', 'email_norm', 'phone')
    ) into v_linked;
    if coalesce(v_linked, false) then
      raise exception 'This account is linked to that pro, so it can not leave a review';
    end if;
  end if;

  insert into public.reviews (lead_id, contractor_id, property_id, rating, comment)
    values (p_lead, v_contractor, v_property, p_rating, nullif(btrim(p_comment), ''))
  on conflict (lead_id) do update
    set rating     = excluded.rating,
        comment    = excluded.comment,
        created_at = now();
end;
$$;

-- =============================================================================
-- Part 7: public_pro_profile - 0113's body, plus the visibility predicate
-- =============================================================================
-- COPY-ONLY, same discipline. 0113 is the latest definition (0112 freed the
-- trust badges, 0113 added the two review links, and 0114/0123 touch
-- browse_pros only). Two predicates added to the final WHERE; the entire
-- payload above it is 0113's, unchanged.
--
-- The grants are restated here rather than relied on, because this is the one
-- function in the file whose EXECUTE reaches `anon`: /p/<id> is a signed-out
-- page. CREATE OR REPLACE would have preserved them anyway; saying them out
-- loud means a reader of this file can see exactly who may call it.
create or replace function public.public_pro_profile(p_contractor uuid)
returns jsonb
language sql
security definer
stable
set search_path = public
as $$
  select jsonb_build_object(
    'id',           c.id,
    'slug',         c.slug,
    'name',         c.name,
    'categories',   coalesce(c.categories, '{}'),
    'created_at',   c.created_at,
    -- Rating exactly as the rest of the app shows it: only real review
    -- averages (review_count > 0), never seeded placeholder values.
    'rating',       case when c.review_count > 0 then c.rating end,
    'review_count', c.review_count,
    'member',       m.live,
    -- Cosmetics: legitimate paid-member perks, still gated on m.live.
    'logo_url',     case when m.live then c.logo_url end,
    'about',        case when m.live then c.about end,
    -- Trust signals: FREE for every pro (0109). The gray "on file" badge is a
    -- safety fact, not a paid perk - same reasoning as license_verified_at and
    -- background_checked_at below. m.live no longer gates these.
    'has_license',  c.license_number is not null
                    and btrim(c.license_number) <> '',
    'has_insurance', c.insurance_carrier is not null
                    and btrim(c.insurance_carrier) <> '',
    -- Outbound review-page links (0110): trust signals, FREE for every pro,
    -- same policy as the "on file" booleans above - never gated on m.live. The
    -- page renders these only as plain "See our reviews" outbound buttons.
    'yelp_url',            c.yelp_url,
    'google_reviews_url',  c.google_reviews_url,
    -- Real CSLB verification (0055). Free feature, not gated on membership.
    -- Only the timestamp, never the status text or CSLB detail: a 'failed'
    -- check must never be inferable from the public payload.
    'license_verified_at', c.license_verified_at,
    -- Real Checkr background check (0057). Free feature, not gated on
    -- membership. Only the timestamp, never the status text or detail: a
    -- 'consider' or in-progress check must never be inferable from the
    -- public payload - it is indistinguishable from 'none' out here.
    'background_checked_at', c.background_checked_at,
    'reviews', coalesce((
      select jsonb_agg(
               jsonb_build_object(
                 'rating',     r.rating,
                 'comment',    r.comment,
                 'created_at', r.created_at
               ) order by r.created_at desc)
      from (
        select rating, comment, created_at
        from public.reviews
        where contractor_id = c.id
        order by created_at desc
        limit 100
      ) r
    ), '[]'::jsonb),
    'projects', coalesce((
      select jsonb_agg(
               jsonb_build_object(
                 'title',       p.title,
                 'category',    p.category,
                 'description', p.description,
                 'months',      p.months,
                 'photos', coalesce((
                   select jsonb_agg(
                            jsonb_build_object(
                              'url',       ph.url,
                              -- Before/After labels are a member perk; the
                              -- photos themselves show for every pro.
                              'is_before', ph.is_before and m.live
                            ) order by ph.sort asc, ph.created_at asc)
                   from public.pro_project_photos ph
                   where ph.project_id = p.id
                 ), '[]'::jsonb)
               ) order by p.sort asc, p.created_at asc)
      from (
        select id, title, category, description, months, sort, created_at
        from public.pro_projects
        where contractor_id = c.id
        order by sort asc, created_at asc
        limit 12
      ) p
    ), '[]'::jsonb)
  )
  from public.contractors c
  cross join lateral (
    -- Mirrors hasProPlan(): a pro_ plan, active or trialing, not past a known
    -- period end. Perks only; it gates NOTHING about rating or reviews above,
    -- and as of 0109 nothing about the license/insurance trust booleans either.
    select exists (
      select 1
      from public.subscriptions s
      where s.user_id = c.user_id
        and s.plan like 'pro\_%'
        and s.status in ('active', 'trialing')
        and (s.current_period_end is null or s.current_period_end > now())
    ) as live
  ) m
  where c.id = p_contractor
    -- 0132: the same two visibility filters browse_pros() and the sitemap
    -- already apply, moved into the ONE function that serves the public page.
    --   user_id is not null  - an unclaimed/seeded row has nobody standing
    --                          behind it, so /p/<id> was a real, indexable,
    --                          shareable business page for a company that has
    --                          never had an account here. Reviews, categories,
    --                          the "license on file" badge, all of it, with no
    --                          owner to be accountable for any of it.
    --   serves_orange_county - the launch-market gate. A pro outside it cannot
    --                          be reached through the product at all, so the
    --                          page was a dead end that still ranked.
    -- Returning nothing makes /p/<id> render its not-found page, which is what
    -- browse and the sitemap were already telling everyone.
    and c.user_id is not null
    and coalesce(c.serves_orange_county, false);
$$;

grant execute on function public.public_pro_profile(uuid) to anon;
grant execute on function public.public_pro_profile(uuid) to authenticated;

comment on function public.public_pro_profile(uuid) is
  'Public business page payload for /p/<id>. Returns nothing unless the row is '
  'claimed (user_id is not null) and in the launch market '
  '(serves_orange_county), the same two filters browse_pros and the sitemap '
  'apply, so the public page can never show a pro the directory hides.';

-- ############################ END 0132_public_column_constraints.sql ##############################
