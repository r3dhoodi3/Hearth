-- =============================================================================
-- Hearth: pro CRM v2, contact fields and a notes timeline (0053)
--
-- Note on numbering: 0052 is reserved by another in flight migration. This one
-- is 0053, which leaves a gap. That is fine, migrations only need to apply in
-- order, not consecutively.
--
-- Extends the v1 client tracker (0049) with the fields a real pipeline needs:
-- phone, email, address, and an estimated deal value in cents, plus a proper
-- notes timeline (pro_client_notes) instead of a single note field.
--
-- PRIVACY RULE: phone, email, and address on pro_clients hold what the PRO
-- themselves types in about their own customer. The app must never auto copy
-- homeowner_email or homeowner_phone from contractor_leads into these columns.
-- The existing Track prefill only ever copies the visible display name
-- (homeowner_name, already shown on the pipeline), never contact info. This
-- mirrors the SECURITY CONSTRAINT already stated in 0049 for client_name and
-- note, and it still holds here.
--
-- Ownership and RLS shape for the new child table follow pro_project_photos
-- in 0045 exactly: the child has no contractor_id of its own, it is gated
-- through a join back to its parent (pro_clients) and from there to
-- contractors.user_id = auth.uid().
--
-- Safe to re-run.
-- =============================================================================

-- ---- pro_clients: additive contact and value columns -------------------------
alter table public.pro_clients
  add column if not exists phone text,
  add column if not exists email text,
  add column if not exists address text,
  add column if not exists est_value_cents bigint;

comment on column public.pro_clients.phone is
  'Typed in by the pro about their own customer. Never auto filled from contractor_leads.homeowner_phone.';
comment on column public.pro_clients.email is
  'Typed in by the pro about their own customer. Never auto filled from contractor_leads.homeowner_email.';
comment on column public.pro_clients.address is
  'Typed in by the pro about their own customer.';
comment on column public.pro_clients.est_value_cents is
  'Estimated deal value in cents, entered by the pro in dollars in the UI.';

-- ---- pro_client_notes: a timeline of notes per client ------------------------
create table if not exists public.pro_client_notes (
  id         uuid primary key default gen_random_uuid(),
  client_id  uuid not null references public.pro_clients(id) on delete cascade,
  body       text not null,
  created_at timestamptz not null default now()
);

comment on table public.pro_client_notes is
  'Append and delete notes timeline for a pro_clients row. No update: a note '
  'is either current or removed, never silently edited after the fact.';

create index if not exists pro_client_notes_client_idx
  on public.pro_client_notes (client_id);

-- ---- RLS: gated through the parent client, same shape as pro_project_photos --
alter table public.pro_client_notes enable row level security;

drop policy if exists "pro_client_notes owner all" on public.pro_client_notes;
create policy "pro_client_notes owner all" on public.pro_client_notes
  for all to authenticated
  using (
    client_id in (
      select c.id
      from public.pro_clients c
      join public.contractors k on k.id = c.contractor_id
      where k.user_id = auth.uid()
    )
  )
  with check (
    client_id in (
      select c.id
      from public.pro_clients c
      join public.contractors k on k.id = c.contractor_id
      where k.user_id = auth.uid()
    )
  );

-- Default deny plus the single owner scoped policy above. Notes are append
-- and delete only: authenticated gets select, insert, delete, but no update.
revoke all on public.pro_client_notes from public;
revoke all on public.pro_client_notes from anon;
revoke all on public.pro_client_notes from authenticated;
grant select, insert, delete on public.pro_client_notes to authenticated;
