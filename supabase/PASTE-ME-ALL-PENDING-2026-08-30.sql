-- ============================================================================
-- HEARTH: ALL PENDING LIVE MIGRATIONS IN ONE PASTE (built 2026-08-30 morning)
-- Prerequisite: the 2026-08-29 bundle (PRECHECK + 0129-0140) is already live.
-- Supabase > SQL editor > new query > paste this whole file > Run.
-- Order: 0141 -> 0142 -> 0143 -> 0144 -> 0145 -> 0146 -> storage caps.
-- One transaction: any failure applies nothing. Only the last query's result
-- shows; green "Success" is the pass signal. Per-file verify queries stay in
-- the source files listed below if you want to run one afterwards.
-- ============================================================================


-- ############################################################################
-- SECTION: 0141 contractors.owner_name + public_pro_profile (after 0138/0140)
-- source: supabase/PASTE-ME-live-2026-08-29-owner-name.sql
-- ############################################################################

-- ============================================================================
-- HEARTH LIVE-DB BUNDLE: migration 0141 (2026-08-29)
-- Paste this WHOLE file into the Supabase SQL editor and run it ONCE.
-- Safe to re-run: every statement is idempotent.
--
-- WHAT THIS IS: one new column on public.contractors, owner_name - the name of
-- the person behind the business. The table already had the company name, a
-- contact email and a contact phone, and nowhere at all for who the homeowner
-- is actually going to be talking to.
--
-- WHERE IT SHOWS UP: the pro signup wizard asks for it (prefilled from the
-- account's name), the pro profile editor lets an existing pro fill it in, and
-- the public /p/<id> page prints it under the business name as
-- "Owner: <name>" when it is set.
--
-- ORDER: run this AFTER the 0129-0140 bundle. Part 2 below replaces the
-- public_pro_profile function, whose current definition ships in migration
-- 0138. If you run this first, 0138 will later replace that function with its
-- own copy and quietly drop 'owner_name' from the payload - no error, the
-- public page just stops showing the line. Number order gives you the right
-- order for free.
--
-- IF YOU DELAY THIS: nothing breaks and nobody sees an error page. The app
-- notices the column (or the grant) is missing, saves everything else on the
-- form, and tells the pro "Saved. Owner name could not be stored yet." The
-- field simply will not stick until this runs.
--
-- THE GRANTS AT THE BOTTOM ARE NOT OPTIONAL. Migration 0085 revoked the
-- table-level INSERT and UPDATE on public.contractors and re-granted them
-- column by column. An allowlist written back then cannot know about a column
-- added now, so without those two GRANT lines the column exists, the app
-- writes to it, and Postgres refuses with a bare permission error. This is the
-- same half-applied shape 0124 hit with launch_cities and 0128 hit with the
-- review links.
-- ============================================================================

-- >>>>>>>>>> BEGIN 0141_contractors_owner_name.sql >>>>>>>>>>

alter table public.contractors
  add column if not exists owner_name text;

comment on column public.contractors.owner_name is
  'The business owner''s own name, shown under the company name on the public '
  '/p/<id> page. Nullable: every row created before 0141 predates the question. '
  'Written by saveCompanyAction (src/app/pro/actions.ts) from the signup wizard '
  'and the profile editor.';

-- Length floor and ceiling, same style and the same NOT VALID then VALIDATE
-- dance 0132 used for contractors.name and contractors.about, so the ACCESS
-- EXCLUSIVE lock covers the catalog change only. 2 and 120 are the numbers the
-- signup wizard and saveCompanyAction already enforce; this restates them
-- somewhere they cannot be skipped by a direct PostgREST write.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.contractors'::regclass
      and conname = 'contractors_owner_name_len'
  ) then
    alter table public.contractors
      add constraint contractors_owner_name_len
      check (
        owner_name is null
        or (char_length(owner_name) >= 2 and char_length(owner_name) <= 120)
      ) not valid;
  end if;
end
$$;

alter table public.contractors validate constraint contractors_owner_name_len;

-- 0085's column allowlist, extended. See the header for why this is required.
grant insert (owner_name) on public.contractors to authenticated;
grant update (owner_name) on public.contractors to authenticated;

