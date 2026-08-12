-- =============================================================================
-- Hearth: household sharing (0048)
--
-- Lets a homeowner invite up to a few other people to share day to day access
-- to one home. An invited person is identified by email until they claim the
-- invite with their own Hearth account, at which point they become an active
-- member of that property.
--
-- Trust model: an active member gets the same day to day access as the owner
-- through owns_property(), which every child table policy already routes
-- through (home_systems, maintenance_tasks, issues, photos, improvements,
-- contractor_leads, intent_signals, documents, messages, and storage). The
-- properties row itself stays owner only for writes: members can read it
-- through the new member select policy below, but insert, update, and delete
-- on properties remain gated to user_id = auth.uid() from 0002, so a member
-- can never edit the home's details, delete the home, or invite anyone else.
--
-- Safe to re-run.
-- =============================================================================

-- ---- household_members: one row per invite or membership --------------------
create table if not exists public.household_members (
  id              uuid primary key default gen_random_uuid(),
  property_id     uuid not null references public.properties(id) on delete cascade,
  invited_email   text not null check (position('@' in invited_email) > 1),
  member_user_id  uuid references auth.users(id) on delete cascade,
  status          text not null default 'invited' check (status in ('invited', 'active')),
  invited_by      uuid not null references auth.users(id) on delete cascade,
  created_at      timestamptz not null default now(),
  accepted_at     timestamptz
);

comment on table public.household_members is
  'An invite (status invited, member_user_id null) or an accepted membership '
  '(status active, member_user_id set) granting one person shared access to '
  'one property. invited_email should always be stored lowercased.';

-- One invite per email per property, case insensitive, so the same address
-- cannot be invited twice or re-invited while an existing row is pending.
create unique index if not exists household_members_property_email_key
  on public.household_members (property_id, lower(invited_email));

alter table public.household_members enable row level security;

-- ---- owner: manage invites and members on a home they own -------------------
drop policy if exists "household_members owner select" on public.household_members;
create policy "household_members owner select" on public.household_members
  for select using (
    exists (
      select 1 from public.properties p
      where p.id = property_id and p.user_id = auth.uid()
    )
  );

-- An owner can only ever create a PENDING invite. Pinning status and
-- member_user_id here means nobody can be attached to a home as an active
-- member without going through the claim step themselves, even via a raw
-- PostgREST insert.
drop policy if exists "household_members owner insert" on public.household_members;
create policy "household_members owner insert" on public.household_members
  for insert with check (
    invited_by = auth.uid()
    and status = 'invited'
    and member_user_id is null
    and exists (
      select 1 from public.properties p
      where p.id = property_id and p.user_id = auth.uid()
    )
  );

drop policy if exists "household_members owner delete" on public.household_members;
create policy "household_members owner delete" on public.household_members
  for delete using (
    exists (
      select 1 from public.properties p
      where p.id = property_id and p.user_id = auth.uid()
    )
  );

-- ---- invitee: see and act on invites addressed to me -------------------------
drop policy if exists "household_members invitee select" on public.household_members;
create policy "household_members invitee select" on public.household_members
  for select using (
    lower(invited_email) = lower(coalesce(auth.jwt() ->> 'email', ''))
    or member_user_id = auth.uid()
  );

-- Claim: an invitee can turn their own pending invite into an active
-- membership, but only into that exact shape, they cannot edit any other
-- column or claim someone else's invite.
drop policy if exists "household_members invitee claim" on public.household_members;
create policy "household_members invitee claim" on public.household_members
  for update
  using (
    status = 'invited'
    and member_user_id is null
    and lower(invited_email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  )
  with check (
    status = 'active'
    and member_user_id = auth.uid()
  );

-- Decline: an invitee can refuse a pending invite before claiming it.
drop policy if exists "household_members invitee decline" on public.household_members;
create policy "household_members invitee decline" on public.household_members
  for delete using (
    status = 'invited'
    and lower(invited_email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );

-- ---- member: leave a home once active ----------------------------------------
drop policy if exists "household_members member leave" on public.household_members;
create policy "household_members member leave" on public.household_members
  for delete using (member_user_id = auth.uid());

-- Column level lockdown: the only client side write path that should ever
-- touch an existing row is the invitee claim above, and it only needs to
-- move status, member_user_id, and accepted_at. Select, insert, and delete
-- stay row gated by the policies above; update is narrowed to those columns
-- so a client cannot rewrite property_id, invited_email, or invited_by.
revoke all on public.household_members from public;
revoke all on public.household_members from anon;
revoke all on public.household_members from authenticated;
grant select, insert, delete on public.household_members to authenticated;
grant update (status, member_user_id, accepted_at) on public.household_members to authenticated;

-- ---- is_active_member: helper so properties RLS does not re-enter this table -
-- properties needs to know if the caller is an active member of a given
-- property. Calling that check directly from the properties policy would
-- otherwise require the properties policy to read household_members, and
-- household_members' own policies read properties, so this is factored into
-- a security definer function to keep the two tables' RLS from recursing
-- into each other.
create or replace function public.is_active_member(p_property_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.household_members hm
    where hm.property_id = p_property_id
      and hm.member_user_id = auth.uid()
      and hm.status = 'active'
  );
$$;

revoke all on function public.is_active_member(uuid) from public;
revoke all on function public.is_active_member(uuid) from anon;
revoke all on function public.is_active_member(uuid) from authenticated;
grant execute on function public.is_active_member(uuid) to authenticated;

-- ---- properties: add member read access, writes stay owner only -------------
-- This is a SELECT only addition. properties owner insert/update/delete from
-- 0002 are untouched on purpose, so a member can see the home but can never
-- edit its details, delete it, or transfer it to someone else.
drop policy if exists "properties member select" on public.properties;
create policy "properties member select" on public.properties
  for select using (public.is_active_member(id));

-- ---- owns_property: the single choke point child tables gate through --------
-- This is the key change. Every table that guards its rows with
-- owns_property(property_id) (home_systems, maintenance_tasks, issues,
-- photos, improvements, contractor_leads, intent_signals, documents,
-- messages, and the matching storage policies) now also opens up to an
-- active household member, with no changes needed to those other policies.
-- The body stays one flat SQL statement with an OR between the owner check
-- and the member check (rather than calling is_active_member) so this stays
-- a single self-contained definition at the one place all of those tables
-- already depend on.
create or replace function public.owns_property(p_property_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.properties p
    where p.id = p_property_id and p.user_id = auth.uid()
  )
  or exists (
    select 1 from public.household_members hm
    where hm.property_id = p_property_id
      and hm.member_user_id = auth.uid()
      and hm.status = 'active'
  );
$$;

revoke all on function public.owns_property(uuid) from public;
revoke all on function public.owns_property(uuid) from anon;
revoke all on function public.owns_property(uuid) from authenticated;
grant execute on function public.owns_property(uuid) to authenticated;
