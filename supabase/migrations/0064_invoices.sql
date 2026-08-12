-- =============================================================================
-- Hearth: in-chat invoices (0062)
-- RUN THIS AGAINST THE LIVE DATABASE (Supabase SQL editor).
--
-- When a homeowner and contractor reach an agreement in their chat thread, the
-- CONTRACTOR can send an invoice into that thread, giving the platform a
-- record. This mirrors 0054_structured_quotes.sql closely on purpose (same
-- ownership shape, same RLS style, same "no deletes, one-way status" idea) so
-- the two features stay easy to reason about side by side:
--   contractor_id references contractors(id), gated through contractors.user_id
--   = auth.uid(), never auth.uid() directly. The homeowner side reuses the
--   same "do I own this lead" join through contractor_leads and
--   public.owns_property(property_id) that lead_quotes/messages use.
--
-- property_id is stored directly on the row (denormalized from the lead at
-- creation time, and locked down below so it can never be changed after
-- insert) purely for cheap "my invoices" lookups; it is NOT trusted for RLS -
-- every policy below re-derives access through lead_id -> contractor_leads,
-- the same as lead_quotes, so a forged property_id can't grant access (the
-- insert check also ties it to the lead's real property_id, so it can't even
-- be forged at insert time).
--
-- Status is a small one-way state machine, enforced by which policy allows
-- which transition rather than by a trigger:
--   sent -> signed  (homeowner only, on their own lead)
--   sent -> void    (contractor only, their own invoice)
-- No deletes for anyone. Signing here never touches money/payout logic - it
-- only flips this row's status and records who signed, when, and how.
--
-- Signing is intentionally lightweight (no PDF, no e-signature vendor): the
-- homeowner either types their name as an in-app acceptance, or the invoice
-- is marked as signed in person (e.g. a paper signature on site). Both are
-- honestly labelled by signature_method so nobody mistakes one for the other.
--
-- Safe to re-run.
-- =============================================================================

-- ---- invoices: one row per invoice a pro sends in a lead's chat thread ------
create table if not exists public.invoices (
  id               uuid primary key default gen_random_uuid(),
  lead_id          uuid not null references public.contractor_leads(id) on delete cascade,
  contractor_id    uuid not null references public.contractors(id) on delete cascade,
  property_id      uuid not null references public.properties(id) on delete cascade,
  line_items       jsonb not null default '[]',
  subtotal_cents   integer not null check (subtotal_cents > 0),
  total_cents      integer not null check (total_cents > 0),
  status           text not null default 'sent'
                     check (status in ('sent', 'signed', 'void')),
  signed_at        timestamptz,
  signed_by        text,
  signature_method text check (signature_method in ('in_app', 'in_person')),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  -- The three signature fields are all-or-nothing, and only ever set together
  -- with status = 'signed'. This is the database backstop for that shape; the
  -- update policies below are what actually enforce the sent -> signed move.
  constraint invoices_signature_consistent check (
    (status = 'signed') = (
      signed_at is not null and signed_by is not null and signature_method is not null
    )
  )
);

comment on table public.invoices is
  'An invoice a pro sends inside a lead''s chat thread once an agreement is '
  'reached: line_items is an array of {description, amount_cents}, '
  'total_cents is the single source of truth for the amount (summed once, in '
  'the server action, never recomputed from the line items elsewhere; '
  'subtotal_cents is kept alongside it for a future discount/tax line and '
  'today always equals total_cents). A companion plain row is also posted to '
  'public.messages so unread badges/notifiers need no changes.';

comment on column public.invoices.property_id is
  'Denormalized from contractor_leads.property_id at insert time for cheap '
  'lookups. Never used by RLS (every policy re-derives access through '
  'lead_id) and never updatable after insert (no column grant for it).';

create index if not exists invoices_lead_idx
  on public.invoices (lead_id, created_at);
create index if not exists invoices_contractor_idx
  on public.invoices (contractor_id);
create index if not exists invoices_property_idx
  on public.invoices (property_id);

-- ---- RLS ----------------------------------------------------------------------
alter table public.invoices enable row level security;

-- Contractor side: the owning contractor (contractors.user_id = auth.uid())
-- can see and send invoices on their own leads.
drop policy if exists "invoices contractor select" on public.invoices;
create policy "invoices contractor select" on public.invoices
  for select to authenticated
  using (
    contractor_id in
      (select id from public.contractors where user_id = auth.uid())
  );

-- with check ties lead_id to a lead this contractor actually owns, and ties
-- property_id to that SAME lead's real property_id, so neither can be forged
-- to attach an invoice to someone else's job.
drop policy if exists "invoices contractor insert" on public.invoices;
create policy "invoices contractor insert" on public.invoices
  for insert to authenticated
  with check (
    contractor_id in
      (select id from public.contractors where user_id = auth.uid())
    and lead_id in (
      select id from public.contractor_leads
      where contractor_id = invoices.contractor_id
    )
    and property_id in (
      select property_id from public.contractor_leads
      where id = invoices.lead_id
    )
  );

-- Contractor can void only their own invoice, and only while it is still
-- 'sent' (using = the row as it stands before the update, so a signed
-- invoice can never be voided); the with check confines the new row to
-- exactly 'void', nothing else.
drop policy if exists "invoices contractor void" on public.invoices;
create policy "invoices contractor void" on public.invoices
  for update to authenticated
  using (
    contractor_id in
      (select id from public.contractors where user_id = auth.uid())
    and status = 'sent'
  )
  with check (
    contractor_id in
      (select id from public.contractors where user_id = auth.uid())
    and status = 'void'
  );

-- Homeowner side: same "do I own this lead" shape as lead_quotes/messages
-- (0054/0007), through contractor_leads.property_id and owns_property().
drop policy if exists "invoices homeowner select" on public.invoices;
create policy "invoices homeowner select" on public.invoices
  for select to authenticated
  using (
    lead_id in (
      select l.id from public.contractor_leads l
      where public.owns_property(l.property_id)
    )
  );

-- Homeowner can sign a 'sent' invoice on their own lead, nothing else: the
-- using clause pins the starting status to 'sent', the with check pins the
-- ending status to 'signed' plus all three signature fields actually set
-- (belt-and-suspenders alongside invoices_signature_consistent above).
drop policy if exists "invoices homeowner sign" on public.invoices;
create policy "invoices homeowner sign" on public.invoices
  for update to authenticated
  using (
    status = 'sent'
    and lead_id in (
      select l.id from public.contractor_leads l
      where public.owns_property(l.property_id)
    )
  )
  with check (
    status = 'signed'
    and signature_method in ('in_app', 'in_person')
    and signed_by is not null
    and signed_at is not null
    and lead_id in (
      select l.id from public.contractor_leads l
      where public.owns_property(l.property_id)
    )
  );

-- Default deny plus the policies above: no anon access, no authenticated
-- access outside the two roles' own scoped rows. No delete for anyone.
-- Update is granted on status/signed_at/signed_by/signature_method/updated_at
-- ONLY: the update policies pin the allowed status transitions, and this
-- column grant is what stops either side from rewriting total_cents,
-- line_items, or property_id on an existing invoice, since the policies
-- alone cannot compare old and new column values.
revoke all on public.invoices from public;
revoke all on public.invoices from anon;
revoke all on public.invoices from authenticated;
grant select, insert on public.invoices to authenticated;
grant update (status, signed_at, signed_by, signature_method, updated_at)
  on public.invoices to authenticated;
