-- Terms-of-service acceptance ledger + SMS consent flag (0073). RUN AGAINST LIVE DB.
--
-- terms_acceptances is an append-only audit trail: every time a user checks
-- the "I agree" box on a signup/consent flow we record one row here (see
-- src/app/(auth)/recordTermsAcceptance.ts). No update/delete policy on
-- purpose - a consent record that could be silently edited or removed after
-- the fact is worthless as evidence of acceptance.
--
-- user_id references public.users(id), not auth.users(id): the app-facing
-- identity table (0001_initial_schema.sql), same as every other user-owned
-- table in this schema.
create table if not exists public.terms_acceptances (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.users (id) on delete cascade,
  doc          text not null,
  version      text not null,
  accepted_at  timestamptz not null default now(),
  ip           text,
  user_agent   text
);

create index if not exists terms_acceptances_user_id_idx
  on public.terms_acceptances (user_id);

alter table public.terms_acceptances enable row level security;

drop policy if exists "terms_acceptances read own" on public.terms_acceptances;
create policy "terms_acceptances read own" on public.terms_acceptances
  for select to authenticated using (auth.uid() = user_id);

drop policy if exists "terms_acceptances insert own" on public.terms_acceptances;
create policy "terms_acceptances insert own" on public.terms_acceptances
  for insert to authenticated with check (auth.uid() = user_id);

-- No update/delete policy: acceptances are append-only. The admin client used
-- by recordTermsAcceptance() bypasses RLS anyway, but the policy is still the
-- documented contract for any authenticated-role access.

-- SMS consent (TCPA): tracked separately from terms acceptance since it's an
-- opt-in, not a contract term, and needs its own timestamp for proof of consent.
alter table public.users
  add column if not exists sms_consent boolean not null default false,
  add column if not exists sms_consent_at timestamptz;
