-- ============================================================================
-- HEARTH: ALL PENDING LIVE MIGRATIONS IN ONE PASTE (built 2026-08-29)
-- Supabase > SQL editor > new query > paste this whole file > Run.
--
-- Order inside: PRECHECK guard -> 0129-0132 -> 0133 -> 0135 -> 0136 -> 0137
--               -> 0138 -> 0139 -> 0140
--
-- The editor runs the paste as one transaction. If anything fails, nothing
-- is applied and the error names the section. The guard at the top is the
-- six PRECHECK queries: if any of them finds rows, it stops here with a
-- message telling you which one, and nothing below runs.
--
-- Only the LAST query's result shows in the editor. A green "Success" is the
-- pass signal; the per-file verify queries are kept in the sources listed
-- below if you want to run one on its own afterward.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- SECTION 0: PRECHECK guard (from PRECHECK-2026-08-26.sql, read-only)
-- ---------------------------------------------------------------------------
do $precheck$
declare n int;
begin
  select count(*) into n from (select id, name, logo_url
  from public.contractors
 where logo_url is not null
   and not (
     logo_url not like '%..%'
     and (
       logo_url like
         'https://tubkvvfkwggaddcmcjqv.supabase.co/storage/v1/object/public/pro-logos/'
         || id::text || '/%'
       or ltrim(logo_url, '/') like 'pro-logos/' || id::text || '/%'
       or ltrim(logo_url, '/') like id::text || '/%'
     )
   )) q;
  if n > 0 then raise exception 'PRECHECK P1 contractors.logo_url outside the pro''s own pro-logos folder: % row(s). Run supabase/PRECHECK-2026-08-26.sql by itself, fix those rows, then paste this file again. Nothing was changed.', n; end if;
  select count(*) into n from (select id, name, contact_phone, char_length(contact_phone) as len
  from public.contractors
 where contact_phone is not null
   and contact_phone !~ '^[0-9+(). -]{7,20}$') q;
  if n > 0 then raise exception 'PRECHECK P2 contractors.contact_phone not phone-shaped or over 20 chars: % row(s). Run supabase/PRECHECK-2026-08-26.sql by itself, fix those rows, then paste this file again. Nothing was changed.', n; end if;
  select count(*) into n from (select id, name, yelp_url
  from public.contractors
 where yelp_url is not null
   and (
     char_length(yelp_url) > 300
     or yelp_url !~* '^https://(www\.|m\.)?yelp\.com/biz/'
   )) q;
  if n > 0 then raise exception 'PRECHECK P3 contractors.yelp_url not a yelp.com/biz page: % row(s). Run supabase/PRECHECK-2026-08-26.sql by itself, fix those rows, then paste this file again. Nothing was changed.', n; end if;
  select count(*) into n from (select id, name, google_reviews_url
  from public.contractors
 where google_reviews_url is not null
   and (
     char_length(google_reviews_url) > 300
     or google_reviews_url !~*
       '^https://(www\.google\.com|google\.com|maps\.google\.com|maps\.app\.goo\.gl|g\.page|g\.co|share\.google)([/?#]|$)'
   )) q;
  if n > 0 then raise exception 'PRECHECK P4 contractors.google_reviews_url not on a Google host: % row(s). Run supabase/PRECHECK-2026-08-26.sql by itself, fix those rows, then paste this file again. Nothing was changed.', n; end if;
  select count(*) into n from (select id, char_length(name) as len, left(name, 80) as name_start
  from public.contractors
 where char_length(name) > 200) q;
  if n > 0 then raise exception 'PRECHECK P5 contractors.name over 200 chars: % row(s). Run supabase/PRECHECK-2026-08-26.sql by itself, fix those rows, then paste this file again. Nothing was changed.', n; end if;
  select count(*) into n from (select id, name, char_length(about) as len
  from public.contractors
 where about is not null and char_length(about) > 1000) q;
  if n > 0 then raise exception 'PRECHECK P6 contractors.about over 1000 chars: % row(s). Run supabase/PRECHECK-2026-08-26.sql by itself, fix those rows, then paste this file again. Nothing was changed.', n; end if;
end $precheck$;


-- ############################################################################
-- SECTION: 0129-0132 (all Orange County, account risk, db-layer ownership, public column constraints)
-- source: supabase/COMBINED-2026-08-26-migrations-0129-0132.sql
-- ############################################################################

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


-- ############################################################################
-- SECTION: 0133 app_feedback
-- source: supabase/PASTE-ME-live-2026-08-27-app-feedback.sql
-- ############################################################################

-- ============================================================================
-- HEARTH LIVE-DB BUNDLE: migration 0133 (2026-08-27)
-- Paste this WHOLE file into the Supabase SQL editor and run it ONCE.
-- Safe to re-run: every statement is idempotent.
-- Live DB should be at 0132 before this. After running, live is at 0133.
--
-- WHAT THIS IS: one new table, app_feedback, backing the in-app review
-- prompt ("Enjoying Hearth?" -> Love it / Not really) and the private
-- /feedback form "Not really" routes to. See the migration file itself
-- (supabase/migrations/0133_app_feedback.sql) for the full reasoning.
--
-- NOTHING BREAKS IF YOU DELAY THIS. src/components/ReviewPrompt.tsx and
-- src/app/(app)/feedback/actions.ts both talk to this table; until it exists
-- the eligibility check and every insert simply error, which the actions file
-- treats as "not eligible" / "couldn't save" rather than throwing, so no page
-- goes down waiting on it - the prompt just never appears and the feedback
-- form shows its normal error toast.
-- ============================================================================

-- >>>>>>>>>> BEGIN 0133_app_feedback.sql >>>>>>>>>>

create table if not exists public.app_feedback (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users (id) on delete cascade,
  side          text not null default 'homeowner' check (side in ('homeowner', 'pro')),
  kind          text not null check (kind in ('prompt_shown', 'loved', 'not_really')),
  message       text,
  contact_email text,
  created_at    timestamptz not null default now()
);
create index if not exists app_feedback_user_id_idx on public.app_feedback (user_id);

-- At most one message-less prompt event ('prompt_shown'/'loved'/'not_really')
-- per account, so the "ask at most once" rule is enforced by the database and
-- not by the app winning a read-then-write race. The /feedback form's rows
-- carry a message and are exempt, so somebody can still send more than one
-- note. See the migration file for the full reasoning.
create unique index if not exists app_feedback_one_event_per_kind_idx
  on public.app_feedback (user_id, kind)
  where message is null;

alter table public.app_feedback enable row level security;

drop policy if exists "app_feedback self insert" on public.app_feedback;
create policy "app_feedback self insert" on public.app_feedback
  for insert to authenticated
  with check (user_id = auth.uid());

comment on table public.app_feedback is
  'Review-prompt event log ("prompt_shown"/"loved"/"not_really") and the private feedback form it routes an unhappy answer to. Insert-your-own-row only for authenticated: no select policy exists, so nobody can read a row back, including their own. The service role reads everything.';

-- <<<<<<<<<< END 0133_app_feedback.sql <<<<<<<<<<

-- Verify (should return one row: app_feedback | YES):
--   select relname, relrowsecurity
--     from pg_class
--    where relname = 'app_feedback';
--
-- Verify RLS: an authenticated user can insert their own row but a select
-- from the browser's own session (anon/authenticated key) returns nothing,
-- ever - that is the design, not a bug. Only the service-role key (used by
-- src/app/(app)/feedback/actions.ts via createAdminClient()) can read it:
--   select kind, count(*) from public.app_feedback group by kind;


-- ############################################################################
-- SECTION: 0135 free AI tastes
-- source: supabase/PASTE-ME-live-2026-08-28-free-ai-tastes.sql
-- ############################################################################

-- ============================================================================
-- HEARTH LIVE-DB BUNDLE: migration 0135 (2026-08-28)
-- Paste this WHOLE file into the Supabase SQL editor and run it ONCE.
-- Safe to re-run: every statement is idempotent.
-- Live DB should be at 0133 (or 0134) before this. After running, live is
-- at 0135.
--
-- WHAT THIS IS: two counter columns on public.users plus the two service-role
-- functions that move them, so the document vault's AI read and the
-- inspection report import stop being free-and-unlimited on the paid model.
-- Free accounts get a lifetime taste (2 document reads, 1 inspection import);
-- Plus and trialing accounts are unaffected and stay bounded by the existing
-- daily ceilings in src/lib/aiUsage.ts.
--
-- NOTHING BREAKS IF YOU DELAY THIS. src/lib/freeAiTaste.ts FAILS OPEN on a
-- missing column or a missing function: it logs and lets the read through,
-- which is exactly today's behaviour. The meter simply does not appear and no
-- free account is ever told it spent something the database cannot prove it
-- spent. The generic per-user daily cap, the burst window, and the owner-wide
-- spend breakers all still apply in the meantime.
-- ============================================================================

-- >>>>>>>>>> BEGIN 0135_free_ai_tastes.sql >>>>>>>>>>

alter table public.users
  add column if not exists free_doc_reads_used integer not null default 0;

alter table public.users
  add column if not exists free_inspection_reads_used integer not null default 0;

comment on column public.users.free_doc_reads_used is
  'Lifetime document-vault AI reads a non-Plus account has spent. Claimed by claim_free_ai_taste, handed back by refund_free_ai_taste when the model call fails.';

comment on column public.users.free_inspection_reads_used is
  'Lifetime inspection-report imports a non-Plus account has spent. Same pair of functions as free_doc_reads_used.';

-- Claim one taste, ATOMICALLY.
--
-- WHY A FUNCTION. supabase-js sends literal values in an update, so it cannot
-- express `col = col + 1`; a read-then-write from the app would let two
-- parallel requests both pass the same check and each spend a taste that was
-- never there. This does the read and the write in one statement, with the
-- limit in the WHERE clause, so exactly p_limit claims can ever succeed no
-- matter how many requests arrive at once. That is the same guarantee the
-- quote analyzer gets from its conditional `is null` update
-- (src/app/api/analyze-quote/route.ts).
--
-- Returns true when this caller got a taste, false when they are out (or the
-- feature name is unknown, or the row is missing). The app treats false as the
-- paywall.
--
-- INVOKER, deliberately (no `security definer` line - invoker is Postgres's
-- default). EXECUTE is granted to service_role ONLY, the same trusted-server
-- posture as linked_accounts (0130) and claim_promo (0073), and Supabase's
-- service_role already carries BYPASSRLS - so the only role that can call this
-- function already sees past "users self update" without any help. Definer
-- would therefore add no capability at all, while turning a future copy-paste
-- mistake (one stray `grant execute ... to authenticated`) from a permission
-- error into a privilege escalation on public.users. The atomicity that
-- actually matters here comes from the single conditional UPDATE below, not
-- from the definer bit. `set search_path = public` stays either way: it pins
-- the schema this body resolves against no matter who calls it. Postgres
-- grants EXECUTE on a new function to PUBLIC, so that grant is revoked
-- explicitly.
create or replace function public.claim_free_ai_taste(
  p_user uuid,
  p_feature text,
  p_limit integer
)
returns boolean
language plpgsql
set search_path = public
as $$
declare
  v_rows integer;
