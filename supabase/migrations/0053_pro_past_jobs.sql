-- =============================================================================
-- Hearth: pro past jobs, for smarter estimates (0050)
--
-- A pro uploads a photo or PDF of one of their OWN past invoices or quotes.
-- Vision extraction reads off the line items and totals so the AI back office
-- can ground future estimates in the pro's real pricing history instead of a
-- guess. This is extract once, delete and reupload to fix: there is no update
-- path, only insert and delete.
--
-- PRIVACY RULE: this table stores the pro's own pricing history, never the
-- customer's identity. Customer names, street addresses, emails, and phone
-- numbers that appear on the source document are never extracted or stored
-- here, by the extraction route or by this schema. location is city and state
-- only, never a street address.
--
-- Ownership follows the same shape as pro_clients (0049): contractor_id
-- references contractors(id), and RLS routes through contractors.user_id =
-- auth.uid(), never auth.uid() directly, since a contractor's id and the
-- signed in user's id are different values.
--
-- Safe to re-run.
-- =============================================================================

-- ---- pro_past_jobs: one row per past invoice/quote a pro has uploaded -------
create table if not exists public.pro_past_jobs (
  id            uuid primary key default gen_random_uuid(),
  contractor_id uuid not null references public.contractors(id) on delete cascade,
  doc_type      text not null default 'invoice' check (doc_type in ('invoice', 'quote', 'estimate', 'receipt', 'other')),
  job_type      text,
  job_summary   text,
  document_date date,
  location      text,
  line_items    jsonb not null default '[]',
  subtotal      text,
  total         text,
  currency      text default 'USD',
  created_at    timestamptz not null default now()
);

comment on table public.pro_past_jobs is
  'A pro''s own pricing history, read off past invoices and quotes they upload. '
  'Customer names, street addresses, emails, and phone numbers from the source '
  'document are never extracted or stored: location is city and state only. '
  'Rows are extract once: no update grant, delete and reupload to fix a row.';

comment on column public.pro_past_jobs.location is
  'City and state only, never a street address.';

comment on column public.pro_past_jobs.line_items is
  'Array of {label, category, quantity, unit_price, line_total}. All monetary '
  'values are kept as strings exactly as printed on the source document.';

create index if not exists pro_past_jobs_contractor_idx
  on public.pro_past_jobs (contractor_id);

-- ---- RLS: owner only, same shape as pro_clients (0049) ----------------------
alter table public.pro_past_jobs enable row level security;

drop policy if exists "pro_past_jobs owner all" on public.pro_past_jobs;
create policy "pro_past_jobs owner all" on public.pro_past_jobs
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
-- authenticated access outside a pro's own rows. No update grant: a row is
-- extract once, the pro deletes and reuploads to fix it.
revoke all on public.pro_past_jobs from public;
revoke all on public.pro_past_jobs from anon;
revoke all on public.pro_past_jobs from authenticated;
grant select, insert, delete on public.pro_past_jobs to authenticated;
