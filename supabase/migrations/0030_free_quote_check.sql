-- =============================================================================
-- Hearth - first quote check free
-- RUN THIS AGAINST THE LIVE DATABASE (Supabase SQL editor).
--
-- Every homeowner gets exactly one free AI quote check as a taste of Hearth
-- Plus. Null means the credit is unused; the /api/analyze-quote route stamps
-- it (service-role client) after the first successful analysis. The existing
-- "users self select" RLS policy already covers reads.
--
-- Safe to re-run.
-- =============================================================================

alter table public.users
  add column if not exists free_quote_used_at timestamptz;
