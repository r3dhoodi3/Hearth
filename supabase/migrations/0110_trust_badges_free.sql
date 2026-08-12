-- =============================================================================
-- Hearth - trust badges are free for every pro (0109)
-- RUN THIS AGAINST THE LIVE DATABASE (Supabase SQL editor); editing repo SQL
-- alone does NOT change the already-deployed database.
--
-- POLICY: trust signals are never pay-to-play. Whether a pro has a license or
-- insurance on file is a safety fact a homeowner is entitled to see, so the
-- gray "on file" badge must show for EVERY pro, member or not - exactly like
-- the green CSLB "License verified" badge (license_verified_at, 0055) and the
-- Checkr "Background checked" badge (background_checked_at, 0057) already do.
-- Those two are free for the same stated reason: "a real background check is a
-- trust signal, not a paid perk" (0057:71-75), "Free feature, not gated on
-- membership" (0055/0057 public_pro_profile comments). The self-reported
-- license/insurance booleans were the last trust signal still behind the
-- membership wall; this migration frees them too.
--
-- COSMETICS STAY PAID: logo_url and about are legitimate paid-member perks
-- (they dress the page up, they are not a safety fact), so they remain gated on
-- m.live here, unchanged. This migration touches ONLY has_license and
-- has_insurance.
--
-- WHAT CHANGES: two functions get `create or replace`d with their exact current
-- bodies, dropping the leading `m.live and` term from the has_license and
-- has_insurance computations:
--   1. public_pro_profile(uuid) - latest body 0057:76-146. has_license and
--      has_insurance lose `m.live and`; logo_url/about keep `case when m.live`.
--   2. browse_pros(text)        - latest body 0104:549-604. has_license loses
--      `m.live and`; logo_url keeps `case when m.live`. (browse_pros has no
--      has_insurance column, so only has_license changes there.)
--
-- Everything else in both bodies - rating math, review ordering, the member
-- flag, license_verified_at / background_checked_at, before/after gating, the
-- OC launch gate, ordering, limits - is byte-identical to the current live
-- definitions. Idempotent (create or replace). Safe to re-run.
-- =============================================================================

-- ---- 1. public_pro_profile: free license/insurance "on file" booleans -------
-- Byte-identical to 0057's body except has_license / has_insurance no longer
-- carry the `m.live and` prefix. logo_url and about stay member-gated.
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
  where c.id = p_contractor;
$$;

grant execute on function public.public_pro_profile(uuid) to anon;
grant execute on function public.public_pro_profile(uuid) to authenticated;

-- ---- 2. browse_pros: free license "on file" boolean -------------------------
-- Byte-identical to 0104's body except has_license no longer carries the
-- `m.live and` prefix. logo_url stays member-gated.
create or replace function public.browse_pros(p_category text default null)
returns table (
  id                   uuid,
  slug                 text,
  name                 text,
  categories           text[],
  rating               numeric,
  review_count         int,
  has_license          boolean,
  license_verified_at  timestamptz,
  background_checked_at timestamptz,
  logo_url             text,
  service_area         text,
  project_count        bigint
) language sql security definer stable set search_path = public as $$
  select
    c.id,
    c.slug,
    c.name,
    coalesce(c.categories, '{}') as categories,
    case when c.review_count > 0 then c.rating end as rating,
    c.review_count,
    -- Trust signal: FREE for every pro (0109). No longer gated on m.live.
    (c.license_number is not null
      and btrim(c.license_number) <> '') as has_license,
    c.license_verified_at,
    c.background_checked_at,
    -- Cosmetic: still a member perk, still gated on m.live.
    case when m.live then c.logo_url end as logo_url,
    c.service_area,
    (select count(*) from pro_projects pp where pp.contractor_id = c.id) as project_count
  from contractors c
  cross join lateral (
    -- Mirrors hasProPlan(): a pro_ plan, active or trialing, not past a known
    -- period end. Gates only the logo now (0109 freed the license badge),
    -- nothing about rating.
    select exists (
      select 1
      from public.subscriptions s
      where s.user_id = c.user_id
        and s.plan like 'pro\_%' escape '\'
        and s.status in ('active', 'trialing')
        and (s.current_period_end is null or s.current_period_end > now())
    ) as live
  ) m
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
