-- =============================================================================
-- Hearth - free profile photos for everyone (2026-09-08)
-- RUN THIS AGAINST THE LIVE DATABASE (Supabase SQL editor). Paste in full.
-- Run AFTER 0153.
--
-- WHAT AND WHY. The profile photo used to be a paid Hearth Pro perk: a pro's
-- logo (contractors.logo_url, pro-logos bucket) was gated on membership both
-- when written (savePublicPageAction) and when shown (browse_pros /
-- public_pro_profile, `case when m.live then c.logo_url end`), and homeowners
-- had no photo at all. A profile picture is table stakes, not an upsell, so:
--
--   Part 1  users.avatar_url            - a NEW free column for homeowner (and
--                                         any account's) avatars.
--   Part 2  the `avatars` storage bucket - public, per-user folders, same
--                                         SVG/size posture as pro-logos.
--   Part 3  browse_pros                 - stop gating logo_url on m.live.
--   Part 4  public_pro_profile          - stop gating logo_url on m.live.
--
-- The paid perks that stay paid (about blurb, share card, rating widget,
-- before/after photo labels) are UNTOUCHED: only the photo is freed, so the
-- `m.live` subquery stays in both functions for everything else it gates.
--
-- NO users column-lock change is needed. 0139's guard is an ALLOW-LIST of
-- LOCKED columns; anything not listed (avatar_url included) stays writable by
-- the row's owner through "users self update" (0002). The homeowner write in
-- saveAvatarAction goes through the caller's own session client and is scoped
-- to their own id, exactly like full_name / phone already are.
--
-- Idempotent: add-column IF NOT EXISTS, bucket upsert on conflict, drop-then-
-- create policies, CREATE OR REPLACE functions. Safe to re-run.
-- =============================================================================


-- =============================================================================
-- Part 1: the free avatar column on public.users
-- =============================================================================
alter table public.users
  add column if not exists avatar_url text;

comment on column public.users.avatar_url is
  'Free profile picture for any account (homeowner or pro-owner). Public URL '
  'into the `avatars` storage bucket, under <user_id>/. Not a locked column '
  '(0139): the row''s owner writes it through their own session client, scoped '
  'to their own id, the same as full_name/phone.';


-- =============================================================================
-- Part 2: the `avatars` storage bucket
-- =============================================================================
-- PUBLIC, because avatars are served on unauthenticated pages (a pro's public
-- /p/<id> page, browse cards, the sitemap-visible surfaces). Objects are
-- namespaced by the owner's auth user id:
--   avatars/<user_id>/<uuid>.<ext>
insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', true)
on conflict (id) do nothing;

-- Reject anything that is not one of the three raster types the client also
-- enforces, and cap size, so Storage itself refuses an image/svg+xml (which can
-- carry a <script> and would be stored XSS on Hearth's own storage origin) or
-- an oversized upload regardless of what the client claims. Mirrors 0081's
-- posture for pro-logos; 5MB is plenty for an avatar.
update storage.buckets
   set allowed_mime_types = array['image/png', 'image/jpeg', 'image/webp'],
       file_size_limit     = 5242880
 where id = 'avatars';

-- public.try_uuid (shipped in 0021 / 0036) safely casts the folder segment so a
-- non-uuid path can never throw the policy. Repeated here so this migration
-- stands alone if run before those.
create or replace function public.try_uuid(p text)
returns uuid language plpgsql immutable set search_path = public as $$
begin
  return p::uuid;
exception when others then
  return null;
end; $$;

-- An account may write only under its own folder (avatars/<auth.uid()>/). Read
-- is public (the bucket is public), so no select policy is needed.
drop policy if exists "avatars owner insert" on storage.objects;
drop policy if exists "avatars owner update" on storage.objects;
drop policy if exists "avatars owner delete" on storage.objects;

create policy "avatars owner insert" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'avatars'
    and public.try_uuid((storage.foldername(name))[1]) = auth.uid()
  );
create policy "avatars owner update" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'avatars'
    and public.try_uuid((storage.foldername(name))[1]) = auth.uid()
  );