begin
  if p_user is null or p_limit is null or p_limit <= 0 then
    return false;
  end if;

  -- A CASE over two known names rather than dynamic SQL: the feature list is
  -- fixed, and there is no string ever interpolated into a statement here.
  if p_feature = 'document' then
    update public.users
       set free_doc_reads_used = coalesce(free_doc_reads_used, 0) + 1
     where id = p_user
       and coalesce(free_doc_reads_used, 0) < p_limit;
  elsif p_feature = 'inspection' then
    update public.users
       set free_inspection_reads_used = coalesce(free_inspection_reads_used, 0) + 1
     where id = p_user
       and coalesce(free_inspection_reads_used, 0) < p_limit;
  else
    return false;
  end if;

  get diagnostics v_rows = row_count;
  return v_rows > 0;
end;
$$;

comment on function public.claim_free_ai_taste(uuid, text, integer) is
  'Atomically spend one free AI taste for p_user on p_feature (document | inspection) while under p_limit. True when claimed. Service role only.';

-- The grant is the LAST thing said about this function, deliberately: whoever
-- reads or edits this block should see the full role list with nothing after
-- it that could be mistaken for a second grant.
revoke all on function public.claim_free_ai_taste(uuid, text, integer)
  from public, anon, authenticated;
grant execute on function public.claim_free_ai_taste(uuid, text, integer)
  to service_role;

-- Hand a claimed taste back when the model call never produced a result: a
-- blurry photo, a thrown request, a ceiling above the caller. Same thinking as
-- refundAskUsage / refundAiUsage in src/lib/aiUsage.ts, which is why the app
-- claims up front (race-proof) and refunds on failure rather than counting
-- afterwards. Never drives a counter below zero.
--
-- INVOKER for the same reason as claim_free_ai_taste above: service_role is
-- the only role granted EXECUTE, and it already bypasses RLS.
create or replace function public.refund_free_ai_taste(
  p_user uuid,
  p_feature text
)
returns void
language plpgsql
set search_path = public
as $$
begin
  if p_user is null then
    return;
  end if;

  if p_feature = 'document' then
    update public.users
       set free_doc_reads_used = greatest(coalesce(free_doc_reads_used, 0) - 1, 0)
     where id = p_user;
  elsif p_feature = 'inspection' then
    update public.users
       set free_inspection_reads_used =
             greatest(coalesce(free_inspection_reads_used, 0) - 1, 0)
     where id = p_user;
  end if;
end;
$$;

comment on function public.refund_free_ai_taste(uuid, text) is
  'Hand back one free AI taste for p_user on p_feature after a failed model call. Never goes below zero. Service role only.';

-- Grant last, same reasoning as claim_free_ai_taste above.
revoke all on function public.refund_free_ai_taste(uuid, text)
  from public, anon, authenticated;
grant execute on function public.refund_free_ai_taste(uuid, text)
  to service_role;

-- <<<<<<<<<< END 0135_free_ai_tastes.sql <<<<<<<<<<

-- Verify 1, the columns exist with the right defaults (should return two
-- rows: free_doc_reads_used | integer | 0 | NO, and
-- free_inspection_reads_used | integer | 0 | NO):
--   select column_name, data_type, column_default, is_nullable
--     from information_schema.columns
--    where table_schema = 'public'
--      and table_name = 'users'
--      and column_name in ('free_doc_reads_used', 'free_inspection_reads_used')
--    order by column_name;
--
-- Verify 2, no existing row was left null and nobody was retroactively
-- charged a taste (should return one row: 0 | 0 | 0):
--   select count(*) filter (where free_doc_reads_used is null
--                              or free_inspection_reads_used is null) as nulls,
--          count(*) filter (where free_doc_reads_used > 0) as docs_spent,
--          count(*) filter (where free_inspection_reads_used > 0) as inspections_spent
--     from public.users;
--
-- Verify 3, both functions exist and are service_role only (should return two
-- rows, each with acl showing service_role=X and NOTHING for anon,
-- authenticated, or PUBLIC, and security_definer = f on both - these two are
-- SECURITY INVOKER on purpose, see the comment above claim_free_ai_taste):
--   select p.proname, pg_get_function_identity_arguments(p.oid) as args,
--          p.prosecdef as security_definer, p.proacl::text as acl
--     from pg_proc p
--     join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'public'
--      and p.proname in ('claim_free_ai_taste', 'refund_free_ai_taste')
--    order by p.proname;
--
-- Verify 4, the claim is really capped (run against YOUR OWN user id, then
-- put it back). With the app limit of 2 for documents, the first two calls
-- return true and the third returns false:
--   select public.claim_free_ai_taste('<your-user-id>'::uuid, 'document', 2);
--   select public.claim_free_ai_taste('<your-user-id>'::uuid, 'document', 2);
--   select public.claim_free_ai_taste('<your-user-id>'::uuid, 'document', 2);  -- false
--   select public.refund_free_ai_taste('<your-user-id>'::uuid, 'document');
--   select public.refund_free_ai_taste('<your-user-id>'::uuid, 'document');
--   select free_doc_reads_used from public.users where id = '<your-user-id>';  -- back to 0


-- ############################################################################
-- SECTION: 0136 household_members indexes
-- source: supabase/PASTE-ME-live-2026-08-28-perf-indexes.sql
-- ############################################################################

-- ============================================================================
-- HEARTH LIVE-DB BUNDLE: migration 0136 (2026-08-28)
-- Paste this WHOLE file into the Supabase SQL editor and run it ONCE.
-- Safe to re-run: every statement is idempotent (create index IF NOT EXISTS).
--
-- WHAT THIS IS: two indexes on public.household_members, and nothing else.
-- No new tables, columns, functions, policies or grants. Nobody gains or loses
-- access to a single row; this only gives Postgres a cheaper way to answer two
-- lookups it already answers on every request.
--
-- NOTHING BREAKS IF YOU DELAY THIS. Every query below already works today; it
-- just does more work per call than it needs to. Applying this is a speed
-- change, not a correctness one.
--
-- WHY NOT `create index concurrently`. It cannot run inside a transaction
-- block, and the SQL editor wraps what you paste in one, so CONCURRENTLY here
-- would fail outright. household_members holds a handful of rows per home, so
-- the plain form below takes milliseconds and its brief write lock is not
-- something a live site will notice. (If this table ever grows large, run each
-- create index concurrently by itself, in its own editor tab, instead.)
-- ============================================================================

-- >>>>>>>>>> BEGIN 0136_household_members_idx.sql >>>>>>>>>>

-- 1. is_active_member(), the RLS function on the app's hottest reads.
--
-- 0051 defines it as: property_id = $1 AND member_user_id = auth.uid() AND
-- status = 'active'. It backs the "properties member select" policy and,
-- through owns_property() (0124), the RLS on home_systems, maintenance_tasks,
-- issues, photos, contractor_leads and documents - so it is consulted while
-- evaluating every one of the dashboard's parallel queries for a shared home.
--
-- The only index this table had is household_members_property_email_key, a
-- unique index on (property_id, lower(invited_email)). invited_email is not in
-- that predicate, so past the property_id prefix it cannot help.
create index if not exists household_members_active_member_idx
  on public.household_members (property_id, member_user_id, status);

-- 2. "which homes am I a member of", keyed by the member. No usable index
-- exists for this today, because member_user_id leads nothing:
--   src/lib/notify.ts   lookupPlusStatus: .eq(member_user_id).eq(status)
--   src/lib/risk/facts.ts householdPeerIds: the member_user_id half of its OR
create index if not exists household_members_member_status_idx
  on public.household_members (member_user_id, status);

comment on index public.household_members_active_member_idx is
  'Serves is_active_member(p_property_id) (0051), which RLS calls on every read of a shared home. Added in 0136.';

comment on index public.household_members_member_status_idx is
  'Serves the member-keyed lookups in lookupPlusStatus (notify.ts) and householdPeerIds (risk/facts.ts). Added in 0136.';

-- <<<<<<<<<< END 0136_household_members_idx.sql <<<<<<<<<<

-- Verify 1, both indexes exist (should return exactly two rows,
-- household_members_active_member_idx and household_members_member_status_idx,
-- with the column lists shown in their definitions):
--   select indexname, indexdef
--     from pg_indexes
--    where schemaname = 'public'
--      and tablename = 'household_members'
--      and indexname in ('household_members_active_member_idx',
--                        'household_members_member_status_idx')
--    order by indexname;
--
-- Verify 2, both are valid and ready (should return two rows, each with
-- indisvalid = true and indisready = true):
--   select c.relname as index_name, i.indisvalid, i.indisready
--     from pg_index i
--     join pg_class c on c.oid = i.indexrelid
--     join pg_class t on t.oid = i.indrelid
--    where t.relname = 'household_members'
--      and c.relname in ('household_members_active_member_idx',
--                        'household_members_member_status_idx');
--
-- Verify 3, the planner will actually use the first one. Substitute a real
-- property id and a real member's user id from your own data. On a table this
-- small Postgres may legitimately still choose a sequential scan (that is not
-- a failure - it means the table is too small for an index to pay); the point
-- is that the index is available and the plan is cheap either way:
--   explain analyze
--   select exists (
--     select 1 from public.household_members hm
--      where hm.property_id = '<a-property-id>'::uuid
--        and hm.member_user_id = '<a-member-user-id>'::uuid
--        and hm.status = 'active'
--   );
--
-- Verify 4, same for the member-keyed direction:
--   explain analyze
--   select property_id from public.household_members
--    where member_user_id = '<a-member-user-id>'::uuid
--      and status = 'active';
--
-- Verify 5, nothing else changed. Row count before and after must match, and
-- no policy or grant was touched by this file (should return the same number
-- you had before running it):
--   select count(*) from public.household_members;


-- ############################################################################
-- SECTION: 0137 app guide seen
-- source: supabase/PASTE-ME-live-2026-08-28-app-guide.sql
-- ############################################################################

-- ============================================================================
-- HEARTH LIVE-DB BUNDLE: migration 0137 (2026-08-28)
-- Paste this WHOLE file into the Supabase SQL editor and run it ONCE.
-- Safe to re-run: every statement is idempotent.
--
-- WHAT THIS IS: two nullable timestamptz columns on public.users that remember
-- whether an account has already been shown the first-run app guide - one
-- stamp for the homeowner guide, one for the contractor guide, because one
-- account can hold both sides. No new table, no new policy, no new grant: the
-- "users self select" / "users self update" policies from migration 0002
-- already cover a user reading and writing their own row, which is all this
-- needs.
--
-- ORDER: this does not depend on 0134-0136. If those are still unapplied, this
-- can go in before or after them without changing anything.
--
-- NOTHING BREAKS IF YOU DELAY THIS. src/components/AppGuideMount.tsx reads the
-- stamp through a select *, so a database without these columns simply reports
-- "not seen yet", and the browser-side localStorage mirror in
-- src/components/AppGuide.tsx keeps the guide to once per browser in the
-- meantime. The write in src/lib/appGuideActions.ts errors and is swallowed on
-- purpose. Nothing 500s either way.
-- ============================================================================

-- >>>>>>>>>> BEGIN 0137_app_guide_seen.sql >>>>>>>>>>

alter table public.users
  add column if not exists guide_seen_at timestamptz;

alter table public.users
  add column if not exists pro_guide_seen_at timestamptz;