-- =============================================================================
-- Part 2: public_pro_profile - hand the public page the owner name
--
-- A COPY of the definition in 0138 with ONE key added ('owner_name'). Diff the
-- two: the only difference should be the block marked 0141. The signature is
-- byte-identical, so CREATE OR REPLACE keeps the function's existing EXECUTE
-- grants; they are re-granted below anyway, which is idempotent.
--
-- ORDER MATTERS HERE. This must run AFTER 0138, which is the current owner of
-- this function body. Applying migrations in number order (the house rule)
-- gives you that for free. If 0141 ran first, 0138 would later replace the
-- function with its own copy and silently drop 'owner_name' from the payload -
-- no error, the page would just stop showing the line.
--
-- The payload stays a whitelist: nothing else about the row is exposed, and
-- owner_name is a value the pro typed into their own public profile knowing it
-- is public.
-- =============================================================================

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
    -- 0141: the owner's own name, under the business name on the public
    -- page. FREE for every pro, never gated on m.live: knowing who is going
    -- to stand on your porch is a safety fact, the same reasoning the
    -- license and background-check signals below are free under. Null until
    -- the pro fills it in, and the page omits the line when it is null.
    'owner_name',   c.owner_name,
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

-- <<<<<<<<<< END 0141_contractors_owner_name.sql <<<<<<<<<<


-- ============================================================================
-- VERIFY. Run these after the bundle above; each says what it should return.
-- ============================================================================

-- 1. The column is there, text, nullable.
select column_name, data_type, is_nullable
  from information_schema.columns
 where table_schema = 'public'
   and table_name = 'contractors'
   and column_name = 'owner_name';
-- EXPECT: one row -> owner_name | text | YES

-- 2. The length check exists AND is validated (convalidated must be t).
select conname, convalidated
  from pg_constraint
 where conrelid = 'public.contractors'::regclass
   and conname = 'contractors_owner_name_len';
-- EXPECT: one row -> contractors_owner_name_len | t

-- 3. `authenticated` can actually write the column. THIS IS THE ONE THAT
--    CATCHES A HALF-APPLIED RUN.
select privilege_type
  from information_schema.column_privileges
 where table_schema = 'public'
   and table_name = 'contractors'
   and column_name = 'owner_name'
   and grantee = 'authenticated'
 order by privilege_type;
-- EXPECT: two rows -> INSERT, UPDATE
-- If this comes back empty, the two GRANT lines above did not run. Re-run
-- them; nothing else needs redoing.

-- 4. Nothing existing was disturbed: no row can have been given a bad value,
--    since they are all null until a pro saves their profile.
select count(*) as rows_with_owner_name
  from public.contractors
 where owner_name is not null;
-- EXPECT: 0 right after applying, and it climbs as pros fill it in.


-- ############################################################################
-- SECTION: 0142 app_feedback kinds for the rating prompt
-- source: supabase/PASTE-ME-live-2026-08-29-review-prompt.sql
-- ############################################################################

-- ============================================================================
-- HEARTH LIVE-DB BUNDLE: migration 0142 (2026-08-29)
-- Paste this WHOLE file into the Supabase SQL editor and run it ONCE.
-- Safe to re-run: every statement is idempotent.
--
-- RUN THE app_feedback TABLE FIRST. This widens a constraint on
-- public.app_feedback, which arrives with migration 0133. If the live database
-- has not had 0133 yet (it is inside
-- supabase/PASTE-ME-ALL-PENDING-2026-08-29.sql), run that bundle first; this
-- one stops with a clear message rather than half-applying.
--
-- WHAT THIS IS: three more values allowed in app_feedback.kind, so the review
-- prompt can stop lying about what it knows.
--
--   rate_clicked   somebody tapped through to the App Store. An INTENT.
--   rate_deferred  they came back and answered "Not yet" when asked whether
--                  they got a chance to rate it.
--   rated          they answered "Yes, done". The permanent stop.
--
-- WHY: tapping the store link used to be recorded as the end of the prompt, so
-- anyone who went to the store and came back without rating was written off as
-- done. Apple never tells an app whether a rating was actually left, so the
-- app now asks the person when they return, and only their own "Yes, done"
-- ends it. See supabase/migrations/0142_review_prompt_events.sql and
-- src/lib/reviewPrompt.ts.
--
-- NOTHING BREAKS IF YOU DELAY THIS, but the new prompt loses its point: the
-- three new inserts fail the old CHECK constraint, recordReviewPromptEvent
-- swallows the error (it is best effort and logs to the server console), and
-- the browser still behaves correctly for the current session while forgetting
-- the answer on the next device. Nobody sees an error page.
-- ============================================================================

-- >>>>>>>>>> BEGIN 0142_review_prompt_events.sql >>>>>>>>>>

do $migration$
declare
  r record;
