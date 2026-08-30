-- =============================================================================
-- Hearth - contractors.owner_name: the business owner's own name (0141)
-- RUN THIS AGAINST THE LIVE DATABASE (Supabase SQL editor); editing repo SQL
-- alone does NOT change the already-deployed database. Apply in number order
-- with no gaps: everything through 0140 first, then this, then 0142. Part 2
-- below REPLACES public_pro_profile, whose current definition lives in 0138,
-- so running this before 0138 would have 0138 quietly undo it.
--
-- WHY THIS EXISTS
--
-- contractors has `name` (the business), `contact_email` and `contact_phone`,
-- and nowhere at all for the name of the person a homeowner is actually going
-- to be talking to. "Acme Home Services" is who you hire; "Alex Rivera" is who
-- turns up, and the public /p/<id> page could not say so.
--
-- WHAT THIS CHANGES
--
-- 1. Adds a nullable text column, owner_name. Nullable because every existing
--    company row predates the question: the signup wizard asks for it from now
--    on, and the profile editor lets an existing pro fill it in, but nothing
--    may break for a row that has not been touched since.
--
-- 2. A length CHECK in the same style 0132 gave name and about: the app caps
--    this at 120 characters, restated here where it cannot be skipped. The
--    floor of 2 is the same one the signup wizard and saveCompanyAction
--    enforce - a one-character "owner name" is a typo, not a name. Added NOT
--    VALID and then validated, exactly as 0132 does, so the ACCESS EXCLUSIVE
--    lock is held for the catalog change only and the full-table scan runs
--    under a weaker lock.
--
-- 3. (Part 1) Column-level INSERT and UPDATE grants for `authenticated`. This is the
--    step that is easy to forget and impossible to skip: 0085 revoked the
--    TABLE-level INSERT and UPDATE on public.contractors and re-granted them
--    column by column, and an allowlist written in 0085 cannot know about a
--    column added in 0141. Without these two lines the column exists, the app
--    writes to it, and PostgREST returns a bare 42501 permission error - the
--    same half-applied shape 0124 hit with launch_cities and 0128 hit with the
--    review links. src/app/pro/actions.ts has a retry for exactly this case
--    (it drops owner_name and saves everything else, loudly logged), so a
--    database missing this migration degrades instead of breaking, but the
--    field silently will not save until this runs.
--
-- NO RLS CHANGE. owner_name is an ordinary profile column and lives under the
-- same policies name / contact_email / contact_phone already have.
--
-- 4. (Part 2) Adds 'owner_name' to public_pro_profile's payload, which is what
--    actually puts it on the public /p/<id> page.
--
-- NOTHING ELSE LEAKS BY ACCIDENT. Every view and SECURITY DEFINER function that
-- reads contractors names its columns explicitly (there is no `select *` over
-- this table anywhere in supabase/migrations), so adding a column exposes it
-- nowhere on its own. Part 2 is the one deliberate exposure, and it is a value
-- the pro typed into their own public profile: the owner's name is exactly the
-- sort of thing a homeowner wants before letting somebody into their house.
-- =============================================================================

alter table public.contractors
  add column if not exists owner_name text;

comment on column public.contractors.owner_name is
  'The business owner''s own name, shown under the company name on the public '
  '/p/<id> page. Nullable: every row created before 0141 predates the question. '
  'Written by saveCompanyAction (src/app/pro/actions.ts) from the signup wizard '
  'and the profile editor.';

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

-- 0085's column allowlist, extended. See point 3 above for why this is not
-- optional.
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


-- =============================================================================
-- VERIFY (run after applying; each should come back as described)
-- =============================================================================

-- 1. The column exists and is nullable text.
--   select column_name, data_type, is_nullable
--     from information_schema.columns
--    where table_schema = 'public'
--      and table_name = 'contractors'
--      and column_name = 'owner_name';
--   -> one row: owner_name | text | YES

-- 2. The constraint exists and is validated (convalidated = true).
--   select conname, convalidated
--     from pg_constraint
--    where conrelid = 'public.contractors'::regclass
--      and conname = 'contractors_owner_name_len';
--   -> one row: contractors_owner_name_len | t

-- 3. `authenticated` holds INSERT and UPDATE on the column.
--   select privilege_type
--     from information_schema.column_privileges
--    where table_schema = 'public'
--      and table_name = 'contractors'
--      and column_name = 'owner_name'
--      and grantee = 'authenticated'
--    order by privilege_type;
--   -> two rows: INSERT, UPDATE

-- 4. The public payload carries the new key. Pick any live pro's id:
--   select public.public_pro_profile('<contractor uuid>') -> 'owner_name';
--   -> null before the pro fills it in, their name after. A MISSING key (not
--      null, absent) means Part 2 did not run, or 0138 ran after it.

-- 5. The check really bites (both of these must ERROR):
--   update public.contractors set owner_name = 'A' where false;
--   update public.contractors set owner_name = repeat('x', 121) where false;
--   -> note: `where false` touches no rows, so run these against a scratch row
--      if you want the constraint to actually fire.
