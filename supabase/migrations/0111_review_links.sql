-- =============================================================================
-- Hearth - optional outbound review-page links (0110)
-- RUN THIS AGAINST THE LIVE DATABASE (Supabase SQL editor); editing repo SQL
-- alone does NOT change the already-deployed database.
--
-- A pro may OPTIONALLY link their existing Yelp and Google review pages. The
-- public page renders them only as plain "See our reviews" outbound buttons -
-- Hearth never embeds or imports review content, never shows star counts from
-- those sites. A link is the whole feature (the zero-ToS-risk pattern).
--
-- POLICY: these are trust signals, exposed FREE for every pro (member or not),
-- exactly like the license/insurance "on file" booleans and the CSLB /
-- background-check timestamps that 0109 and earlier expose ungated. Membership
-- gates only cosmetics (logo, about), never a trust signal.
--
-- WHAT CHANGES:
--   1. contractors gains two nullable text columns: yelp_url, google_reviews_url.
--   2. public_pro_profile(uuid) is create-or-replace'd with 0109's EXACT body
--      plus two new keys ('yelp_url', 'google_reviews_url'), exposed ungated.
-- browse_pros is deliberately NOT changed: the browse cards don't need
-- link-outs. Idempotent (add column if not exists / create or replace). Safe
-- to re-run.
-- =============================================================================

-- ---- 1. columns -------------------------------------------------------------
alter table public.contractors
  add column if not exists yelp_url text;
alter table public.contractors
  add column if not exists google_reviews_url text;

-- ---- 2. public_pro_profile: expose the two links ungated ---------------------
-- Byte-identical to 0109's body except for the two new keys added just after
-- the trust-signal booleans. Same free-trust-signal policy: no m.live gate.
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
  where c.id = p_contractor;
$$;

grant execute on function public.public_pro_profile(uuid) to anon;
grant execute on function public.public_pro_profile(uuid) to authenticated;