begin
  if to_regclass('public.app_feedback') is null then
    raise exception
      'public.app_feedback is missing: run migration 0133 (or the ALL-PENDING bundle) before this one';
  end if;

  -- Dropped by definition rather than by name: the inline check from 0133 is
  -- called app_feedback_kind_check, but a table created by hand could carry
  -- the same rule under another name, and leaving a narrower one in place
  -- would reject every new kind with no obvious cause.
  for r in
    select con.conname
      from pg_constraint con
      join pg_class c on c.oid = con.conrelid
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relname = 'app_feedback'
       and con.contype = 'c'
       and pg_get_constraintdef(con.oid) like '%prompt_shown%'
  loop
    execute format('alter table public.app_feedback drop constraint %I', r.conname);
  end loop;

  execute $c$
    alter table public.app_feedback
      add constraint app_feedback_kind_check
      check (kind in (
        'prompt_shown',
        'loved',
        'not_really',
        'rate_clicked',
        'rate_deferred',
        'rated'
      ))
  $c$;
end
$migration$;

comment on table public.app_feedback is
  'Review-prompt event log ("prompt_shown"/"loved"/"not_really"/"rate_clicked"/"rate_deferred"/"rated") and the private feedback form an unhappy answer is routed to. Only "rated" and "not_really" stop the prompt for good; "rate_clicked" is a tap on the store link, never a rating. Insert-your-own-row only for authenticated: no select policy exists, so nobody can read a row back, including their own. The service role reads everything.';

-- <<<<<<<<<< END 0142_review_prompt_events.sql <<<<<<<<<<

-- ---------------------------------------------------------------------------
-- VERIFY
-- ---------------------------------------------------------------------------
-- 1. The constraint now lists all six kinds (one row, definition contains
--    'rated'):
--   select conname, pg_get_constraintdef(oid)
--     from pg_constraint
--    where conrelid = 'public.app_feedback'::regclass
--      and contype = 'c'
--      and pg_get_constraintdef(oid) like '%prompt_shown%';
--
-- 2. Exactly one such constraint exists (should return 1, never 2):
--   select count(*)
--     from pg_constraint
--    where conrelid = 'public.app_feedback'::regclass
--      and contype = 'c'
--      and pg_get_constraintdef(oid) like '%prompt_shown%';
--
-- 3. The "at most one of each per account" index is still there and still
--    partial (should return app_feedback_one_event_per_kind_idx with
--    "WHERE (message IS NULL)"):
--   select indexname, indexdef
--     from pg_indexes
--    where schemaname = 'public'
--      and tablename = 'app_feedback';
--
-- 4. RLS is still on and there is still NO select policy (rowsecurity = true,
--    and the second query returns only the insert policy):
--   select relname, relrowsecurity
--     from pg_class where relname = 'app_feedback';
--   select polname, polcmd from pg_policy
--    where polrelid = 'public.app_feedback'::regclass;
--
-- 5. Once the app has been used for a day, the event mix (service role only):
--   select kind, count(*) from public.app_feedback group by kind order by kind;
--    - rate_clicked much larger than rated is normal and honest: it counts
--      taps on the store link, not ratings.


-- ############################################################################
-- SECTION: 0143 push_subscriptions
-- source: supabase/PASTE-ME-live-2026-08-29-push.sql
-- ############################################################################

-- ============================================================================
-- HEARTH LIVE-DB BUNDLE: migration 0143 (2026-08-29)
-- Paste this WHOLE file into the Supabase SQL editor and run it ONCE.
-- Safe to re-run: every statement is idempotent.
-- Live DB should be at 0142 before this. After running, live is at 0143.
--
-- WHAT THIS IS: one new table, public.push_subscriptions, which is what lets
-- Hearth notify somebody on their phone WITH THE APP CLOSED. Today the only
-- ways to reach a person are the bell inside the app and (once the provider
-- keys exist) email and SMS. This is the third channel, it costs nothing per
-- message, and it is free for homeowners and pros alike.
--
-- NOTHING ELSE IN THE DATABASE CHANGES. No existing table, policy, function or
-- grant is touched. The push opt-out preference rides in the users.
-- notification_prefs jsonb that already exists, so it needs no column.
--
-- NOTHING BREAKS IF YOU DELAY THIS. src/lib/push.ts treats a missing table as
-- "push is not wired up yet" and returns quietly; the subscribe API answers
-- 503 and the button says it could not save. The bell, email and SMS are all
-- unaffected. Nobody sees an error page.
--
-- THE OTHER HALF IS THREE ENV VARS IN VERCEL. Without them push stays dormant
-- even with this table in place - see docs/GO-LIVE-WIRING.md section 10:
--   NEXT_PUBLIC_VAPID_PUBLIC_KEY
--   VAPID_PRIVATE_KEY
--   VAPID_SUBJECT
-- ============================================================================

-- >>>>>>>>>> BEGIN 0143_push_subscriptions.sql >>>>>>>>>>

