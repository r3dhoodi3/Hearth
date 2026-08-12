-- =============================================================================
-- Hearth - pro page slugs for SEO (0043)
-- RUN THIS AGAINST THE LIVE DATABASE (Supabase SQL editor).
--
-- Every pro's public page (/p/..., 0033) gets a human-readable slug so search
-- engines index "acme-plumbing-1a2b3c4d" instead of a bare UUID. The slug is
-- derived from the business name and suffixed with the first 8 chars of the
-- contractor id, which guarantees uniqueness without any retry loop. UUID URLs
-- keep working forever; the slug is additive.
--
-- Two read paths change:
--   1. public_pro_profile() (0033) is re-created with ONE extra key, 'slug',
--      so the page can emit a canonical URL that prefers the slug form. The
--      payload is jsonb, so adding a key is invisible to existing callers.
--   2. public_pro_id_for_slug(text) is a tiny companion resolver that maps a
--      slug back to a contractor id. It lives apart from public_pro_profile
--      so the profile function keeps its single job (id -> safe payload) and
--      its uuid signature; overloading it to also accept slugs would have
--      forced a signature change and touched every caller.
-- Both are SECURITY DEFINER and expose nothing beyond the slug/id pair; the
-- contractors table itself stays non-public.
--
-- Safe to re-run: the backfill only touches rows whose slug is still null.
-- =============================================================================

-- ---- slug column + uniqueness -------------------------------------------------
alter table public.contractors
  add column if not exists slug text;

-- Case-insensitive uniqueness: lookups lower() both sides.
create unique index if not exists contractors_slug_lower_uidx
  on public.contractors (lower(slug));

-- ---- backfill ------------------------------------------------------------------
-- name -> lowercase, non-alphanumerics collapsed to single hyphens, trimmed of
-- leading/trailing hyphens, then "-<first 8 of id>" for guaranteed uniqueness.
-- A blank name degrades to just the id prefix (outer btrim drops the orphan
-- hyphen). Idempotent: only rows with a null slug are touched.
update public.contractors
set slug = btrim(
             btrim(
               lower(regexp_replace(coalesce(name, ''), '[^a-zA-Z0-9]+', '-', 'g')),
               '-'
             ) || '-' || left(id::text, 8),
             '-'
           )
where slug is null;

-- ---- public_pro_profile: 0033 body + 'slug' ------------------------------------
-- Identical to 0033 except for the one added 'slug' key. Rating math, review
-- ordering, member gating: all byte-for-byte the same.
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
    'logo_url',     case when m.live then c.logo_url end,
    'about',        case when m.live then c.about end,
    'has_license',  m.live
                    and c.license_number is not null
                    and btrim(c.license_number) <> '',
    'has_insurance', m.live
                    and c.insurance_carrier is not null
                    and btrim(c.insurance_carrier) <> '',
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
    ), '[]'::jsonb)
  )
  from public.contractors c
  cross join lateral (
    -- Mirrors hasProPlan(): a pro_ plan, active or trialing, not past a known
    -- period end. Perks only; it gates NOTHING about rating or reviews above.
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

-- ---- slug -> id resolver ---------------------------------------------------------
-- Returns null (not an error) for an unknown slug; the page turns that into 404.
create or replace function public.public_pro_id_for_slug(p_slug text)
returns uuid
language sql
security definer
stable
set search_path = public
as $$
  select c.id
  from public.contractors c
  where c.slug is not null
    and lower(c.slug) = lower(p_slug)
  limit 1;
$$;

grant execute on function public.public_pro_id_for_slug(text) to anon;
grant execute on function public.public_pro_id_for_slug(text) to authenticated;
