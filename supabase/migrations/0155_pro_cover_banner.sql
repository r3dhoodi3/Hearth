-- =============================================================================
-- OakTend - free company cover banner for every pro (2026-09-09)
-- RUN THIS AGAINST THE LIVE DATABASE (Supabase SQL editor). Paste in full.
-- Run AFTER 0154.
--
-- WHAT AND WHY. The pro card and the public /p/<id> page both show a plain
-- coloured strip behind the profile photo. This makes it a REAL uploadable
-- cover image - the company's own banner - the same way 0154 made the logo a
-- free, tap-to-upload photo.
--
--   Part 1  contractors.banner_url  - a NEW free column for the cover image.
--   Part 2  public_pro_profile      - return banner_url (free, never gated).
--
-- NO NEW BUCKET AND NO NEW STORAGE POLICY. The banner is just another object
-- under the existing PUBLIC `pro-logos` bucket (0036), at
-- pro-logos/<contractor_id>/<uuid>.<ext>, tracked by its own banner_url column.
-- The owner-scoped insert/update/delete policies 0036 created on that bucket
-- already permit exactly this write, so nothing about storage RLS changes.
--
-- FREE for every pro, matching the logo (0154): a cover image is presentation,
-- not a paid perk. saveBannerAction has no hasProPlan() gate, and the read
-- below is not wrapped in the m.live check. The paid perks that stay paid
-- (about blurb, before/after labels) are UNTOUCHED - the m.live subquery stays
-- for everything it still gates.
--
-- NO users/contractors column-lock change is needed. 0139's guard is an
-- ALLOW-LIST of LOCKED columns; banner_url is unlisted, so the row's owner
-- writes it through their own session client scoped to their contractor id,
-- exactly like logo_url and about already are (saveBannerAction).
--
-- Idempotent: add-column IF NOT EXISTS, CREATE OR REPLACE function. Safe to
-- re-run.
-- =============================================================================


-- =============================================================================
-- Part 1: the free banner column on public.contractors
-- =============================================================================
alter table public.contractors
  add column if not exists banner_url text;

comment on column public.contractors.banner_url is
  'Free company cover banner. Public URL into the existing `pro-logos` storage '
  'bucket, under <contractor_id>/ (same bucket + owner RLS as logo_url). Not a '
  'locked column (0139): the owner writes it through their own session client '
  'scoped to their contractor id, the same as logo_url/about.';


-- =============================================================================
-- Part 2: public_pro_profile - now returns banner_url (FREE, never gated)
-- =============================================================================
-- Byte-identical to 0154 except the one added banner_url line. `about` and the
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
    -- FREE for every pro as of 0155 (2026-09-09): a cover banner is
    -- presentation, not a paid perk. Same policy as logo_url above.
    'banner_url',   c.banner_url,
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
    -- period end. As of 0154 it no longer gates the logo, and as of 0155 not
    -- the banner either; it still gates the about blurb and before/after labels.
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
--       where table_schema = 'public' and table_name = 'contractors'
--         and column_name = 'banner_url';   -- expect one row
--
-- 2. banner_url comes back from the public read. Pick a contractor, set a
--    banner_url on them, then:
--      select (public.public_pro_profile('<contractor_id>') ->> 'banner_url');
--    Must return the URL (free, even for a NON-member pro), not null.
--
-- 3. about is STILL gated for a non-member pro (unchanged by this migration):
--      select (public.public_pro_profile('<contractor_id>') ->> 'about');
--    Must be null when the pro is not a live member.
-- =============================================================================