create policy "avatars owner delete" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'avatars'
    and public.try_uuid((storage.foldername(name))[1]) = auth.uid()
  );


-- =============================================================================
-- Part 3: browse_pros - logo_url is FREE now (was gated on m.live)
-- =============================================================================
-- Byte-identical to 0114 except the one logo_url line. The signature is
-- unchanged, so CREATE OR REPLACE is fine (no drop needed). The m.live subquery
-- stays: nothing else here uses it today, but the function is kept in the same
-- shape as public_pro_profile, which still gates about/labels on it.
create or replace function public.browse_pros(p_category text default null)
returns table (
  id                    uuid,
  slug                  text,
  name                  text,
  categories            text[],
  rating                numeric,
  review_count          int,
  has_license           boolean,
  has_insurance         boolean,
  license_verified_at   timestamptz,
  background_checked_at timestamptz,
  logo_url              text,
  service_area          text,
  project_count         bigint,
  yelp_url              text,
  google_reviews_url    text,
  latest_review_comment text,
  latest_review_rating  int,
  photo_urls            text[],
  created_at            timestamptz
) language sql security definer stable set search_path = public as $$
  select
    c.id,
    c.slug,
    c.name,
    coalesce(c.categories, '{}') as categories,
    case when c.review_count > 0 then c.rating end as rating,
    c.review_count,
    -- Trust signals: FREE for every pro (0109). Not gated on m.live.
    (c.license_number is not null
      and btrim(c.license_number) <> '') as has_license,
    (c.insurance_carrier is not null
      and btrim(c.insurance_carrier) <> '') as has_insurance,
    c.license_verified_at,
    c.background_checked_at,
    -- FREE for every pro as of 0154 (2026-09-08): a profile photo is table
    -- stakes, not a paid perk. Was: case when m.live then c.logo_url end.
    c.logo_url,
    c.service_area,
    (select count(*) from pro_projects pp where pp.contractor_id = c.id) as project_count,
    -- Outbound review-page links (0110): free trust signal, plain links only.
    c.yelp_url,
    c.google_reviews_url,
    -- Newest review with a non-empty comment; both null when there is none.
    lr.comment as latest_review_comment,
    lr.rating  as latest_review_rating,
    -- Up to 3 project photos: "after" shots first, then newest first. Empty
    -- array (never null) when the pro has no photos.
    coalesce((
      select array_agg(ph3.url)
      from (
        select ph.url
        from public.pro_project_photos ph
        join public.pro_projects pj on pj.id = ph.project_id
        where pj.contractor_id = c.id
        order by ph.is_before asc, ph.created_at desc, ph.sort asc
        limit 3
      ) ph3
    ), '{}'::text[]) as photo_urls,
    c.created_at
  from contractors c
  cross join lateral (
    -- Mirrors hasProPlan(): a pro_ plan, active or trialing, not past a known
    -- period end. As of 0154 it no longer gates the logo; kept for parity with
    -- public_pro_profile, which still gates about / before-after labels on it.
    select exists (
      select 1
      from public.subscriptions s
      where s.user_id = c.user_id
        and s.plan like 'pro\_%' escape '\'
        and s.status in ('active', 'trialing')
        and (s.current_period_end is null or s.current_period_end > now())
    ) as live
  ) m
  left join lateral (
    -- Most recent review that actually has a comment. reviews.rating is
    -- smallint (0009); cast so it matches the declared int return column.
    select r.comment, r.rating::int as rating
    from public.reviews r
    where r.contractor_id = c.id
      and r.comment is not null
      and btrim(r.comment) <> ''
    order by r.created_at desc
    limit 1
  ) lr on true
  where c.user_id is not null
    -- ORANGE COUNTY LAUNCH GATE: hard filter, same as open_jobs_for_me /
    -- can_preview_job_photo. A homeowner must not reach a pro who has not
    -- confirmed they serve the launch market.
    and c.serves_orange_county = true
    and (p_category is null or p_category = any (c.categories))
  order by
    (c.license_verified_at is not null) desc,
    case when c.review_count > 0 then c.rating end desc nulls last,
    c.review_count desc,
    c.name asc
  limit 200;
