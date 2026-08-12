-- =============================================================================
-- Hearth: structured quotes in chat (0054)
--
-- Note on numbering: 0052 is an intentional gap (never existed), so this one
-- follows 0053. That is fine, migrations only need to apply in order, not
-- consecutively.
--
-- Today a "quote" is only ever a regex guess (src/lib/quotes.ts extractQuote)
-- run against free text chat messages. This adds a real table so a pro can
-- compose a quote (line items + total + note) and send it as its own row,
-- while a plain companion message is still posted alongside it (see the
-- sendQuoteAction server action) so every existing unread badge, notifier,
-- and the applicant-nudge cron keep working untouched, no schema change
-- needed there.
--
-- Ownership follows the same shape as pro_projects/pro_clients (0045/0049):
-- contractor_id references contractors(id), gated through contractors.user_id
-- = auth.uid(), never auth.uid() directly. The homeowner side reuses the
-- exact "do I own this lead" pattern from can_access_lead() (0007): join
-- through contractor_leads and public.owns_property(property_id).
--
-- Status is a small one-way state machine, enforced by which policy allows
-- which transition rather than by a trigger:
--   sent -> accepted   (homeowner only)
--   sent -> declined   (homeowner only)
--   sent -> withdrawn  (contractor only, their own quote)
-- No deletes for anyone. Accepting a quote here NEVER calls choose_applicant
-- or touches money in any way, it only flips this row's status.
--
-- Safe to re-run.
-- =============================================================================

-- ---- lead_quotes: one row per quote a pro sends in a lead's chat thread ------
create table if not exists public.lead_quotes (
  id            uuid primary key default gen_random_uuid(),
  lead_id       uuid not null references public.contractor_leads(id) on delete cascade,
  contractor_id uuid not null references public.contractors(id) on delete cascade,
  total_cents   integer not null check (total_cents > 0),
  line_items    jsonb not null default '[]',
  note          text,
  status        text not null default 'sent'
                  check (status in ('sent', 'accepted', 'declined', 'withdrawn')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on table public.lead_quotes is
  'A structured quote a pro composes and sends inside a lead''s chat thread: '
  'line_items is an array of {label, amount_cents}, total_cents is the single '
  'source of truth for the amount (summed once, in the server action, never '
  'recomputed from the line items elsewhere). A companion plain row is also '
  'posted to public.messages so unread badges/notifiers/cron need no changes.';

create index if not exists lead_quotes_lead_idx
  on public.lead_quotes (lead_id, created_at);
create index if not exists lead_quotes_contractor_idx
  on public.lead_quotes (contractor_id);

-- ---- RLS ----------------------------------------------------------------------
alter table public.lead_quotes enable row level security;

-- Contractor side: the owning contractor (contractors.user_id = auth.uid())
-- can see and send quotes on their own leads.
drop policy if exists "lead_quotes contractor select" on public.lead_quotes;
create policy "lead_quotes contractor select" on public.lead_quotes
  for select to authenticated
  using (
    contractor_id in
      (select id from public.contractors where user_id = auth.uid())
  );

drop policy if exists "lead_quotes contractor insert" on public.lead_quotes;
create policy "lead_quotes contractor insert" on public.lead_quotes
  for insert to authenticated
  with check (
    contractor_id in
      (select id from public.contractors where user_id = auth.uid())
    and lead_id in (
      select id from public.contractor_leads
      where contractor_id = lead_quotes.contractor_id
    )
  );

-- Contractor can withdraw only their own quote, and only while it is still
-- 'sent' (using = the row as it stands before the update); the with check
-- confines the new row to exactly 'withdrawn', nothing else.
drop policy if exists "lead_quotes contractor withdraw" on public.lead_quotes;
create policy "lead_quotes contractor withdraw" on public.lead_quotes
  for update to authenticated
  using (
    contractor_id in
      (select id from public.contractors where user_id = auth.uid())
    and status = 'sent'
  )
  with check (
    contractor_id in
      (select id from public.contractors where user_id = auth.uid())
    and status = 'withdrawn'
  );

-- Homeowner side: same "do I own this lead" shape as messages/lead_reads
-- (0007/0009), through contractor_leads.property_id and owns_property().
drop policy if exists "lead_quotes homeowner select" on public.lead_quotes;
create policy "lead_quotes homeowner select" on public.lead_quotes
  for select to authenticated
  using (
    lead_id in (
      select l.id from public.contractor_leads l
      where public.owns_property(l.property_id)
    )
  );

-- Homeowner can accept or decline a 'sent' quote on their own lead, nothing
-- else: the using clause pins the starting status to 'sent', the with check
-- pins the ending status to one of the two allowed outcomes.
drop policy if exists "lead_quotes homeowner respond" on public.lead_quotes;
create policy "lead_quotes homeowner respond" on public.lead_quotes
  for update to authenticated
  using (
    status = 'sent'
    and lead_id in (
      select l.id from public.contractor_leads l
      where public.owns_property(l.property_id)
    )
  )
  with check (
    status in ('accepted', 'declined')
    and lead_id in (
      select l.id from public.contractor_leads l
      where public.owns_property(l.property_id)
    )
  );

-- Default deny plus the policies above: no anon access, no authenticated
-- access outside the two roles' own scoped rows. No delete for anyone.
-- Update is granted on status/updated_at ONLY: the update policies pin the
-- allowed status transitions, and this column grant is what stops either
-- side from rewriting total_cents/line_items/note on an existing quote,
-- since the policies alone cannot compare old and new column values.
revoke all on public.lead_quotes from public;
revoke all on public.lead_quotes from anon;
revoke all on public.lead_quotes from authenticated;
grant select, insert on public.lead_quotes to authenticated;
grant update (status, updated_at) on public.lead_quotes to authenticated;
