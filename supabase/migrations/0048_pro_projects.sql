-- =============================================================================
-- Hearth - per-project portfolios for pros (0045)
-- RUN THIS AGAINST THE LIVE DATABASE (Supabase SQL editor).
--
-- Pros showcase completed work as per-project photo albums on their public
-- page (/p/..., 0033/0043): title, category, an optional description and a
-- "when" like "March 2026", plus photos that can be tagged Before/After.
-- Research note: Houzz and Yelp both converged on per-project albums, and
-- "examples of completed projects" is a named hiring factor for homeowners.
--
-- Access model:
--   * Pros manage ONLY their own projects/photos (RLS below, keyed through
--     contractors.user_id = auth.uid()). There are NO anon table policies:
--     the public read path is exclusively public_pro_profile(), the existing
--     SECURITY DEFINER RPC, which is re-created here as the 0043 version plus
--     one added 'projects' jsonb key (up to 12 projects, photos included).
--   * Tiering is enforced in the app layer: every pro can publish up to 3
--     projects, Pro members unlimited. The RPC collapses the Before/After
--     flag to false for non-members (same m.live gate as logo/about), so the
--     badge chips are a member perk while the photos themselves show for all.
--   * Nothing here touches rating math or review ordering.
--
-- Storage: project photos REUSE the existing PUBLIC `pro-logos` bucket (0033)
-- under <contractor_id>/projects/<uuid>.<ext>. The 0033 owner policies scope
-- writes to the contractor's own top-level folder, which already covers the
-- projects/ subfolder, so no new bucket and no new storage policies.
--
-- Safe to re-run.
-- =============================================================================

-- ---- tables -------------------------------------------------------------------
create table if not exists public.pro_projects (
  id            uuid primary key default gen_random_uuid(),
  contractor_id uuid not null references public.contractors(id) on delete cascade,
  title         text not null,
  category      text,
  description   text,
  months        text,
  sort          int not null default 0,
  created_at    timestamptz default now()
);

create table if not exists public.pro_project_photos (
  id         uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.pro_projects(id) on delete cascade,
  url        text not null,
  is_before  boolean not null default false,
  sort       int not null default 0,
  created_at timestamptz default now()
);

create index if not exists pro_projects_contractor_idx
  on public.pro_projects (contractor_id);
create index if not exists pro_project_photos_project_idx
  on public.pro_project_photos (project_id);

-- ---- RLS: owners only; the public reads through the RPC ------------------------
alter table public.pro_projects enable row level security;
alter table public.pro_project_photos enable row level security;

drop policy if exists "pro_projects owner all" on public.pro_projects;
create policy "pro_projects owner all" on public.pro_projects
  for all to authenticated
  using (
    contractor_id in
      (select id from public.contractors where user_id = auth.uid())
  )
  with check (
    contractor_id in
      (select id from public.contractors where user_id = auth.uid())
  );

drop policy if exists "pro_project_photos owner all" on public.pro_project_photos;
create policy "pro_project_photos owner all" on public.pro_project_photos
  for all to authenticated
  using (
    project_id in (
      select p.id
      from public.pro_projects p
      join public.contractors c on c.id = p.contractor_id
      where c.user_id = auth.uid()
    )
  )
  with check (
    project_id in (
      select p.id
      from public.pro_projects p
      join public.contractors c on c.id = p.contractor_id
      where c.user_id = auth.uid()
    )
  );

-- ---- public_pro_profile: 0043 body + 'projects' --------------------------------
-- Identical to 0043 (which is 0033 + 'slug') except for the one added
-- 'projects' key: up to 12 projects ordered by sort, each with its photos.
-- is_before collapses to false for non-members (m.live gate, exactly like
-- logo/about), so Before/After chips render publicly only for Pro members.
-- Rating math, review ordering, member gating: all byte-for-byte the same.
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