-- =============================================================================
-- Hearth - Web Push subscriptions (0143)
-- RUN THIS AGAINST THE LIVE DATABASE (Supabase SQL editor); editing repo SQL
-- alone does NOT change the already-deployed database.
--
-- WHY THIS EXISTS
-- Until now Hearth could only reach someone who had the app OPEN: the bell in
-- the nav, and a toast that polls every 45 seconds. Close the app and a quote
-- request or a message sat there unseen. This table is what makes the phone
-- itself buzz.
--
-- WHAT A ROW IS. When somebody taps "Turn on notifications", their browser
-- creates a PushSubscription: an `endpoint` URL at their browser vendor's own
-- push service (Apple, Google, Mozilla) plus two keys the push service uses to
-- carry an encrypted payload. One row per DEVICE, not per person - the same
-- account on a phone and a laptop is two rows. The server posts a message to
-- the endpoint; the push service wakes the device; public/sw.js shows it.
--
-- WHAT IS AND IS NOT SENSITIVE HERE. The endpoint is a capability URL: anyone
-- holding it can ask that push service to wake that device, though they cannot
-- read anything and cannot produce a notification that looks like Hearth's
-- without Hearth's VAPID private key (which lives only in the server env).
-- `p256dh` and `auth` are PUBLIC halves - the matching private key never leaves
-- the browser, which is what makes the payload readable only on that device.
-- Still: an endpoint identifies a device, so this table is self-scoped under
-- RLS and revoked from anon entirely.
--
-- The DELETE half of the policy set matters as much as the insert: turning
-- notifications off has to actually remove the row, or "off" is a lie the
-- server keeps ignoring.
--
-- NOTHING BREAKS IF YOU DELAY THIS. src/lib/push.ts treats a missing table as
-- "push is not wired up yet" (isMissingSchemaError) and returns quietly, the
-- subscribe API answers 503, and the in-app bell, email and SMS are all
-- untouched. The only thing that happens is that the "Turn on notifications"
-- button reports it could not save.
--
-- Safe to re-run: every statement is idempotent.
-- =============================================================================

create table if not exists public.push_subscriptions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  -- Which shell the person was in when they turned notifications on. Not used
  -- to decide anything today (a push goes to every device the account has, and
  -- the same human can be both a homeowner and a pro on one account), but it
  -- is the difference between "we can tell where this came from" and a support
  -- question nobody can answer. Nullable: an older client that does not send it
  -- still subscribes successfully.
  side        text check (side in ('homeowner', 'pro')),
  -- THE identity of a device, and the reason for the unique constraint. A
  -- browser hands back the SAME endpoint every time until the subscription is
  -- revoked, so an upsert on this column is what keeps a person who taps the
  -- button on five different days at exactly one row rather than five. Without
  -- the constraint the upsert in src/app/api/push/subscribe has nothing to
  -- conflict on and every visit would add another duplicate buzz.
  endpoint    text not null unique,
  -- The browser's public encryption key and auth secret for this subscription.
  -- Opaque base64url strings from the PushSubscription; the server only ever
  -- hands them straight back to the web-push library.
  p256dh      text not null,
  auth        text not null,
  -- Purely diagnostic: "which device is this" when somebody says notifications
  -- stopped working. Never parsed, never used in a decision.
  user_agent  text,
  created_at  timestamptz not null default now(),
  -- Stamped on every successful re-subscribe, which the app does on each visit
  -- once permission is granted (see src/components/PushRegistrar.tsx). A row
  -- whose last_used_at has not moved in months belongs to a device that stopped
  -- coming back, and is a candidate for cleanup later.
  last_used_at timestamptz
);

create index if not exists push_subscriptions_user_id_idx
  on public.push_subscriptions (user_id);

alter table public.push_subscriptions enable row level security;

-- Self-scoped, all four verbs a person needs for their own devices and nothing
-- more. There is no policy that lets one account see another's rows, so the
-- endpoint list is not enumerable from the browser: the service role (which
-- bypasses RLS) is what actually sends, in src/lib/push.ts.
drop policy if exists "push_subscriptions self select" on public.push_subscriptions;
create policy "push_subscriptions self select" on public.push_subscriptions
  for select to authenticated
  using (user_id = auth.uid());

drop policy if exists "push_subscriptions self insert" on public.push_subscriptions;
create policy "push_subscriptions self insert" on public.push_subscriptions
  for insert to authenticated
  with check (user_id = auth.uid());

-- UPDATE is needed as well as INSERT because the API upserts on `endpoint`: a
-- device that re-subscribes with rotated keys takes the UPDATE branch. Both
-- USING and WITH CHECK are pinned to auth.uid(), so an update can neither reach
-- somebody else's row nor hand one of yours to another account.
drop policy if exists "push_subscriptions self update" on public.push_subscriptions;
create policy "push_subscriptions self update" on public.push_subscriptions
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists "push_subscriptions self delete" on public.push_subscriptions;
create policy "push_subscriptions self delete" on public.push_subscriptions
  for delete to authenticated
  using (user_id = auth.uid());

