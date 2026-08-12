-- =============================================================================
-- Hearth: pro compliance calendar (0051)
-- RUN THIS AGAINST THE LIVE DATABASE (Supabase SQL editor).
--
-- Pros upload their contractor license and certificate of insurance once.
-- Hearth reads the expiration date off the document and reminds the pro
-- before anything lapses. This migration adds the columns that track the
-- license side (insurance_expires already exists from migration 0033) and a
-- new PRIVATE storage bucket, pro-docs, to hold the uploaded files.
--
-- These documents are private business records: they are served only to
-- their owner, through an authenticated proxy, never publicly. Reading a
-- date off a document is not verification. license_verified_status (0037)
-- is untouched by this migration and still governs what the app may claim.
--
-- No new RLS needed on contractors: existing row policies already cover the
-- new columns.
--
-- Safe to re-run.
-- =============================================================================

-- ---- license/document columns -------------------------------------------------
alter table public.contractors
  add column if not exists license_expires    date,
  add column if not exists license_doc_path    text,
  add column if not exists insurance_doc_path  text;

comment on column public.contractors.license_expires is
  'Expiration date read off the uploaded contractor license, or entered manually when the document could not be read. Null if no license is on file.';
comment on column public.contractors.license_doc_path is
  'Storage object path (pro-docs bucket) of the uploaded contractor license. Null if none uploaded.';
comment on column public.contractors.insurance_doc_path is
  'Storage object path (pro-docs bucket) of the uploaded certificate of insurance. Null if none uploaded.';

-- ---- pro-docs storage bucket ---------------------------------------------------
-- Private bucket for the license and COI uploads, namespaced by contractor:
--   pro-docs/<contractor_id>/license.<ext>
--   pro-docs/<contractor_id>/insurance.<ext>
-- Unlike pro-logos (0033, public by design), these are private business
-- records and stay behind RLS: only the owning contractor's user may read or
-- write their folder, and the app serves them back through an authenticated
-- proxy that signs a short-lived URL per request, never a public URL.
insert into storage.buckets (id, name, public)
values ('pro-docs', 'pro-docs', false)
on conflict (id) do nothing;

-- Safe text->uuid cast (also shipped in 0021/0033; repeated here so this
-- migration stands alone if the earlier ones haven't run yet).
create or replace function public.try_uuid(p text)
returns uuid language plpgsql immutable set search_path = public as $$
begin
  return p::uuid;
exception when others then
  return null;
end; $$;

drop policy if exists "pro-docs owner select" on storage.objects;
drop policy if exists "pro-docs owner insert" on storage.objects;
drop policy if exists "pro-docs owner update" on storage.objects;
drop policy if exists "pro-docs owner delete" on storage.objects;

create policy "pro-docs owner select" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'pro-docs'
    and public.try_uuid((storage.foldername(name))[1]) in
      (select id from public.contractors where user_id = auth.uid())
  );
create policy "pro-docs owner insert" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'pro-docs'
    and public.try_uuid((storage.foldername(name))[1]) in
      (select id from public.contractors where user_id = auth.uid())
  );
create policy "pro-docs owner update" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'pro-docs'
    and public.try_uuid((storage.foldername(name))[1]) in
      (select id from public.contractors where user_id = auth.uid())
  );
create policy "pro-docs owner delete" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'pro-docs'
    and public.try_uuid((storage.foldername(name))[1]) in
      (select id from public.contractors where user_id = auth.uid())
  );