comment on column public.users.guide_seen_at is
  'When this account closed the homeowner first-run app guide (src/components/AppGuide.tsx). Null = never shown yet. Stamped once, never cleared by the app.';
comment on column public.users.pro_guide_seen_at is
  'When this account closed the contractor first-run app guide. Separate from guide_seen_at because one account can hold both sides.';

-- <<<<<<<<<< END 0137_app_guide_seen.sql <<<<<<<<<<

-- ============================================================================
-- VERIFY (run these after the block above; each should match the note)
-- ============================================================================

-- 1. Both columns exist, both nullable, both timestamptz.
--    Expect exactly 2 rows: guide_seen_at | timestamp with time zone | YES
--                           pro_guide_seen_at | timestamp with time zone | YES
-- select column_name, data_type, is_nullable
--   from information_schema.columns
--  where table_schema = 'public'
--    and table_name = 'users'
--    and column_name in ('guide_seen_at', 'pro_guide_seen_at')
--  order by column_name;

-- 2. No account was accidentally stamped by the migration itself: every
--    existing row must still be null on both, so nobody silently loses a guide
--    they never saw. Expect one row: 0 | 0.
-- select count(*) filter (where guide_seen_at is not null)     as homeowner_stamped,
--        count(*) filter (where pro_guide_seen_at is not null) as pro_stamped
--   from public.users;

-- 3. RLS is still on for the table and no new policy appeared. Expect
--    users | true, and the same policy list as before (users self select,
--    users self update, plus whatever else is already there).
-- select relname, relrowsecurity from pg_class where relname = 'users';
-- select policyname, cmd from pg_policies
--  where schemaname = 'public' and tablename = 'users'
--  order by policyname;

-- 4. After signing in once on the live site and closing the guide, the stamp
--    should be set for that account and only that account. Replace the email.
-- select email, guide_seen_at, pro_guide_seen_at
--   from public.users
--  where email = 'you@example.com';

-- 5. If you ever want to see the guide again yourself for a screenshot, clear
--    your own stamp AND clear the browser mirror (devtools > Application >
--    Local Storage > remove hearth_app_guide_seen / hearth_pro_guide_seen).
--    Both have to go: either one alone keeps the guide hidden.
-- update public.users
--    set guide_seen_at = null, pro_guide_seen_at = null
--  where email = 'you@example.com';


-- ############################################################################
-- SECTION: 0138 user_blocks
-- source: supabase/PASTE-ME-live-2026-08-28-user-blocks.sql
-- ############################################################################

-- ============================================================================
-- HEARTH LIVE-DB BUNDLE: migration 0138 (2026-08-28)
-- Paste this WHOLE file into the Supabase SQL editor and run it ONCE.
-- Safe to re-run: every statement is idempotent.
-- Live DB should be at 0137 before this. After running, live is at 0138.
--
-- WHAT THIS IS: the App Store guideline 1.2 pieces Hearth was missing.
--   * a new table, public.user_blocks, so one account can block another;
--   * that block enforced in four places (messages insert policy, a messages
--     BEFORE INSERT trigger, open_jobs_for_me(), apply_to_lead());
--   * public.reports widened so a REVIEW or a PRO PROFILE can be reported,
--     not just a chat thread (lead_id becomes nullable, target_type/target_id
--     added);
--   * contractor_reviews() and public_pro_profile() now return each review's
--     id, which is what the new "Report this review" link targets.
--
-- RUN ORDER: this file must run AFTER 0129-0137. It re-issues
-- open_jobs_for_me() from 0124 and apply_to_lead() from 0132; running it
-- before those would roll those two functions backwards.
--
-- NOTHING BREAKS IF YOU DELAY THIS:
--   * /account/blocks and /pro/blocks read user_blocks through a wrapper that
--     turns a missing-table error into an empty list, so both pages render
--     their normal "You have not blocked anyone" state.
--   * The Block button's insert fails, and the UI says "Couldn't block this
--     person just now" instead of claiming it worked.
--   * The "Report this review" link never appears, because it is gated on a
--     review id only the new contractor_reviews()/public_pro_profile() return.
--   * Reporting a pro's profile fails the same honest way as the Block button.
--   * Chat reporting, applying to jobs, the job board and messaging all keep
--     working exactly as they do today.
--
-- ONE DESTRUCTIVE STATEMENT: `drop function if exists
-- public.contractor_reviews(uuid)` in Part 7, immediately followed by its
-- replacement. Postgres will not let CREATE OR REPLACE add a column to a
-- function's return type, so the drop is unavoidable. Run this file in one
-- paste (one transaction) and there is no window where it is missing.
-- ============================================================================

-- >>>>>>>>>> BEGIN 0138_user_blocks.sql >>>>>>>>>>

-- =============================================================================
-- Hearth - blocking, and reporting beyond the chat thread
--
-- WHY: App Store guideline 1.2 (user-generated content) asks for three things
-- on any app where strangers can talk to each other: a way to REPORT
-- objectionable content, a way to BLOCK an abusive user, and a published way
-- to reach the people who run the service. Hearth already had the first one
-- for chat only (public.reports, migration 0009) and the third one (the
-- /contact form, migration 0024's support_messages). This migration adds the
-- block half and widens reporting to cover reviews and pro profiles.
--
-- WHAT THIS FILE DOES, in order:
--   1. public.user_blocks - one row per "I never want to hear from this
--      account again". Self-scoped RLS: you can only see, create and remove
--      YOUR OWN blocks. Nobody can read who blocked them.
--   2. public.blocked_between(uuid, uuid) and public.lead_has_block(uuid) -
--      the two read helpers everything below shares, so the rule lives in one
--      place instead of being re-typed into four call sites. blocked_between
--      is service_role only (a grant to `authenticated` would publish it as a
--      PostgREST RPC and let anyone ask "did that account block me?");
--      lead_has_block must stay callable by `authenticated` because a policy
--      evaluates it as the querying role, so it carries its own
--      can_access_lead() guard instead.
--   3. Messages: a BEFORE INSERT trigger (clear error message) AND the
--      "messages insert" policy (the real fence). Both, on purpose - see the
--      comment above them.
--   4. open_jobs_for_me(): a blocked homeowner's jobs vanish from that pro's
--      board. 0124's body, byte for byte, plus ONE where-clause predicate.
--   5. apply_to_lead(): a blocked pro cannot buy their way onto the job
--      anyway, in case they kept a lead id from before the block. 0132's
--      body, byte for byte, plus ONE gate placed before any money moves.
--   6. public.reports gains an optional target (target_type/target_id) and
--      lead_id becomes nullable, so a review or a pro profile can be
--      reported by the same table and the same inbox as a chat.
--   7. contractor_reviews() and public_pro_profile() return each review's id,
--      which is what the new "Report" link on a review targets.
--      contractor_reviews() also picks up public_pro_profile's visibility
--      gate, so a delisted or never-claimed pro's reviews stop being readable
--      from a page that no longer exists.
--
-- WHAT DOES NOT CHANGE: no column is dropped, no row is rewritten, no price
-- moves, and both functions re-issued below are copies of their latest
-- definition with the named lines added and nothing else edited.
--
-- IF THIS FILE HAS NOT BEEN RUN ON LIVE YET: nothing breaks. Every read the
-- app makes against user_blocks is wrapped so a 42P01 (relation does not
-- exist) or a PostgREST 404 comes back as "no blocks", the /account/blocks
-- page renders its empty state, the Block button reports an honest failure
-- instead of claiming success, and the review Report link simply never
-- appears (it is gated on a review id the old RPC does not return).
--
-- Idempotent: every object is IF NOT EXISTS / CREATE OR REPLACE / drop-then-
-- create. Safe to re-run.
-- =============================================================================


-- =============================================================================
-- Part 1: public.user_blocks
-- =============================================================================
-- UUID primary key, like every other table here: a sequential id would let
-- anyone holding one block id guess at the volume and ordering of everyone
-- else's.
--
-- ON DELETE CASCADE on both sides: a deleted account should not leave a block
-- row pointing at a user that no longer exists, and "delete my account and all
-- associated data" (account/security) has to mean it.
create table if not exists public.user_blocks (
  id              uuid primary key default gen_random_uuid(),
  blocker_user_id uuid not null references auth.users (id) on delete cascade,
  blocked_user_id uuid not null references auth.users (id) on delete cascade,
  reason          text,
  created_at      timestamptz not null default now(),
  unique (blocker_user_id, blocked_user_id)
);

-- Nobody may block themselves. A self-block would make lead_has_block() true
-- for every thread that account is on and lock them out of their own chats.
alter table public.user_blocks
  drop constraint if exists user_blocks_not_self;
alter table public.user_blocks
  add constraint user_blocks_not_self
  check (blocker_user_id <> blocked_user_id);

-- The unique constraint above already indexes (blocker_user_id, ...), which
-- serves "my blocks" and "did A block B". This one serves the other
-- direction, "did anyone block B", which lead_has_block and open_jobs_for_me
-- both ask on every call.
create index if not exists user_blocks_blocked_idx
  on public.user_blocks (blocked_user_id);

alter table public.user_blocks enable row level security;

-- Self-scoped, all three verbs on blocker_user_id = auth.uid(). There is
-- deliberately NO policy that lets the blocked side read the row: being told
-- "X blocked you" is itself a message from someone who asked not to send you
-- any. The enforcement everywhere else runs through SECURITY DEFINER helpers,
-- which do not need a select policy to see the row.
drop policy if exists "user_blocks self select" on public.user_blocks;
create policy "user_blocks self select" on public.user_blocks
  for select to authenticated
  using (blocker_user_id = auth.uid());

drop policy if exists "user_blocks self insert" on public.user_blocks;
create policy "user_blocks self insert" on public.user_blocks
  for insert to authenticated
  with check (blocker_user_id = auth.uid());

drop policy if exists "user_blocks self delete" on public.user_blocks;
create policy "user_blocks self delete" on public.user_blocks
  for delete to authenticated
  using (blocker_user_id = auth.uid());

-- Grants matching the neighbouring tables (0130's account_signals pattern,
-- inverted: this one IS user-facing, so authenticated keeps exactly the three
-- verbs the policies above scope). No UPDATE: a block is created or removed,
-- never edited, so there is no way to re-point an existing row at somebody
-- else. anon gets nothing.
revoke all on public.user_blocks from anon;
grant select, insert, delete on public.user_blocks to authenticated;
grant all on public.user_blocks to service_role;

comment on table public.user_blocks is
  'One row per "this account never wants to hear from that account again". '
  'RLS is self-scoped to blocker_user_id = auth.uid() for select/insert/'
  'delete, so nobody can discover that they have been blocked. Enforced by '
  'blocked_between()/lead_has_block(), which the messages insert policy, the '
  'messages_block_guard trigger, open_jobs_for_me() and apply_to_lead() all '
  'read. No UPDATE grant: rows are created and removed, never re-pointed.';


-- =============================================================================
-- Part 2: the two read helpers
-- =============================================================================
-- SECURITY DEFINER because every caller needs to see blocks in BOTH
-- directions, and RLS above deliberately hides the ones pointing at you.
-- Both return a bare boolean and never a row, an id, or a reason, so a caller
-- learns "you two cannot interact" and nothing about who decided that.
--
-- blocked_between is NOT granted to `authenticated`, on purpose. Supabase
-- publishes every public function an ordinary role may execute as a PostgREST
-- RPC, so that grant would have made this a block oracle: any signed-in
-- account could POST /rest/v1/rpc/blocked_between with two ids and get a
-- yes/no - including its own id and the id of whoever it suspects blocked it,
-- which each side of a lead already learns from messages.sender_id. That is
-- exactly the thing the table comment above says is impossible. Nothing needs
-- the grant: apply_to_lead (Part 5) is itself SECURITY DEFINER and calls this
-- as the function owner, and the app's own path (isBlockedBetween in
-- src/lib/blocks.ts) goes through the service-role client.
create or replace function public.blocked_between(p_a uuid, p_b uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.user_blocks b
    where (b.blocker_user_id = p_a and b.blocked_user_id = p_b)
       or (b.blocker_user_id = p_b and b.blocked_user_id = p_a)
  );