$$;

grant execute on function public.browse_pros(text) to anon;
grant execute on function public.browse_pros(text) to authenticated;


-- =============================================================================
-- Part 4: public_pro_profile - logo_url is FREE now (was gated on m.live)
-- =============================================================================
-- Byte-identical to 0141 except the one logo_url line. `about` and the
-- before/after photo labels STAY gated on m.live - those are still paid perks.
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
    -- 0141: the owner's own name, under the business name on the public page.
    -- FREE for every pro, never gated on m.live.
    'owner_name',   c.owner_name,
    'categories',   coalesce(c.categories, '{}'),
    'created_at',   c.created_at,
    -- Rating exactly as the rest of the app shows it: only real review
    -- averages (review_count > 0), never seeded placeholder values.
    'rating',       case when c.review_count > 0 then c.rating end,
    'review_count', c.review_count,
    'member',       m.live,
    -- FREE for every pro as of 0154 (2026-09-08): a profile photo is table
    -- stakes, not a paid perk. Was: case when m.live then c.logo_url end.
    'logo_url',     c.logo_url,
    -- Still a paid-member perk, still gated on m.live.
    'about',        case when m.live then c.about end,
    -- Trust signals: FREE for every pro (0109). Never gated on m.live.
    'has_license',  c.license_number is not null
                    and btrim(c.license_number) <> '',
    'has_insurance', c.insurance_carrier is not null
                    and btrim(c.insurance_carrier) <> '',
    -- Outbound review-page links (0110): trust signals, FREE for every pro.
    'yelp_url',            c.yelp_url,
    'google_reviews_url',  c.google_reviews_url,
    -- Real CSLB verification (0055). Free feature, not gated on membership.
    -- Only the timestamp, never the status text or CSLB detail.
    'license_verified_at', c.license_verified_at,
    -- Real Checkr background check (0057). Free feature, not gated on
    -- membership. Only the timestamp, never the status text or detail.
    'background_checked_at', c.background_checked_at,
    'reviews', coalesce((
      select jsonb_agg(
               jsonb_build_object(
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
    -- period end. As of 0154 it no longer gates the logo; it still gates the
    -- about blurb and the before/after photo labels above.
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
    and c.user_id is not null
    and coalesce(c.serves_orange_county, false);
$$;

grant execute on function public.public_pro_profile(uuid) to anon;
grant execute on function public.public_pro_profile(uuid) to authenticated;


-- =============================================================================
-- VERIFY (run after applying)
--
-- 1. The column exists:
--      select column_name from information_schema.columns
--       where table_schema = 'public' and table_name = 'users'
--         and column_name = 'avatar_url';   -- expect one row
--
-- 2. The bucket exists and is public with the right limits:
--      select id, public, file_size_limit, allowed_mime_types
--        from storage.buckets where id = 'avatars';
--
-- 3. The three avatars policies exist:
--      select polname from pg_policy
--       where polrelid = 'storage.objects'::regclass
--         and polname like 'avatars owner %';   -- expect 3 rows
--
-- 4. logo_url now comes back for a NON-member pro. Pick a contractor with a
--    logo_url set and NO active pro_ subscription, then:
--      select (public.public_pro_profile('<contractor_id>') ->> 'logo_url');
--      select logo_url from public.browse_pros(null) where id = '<contractor_id>';
--    Both must return the URL, not null.
--
-- 5. about is STILL gated for that same non-member pro:
--      select (public.public_pro_profile('<contractor_id>') ->> 'about');
--    Must be null when the pro is not a live member.
-- =============================================================================
