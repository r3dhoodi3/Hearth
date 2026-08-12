-- =============================================================================
-- Hearth: pro tool style memory, so the AI back office learns a pro's voice (0063)
--
-- When a pro edits an AI back office draft (estimate, invoice, follow-up,
-- review response, or overdue reminder) before sending or copying it, the
-- original AI text and the pro's final edited text are both saved here. Only
-- real edits the pro actually made are ever stored: if the text they send or
-- copy is unchanged from the draft, nothing is written. /api/pro-tools reads
-- back a pro's most recent edits for a given tool as few-shot style guidance,
-- so future drafts for that tool are conditioned on how this pro actually
-- likes their paperwork worded.
--
-- Ownership follows the same shape as pro_past_jobs (0050): contractor_id
-- references contractors(id), and RLS routes through contractors.user_id =
-- auth.uid(), never auth.uid() directly, since a contractor's id and the
-- signed in user's id are different values.
--
-- NOTE FOR THE FOUNDER: this migration has not been applied to the live
-- database yet. Run it by hand the same way as the other pending migrations.
--
-- Safe to re-run.
-- =============================================================================

-- ---- pro_tool_edits: one row per real edit a pro made to a draft ------------
create table if not exists public.pro_tool_edits (
  id            uuid primary key default gen_random_uuid(),
  contractor_id uuid not null references public.contractors(id) on delete cascade,
  tool          text not null check (tool in ('estimate', 'invoice', 'followup', 'review_response', 'overdue')),
  original_text text not null,
  edited_text   text not null,
  created_at    timestamptz not null default now()
);

comment on table public.pro_tool_edits is
  'A pro''s real edits to AI back office drafts, kept so future drafts for the '
  'same tool can be conditioned on how this pro actually likes their '
  'paperwork worded. Only genuine edits are stored: if a pro sends or copies '
  'a draft unchanged, no row is written here.';

create index if not exists pro_tool_edits_contractor_tool_idx
  on public.pro_tool_edits (contractor_id, tool, created_at desc);

-- ---- RLS: owner only, same shape as pro_past_jobs (0050) --------------------
alter table public.pro_tool_edits enable row level security;

drop policy if exists "pro_tool_edits owner all" on public.pro_tool_edits;
create policy "pro_tool_edits owner all" on public.pro_tool_edits
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
-- authenticated access outside a pro's own rows. No update grant: an edit
-- record is a snapshot, not something that itself gets revised.
revoke all on public.pro_tool_edits from public;
revoke all on public.pro_tool_edits from anon;
revoke all on public.pro_tool_edits from authenticated;
grant select, insert on public.pro_tool_edits to authenticated;
