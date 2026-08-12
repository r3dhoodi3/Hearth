-- =============================================================================
-- Hearth - pro public page + license/insurance vault (0033)
-- RUN THIS AGAINST THE LIVE DATABASE (Supabase SQL editor).
--
-- Every pro gets a shareable public page at /p/<contractor_id>: business name,
-- categories, and their real rating + reviews, readable with NO account. Pro
-- MEMBERS additionally get a logo, an about section, and a "license and
-- insurance on file" badge once they save those details into the vault columns
-- below. Membership never touches rating math or review ordering: the numbers
-- come from the same reviews/rating columns 0016-0018 maintain, member or not.
--
-- The vault fields (license/insurance details) are PRIVATE. The public read
-- path is public_pro_profile(), a SECURITY DEFINER function that exposes only
-- safe fields and reduces the vault to has_license / has_insurance booleans.
-- Contact info stays gated exactly as before (0012/0019): it is never selected
-- here, so the public page can't leak an email or phone number.
--
-- Also creates a small PUBLIC storage bucket for logos ("pro-logos"): a logo
-- is public-page content by definition, unlike home-photos (0021), which
-- stays private. Pros may write only under their own company's folder.
--
-- Safe to re-run.
-- =============================================================================

-- ---- vault + member page columns --------------------------------------------
alter table public.contractors
  add column if not exists logo_url                     text,
  add column if not exists about                        text,
  add column if not exists license_number               text,
  add column if not exists license_state                text,
  add column if not exists insurance_carrier            text,
  add column if not exists insurance_expires            date,
  add column if not exists license_insurance_updated_at timestamptz;

-- ---- public profile read -----------------------------------------------------
-- One JSON payload per contractor with ONLY safe public fields. Raw license /
-- insurance values never leave the database: they collapse to booleans. The
-- member extras (logo, about, badge booleans) null out when the linked user has
-- no live pro_ subscription, so a lapsed membership quietly reverts the page to
-- its basic form. Rating + reviews are returned for EVERYONE, straight from the
-- 0016 aggregate and in the same order/limit as contractor_reviews (0018).
create or replace function public.public_pro_profile(p_contractor uuid)
returns jsonb
language sql
security definer
stable
set search_path = public
as $$
  select jsonb_build_object(
    'id',           c.id,
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

-- The page is public by design, so anon may call it. Postgres already grants
-- EXECUTE to PUBLIC on new functions; make the intent explicit anyway.
grant execute on function public.public_pro_profile(uuid) to anon;
grant execute on function public.public_pro_profile(uuid) to authenticated;

-- ---- logo storage ------------------------------------------------------------
-- Public bucket: logos are served straight off their public URL on an
-- unauthenticated page. Objects are namespaced by contractor id:
--   pro-logos/<contractor_id>/<uuid>.<ext>
insert into storage.buckets (id, name, public)
values ('pro-logos', 'pro-logos', true)
on conflict (id) do nothing;

-- Safe text->uuid cast (also shipped in 0021; repeated here so this migration
-- stands alone if 0021 hasn't been applied yet).
create or replace function public.try_uuid(p text)
returns uuid language plpgsql immutable set search_path = public as $$
begin
  return p::uuid;
exception when others then
  return null;
end; $$;

-- A pro may write only under the folder of a company they own.
drop policy if exists "pro-logos owner insert" on storage.objects;
drop policy if exists "pro-logos owner update" on storage.objects;
drop policy if exists "pro-logos owner delete" on storage.objects;

create policy "pro-logos owner insert" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'pro-logos'
    and public.try_uuid((storage.foldername(name))[1]) in
      (select id from public.contractors where user_id = auth.uid())
  );
create policy "pro-logos owner update" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'pro-logos'
    and public.try_uuid((storage.foldername(name))[1]) in
      (select id from public.contractors where user_id = auth.uid())
  );
create policy "pro-logos owner delete" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'pro-logos'
    and public.try_uuid((storage.foldername(name))[1]) in
      (select id from public.contractors where user_id = auth.uid())
  );