-- Grants in the same shape as 0138's user_blocks: nothing at all for anon (this
-- is a signed-in-only feature and an anonymous visitor has no devices to
-- register), the four self-scoped verbs for authenticated, everything for the
-- service role, which is the only thing that reads across accounts in order to
-- send.
revoke all on public.push_subscriptions from anon;
grant select, insert, update, delete on public.push_subscriptions to authenticated;
grant all on public.push_subscriptions to service_role;

comment on table public.push_subscriptions is
  'One row per DEVICE that has agreed to receive Web Push from Hearth (browser push endpoint plus its public encryption keys). Self-scoped RLS: an account can only see, create, refresh and delete its own rows, and anon has none at all. The service role reads across accounts to send - see src/lib/push.ts and public/sw.js.';

-- <<<<<<<<<< END 0143_push_subscriptions.sql <<<<<<<<<<


-- ============================================================================
-- VERIFY (run these after the bundle above; each should answer as described)
-- ============================================================================
--
-- 1. The table exists with the columns the app expects (11 rows: id, user_id,
--    side, endpoint, p256dh, auth, user_agent, created_at, last_used_at):
--   select column_name, data_type, is_nullable
--     from information_schema.columns
--    where table_schema = 'public' and table_name = 'push_subscriptions'
--    order by ordinal_position;
--
-- 2. RLS is ON and there are exactly FOUR self-scoped policies
--    (select/insert/update/delete, all qualified by auth.uid()):
--   select relname, relrowsecurity
--     from pg_class where relname = 'push_subscriptions';
--   select polname, polcmd from pg_policy
--    where polrelid = 'public.push_subscriptions'::regclass
--    order by polname;
--
-- 3. anon has NO privileges on it, authenticated has the four verbs, and
--    service_role has everything (anon must not appear at all):
--   select grantee, privilege_type
--     from information_schema.role_table_grants
--    where table_schema = 'public' and table_name = 'push_subscriptions'
--    order by grantee, privilege_type;
--
-- 4. The endpoint uniqueness that makes the upsert work is really there
--    (should return one unique constraint or index on (endpoint)):
--   select indexname, indexdef
--     from pg_indexes
--    where schemaname = 'public' and tablename = 'push_subscriptions';
--
-- 5. Once the env vars are set and somebody has tapped "Turn on
--    notifications", there should be a row per device (service role only):
--   select side, count(*), max(created_at), max(last_used_at)
--     from public.push_subscriptions group by side;
--    - zero rows is the correct answer until someone turns it on.
--    - endpoints starting web.push.apple.com are iPhones with Hearth added to
--      the Home Screen; fcm.googleapis.com is Android/Chrome.
--
-- 6. Nobody has opted out yet (service role only). push_opt_out lives in the
--    same jsonb as the email opt-out:
--   select count(*) from public.users
--    where notification_prefs ->> 'push_opt_out' = 'true';
-- ============================================================================


-- ############################################################################
-- SECTION: 0144 pro_feedback + grant_feedback_credit
-- source: supabase/PASTE-ME-live-2026-08-29-feedback-credit.sql
-- ############################################################################

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


-- ############################################################################
-- SECTION: 0145 contractors.free_tool_drafts_used + claim/refund
-- source: supabase/PASTE-ME-live-2026-08-29-pro-free-drafts.sql
-- ############################################################################

-- ============================================================================
-- HEARTH LIVE-DB BUNDLE: migration 0145 (2026-08-29)
-- Paste this WHOLE file into the Supabase SQL editor and run it ONCE.
-- Safe to re-run: every statement is idempotent.
--
-- WHAT THIS IS: two free AI back-office drafts for every contractor account,
-- then the Hearth Pro wall. One new column on public.contractors
-- (free_tool_drafts_used) and the atomic claim/refund pair that spends it,
-- exactly the shape migration 0135 gave the homeowner side's document and
-- inspection reads.
--
-- WHY IT MATTERS: before this, /pro/tools was members-only with no way to see
-- what a draft even looks like. A pro was being asked to pay for the idea of a
-- product. Now they get two real ones.
--
-- ORDER: run this AFTER 0144. It only needs public.contractors, which has been
-- live since the beginning, so the order is a convenience rather than a
-- dependency. Nothing later depends on it.
--
-- IF YOU DELAY THIS: nothing breaks and nobody sees an error page. The app
-- notices the function is missing and FAILS OPEN for the drafts (a
-- previously-members-only feature stays usable rather than telling a pro they
-- spent a taste the database cannot prove they spent), logging one warning line
-- naming this file. Members are unaffected either way. The gate closes the
-- moment this runs.
--
-- THERE IS DELIBERATELY NO GRANT ON THE NEW COLUMN. Migration 0085 revoked
-- table-level INSERT and UPDATE on public.contractors from authenticated and
-- anon and re-granted a hard-coded column allowlist. Leaving this column off
-- that list is what stops a signed-in pro from PATCHing their own counter back
-- to zero. Do NOT "fix" this by adding a grant. (0141 needed the opposite:
-- owner_name is a field a pro fills in themselves.)
-- ============================================================================

