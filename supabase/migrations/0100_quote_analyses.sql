-- =============================================================================
-- Hearth - persisted quote analyzer results (0098)
-- RUN THIS AGAINST THE LIVE DATABASE (Supabase SQL editor); editing repo SQL
-- alone does NOT change the already-deployed database.
--
-- WHY: the quote analyzer used to be pure client state (src/components/
-- QuoteAnalyzer.tsx): the result lived only in a useState and vanished the
-- moment the tab closed or the homeowner navigated away mid-analysis. This
-- table makes an analysis a real, durable record: /api/analyze-quote (POST)
-- writes a pending row before it starts the two-stage Gemini pipeline (see
-- src/lib/quoteAnalysis.ts), fills in the result and flips status to 'done'
-- or 'failed' once the pipeline finishes, and inserts an in-app notification
-- on success. The whole POST handler runs synchronously server-side from
-- auth through that final write, so the analysis completes and is saved even
-- if the homeowner leaves the page mid-request; a GET on the same route
-- reads back the latest row so QuoteAnalyzer can restore it on remount or
-- poll it while status is still 'pending'.
--
-- Server-write only, same shape as notifications (0023): a homeowner can read
-- their own rows, but only the service-role client (via createAdminClient)
-- ever inserts or updates one. No client insert/update policy at all.
--
-- findings holds the ENTIRE analysis object the UI renders (verdict, total,
-- summary, overall, line_items, red_flags, missing, negotiation), not just a
-- findings array, named to match the column the product spec asked for.
--
-- Idempotent: create table/index if not exists, drop-then-create policies.
-- Safe to re-run.
-- =============================================================================

create table if not exists public.quote_analyses (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references public.users (id) on delete cascade,
  status         text not null default 'pending'
                   check (status in ('pending', 'done', 'failed')),
  quote_filename text,
  findings       jsonb,
  error          text,
  created_at     timestamptz not null default now(),
  finished_at    timestamptz
);

create index if not exists quote_analyses_user_created_idx
  on public.quote_analyses (user_id, created_at desc);

alter table public.quote_analyses enable row level security;

drop policy if exists "quote_analyses owner read" on public.quote_analyses;
create policy "quote_analyses owner read" on public.quote_analyses
  for select
  using (user_id = auth.uid());

-- No insert/update policy: every row is written by /api/analyze-quote's
-- service-role client (createAdminClient), which bypasses RLS. A client that
-- only holds the anon/authenticated key can never create or edit a row,
-- including its own status or findings.

comment on column public.quote_analyses.status is
  'pending while the two-stage Gemini pipeline is running, done once '
  'findings are written, failed if either stage came back empty or over the '
  'rate limit (see error). Set exactly once from pending to a terminal '
  'state; never reverted.';
comment on column public.quote_analyses.findings is
  'The full Analysis object QuoteAnalyzer renders (verdict, total, summary, '
  'overall, line_items, red_flags, missing, negotiation), null while '
  'pending or failed.';
