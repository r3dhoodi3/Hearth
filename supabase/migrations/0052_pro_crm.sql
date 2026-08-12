-- =============================================================================
-- Hearth: basic pro CRM (0049)
--
-- A simple client tracker for pros: one row per client the pro is keeping tabs
-- on, with a stage, a note, and an optional follow up date. This is v1, kept
-- deliberately small.
--
-- Ownership follows the same shape as pro_projects (0045): contractor_id
-- references contractors(id), and RLS routes through contractors.user_id =
-- auth.uid(), never auth.uid() directly, since a contractor's id and the
-- signed in user's id are different values.
--
-- SECURITY CONSTRAINT: this table stores only what the pro themselves types
-- in, client_name and note. It links to contractor_leads through lead_id so a
-- row can point back at a conversation, but it never stores or joins to
-- homeowner_email or homeowner_phone. Those stay redacted or revealed exactly
-- as they already are on contractor_leads and the chat thread, this table
-- changes none of that. See src/lib/redact.ts for the existing redaction of
-- unchosen applications.
--
-- Safe to re-run.
-- =============================================================================

-- ---- pro_clients: one row per client a pro is tracking ----------------------
create table if not exists public.pro_clients (
  id            uuid primary key default gen_random_uuid(),
  contractor_id uuid not null references public.contractors(id) on delete cascade,
  lead_id       uuid references public.contractor_leads(id) on delete set null,
  client_name   text not null,
  stage         text not null default 'lead' check (stage in ('lead', 'quoted', 'won', 'lost')),
  note          text,
  follow_up_on  date,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on table public.pro_clients is
  'A pro''s own client tracker. client_name and note are typed in by the pro, '
  'lead_id only links back to a lead/chat the pro can already access under '
  'existing RLS. Never joins to homeowner_email or homeowner_phone.';

create index if not exists pro_clients_contractor_idx
  on public.pro_clients (contractor_id);
create index if not exists pro_clients_lead_idx
  on public.pro_clients (lead_id);

-- ---- RLS: owner only, same shape as pro_projects (0045) ----------------------
alter table public.pro_clients enable row level security;

drop policy if exists "pro_clients owner all" on public.pro_clients;
create policy "pro_clients owner all" on public.pro_clients
  for all to authenticated
  using (
    contractor_id in
      (select id from public.contractors where user_id = auth.uid())
  )
  with check (
    contractor_id in
      (select id from public.contractors where user_id = auth.uid())
  );

-- Default deny plus the single owner scoped policy above: no anon access, no
-- authenticated access outside a pro's own rows.
revoke all on public.pro_clients from public;
revoke all on public.pro_clients from anon;
revoke all on public.pro_clients from authenticated;
grant select, insert, update, delete on public.pro_clients to authenticated;