-- >>>>>>>>>> BEGIN 0145_pro_free_tool_drafts.sql >>>>>>>>>>

alter table public.contractors
  add column if not exists free_tool_drafts_used integer not null default 0;

comment on column public.contractors.free_tool_drafts_used is
  'Lifetime AI back-office drafts a non-member contractor has spent. Claimed by claim_pro_free_taste, handed back by refund_pro_free_taste when the model call fails. Not writable by authenticated: migration 0085 re-granted contractors column by column and this column is deliberately not on that list.';

-- Claim one taste, ATOMICALLY.
--
-- WHY A FUNCTION. supabase-js sends literal values in an update, so it cannot
-- express `col = col + 1`; a read-then-write from the app would let two
-- parallel requests both pass the same check and each spend a taste that was
-- never there. This does the read and the write in one statement, with the
-- limit in the WHERE clause, so exactly p_limit claims can ever succeed no
-- matter how many requests arrive at once. Same guarantee, and the same shape,
-- as claim_free_ai_taste (0135).
--
-- Returns true when this caller got a taste, false when they are out (or the
-- contractor row is missing). The app treats false as the paywall.
--
-- INVOKER, deliberately (no `security definer` line - invoker is Postgres's
-- default), following 0135. EXECUTE is granted to service_role ONLY, and
-- service_role already carries BYPASSRLS, so definer would add no capability
-- while turning one stray `grant execute ... to authenticated` from a
-- permission error into a privilege escalation on public.contractors. The
-- atomicity that matters comes from the single conditional UPDATE below.
-- `set search_path = public` pins the schema this body resolves against no
-- matter who calls it. Postgres grants EXECUTE on a new function to PUBLIC, so
-- that grant is revoked explicitly.
create or replace function public.claim_pro_free_taste(
  p_contractor uuid,
  p_limit integer
)
returns boolean
language plpgsql
set search_path = public
as $$
declare
  v_rows integer;
begin
  if p_contractor is null or p_limit is null or p_limit <= 0 then
    return false;
  end if;

  update public.contractors
     set free_tool_drafts_used = coalesce(free_tool_drafts_used, 0) + 1
   where id = p_contractor
     and coalesce(free_tool_drafts_used, 0) < p_limit;

  get diagnostics v_rows = row_count;
  return v_rows > 0;
end;
$$;

comment on function public.claim_pro_free_taste(uuid, integer) is
  'Atomically spend one free AI back-office draft for p_contractor while under p_limit. True when claimed. Service role only.';

-- The grant is the LAST thing said about this function, deliberately: whoever
-- reads or edits this block should see the full role list with nothing after
-- it that could be mistaken for a second grant.
revoke all on function public.claim_pro_free_taste(uuid, integer)
  from public, anon, authenticated;
grant execute on function public.claim_pro_free_taste(uuid, integer)
  to service_role;

-- Hand a claimed taste back when the model call never produced a document: a
-- thrown request, a ceiling above the caller, an unusable draft. Same thinking
-- as refund_free_ai_taste (0135) and refundAiUsage in src/lib/aiUsage.ts,
-- which is why the app claims up front (race-proof) and refunds on failure
-- rather than counting afterwards. Never drives the counter below zero.
--
-- INVOKER for the same reason as claim_pro_free_taste above.
create or replace function public.refund_pro_free_taste(
  p_contractor uuid
)
returns void
language plpgsql
set search_path = public
as $$
begin
  if p_contractor is null then
    return;
  end if;

  update public.contractors
     set free_tool_drafts_used = greatest(coalesce(free_tool_drafts_used, 0) - 1, 0)
   where id = p_contractor;
end;
$$;

comment on function public.refund_pro_free_taste(uuid) is
  'Hand back one free AI back-office draft for p_contractor after a failed model call. Never goes below zero. Service role only.';

-- Grant last, same reasoning as claim_pro_free_taste above.
revoke all on function public.refund_pro_free_taste(uuid)
  from public, anon, authenticated;
