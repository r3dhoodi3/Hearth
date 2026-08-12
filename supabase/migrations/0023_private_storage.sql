-- =============================================================================
-- Hearth - make the home-photos bucket PRIVATE (0021)
--
-- RUN THIS AGAINST THE LIVE DATABASE (Supabase Dashboard -> SQL Editor).
--
-- The bucket was public:true, which serves every object at a public URL and
-- BYPASSES the "owner read" RLS entirely - so home documents (inspection
-- reports, invoices, warranties) and photos were readable by anyone with the
-- URL. This makes it private; the app now serves images through an
-- authenticated proxy (/api/img) that signs a short-lived URL per request,
-- gated by the same RLS below.
--
-- It also fixes a latent bug: chat images are stored under `chat/<lead_id>/...`,
-- but the old policies cast the first path segment to uuid ('chat'::uuid), which
-- throws and breaks the whole storage query. We now cast safely (try_uuid) and
-- add explicit chat policies keyed on lead access.
--
-- Safe to re-run.
-- =============================================================================

-- Cast text->uuid without throwing on non-uuid segments (returns null instead),
-- so a policy evaluated against a chat/ path never errors the query.
create or replace function public.try_uuid(p text)
returns uuid language plpgsql immutable set search_path = public as $$
begin
  return p::uuid;
exception when others then
  return null;
end; $$;

-- Rebuild the object policies with safe casting.
drop policy if exists "home-photos owner read"   on storage.objects;
drop policy if exists "home-photos owner insert" on storage.objects;
drop policy if exists "home-photos owner delete" on storage.objects;
drop policy if exists "home-photos chat read"    on storage.objects;
drop policy if exists "home-photos chat insert"  on storage.objects;

-- Property-namespaced objects: <property_id>/...  (photos + docs)
create policy "home-photos owner read" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'home-photos'
    and public.owns_property(public.try_uuid((storage.foldername(name))[1]))
  );
create policy "home-photos owner insert" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'home-photos'
    and public.owns_property(public.try_uuid((storage.foldername(name))[1]))
  );
create policy "home-photos owner delete" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'home-photos'
    and public.owns_property(public.try_uuid((storage.foldername(name))[1]))
  );

-- Chat-namespaced objects: chat/<lead_id>/...  (either party on the lead)
create policy "home-photos chat read" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'home-photos'
    and (storage.foldername(name))[1] = 'chat'
    and public.can_access_lead(public.try_uuid((storage.foldername(name))[2]))
  );
create policy "home-photos chat insert" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'home-photos'
    and (storage.foldername(name))[1] = 'chat'
    and public.can_access_lead(public.try_uuid((storage.foldername(name))[2]))
  );

-- Flip the bucket private so the public URL no longer bypasses the policies.
update storage.buckets set public = false where id = 'home-photos';
