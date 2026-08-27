-- ============================================================================
-- HEARTH LIVE-DB BUNDLE: migration 0129 (2026-08-26)
-- Paste this WHOLE file into the Supabase SQL editor and run it ONCE.
-- Safe to re-run: every section is idempotent.
-- Live DB should be at 0128 before this. After running, live is at 0129.
--
-- WHAT THIS IS: the launch area goes from 9 cities to all of Orange County,
-- 36 names (34 incorporated cities plus Ladera Ranch and Midway City, the two
-- unincorporated communities with a ZIP of their own). Every one of them is
-- in Orange County, so serves_orange_county keeps its meaning and every gate
-- built on it is untouched.
--
-- ORDER MATTERS INSIDE THE FILE: the CHECK constraint is widened to 36 names
-- BEFORE the backfill writes the 36-name array, because the old nine-city
-- constraint would reject every one of those updates. Do not paste sections
-- out of order.
--
-- THIS ONE CHANGES DATA, not just schema: every contractors row with
-- serves_orange_county = true is granted ALL 36 names, including rows where a
-- pro had narrowed their pick since 0126. It only ever grants access, never
-- removes it, and a pro can uncheck "All of Orange County" in their profile
-- afterwards. Read the backfill's comment below before running - in
-- particular, run this once, at expansion time, not on a schedule.
--
-- KNOWN LAG: the backfill widens launch_cities only. The free-text
-- contractors.service_area string a pro's profile and applicant card show
-- (and that the AI prompts read) keeps its old wording until that pro saves
-- their profile again; the job board and apply gates are correct immediately.
--
-- open_jobs_for_me() and apply_to_lead() are deliberately NOT in this bundle:
-- both read launch_city_for_zip() and contractors.launch_cities, which this
-- file updates underneath them, so their own text does not change.
--
-- The VERIFY section at the bottom is read-only. Expected results are written
-- next to each query.
-- ============================================================================

-- >>>>>>>>>> BEGIN 0129_all_orange_county.sql >>>>>>>>>>

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

-- <<<<<<<<<< END 0129_all_orange_county.sql <<<<<<<<<<

-- ============================================================================
-- VERIFY (read-only). Run after the section above.
-- ============================================================================

-- 1. The constraint definition, for you to eyeball. Postgres may fold the
--    array literal into one '{...}' string, so this is printed rather than
--    counted. Expect: 36 names, Aliso Viejo first, Midway City last, and no
--    North Tustin / Rossmoor / Coto de Caza.
select pg_get_constraintdef(oid) as constraint_def
from pg_constraint
where conname = 'contractors_launch_cities_subset';

-- 2. The ZIP map knows the whole county. Expect: Ladera Ranch, Dana Point,
--    Rancho Santa Margarita, Rancho Santa Margarita, Orange, Fullerton,
--    null (a Long Beach ZIP).
select public.launch_city_for_zip('92694') as ladera_ranch,
       public.launch_city_for_zip('92624') as capistrano_beach_to_dana_point,
       public.launch_city_for_zip('92678') as trabuco_canyon_to_rsm,
       public.launch_city_for_zip('92679') as coto_de_caza_to_rsm,
       public.launch_city_for_zip('92676') as silverado_to_orange,
       public.launch_city_for_zip('92832') as fullerton_downtown,
       public.launch_city_for_zip('90803') as long_beach_is_null;

-- 3. The ZIP map has 91 entries. Expect: mapped = 91.
select count(*) as mapped
from regexp_matches(pg_get_functiondef('public.launch_city_for_zip(text)'::regprocedure),
                    'when ''\d{5}'' then', 'g');

-- 4. Every attested pro now holds all 36 names; anyone else is unchanged.
--    Expect: every row with serves_orange_county = true shows 36.
select id, serves_orange_county, cardinality(launch_cities) as cities
from public.contractors
order by serves_orange_county desc nulls last, id;