$$;

revoke all on function public.blocked_between(uuid, uuid) from public, anon, authenticated;
grant execute on function public.blocked_between(uuid, uuid) to service_role;

comment on function public.blocked_between(uuid, uuid) is
  'True when either account has blocked the other. Symmetric on purpose: a '
  'block stops the conversation in both directions, so the blocked party '
  'cannot keep talking at someone who left. Returns a bare boolean, never '
  'which side blocked or why. Service role only: a grant to authenticated '
  'would expose it as a PostgREST RPC and turn it into a block oracle. '
  'apply_to_lead calls it as its own definer, so no user-facing grant is '
  'needed.';

-- The lead-shaped version: does a block sit between the two people on this
-- thread? LEFT JOINs so a lead with no property row or no assigned contractor
-- yields nulls, which the join predicate treats as "no block" - the opposite
-- posture from the launch-city gate, and the right one here: an unassigned
-- lead has no second party to have blocked anyone.
--
-- The homeowner side is the PROPERTY OWNER, not household members. A block is
-- between two people; a shared household member who has not blocked anyone is
-- not silenced by their co-owner's block, and does not gain a way to keep
-- messaging a pro their co-owner blocked either (that pro's own thread is
-- gated on the owner's row, which is the one the pro is talking to).
--
-- Unlike blocked_between, this one HAS to keep its `authenticated` grant: RLS
-- evaluates a policy's function calls as the querying role, and the "messages
-- insert" policy below calls it. So the caller check lives inside the body
-- instead: `public.can_access_lead(p_lead)` (0007), the same helper the
-- messages policies and Part 6 already use. Without it this is a narrower
-- version of the same oracle - hand it any lead id and it tells you whether
-- those two strangers have blocked each other.
--
-- It changes nothing about the two real callers. The "messages insert" policy
-- already requires can_access_lead(lead_id) in the same WITH CHECK, so the
-- added conjunct is true whenever the rest of that policy is. The
-- messages_block_guard trigger is SECURITY DEFINER, but definer only swaps
-- the privilege role - auth.uid() reads the request's JWT claims from a GUC,
-- so inside the trigger it is still the inserting user, who is on the lead by
-- construction (every message insert in the app runs on that person's own
-- session client). A caller who is NOT on the lead now gets `false` here and
-- is refused a line later by the policy's own can_access_lead, which is the
-- same outcome by a better route.
create or replace function public.lead_has_block(p_lead uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select public.can_access_lead(p_lead) and exists (
    select 1
    from public.contractor_leads l
    left join public.properties pr on pr.id = l.property_id
    left join public.contractors c on c.id = l.contractor_id
    join public.user_blocks b
      on (b.blocker_user_id = pr.user_id and b.blocked_user_id = c.user_id)
      or (b.blocker_user_id = c.user_id and b.blocked_user_id = pr.user_id)
    where l.id = p_lead
  );
$$;

revoke all on function public.lead_has_block(uuid) from public, anon;
grant execute on function public.lead_has_block(uuid) to authenticated, service_role;

comment on function public.lead_has_block(uuid) is
  'True when the caller is on this lead AND the homeowner who owns its '
  'property and the contractor assigned to it have a block between them in '
  'either direction. Read by the "messages insert" policy and the '
  'messages_block_guard trigger. Granted to authenticated because RLS '
  'evaluates policy functions as the querying role, which is also why the '
  'can_access_lead guard has to sit inside the body rather than in a grant.';


-- =============================================================================
-- Part 3: messages - the trigger AND the policy
-- =============================================================================
-- BOTH, deliberately, and they are not redundant:
--
--   The POLICY is the fence. Policies are what a direct PostgREST insert from
--   a crafted client hits, and what stays true if a future migration replaces
--   the trigger. It is the thing that cannot be bypassed.
--
--   The TRIGGER is the sentence. An RLS refusal surfaces as "new row violates
--   row-level security policy for table messages", which tells a real person
--   nothing. The trigger fires first (BEFORE INSERT runs before the WITH
--   CHECK is evaluated) and raises a sentence the chat can print as is.
--
-- Both exempt sender_role = 'system', and both exempt it ONLY for the three
-- exact bodies LeadChat actually posts (CLOSE_PREFIX + role, and REOPEN_BODY,
-- in src/components/LeadChat.tsx). Those rows are not speech: somebody who has
-- just blocked the other side must still be able to close the thread, and
-- taking that away would leave the conversation stuck open with no way out.
--
-- Red team (2026-08-28): the exemption used to be sender_role = 'system' and
-- nothing else. enforce_message_sender_role (0089) only checks that a
-- 'homeowner'/'contractor' row matches who is sending, so it never rejects a
-- 'system' row - which left a blocked party free to POST
-- {"sender_role":"system","body":"anything"} straight at PostgREST and have it
-- land in the thread. Matching the exact marker bodies closes that: close and
-- reopen still work from either side, arbitrary text under a system label does
-- not. If those strings ever change in LeadChat, change them here too.
create or replace function public.enforce_message_not_blocked()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if not (
       new.sender_role = 'system'
       and new.body in (
         'Conversation closed by the homeowner.',
         'Conversation closed by the contractor.',
         'Conversation reopened.'
       )
     ) and public.lead_has_block(new.lead_id) then
    raise exception
      'You can no longer message this person. One of you has blocked the other.';
  end if;
  return new;
end; $$;

-- Name sorts before messages_rate_limit and messages_sender_role_guard, and
-- same-timing triggers fire in name order, so a blocked send is refused
-- before it consumes any of that sender's rate-limit budget.
drop trigger if exists messages_block_guard on public.messages;
create trigger messages_block_guard
  before insert on public.messages
  for each row execute function public.enforce_message_not_blocked();

-- 0007's policy, with the block predicate added and nothing else changed.
drop policy if exists "messages insert" on public.messages;
create policy "messages insert" on public.messages
  for insert to authenticated
  with check (
    public.can_access_lead(lead_id)
    and sender_id = auth.uid()
    and (
      (
        sender_role = 'system'
        and body in (
          'Conversation closed by the homeowner.',
          'Conversation closed by the contractor.',
          'Conversation reopened.'
        )
      )
      or not public.lead_has_block(lead_id)
    )
  );

-- SELECT is untouched on purpose. A block stops new messages; it does not
-- delete the history either side already has, which both people may need if
-- the thing they are blocking each other over ends up in front of support.


-- =============================================================================
-- Part 4: open_jobs_for_me - 0124's body, plus the block predicate
-- =============================================================================
-- COPY-ONLY. 0124 is the latest definition of open_jobs_for_me in this folder
-- (0131 and 0132 only mention it in comments), so that is the live body. The
-- diff is exactly ONE where-clause block and nothing else. CREATE OR REPLACE
-- with an unchanged signature preserves the existing EXECUTE grants.
--
-- The predicate is a NOT EXISTS rather than blocked_between(pr.user_id,
-- auth.uid()): the board is a set-returning query over up to 200 rows and the
-- planner can drive this straight off user_blocks' two indexes, whereas a
-- per-row SECURITY DEFINER call cannot be inlined.
create or replace function public.open_jobs_for_me()
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
  has_plans_permits  boolean
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
         cl.has_plans_permits
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
    -- 0138: a block hides the job board from each other, both ways. A
    -- homeowner who blocked this pro stops seeing them apply, and a pro who
    -- blocked a homeowner stops being shown that homeowner's work.
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
-- Part 5: apply_to_lead - 0132's body, plus the block gate
-- =============================================================================
-- COPY-ONLY, same discipline as Part 4. 0132 is the latest definition of
-- apply_to_lead in this folder. ONE block added and nothing else edited; the
-- signature is unchanged, so CREATE OR REPLACE preserves the EXECUTE grant to
-- `authenticated`.
--
-- WHERE THE GATE SITS: immediately after v_owner resolves (the "one live lead
-- per relationship" select is the first statement that knows who the
-- homeowner is), which is after the cheap idempotent returns - a pro who
-- already applied and was blocked afterwards still gets the honest `true` on
-- a retry rather than an error for a lead they already hold - and well before
-- get_or_create_wallet, the wallet FOR UPDATE, the bonus drain, the debit, or
-- any insert. Nothing between the select and the gate mutates anything.
--
-- Part 4 already hides these jobs from the board; this is the half that
-- matters for a lead id kept from before the block or lifted from a URL.
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
-- Part 6: public.reports gains a target, so more than a chat can be reported
-- =============================================================================
-- 0009 created reports with `lead_id uuid not null`, which pinned every report
-- to a chat thread. A review or a pro's public profile has no lead, so the
-- column has to become nullable and the row has to be able to name what it is
-- about instead. Existing rows are untouched: they keep their lead_id and
-- carry a null target, which is exactly what they are.
alter table public.reports alter column lead_id drop not null;

alter table public.reports add column if not exists target_type text;
alter table public.reports add column if not exists target_id uuid;

-- A report has to be about SOMETHING: either a chat thread or a named target.
alter table public.reports
  drop constraint if exists reports_has_a_target;
alter table public.reports
  add constraint reports_has_a_target
  check (lead_id is not null or (target_type is not null and target_id is not null));

-- Closed vocabulary, so the moderation inbox can group by it. 'chat' is
-- implied by a null target_type on the old rows and is not re-stated here.
alter table public.reports
  drop constraint if exists reports_target_type_known;
alter table public.reports
  add constraint reports_target_type_known
  check (target_type is null or target_type in ('review', 'contractor'));

create index if not exists reports_target_idx
  on public.reports (target_type, target_id, created_at desc);

-- 0009's insert policy, widened to the new shape and nothing more. The
-- lead-shaped branch is 0009's rule byte for byte. The target-shaped branch
-- keeps the only thing that actually matters for a report - reporter_id =
-- auth.uid(), so nobody can file under someone else's name - and does NOT
-- require a relationship to the target: the whole point of reporting a public
-- review or a public profile is that a stranger who just read it can say so.
-- The server action (src/lib/reportActions.ts) verifies the target row really
-- exists before it gets here, and rate limits per account.
drop policy if exists "reports insert" on public.reports;
create policy "reports insert" on public.reports
  for insert to authenticated
  with check (
    reporter_id = auth.uid()
    and (
      (lead_id is not null and public.can_access_lead(lead_id))
      or (lead_id is null and target_type is not null and target_id is not null)
    )
  );

-- SELECT is unchanged (0009: reporter_id = auth.uid()), restated so this file
-- is self-verifying about who may read reports back.
drop policy if exists "reports select" on public.reports;
create policy "reports select" on public.reports
  for select to authenticated
  using (reporter_id = auth.uid());

comment on table public.reports is
  'Abuse reports. Either lead_id (a chat thread, 0009) or target_type/'
  'target_id (a review or a contractor profile, 0138) identifies what is '
  'being reported. Insert requires reporter_id = auth.uid(); select returns '
  'only your own. The Hearth team reads everything through the service role.';


-- =============================================================================
-- Part 7: review ids, so a single review can be reported
-- =============================================================================
-- Both review readers returned rating/comment/created_at and no id, so the
-- "Report" link on a review had nothing to point at. Adding the id changes
-- nothing about what is public: a review's id is not a secret, and neither
-- function has ever exposed the reviewer.
--
-- contractor_reviews has to be DROPped first - Postgres will not let CREATE OR
-- REPLACE change a function's return type, even by adding a column. 0018
-- created it with no explicit grant, so it ran on the default PUBLIC EXECUTE;
-- the grants below restate that intent narrowly instead (anon reads the public
-- profile page, authenticated reads the applicant expander), which is a
-- tightening, not a loosening.
--
-- It also picks up the SAME visibility gate public_pro_profile carries (0132:
-- user_id is not null and serves_orange_county). The two functions serve one
-- page and disagreed: /p/<id> would render its not-found state for a delisted
-- or never-claimed pro while this RPC still handed an anonymous caller up to
-- 100 of that pro's reviews. Ids are not enumerable (public_pro_id_for_slug
-- only resolves live pros), so this is small, but "the pro is not public" has
-- to mean the same thing in both places.
drop function if exists public.contractor_reviews(uuid);
create or replace function public.contractor_reviews(p_contractor uuid)
returns table (
  id         uuid,
  rating     smallint,
  comment    text,
  created_at timestamptz
)
language sql
security definer
stable
set search_path = public
as $$
  select r.id, r.rating, r.comment, r.created_at
  from public.reviews r
  where r.contractor_id = p_contractor
    -- Same predicate as public_pro_profile's WHERE clause below. A pro with no
    -- account behind the row, or one outside the launch market, is not public,
    -- so their reviews are not public either. Returns zero rows, which is what
    -- the review list already renders as "no reviews yet".
    and exists (
      select 1
      from public.contractors c
      where c.id = p_contractor
        and c.user_id is not null
        and coalesce(c.serves_orange_county, false)
    )
  order by r.created_at desc
  limit 100;
$$;

revoke all on function public.contractor_reviews(uuid) from public;
grant execute on function public.contractor_reviews(uuid) to anon, authenticated, service_role;

comment on function public.contractor_reviews(uuid) is
  'Public review list for one pro: id, rating, comment, created_at, newest '
  'first, capped at 100. Never returns the reviewer. Returns nothing unless '
  'the pro is publicly visible (user_id is not null and serves_orange_county), '
  'the same gate public_pro_profile applies. The id is what the "Report this '
  'review" control targets (public.reports.target_id).';

-- public_pro_profile: 0132's body, with 'id' added to each review object and
-- NOTHING else edited. Returns jsonb, so this is a plain CREATE OR REPLACE.
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
                 -- 0138: the review's own id, so the public page can offer a
                 -- "Report this review" control that names one row. Not a
                 -- secret and not the reviewer.
                 'id',         r.id,
                 'rating',     r.rating,
                 'comment',    r.comment,
                 'created_at', r.created_at
               ) order by r.created_at desc)
      from (
        select id, rating, comment, created_at
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


-- =============================================================================
-- RISK / VERIFICATION NOTES
--
-- 1. Parts 4 and 5 are copies. Diff them against 0124's open_jobs_for_me and
--    0132's apply_to_lead: the ONLY differences should be the two blocks
--    marked "0138". Signatures are byte-identical, so CREATE OR REPLACE keeps
--    both functions' EXECUTE grants.
--
-- 2. Part 7 DROPs contractor_reviews, which is the one destructive statement
--    in this file. Between the drop and the create (same transaction when run
--    as one paste) nothing can call it. Callers:
--    src/app/(app)/contractors/ContractorReviews.tsx only. Its client reads
--    fields by name off the returned rows, so the added column is additive.
--
-- 3. Dry run for the block itself, on a copy:
--      insert into user_blocks (blocker_user_id, blocked_user_id)
--        values ('<homeowner>', '<pro user>');
--    then, as the pro: open_jobs_for_me() no longer returns that homeowner's
--    jobs; apply_to_lead('<their lead>', 'hi') raises 'This job is not
--    available to you.'; an insert into messages on a shared thread raises
--    'You can no longer message this person...'; a system-role insert on the
--    same thread still succeeds. Delete the row and all four reverse.
--
-- 4. Self-block is refused by user_blocks_not_self. Confirm:
--      insert into user_blocks (blocker_user_id, blocked_user_id)
--        values ('<u>', '<u>');  -- must fail
--
-- 5. reports: an old row (lead_id set, target null) still satisfies both new
--    CHECK constraints, so the ALTERs cannot fail on existing data. Confirm
--    with: select count(*) from public.reports where lead_id is null
--      and (target_type is null or target_id is null);  -- must be 0
--
-- 6. Execute grants on the two helpers. blocked_between must show service_role
--    and nothing else; lead_has_block must still show authenticated. See
--    VERIFY 14 below.
--
-- 7. lead_has_block's caller guard: on a lead you are not part of it must now
--    return false even when a block really sits between that lead's two
--    parties. See VERIFY 15 below.
-- =============================================================================

-- <<<<<<<<<< END 0138_user_blocks.sql <<<<<<<<<<


-- ============================================================================
-- VERIFY. Run these after the paste above. Expected results are stated on
-- each one; anything else means the run did not finish.
-- ============================================================================

-- 1. The table exists and RLS is on (expect one row: user_blocks | t).
--    select relname, relrowsecurity
--      from pg_class
--     where relname = 'user_blocks' and relnamespace = 'public'::regnamespace;

-- 2. Exactly three policies, all self-scoped (expect 3 rows: select, insert,
--    delete, each with blocker_user_id = auth.uid() in qual or with_check).
--    select policyname, cmd, qual, with_check
--      from pg_policies
--     where schemaname = 'public' and tablename = 'user_blocks'
--     order by policyname;

-- 3. Grants: authenticated has SELECT/INSERT/DELETE and NOT update; anon has
--    nothing (expect 3 rows for authenticated, 0 for anon).
--    select grantee, privilege_type
--      from information_schema.role_table_grants
--     where table_schema = 'public' and table_name = 'user_blocks'
--       and grantee in ('anon', 'authenticated')
--     order by grantee, privilege_type;

-- 4. Both helper functions exist and are SECURITY DEFINER (expect 2 rows,
--    prosecdef = t).
--    select proname, prosecdef
--      from pg_proc
--     where pronamespace = 'public'::regnamespace
--       and proname in ('blocked_between', 'lead_has_block')
--     order by proname;

-- 5. The messages trigger is installed and sorts FIRST of the three BEFORE
--    INSERT triggers (expect messages_block_guard, messages_rate_limit,
--    messages_sender_role_guard, in that order).
--    select tgname from pg_trigger
--     where tgrelid = 'public.messages'::regclass and not tgisinternal
--     order by tgname;

-- 6. The messages insert policy now mentions lead_has_block (expect one row
--    whose with_check contains lead_has_block).
--    select policyname, with_check
--      from pg_policies
--     where schemaname = 'public' and tablename = 'messages'
--       and policyname = 'messages insert';

-- 7. Both re-issued functions carry the block predicate (expect t | t).
--    select
--      pg_get_functiondef('public.open_jobs_for_me()'::regprocedure)
--        like '%user_blocks%' as board_gated,
--      pg_get_functiondef(
--        'public.apply_to_lead(uuid, text)'::regprocedure)
--        like '%blocked_between%' as apply_gated;

-- 8. reports: lead_id is nullable now and the two new columns exist (expect
--    lead_id | YES, target_id | YES, target_type | YES).
--    select column_name, is_nullable
--      from information_schema.columns
--     where table_schema = 'public' and table_name = 'reports'
--       and column_name in ('lead_id', 'target_type', 'target_id')
--     order by column_name;

-- 9. No existing report row violates the new CHECK constraints (expect 0).
--    select count(*) from public.reports
--     where lead_id is null and (target_type is null or target_id is null);

-- 10. contractor_reviews returns four columns starting with id (expect
--     id, rating, comment, created_at), and carries the public-pro gate
--     (expect t).
--     select pg_get_function_result(
--       'public.contractor_reviews(uuid)'::regprocedure);
--     select pg_get_functiondef(
--       'public.contractor_reviews(uuid)'::regprocedure)
--       like '%serves_orange_county%' as gated;
--     Behavioural check, on a contractor row with at least one review:
--       select count(*) from public.contractor_reviews('<live pro uuid>');
--         -- > 0
--       select count(*) from public.contractor_reviews('<delisted pro uuid>');
--         -- 0  (user_id null, or serves_orange_county not true)

-- 11. public_pro_profile puts an id on every review (expect t, using any
--     contractor id that has at least one review).
--     select (public.public_pro_profile('<contractor-uuid>') -> 'reviews' -> 0)
--            ? 'id';

-- 12. Self-block is refused (expect ERROR: violates check constraint
--     "user_blocks_not_self"). Use any real auth.users id.
--     insert into public.user_blocks (blocker_user_id, blocked_user_id)
--     values ('<user-uuid>', '<user-uuid>');

-- 13. END-TO-END, on a throwaway pair. With <ho> = a homeowner's auth id and
--     <pro> = the pro account's auth id who shares a lead with them:
--       insert into public.user_blocks (blocker_user_id, blocked_user_id)
--       values ('<ho>', '<pro>');
--     then, signed in AS THE PRO:
--       * open_jobs_for_me() no longer lists that homeowner's open jobs;
--       * apply_to_lead('<their lead>', 'hi') raises
--         'This job is not available to you.';
--       * inserting a normal message on a shared thread raises
--         'You can no longer message this person...';
--       * inserting a sender_role = 'system' row whose body is exactly
--         'Conversation reopened.' on that thread still works, so either side
--         can still close and reopen the conversation;
--       * inserting a sender_role = 'system' row with any other body is
--         refused by the same sentence, so the system label is not a way
--         around the block.
--     Then delete the row and confirm all of them go back to normal.

-- 14. blocked_between is service_role ONLY and lead_has_block still reaches
--     authenticated (expect blocked_between's acl to contain service_role= and
--     NOT authenticated=; lead_has_block's to contain both).
--     select p.proname, p.proacl::text
--       from pg_proc p
--      where p.pronamespace = 'public'::regnamespace
--        and p.proname in ('blocked_between', 'lead_has_block')
--      order by p.proname;
--     And, signed in as an ordinary homeowner or pro (not the SQL editor's
--     postgres role), this must now fail with 42501 permission denied:
--       select public.blocked_between('<a>'::uuid, '<b>'::uuid);

-- 15. lead_has_block only answers for a lead the caller is on. Keep the block
--     row from step 13 in place, then, signed in as a THIRD account that is on
--     neither side of that lead:
--       select public.lead_has_block('<their lead>'::uuid);   -- false
--     Signed in as the pro or the homeowner on that lead:
--       select public.lead_has_block('<their lead>'::uuid);   -- true
--     Step 13's message-insert refusal must still fire for that pair, which is
--     the behaviour that actually matters.


-- ############################################################################
-- SECTION: 0139 users column lock
-- source: supabase/PASTE-ME-live-2026-08-28-users-column-lock.sql
-- ############################################################################

-- ============================================================================
-- HEARTH LIVE-DB BUNDLE: migration 0139 (2026-08-28)
-- Paste this WHOLE file into the Supabase SQL editor and run it ONCE.
-- Safe to re-run: every statement is idempotent.
-- Run this AFTER PASTE-ME-live-2026-08-28-user-blocks.sql (0138): Part 2
-- indexes public.reports.target_type, which 0138 adds. After running, live is
-- at 0139.
--
-- WHAT THIS IS: the missing write-side lock on public.users. "users self
-- update" (migration 0002) is row-scoped and names no columns, so until this
-- runs a signed-in account can PATCH its own row through PostgREST and reset
-- every free-credit counter that decides whether a paid AI feature is
-- available - 0135's two free AI tastes, 0030's free quote check, 0101's free
-- maintenance plan - plus its own email, SMS consent record and referral
-- attribution. This adds a BEFORE UPDATE guard trigger that refuses a change
-- to any of those columns unless the caller is the service role. It also adds
-- a one-report-per-target unique index on public.reports (0138's new shape).
--
-- YOU SHOULD RUN THIS THE SAME NIGHT AS 0135. 0135 adds the counters; without
-- this file those counters are resettable by the account they meter, and the
-- paywall is decorative.
--
-- TWO APP PATHS THAT WOULD OTHERWISE CHANGE BEHAVIOUR THE MOMENT THIS LANDS
-- ARE ALREADY FIXED: both writes moved to the admin client tonight, ahead of
-- this paste.
--   * /account -> saveAccountAction (src/app/(app)/account/actions.ts)
--     writes sms_consent through createAdminClient(), so toggling the
--     checkbox keeps working. Name and phone still go through the caller's
--     own session client, which is correct.
--   * the "Invite a neighbor" link -> getOrCreateReferralCode
--     (src/lib/referralCode.ts) writes referral_code through
--     createAdminClient() too, so the link keeps generating. It still
--     swallows every error and returns null on failure, so nothing crashes
--     either way.
-- ============================================================================

-- >>>>>>>>>> BEGIN 0139_users_column_lock.sql >>>>>>>>>>

-- =============================================================================
-- Hearth - lock the columns on public.users that a homeowner must not write
-- RUN THIS AGAINST THE LIVE DATABASE (Supabase SQL editor).
-- Run it AFTER 0138 (Part 2 indexes a column 0138 adds to public.reports).
--
-- WHY. Migration 0002 is the only thing standing over public.users:
--
--   create policy "users self update" on public.users
--     for update using (id = auth.uid()) with check (id = auth.uid());
--
-- That is a ROW rule with no column list, and there is no column-level GRANT
-- and no BEFORE UPDATE trigger on the table anywhere in this folder. So
-- Supabase's default table-level grants stand and a signed-in account may
-- rewrite EVERY column of its own row straight through PostgREST, using only
-- the anon key (in the browser bundle by definition) and its own session
-- token:
--
--   curl -X PATCH "$SUPABASE_URL/rest/v1/users?id=eq.$MY_UID" \
--     -H "apikey: $NEXT_PUBLIC_SUPABASE_ANON_KEY" \
--     -H "Authorization: Bearer $MY_ACCESS_TOKEN" \
--     -H "Content-Type: application/json" \
--     -d '{"free_doc_reads_used":0,"free_inspection_reads_used":0,
--          "free_quote_used_at":null,"free_plan_used_at":null}'
--
-- One request resets 0135's free-AI-taste paywall (2 lifetime document reads,
-- 1 lifetime inspection import), 0030's free quote check and 0101's free
-- maintenance-plan build. claim_free_ai_taste being atomic and service_role
-- only buys nothing against this: it reads the counter the caller just zeroed.
-- Every one of those features calls a paid vision model on a heavy payload, so
-- this is direct spend, repeatable in a loop.
--
-- The same row also carries `email` (UNIQUE, and match_support_contact keys
-- off it), `sms_consent` / `sms_consent_at` (a TCPA consent record the account
-- could forge or erase) and `referral_code` / `referred_by` (no payout in v1,
-- a landmine the day one ships).
--
-- WHY A TRIGGER AND NOT A COLUMN GRANT. Both work. 0085 uses the grant shape
-- on contractors: revoke the TABLE-level UPDATE, then grant it back per
-- column - which is the only way a column grant means anything, since a bare
-- column-level REVOKE against a standing table-level grant is a no-op (that is
-- exactly why 0078 did nothing). The trigger shape is chosen here because:
--   * it fails LOUD. A grant violation on a PATCH that names a locked column
--     returns 42501 for the whole statement with no indication of which
--     column; the trigger names the offending columns in its message, which is
--     what a future debugging session needs.
--   * it is one object to keep in step with the table instead of two lists
--     (the revoke plus the re-grant) that drift the moment a column is added.
--     A column added later and NOT listed below stays writable - the same
--     default as today, so nothing silently breaks - and adding it to the
--     array is a one-line change.
--   * it does not disturb the table-level grants other code paths rely on.
-- The trigger is the fence either way: it runs BEFORE the row is written, it
-- runs on every UPDATE regardless of where it came from, and it cannot be
-- talked past by an ordinary role.
--
-- LOCKED COLUMNS, and how the list was decided. Every column on public.users,
-- from 0001's CREATE TABLE plus every `alter table public.users add column`
-- since (0022, 0030, 0075, 0101, 0102, 0135, 0137):
--
--   LOCKED (service role only)
--     id                          primary key, never rewritten by anything
--     email                       UNIQUE; identity, and the key
--                                 match_support_contact joins on. The app
--                                 changes a sign-in address through
--                                 supabase.auth.updateUser({ email }), which
--                                 writes auth.users, never this column.
--     created_at                  column default only, never app-written
--     free_doc_reads_used         0135 paywall counter
--     free_inspection_reads_used  0135 paywall counter
--     free_quote_used_at          0030 one free quote check
--     free_plan_used_at           0101 one free maintenance plan
--     sms_consent                 0075 consent record
--     sms_consent_at              0075 consent record
--     referral_code               0102 invite slug (UNIQUE)
--     referred_by                 0102 attribution
--
--   LEFT WRITABLE (a signed-in account's own profile settings, each written
--   today by a user-scoped createClient() call, verified against src/):
--     full_name           src/app/(app)/account/actions.ts saveAccountAction,
--                         src/app/onboarding/actions.ts (~883)
--     phone               saveAccountAction
--     notification_prefs  src/app/(app)/account/notifications/actions.ts
--     guide_seen_at       src/lib/appGuideActions.ts markGuideSeenAction
--     pro_guide_seen_at   same
--
-- THE TWO WRITERS THAT WOULD OTHERWISE HIT A LOCKED COLUMN FROM A SESSION
-- CLIENT ARE ALREADY ON THE ADMIN CLIENT, as of tonight's app-side fix. Both
-- were app bugs this migration would have exposed; both are closed now, so
-- the trigger below changes nothing about how either one behaves:
--
--   1. src/app/(app)/account/actions.ts saveAccountAction (~152-155) writes
--      { sms_consent, sms_consent_at } through createAdminClient(), not the
--      caller's session client. Name and phone (~126-129) still go through
--      the session client, which is correct - those two stay writable by
--      the row's owner. Both writes are scoped to the verified session's
--      own user.id, never an id the form supplied.
--   2. src/lib/referralCode.ts getOrCreateReferralCode (~66-72) writes
--      users.referral_code through createAdminClient() too, also scoped to
--      the verified session's own user.id. It still swallows every error
--      and returns null on failure, so the failure mode stays "the invite
--      link never appears", never a crash.
--
-- Locking both anyway is deliberate defense in depth: a consent record and a
-- referral attribution that the account being measured could rewrite are
-- worth less than nothing, even with the app-side writers already correct.
--
-- ORDER-INDEPENDENT with 0135 and 0137. The list is compared through
-- to_jsonb(NEW)/to_jsonb(OLD), so a column that does not exist yet reads as
-- NULL on both sides, is never "changed", and never raises. Running this
-- before 0135 is harmless; it simply starts enforcing the moment the column
-- appears.
--
-- Idempotent: CREATE OR REPLACE, drop-then-create trigger, IF NOT EXISTS
-- index. Safe to re-run.
-- =============================================================================


-- =============================================================================
-- Part 1: the guard trigger on public.users
-- =============================================================================
-- SECURITY INVOKER (the default, no `security definer` line): the body reads
-- only NEW and OLD and touches no table, so it needs no privilege of its own,
-- and running as the caller is what makes current_user meaningful below.
--
-- HOW THE SERVICE ROLE IS RECOGNISED. Two independent signals, either one is
-- enough:
--   * the JWT claim. PostgREST puts the verified claims in the
--     `request.jwt.claims` GUC, so `->> 'role'` is what Supabase's own
--     auth.role() reads. Taken through nullif + a sub-block so a missing GUC
--     (a direct psql session) or a malformed one can never throw here.
--   * current_user. PostgREST connects as `authenticator` and then SETs the
--     role named by the token, so an admin-client request really is running as
--     `service_role`. postgres / supabase_admin / supabase_auth_admin are the
--     platform's own roles: the SQL editor and the auth service. Letting them
--     through is not a weakening - anyone holding those credentials can drop
--     this trigger outright - and it is what lets the owner fix a row by hand.
-- Everything else - `authenticated`, `anon`, any future app role - is subject
-- to the list.
create or replace function public.enforce_users_column_lock()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  -- Keep this in step with the table. A new counter, credit, plan flag,
  -- consent field or identity column on public.users belongs here the day it
  -- is added; anything not listed stays writable by the row's owner, which is
  -- the behaviour that existed before this migration.
  v_locked constant text[] := array[
    'id',
    'email',
    'created_at',
    'free_doc_reads_used',
    'free_inspection_reads_used',
    'free_quote_used_at',
    'free_plan_used_at',
    'sms_consent',
    'sms_consent_at',
    'referral_code',
    'referred_by'
  ];
  v_role    text;
  v_changed text[];
begin
  begin
    v_role := nullif(current_setting('request.jwt.claims', true), '')::jsonb
                ->> 'role';
  exception when others then
    v_role := null;
  end;

  if v_role = 'service_role'
     or current_user in ('service_role', 'postgres', 'supabase_admin',
                         'supabase_auth_admin')
  then
    return new;
  end if;

  -- Compared through jsonb rather than named IF branches so the list above is
  -- the single source of truth, and so a column that does not exist on this
  -- database yet reads NULL on both sides instead of failing to compile.
  -- `is distinct from` means a write that re-sends a locked column UNCHANGED
  -- is fine: only an actual change is refused, which keeps a plain profile
  -- save working even when it names more columns than it edits.
  select array_agg(t.col order by t.col)
    into v_changed
    from unnest(v_locked) as t(col)
   where to_jsonb(new) -> t.col is distinct from to_jsonb(old) -> t.col;

  if v_changed is not null then
    raise exception
      'These fields are managed by Hearth and cannot be changed from an account session: %',
      array_to_string(v_changed, ', ')
      using errcode = '42501';
  end if;

  return new;
end;
$$;

drop trigger if exists users_column_lock on public.users;
create trigger users_column_lock
  before update on public.users
  for each row execute function public.enforce_users_column_lock();

comment on function public.enforce_users_column_lock() is
  'BEFORE UPDATE guard on public.users. Raises 42501 when a locked column '
  '(paywall counters, consent record, referral attribution, id, email, '
  'created_at) actually changes and the caller is not the service role or a '
  'platform role. "users self update" (0002) is row-scoped with no column '
  'list, so without this a homeowner could reset their own free-AI-taste, '
  'free-quote and free-plan credits with one PATCH.';

comment on trigger users_column_lock on public.users is
  'See enforce_users_column_lock(). Fires on every UPDATE; service-role and '
  'platform-role writes return early, so every admin-client path in the app '
  'is unaffected.';


-- =============================================================================
-- Part 2: one report per account per target
-- =============================================================================
-- reportContentAction (src/lib/reportActions.ts) rate limits at 20 reports an
-- hour per account and confirms the target row exists, but nothing stopped the
-- same account filing the same report against the same review twenty times an
-- hour. The moderation inbox has no dedupe of its own, so that is a cheap way
-- to bury every other report in it.
--
-- PARTIAL, on `target_type is not null`, for two reasons: 0009's chat reports
-- carry a null target and would all collide with each other on (reporter, null,
-- null), and a partial index is the shape that says "this rule is about the
-- 0138 report shape" rather than retro-fitting a constraint onto rows that
-- predate it. Chat reports stay ungated - they are per-thread and already
-- scoped by can_access_lead.
--
-- CANNOT FAIL ON EXISTING DATA when run in order: target_type only exists as
-- of 0138 and no row can have been written with one before this file runs. If
-- you are re-running out of order and it does fail, find the duplicates with
--   select reporter_id, target_type, target_id, count(*)
--     from public.reports where target_type is not null
--    group by 1, 2, 3 having count(*) > 1;
-- and keep the oldest of each group.
create unique index if not exists reports_reporter_target_uniq
  on public.reports (reporter_id, target_type, target_id)
  where target_type is not null;

comment on index public.reports_reporter_target_uniq is
  'One report per account per target (0138 shape only - chat reports carry a '
  'null target_type and are excluded). A repeat report is a 23505, which '
  'reportContentAction should treat as "already reported, thank you" rather '
  'than an error.';


-- =============================================================================
-- RISK / VERIFICATION NOTES
--
-- 1. The trigger fires on EVERY update of public.users, including the ones the
--    app makes through createAdminClient(). Those run as `service_role` and
--    return early, so nothing on that side changes. Confirm the admin paths
--    still work after pasting: the free-plan claim
--    (src/app/(app)/dashboard/actions.ts ~162), the free-quote claim
--    (src/app/api/analyze-quote/route.ts ~110), the SMS opt-out writer
--    (src/app/api/twilio/inbound/route.ts ~242), the email opt-out writer
--    (src/app/unsubscribe/route.ts ~72) and 0135's two RPCs.
--
-- 2. The two writers named in the header (saveAccountAction's sms_consent
--    write, getOrCreateReferralCode's referral_code write) are already on
--    the admin client, so this trigger does not change their behaviour:
--    both keep working. Spot-check anyway after pasting, since they are the
--    two writers this migration exists to protect - toggling SMS consent on
--    /account should still succeed, and the invite link should still
--    generate.
--
-- 3. The trigger is not a substitute for RLS - "users self select" / "users
--    self update" (0002) still decide WHICH row an account may touch. This
--    only decides which COLUMNS of that row.
--
-- 4. Verify the trigger exists (expect one row: users_column_lock | O):
--      select tgname, tgenabled
--        from pg_trigger
--       where tgrelid = 'public.users'::regclass and not tgisinternal;
--
-- 5. Verify a SERVICE-ROLE write of a locked column still passes. In the SQL
--    editor (which runs as postgres, itself an allowed role), against your own
--    row, restoring the value afterwards:
--      select id, free_doc_reads_used from public.users where id = '<you>';
--      update public.users set free_doc_reads_used = 1 where id = '<you>';
--      update public.users set free_doc_reads_used = 0 where id = '<you>';
--    Both updates must succeed.
--
-- 6. Verify an AUTHENTICATED write of a locked column FAILS. The SQL editor's
--    own role is exempt on purpose, so this has to borrow the `authenticated`
--    role and a matching JWT claim. Paste this block on its own; it rolls its
--    own write back and writes nothing:
--
--      do $v$
--      declare
--        v_user   uuid;
--        v_result text := 'wrote it';
--      begin
--        select id into v_user from public.users limit 1;
--        if v_user is null then
--          raise notice 'SKIP: no rows in public.users';
--          return;
--        end if;
--        begin
--          perform set_config(
--            'request.jwt.claims',
--            json_build_object('sub', v_user, 'role', 'authenticated')::text,
--            true);
--          execute 'set local role authenticated';
--          -- +1, never a fixed value: the guard compares with IS DISTINCT
--          -- FROM, so re-writing the same number would legitimately pass.
--          update public.users
--             set free_doc_reads_used = coalesce(free_doc_reads_used, 0) + 1
--           where id = v_user;
--          if not found then
--            v_result := 'rls filtered the row';
--          end if;
--          -- Always raise, so the subtransaction (and the UPDATE with it) is
--          -- rolled back whatever happened above.
--          raise exception using errcode = 'HRTH1', message = v_result;
--        exception
--          when sqlstate '42501' then v_result := 'refused';
--          when sqlstate 'HRTH1' then null;  -- v_result already says what
--        end;
--        execute 'reset role';
--        perform set_config('request.jwt.claims', '', true);
--        if v_result = 'refused' then
--          raise notice 'PASS: authenticated cannot change a locked column';
--        elsif v_result = 'rls filtered the row' then
--          raise notice
--            'INCONCLUSIVE: auth.uid() did not resolve, so the UPDATE matched '
--            'no row and the trigger never ran. Check by hand from the app.';
--        else
--          raise exception
--            'FAIL: an authenticated session changed users.free_doc_reads_used';
--        end if;
--      end
--      $v$;
--
--    Expected output: NOTICE  PASS: authenticated cannot change a locked
--    column. The UPDATE is rolled back with the inner subtransaction in every
--    branch, so no counter moves.
--
-- 7. Verify an authenticated write of an UNLOCKED column still passes: on
--    /account, change your name and save. It must still work, and the toolbar
--    name must change.
--
-- 8. Verify the report index (expect one row):
--      select indexname, indexdef
--        from pg_indexes
--       where schemaname = 'public'
--         and indexname = 'reports_reporter_target_uniq';
-- =============================================================================

-- <<<<<<<<<< END 0139_users_column_lock.sql <<<<<<<<<<


-- ============================================================================
-- VERIFY. Run these after the paste above. Expected results are stated on
-- each one; anything else means the run did not finish. The RISK /
-- VERIFICATION NOTES inside the migration body above carry the long-form
-- version of items 1-3, including the full self-rolling-back DO block for the
-- authenticated-caller check.
-- ============================================================================

-- 1. The trigger exists and is enabled (expect one row: users_column_lock | O).
--    select tgname, tgenabled
--      from pg_trigger
--     where tgrelid = 'public.users'::regclass and not tgisinternal;

-- 2. The function is SECURITY INVOKER and pins its search_path (expect
--    enforce_users_column_lock | f | {search_path=public}).
--    select proname, prosecdef, proconfig
--      from pg_proc
--     where pronamespace = 'public'::regnamespace
--       and proname = 'enforce_users_column_lock';

-- 3. A service-role write of a locked column still passes. The SQL editor runs
--    as postgres, which the guard treats as a platform role, so both of these
--    must succeed (run them against your own id, and note the value you start
--    from so you can put it back):
--      select id, free_doc_reads_used from public.users where id = '<you>';
--      update public.users set free_doc_reads_used = 1 where id = '<you>';
--      update public.users set free_doc_reads_used = 0 where id = '<you>';

-- 4. An authenticated write of a locked column FAILS. Paste the DO block from
--    note 6 of the migration body above on its own. Expected output:
--      NOTICE  PASS: authenticated cannot change a locked column
--    It rolls its own UPDATE back, so no counter moves.

-- 5. An authenticated write of an UNLOCKED column still passes. On /account,
--    change your name and save: it must still work and the toolbar name must
--    change. Leave the SMS checkbox alone for this one - see the header.

-- 6. The report dedupe index exists (expect one row, and the definition must
--    contain WHERE (target_type IS NOT NULL)).
--    select indexname, indexdef
--      from pg_indexes
--     where schemaname = 'public'
--       and indexname = 'reports_reporter_target_uniq';

-- 7. Nothing in public.users was rewritten by this file (expect the same
--    counts as before the paste; this file writes no rows at all).
--    select count(*) as users,
--           count(*) filter (where free_doc_reads_used > 0) as docs_spent,
--           count(*) filter (where free_quote_used_at is not null) as quotes
--      from public.users;


-- ############################################################################
-- SECTION: 0140 blocks + direct requests
-- source: supabase/PASTE-ME-live-2026-08-28-blocks-direct-requests.sql
-- ############################################################################

-- ============================================================================
-- HEARTH LIVE-DB BUNDLE: migration 0140 (2026-08-28)
-- Paste this WHOLE file into the Supabase SQL editor and run it ONCE.
-- Safe to re-run: every statement is idempotent.
-- Run this AFTER PASTE-ME-live-2026-08-28-users-column-lock.sql (0139).
-- After running, live is at 0140.
--
-- WHAT THIS IS: closes the one spending path 0138's blocking work left open.
-- 0138 gated the job board (open_jobs_for_me) and apply_to_lead against a
-- block between the two people on a job; unlock_direct_request, the paid
-- unlock of a direct request, never got the same gate. This file re-issues
-- unlock_direct_request with that ONE addition, adds a 500-character length
-- cap on public.user_blocks.reason, and re-issues that table's
-- pair-uniqueness rule under a real name (user_blocks_pair_uniq) so it does
-- not depend on the original CREATE TABLE ever having run.
--
-- NOTHING BREAKS IF YOU DELAY THIS: a blocked pro can still pay to unlock a
-- direct request against a homeowner they have a block with, exactly as
-- before 0138. apply_to_lead, the job board and messaging are unaffected
-- either way, and nothing here touches them again.
-- ============================================================================

-- >>>>>>>>>> BEGIN 0140_blocks_direct_requests.sql >>>>>>>>>>

-- =============================================================================
-- Hearth - close the block gap on direct requests, and two small hardenings
-- on public.user_blocks
-- RUN THIS AGAINST THE LIVE DATABASE (Supabase SQL editor), AFTER 0139.
--
-- WHY THIS EXISTS
--
-- 1. UNLOCK_DIRECT_REQUEST NEVER LEARNED ABOUT BLOCKS. 0138 gated the two
--    other places a pro spends wallet money against a homeowner they have a
--    block with: apply_to_lead() (its own header, Part 5) and the job board
--    (open_jobs_for_me(), Part 4). unlock_direct_request() - the third and
--    last spending path, 0105/0115's paid unlock of a direct request - was
--    left untouched. A pro who still holds (or is handed, or guesses) a
--    direct-request lead id can pay to unlock it against a homeowner who has
--    blocked them, or whom they blocked, and the assignment UPDATE at the end
--    of that function sets contractor_id - which is exactly the column
--    lead_has_block() and the messages insert policy use to find the other
--    party on the thread. The pro would hold a paid, assigned job and then be
--    unable to send the first message, with no way to get the money back
--    short of support.
--
-- 2. THE TWO GAPS BELOW ARE UNRELATED TO 1 AND EXIST SO A RE-RUN CAN'T QUIETLY
--    SKIP THEM.
--    a. public.user_blocks.reason has no length limit. Every other free-text
--       column a signed-in account can write in this schema is capped
--       (contractors.about at 1,000, reports presumably next); an unbounded
--       reason is the one column here that is not.
--    b. 0138 added the pair-uniqueness rule as an INLINE `unique (...)`
--       inside `create table if not exists public.user_blocks`. That is fine
--       the first time the table is created, but it means the constraint's
--       existence rides on that CREATE TABLE statement having actually run -
--       on a database where user_blocks already exists from an earlier
--       partial paste, the whole CREATE TABLE IF NOT EXISTS is a no-op and
--       nothing re-checks that the unique constraint is there. Naming it and
--       using the drop-if-exists/add pattern this file already uses for
--       user_blocks_reason_len (and 0138 already uses for
--       user_blocks_not_self) makes its presence independent of whether the
--       CREATE TABLE ever ran.
--
-- WHAT THIS FILE DOES, in order:
--   1. unlock_direct_request() - 0132's body, byte for byte, plus ONE gate:
--      the same blocked_between() check apply_to_lead already carries,
--      placed in the equivalent spot - after the lead is locked and every
--      "is this even open" check has passed, and before the wallet is
--      touched, before a single cent moves, before any row is written.
--   2. public.user_blocks.reason gets a 500-character CHECK constraint.
--   3. public.user_blocks' pair-uniqueness rule is re-issued under a real
--      name, user_blocks_pair_uniq, via drop-if-exists/add.
--
-- WHAT DOES NOT CHANGE: no column is dropped, no row is rewritten, no price
-- moves, and the one function re-issued below is a copy of its latest
-- definition (0132) with the named lines added and nothing else edited. The
-- signature is unchanged, so CREATE OR REPLACE preserves the existing
-- EXECUTE grant (0132 restated no explicit grant for unlock_direct_request,
-- so it stands on the default PUBLIC/authenticated EXECUTE it has always had -
-- this file does not add one either, for the same reason 0132 didn't).
--
-- IF THIS FILE HAS NOT BEEN RUN ON LIVE YET: nothing new breaks. A blocked
-- pro can still pay to unlock a direct request against a homeowner they have
-- a block with, exactly as they could before 0138. apply_to_lead, the job
-- board and messaging are unaffected either way.
--
-- Idempotent: the function is CREATE OR REPLACE, both constraints are
-- drop-then-add by name. Safe to re-run.
-- =============================================================================


-- =============================================================================
-- Part 1: unlock_direct_request - 0132's body, plus the block gate
-- =============================================================================
-- COPY-ONLY, the same discipline 0138 used for open_jobs_for_me and
-- apply_to_lead. 0132 is the latest definition of unlock_direct_request in
-- this folder (0105 created it, 0115 re-issued it for the intro price, 0132
-- added the chargeback freeze, nothing since). ONE block added and nothing
-- else edited.
--
-- WHERE THE GATE SITS: immediately after the lead is locked and read (so
-- v_direct_to, v_lead_contractor, v_status etc. are all resolved) and after
-- every existing "is this request even available" check - not a direct
-- request, not mine, already assigned, declined, not new - and still before
-- get_or_create_wallet, the wallet FOR UPDATE, the bonus drain, the debit,
-- and the final assignment UPDATE that sets contractor_id and opens the chat.
-- Nothing between the last existing check and this gate mutates anything, so
-- placing it here costs nothing extra and still refuses before a single cent
-- moves.
--
-- The property owner is resolved through a join inside the predicate rather
-- than read into a local variable first. property_id on contractor_leads can
-- in principle be null, and a join simply matches zero rows in that case (no
-- block found), so a null property never needs its own null-check the way a
-- bare variable comparison would.
--
-- Worded exactly like apply_to_lead's gate, and for the same reason: a pro
-- must not be able to use the error message to learn WHICH side blocked whom.
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

  -- 0140: a block between these two people. Same predicate as apply_to_lead's
  -- gate (0138), same wording, same reason: symmetric, and it must not tell
  -- the pro which side blocked whom. This is the third and last place a pro
  -- spends wallet money - the job board (open_jobs_for_me) and apply_to_lead
  -- were closed in 0138; this was the one left open. Placed after every
  -- existing "is this request even available" check and before
  -- get_or_create_wallet, so it costs nothing extra and still refuses before
  -- any wallet is touched.
  if exists (
    select 1
    from contractor_leads l
    join properties pr on pr.id = l.property_id
    where l.id = p_lead
      and public.blocked_between(auth.uid(), pr.user_id)
  ) then
    raise exception 'This job is not available to you.';
  end if;

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

comment on function public.unlock_direct_request(uuid) is
  'Pays to unlock and assign a direct request (0105/0115). Copy of 0132''s '
  'body plus one gate (0140): refuses when public.blocked_between() is true '
  'between the caller and the request''s property owner, placed after every '
  'availability check and before the wallet is touched. Closes the same gap '
  '0138 already closed on open_jobs_for_me and apply_to_lead - this was the '
  'third spending path and the one left open.';


-- =============================================================================
-- Part 2: public.user_blocks.reason gets a length cap
-- =============================================================================
alter table public.user_blocks drop constraint if exists user_blocks_reason_len;
alter table public.user_blocks
  add constraint user_blocks_reason_len
  check (reason is null or char_length(reason) <= 500);


-- =============================================================================
-- Part 3: name the pair-uniqueness constraint on public.user_blocks
-- =============================================================================
-- 0138 added this rule as an inline `unique (blocker_user_id, blocked_user_id)`
-- inside `create table if not exists public.user_blocks`, so its presence
-- depends on that CREATE TABLE statement having actually executed. Re-issuing
-- it here by name, with the drop-if-exists/add pattern 0138 already uses for
-- user_blocks_not_self two lines below it, makes the rule's presence
-- independent of that - a partial re-run of 0138 that skipped the CREATE
-- TABLE (because the table already existed) cannot leave this rule missing.
--
-- The first DROP targets Postgres' own default name for an inline table-level
-- UNIQUE (table_col1_col2_key); the second is a no-op the first time this
-- file runs and guards every re-run after. Either the default-named
-- constraint or this one may be present depending on history - dropping both
-- before adding leaves exactly one, correctly named, either way.
alter table public.user_blocks
  drop constraint if exists user_blocks_blocker_user_id_blocked_user_id_key;
alter table public.user_blocks
  drop constraint if exists user_blocks_pair_uniq;
alter table public.user_blocks
  add constraint user_blocks_pair_uniq
  unique (blocker_user_id, blocked_user_id);


-- =============================================================================
-- RISK / VERIFICATION NOTES
--
-- 1. Diff Part 1 against 0132's unlock_direct_request: the ONLY difference
--    should be the one block marked "0140", placed after the 'Request no
--    longer available' check and before `v_wallet := get_or_create_wallet`.
--    The signature is unchanged, so CREATE OR REPLACE keeps the function's
--    existing EXECUTE grant.
--
-- 2. Dry run, on a copy: as the pro who is D0's direct_to on a fresh direct
--    request, with a block row between the caller and the property owner
--    (insert into user_blocks (blocker_user_id, blocked_user_id) values
--    (...)), select public.unlock_direct_request('<lead>') must raise 'This
--    job is not available to you.' and must not touch wallets,
--    lead_applications, wallet_transactions or contractor_leads. Delete the
--    block row and the same call must proceed to its normal chargeback/price/
--    balance logic.
--
-- 3. A direct request with NO block in place is unaffected: confirm a normal
--    unlock still succeeds end to end (wallet debited, lead_applications row
--    inserted with status 'chosen', contractor_leads assigned) exactly as it
--    did before this file.
--
-- 4. user_blocks_reason_len: a reason over 500 characters is refused; 500 or
--    fewer, or null, succeeds. Confirm with:
--      select conname from pg_constraint
--       where conrelid = 'public.user_blocks'::regclass
--         and conname = 'user_blocks_reason_len';
--
-- 5. user_blocks_pair_uniq: confirm exactly one unique constraint remains on
--    (blocker_user_id, blocked_user_id), named user_blocks_pair_uniq, and
--    that inserting the same pair twice still raises 23505:
--      select conname, contype
--        from pg_constraint
--       where conrelid = 'public.user_blocks'::regclass
--         and contype = 'u';
-- =============================================================================

-- <<<<<<<<<< END 0140_blocks_direct_requests.sql <<<<<<<<<<


-- ============================================================================
-- VERIFY. Run these after the paste above. Expected results are stated on
-- each one; anything else means the run did not finish. The RISK /
-- VERIFICATION NOTES inside the migration body above carry the long-form
-- version, including the full dry-run walkthrough.
-- ============================================================================

-- 1. unlock_direct_request keeps its signature and default EXECUTE grant
--    (expect one row; proacl null or showing only the defaults it had before
--    this file, never narrower):
--    select p.proname, p.proacl::text
--      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--     where n.nspname = 'public' and p.proname = 'unlock_direct_request';

-- 2. A block between the caller and a direct request's property owner
--    refuses the unlock and moves no money. On a copy, with a block row in
--    place between the two accounts, this must raise 'This job is not
--    available to you.':
--      select public.unlock_direct_request('<direct-request lead id>');
--    Then confirm nothing changed:
--      select cash_balance_cents, bonus_balance_cents from wallets
--       where id = (select id from contractors where user_id = '<pro>');
--      select count(*) from lead_applications where lead_id = '<lead>';
--      select contractor_id, status, paid from contractor_leads
--       where id = '<lead>';
--    Delete the block row and the same call must proceed normally.

-- 3. A direct request with no block in place is unaffected: a normal unlock
--    still debits the wallet, inserts a 'chosen' lead_applications row and
--    assigns contractor_leads exactly as it did before this file.

-- 4. The reason length cap exists (expect one row):
--    select conname from pg_constraint
--     where conrelid = 'public.user_blocks'::regclass
--       and conname = 'user_blocks_reason_len';
--    And a reason over 500 characters is refused while 500 or fewer (or
--    null) succeeds.

-- 5. Exactly one named unique constraint covers
--    (blocker_user_id, blocked_user_id) (expect one row, contype = 'u',
--    conname = user_blocks_pair_uniq):
--    select conname, contype from pg_constraint
--     where conrelid = 'public.user_blocks'::regclass and contype = 'u';
--    Inserting the same (blocker_user_id, blocked_user_id) pair twice must
--    still raise 23505.