grant execute on function public.refund_pro_free_taste(uuid)
  to service_role;

-- <<<<<<<<<< END 0145_pro_free_tool_drafts.sql <<<<<<<<<<


-- ============================================================================
-- VERIFY. Run these after the bundle above; each says what it should return.
-- ============================================================================

-- 1. The column is there, integer, not null, defaulting to 0.
select column_name, data_type, is_nullable, column_default
  from information_schema.columns
 where table_schema = 'public'
   and table_name = 'contractors'
   and column_name = 'free_tool_drafts_used';
-- EXPECT: one row -> free_tool_drafts_used | integer | NO | 0

-- 2. `authenticated` CANNOT write the column. THIS IS THE ONE THAT MATTERS:
--    if it comes back with rows, somebody granted it and the paywall is a
--    formality - a pro could reset their own counter over the REST API.
select privilege_type
  from information_schema.column_privileges
 where table_schema = 'public'
   and table_name = 'contractors'
   and column_name = 'free_tool_drafts_used'
   and grantee in ('authenticated', 'anon')
 order by privilege_type;
-- EXPECT: ZERO rows. Empty is correct here.

-- 3. Both functions exist, are SECURITY INVOKER (prosecdef = f), and pin
--    their search_path.
select p.proname, p.prosecdef, p.proconfig
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname in ('claim_pro_free_taste', 'refund_pro_free_taste')
 order by p.proname;
-- EXPECT: two rows, both with prosecdef = f and {search_path=public}

-- 4. ONLY service_role may execute them.
select routine_name, grantee, privilege_type
  from information_schema.routine_privileges
 where routine_schema = 'public'
   and routine_name in ('claim_pro_free_taste', 'refund_pro_free_taste')
 order by routine_name, grantee;
-- EXPECT: service_role | EXECUTE for each (and postgres, which owns them).
--         NOT anon, NOT authenticated, NOT PUBLIC.

-- 5. Nothing existing was disturbed: every pro starts with a full allowance.
select count(*) as pros, count(*) filter (where free_tool_drafts_used > 0)
         as pros_who_have_spent_one
  from public.contractors;
-- EXPECT: your contractor count, then 0. The second number climbs as
--         non-members try the back office.

-- 6. The claim really is capped. Run this on a throwaway contractor id only
--    (it SPENDS drafts). The third call must come back false.
-- select public.claim_pro_free_taste('<contractor uuid>'::uuid, 2);  -- t
-- select public.claim_pro_free_taste('<contractor uuid>'::uuid, 2);  -- t
-- select public.claim_pro_free_taste('<contractor uuid>'::uuid, 2);  -- f
-- select public.refund_pro_free_taste('<contractor uuid>'::uuid);


-- ############################################################################
-- SECTION: 0146 replica identity default on published tables
-- source: supabase/PASTE-ME-live-2026-08-29-realtime.sql
-- ############################################################################

-- PASTE-ME (2026-08-29): stop shipping full old rows over Realtime.
-- This is migration 0146_realtime_replica_identity.sql, plus the checks to run
-- before and after. Safe to run more than once.
--
-- WHY. 0013_realtime.sql set `replica identity full` on contractor_leads and
-- lead_applications back when the Leads board was new. That tells Postgres to
-- write the ENTIRE pre-change row into the WAL on every update and delete, and
-- Supabase Realtime forwards it to subscribers as payload.old. For
-- contractor_leads that old row is the whole job request: property_id,
-- category, status, payout_amount. Every subscriber realtime admits to the row
-- gets that snapshot on every edit, including columns the page never selected.
--
-- Nothing in the app reads it. Every realtime callback in the codebase ignores
-- its payload and re-queries through PostgREST, which applies RLS and column
-- grants properly; `grep -rn "payload.old\|eventType" src` is empty. So the
-- full row image has no consumer and only downside, and `default` (primary key
-- only) is the right setting.
--
-- WHAT IT COSTS. With `default` a DELETE's old row carries only the primary
-- key, so a subscription with a column filter cannot match a delete and
-- realtime drops it. The only contractor_leads delete in the app is the dedup
-- rollback of a row the same request just inserted, no client waits on it, and
-- nothing deletes lead_applications. INSERT and UPDATE are untouched: their new
-- row is always complete in the WAL whatever the replica identity is, so the
-- live Leads board, the chat and the unread badge behave exactly as today.
--
-- messages and notifications were never set to full. Their statements below are
-- no-ops, included so all four published tables are stated in one place.

