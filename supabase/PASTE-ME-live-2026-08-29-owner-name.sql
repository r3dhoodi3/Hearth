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
