-- =============================================================================
-- Hearth - let a homeowner close a job that already has applicants (0092)
-- RUN THIS AGAINST THE LIVE DATABASE (Supabase SQL editor); editing repo SQL
-- alone does NOT change the already-deployed database.
--
-- WHY: closeJobAction (src/app/(app)/contractors/actions.ts) has always
-- refused to close a job once any pro applied ("pick one instead"), and
-- enforce_contractor_leads_locked() (0087) backs that refusal at the DB layer
-- too: a non-privileged UPDATE that flips status to 'closed'/'lost' on a lead
-- with a live (non-refunded) application is silently reverted (0087, rule d).
-- There was no escape hatch: a homeowner who no longer wants the job (hired
-- someone off-platform, changed their mind) was stuck with it sitting open
-- forever unless they picked an applicant they don't actually want.
--
-- FIX CONSIDERED AND REJECTED: a privileged RPC that force-sets status to
-- 'closed', the way choose_applicant sets 'accepted'. Rejected because
-- ghost_refund_application() (0028) - the ONLY refund path for a paid,
-- unpicked apply fee - requires the lead's status = 'new' AND contractor_id
-- is null (and so does the ghost-protection cron's own candidate pre-filter,
-- src/app/api/cron/ghost-protection/route.ts). Flipping status to 'closed'
-- would make every one of this job's applicants permanently unrefundable -
-- worse than today's stuck-open state, not better. contractor_leads.closed_at
-- (0088) is also out: it is trigger-owned and derived only from real status
-- transitions (and separately drives the 21-day referral-reward hold), so it
-- cannot be repurposed for this without corrupting that clock.
--
-- FIX SHIPPED: a plain, additive, non-privileged column the trigger never
-- looks at. status, contractor_id, paid and closed_at all stay untouched, so
-- ghost-protection keeps refunding these applicants on its normal 7-day
-- schedule exactly as it does today - this migration moves no money and adds
-- no new money logic. closeJobAction stamps owner_closed_at through the
-- ordinary owner-scoped RLS update (the same "contractor_leads owner all"
-- policy that already lets an owner touch any column the trigger doesn't
-- lock) and notifies the live applicants that the homeowner closed the job.
-- The contractors page hides the applicant/choose UI once this is set.
--
-- RESIDUAL (reported, not fixed): apply_to_lead() has no awareness of this
-- column, so a pro who has not yet applied can still apply (and pay) to a job
-- the homeowner already closed, up to the existing 3-applicant cap
-- (MAX_APPLICANTS_PER_JOB). Closing that gap means editing apply_to_lead's
-- money-charging body, which is out of scope for this UI-only fix. Flag for a
-- follow-up migration if it proves to matter in practice.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS. Safe to re-run.
-- =============================================================================

alter table public.contractor_leads
  add column if not exists owner_closed_at timestamptz;

comment on column public.contractor_leads.owner_closed_at is
  'Set by closeJobAction (src/app/(app)/contractors/actions.ts) when the '
  'homeowner closes a job that already has applicants, without choosing one. '
  'Plain client-writable column via RLS (no trigger involvement) - '
  'deliberately NOT status/closed_at, so it never interferes with '
  'ghost_refund_application''s status = ''new'' refund gate. UI-only signal: '
  'status stays ''new'', contractor_id stays null, applicants still refund '
  'on the normal 7-day ghost-protection schedule.';