-- -----------------------------------------------------------------------------
-- 1. BEFORE. What the live database has right now.
--    relreplident: 'd' = default (primary key), 'f' = full, 'n' = nothing,
--    'i' = index. Expect 'f' on contractor_leads and lead_applications, 'd' on
--    messages and notifications.
-- -----------------------------------------------------------------------------
select c.relname, c.relreplident
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public'
   and c.relname in ('contractor_leads', 'lead_applications', 'messages', 'notifications')
 order by c.relname;

-- Which tables realtime publishes at all (context for the list above).
select schemaname, tablename
  from pg_publication_tables
 where pubname = 'supabase_realtime'
 order by schemaname, tablename;

-- -----------------------------------------------------------------------------
-- 2. APPLY.
-- -----------------------------------------------------------------------------
alter table public.contractor_leads replica identity default;
alter table public.lead_applications replica identity default;
alter table public.messages replica identity default;
alter table public.notifications replica identity default;

-- -----------------------------------------------------------------------------
-- 3. AFTER. Expect relreplident = 'd' on all four rows.
-- -----------------------------------------------------------------------------
select c.relname, c.relreplident
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public'
   and c.relname in ('contractor_leads', 'lead_applications', 'messages', 'notifications')
 order by c.relname;

-- Nothing should come back: any published public table still on `full` is one
-- this rule has not been applied to yet.
select c.relname, c.relreplident
  from pg_publication_tables p
  join pg_class c on c.relname = p.tablename
  join pg_namespace n on n.oid = c.relnamespace and n.nspname = p.schemaname
 where p.pubname = 'supabase_realtime'
   and p.schemaname = 'public'
   and c.relreplident = 'f'
 order by c.relname;


-- ############################################################################
-- SECTION: storage bucket caps (pro-logos 5MB, pro-docs 10MB)
-- source: supabase/PASTE-ME-live-2026-08-29-storage-limits.sql
-- ############################################################################

-- PASTE-ME (2026-08-29): tighten the Storage bucket limits, which are the ONLY
-- server-side upload cap on most of the app.
--
-- WHY. Seven of the eleven upload paths in Hearth go straight from the browser
-- to Supabase Storage with the user's own session: PhotoUpload.tsx,
-- DocumentUpload.tsx, LeadChat.tsx (chat photos), PrepPhotoUpload.tsx,
-- LogoUpload.tsx and ProjectPhotoManager.tsx. No Next.js server action or route
-- handler ever sees those bytes, so the MAX_BYTES constants in those components
-- are advice to the browser, not a control: the same request replays with any
-- body. The bucket's own file_size_limit is the only thing an attacker cannot
-- edit, which makes these three numbers the real caps.
--
-- WHAT CHANGES. Two of them are currently looser than what the app tells the
-- user, so the honest number is put in the one place that enforces it:
--   pro-logos  15MB -> 5MB   (LogoUpload.tsx has always said 5MB, and this is
--                             the one PUBLIC bucket, so the smallest cap that
--                             still does the job is the right one)
--   pro-docs   15MB -> 10MB  (matches MAX_FILE_BYTES in
--                             src/app/api/pro-compliance/route.ts and
--                             UPLOAD_KINDS.compliance in src/lib/uploadGuard.ts)
--   home-photos      unchanged at 15MB (matches every client that writes to it)
--
-- WHAT THIS DOES NOT FIX. Supabase checks allowed_mime_types against the
-- request's Content-Type header, which the browser copies from the client-side
-- File.type. So the MIME list below stops an honest mistake, not a crafted
-- upload. The real type check reads the file's magic bytes and lives in
-- src/lib/uploadGuard.ts; it is wired into /api/pro-compliance today, and the
-- direct-to-storage paths above cannot use it until their uploads are routed
-- through a server handler. That is a code change, not a paste, and it is
-- written up in the S2 report.
--
-- Safe to run twice. Nothing is dropped, no object is touched, only three
-- numbers on three bucket rows change.

update storage.buckets
   set file_size_limit = 5242880,  -- 5MB
       allowed_mime_types = array['image/png', 'image/jpeg', 'image/webp']
 where id = 'pro-logos';

update storage.buckets
   set file_size_limit = 10485760,  -- 10MB
       allowed_mime_types =
         array['image/png', 'image/jpeg', 'image/webp', 'application/pdf']
 where id = 'pro-docs';

update storage.buckets
   set file_size_limit = 15728640,  -- 15MB, unchanged; restated so all three
                                    -- buckets are set from one place
       allowed_mime_types =
         array['image/png', 'image/jpeg', 'image/webp', 'application/pdf']
 where id = 'home-photos';

-- Result. Copy this back: three rows, public=false for home-photos and
-- pro-docs, public=true for pro-logos only.
select id, public, file_size_limit, allowed_mime_types
  from storage.buckets
 order by id;
