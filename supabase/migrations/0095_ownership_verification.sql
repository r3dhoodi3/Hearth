-- =============================================================================
-- Hearth - property ownership verification (0093)
-- RUN THIS AGAINST THE LIVE DATABASE (Supabase SQL editor); editing repo SQL
-- alone does NOT change the already-deployed database.
--
-- WHY: onboarding already pulls RentCast's county-assessor record for every
-- claimed address (src/lib/parcel.ts), and that record includes the county's
-- recorded owner name(s) and owner type. We now keep that data and fuzzy-
-- match it against the account holder's own name (src/lib/ownershipMatch.ts)
-- to produce a soft trust signal: ownership_status. It gates only the
-- email/SMS fan-out on a new job posting (src/lib/proAlerts.ts) - never the
-- job post itself, and never signup - because assessor data lags sales and
-- misses trusts, spouses, and married names. A mismatch just stays
-- "unverified", quietly, not blocked.
--
-- HONEST LIMIT: the match input on our side is the name the user typed at
-- sign-up, which is self-reported. County assessor owner names are public
-- record, so a motivated user can look up the recorded owner and type that
-- name in to get "verified" on a home that is not theirs. "Verified" here
-- raises the bar against casual misuse and bulk/scripted abuse of the
-- email/SMS fan-out - it is not proof of ownership and must never be
-- treated as one. A real proof-of-ownership flow (e.g. a mailed postcard
-- code, a utility bill upload, or a document-verification vendor) is the
-- future upgrade path if a harder guarantee is ever needed.
--
-- These columns are SERVER-COMPUTED - the client cannot set the RESULT
-- directly, even though the underlying name input is user-supplied (see
-- HONEST LIMIT above) - so unlike most of properties' columns they must
-- not be client-writable: properties RLS (0002) is row-scoped only with no
-- column restrictions on any of the four verbs, so today any signed-in
-- owner could PATCH these directly via PostgREST. The legacy
-- `ownership_verified` boolean (0001) was always
-- self-attested at claim time ("Self-attestation for MVP" - see
-- src/app/onboarding/actions.ts) and is exactly as forgeable, so it is
-- locked here too alongside the new columns - nothing ownership-related is
-- left client-writable. Same column-lock TRIGGER pattern as
-- enforce_contractor_leads_locked() (0087): a session-local
-- hearth.ownership_write flag, set only by the SECURITY DEFINER RPC below,
-- gates every write to these columns. NOT the 0083 grant-allowlist pattern -
-- properties has many legitimate app writers (onboarding, the value page,
-- the tax page, systems), and a wrong allowlist there would break real
-- saves.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, a guarded DO block for the check
-- constraint, CREATE OR REPLACE for functions, DROP TRIGGER IF EXISTS +
-- CREATE for the trigger. Safe to re-run.
-- =============================================================================

alter table public.properties
  add column if not exists ownership_status text not null default 'unverified';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'properties_ownership_status_check'
      and conrelid = 'public.properties'::regclass
  ) then
    alter table public.properties
      add constraint properties_ownership_status_check
      check (ownership_status in ('verified', 'unverified'));
  end if;
end $$;

alter table public.properties
  add column if not exists ownership_owner_names jsonb;
alter table public.properties
  add column if not exists ownership_owner_type text;
alter table public.properties
  add column if not exists ownership_owner_occupied boolean;
alter table public.properties
  add column if not exists ownership_checked_at timestamptz;

comment on column public.properties.ownership_status is
  'verified/unverified: whether the account holder''s name matched the '
  'county assessor''s recorded owner name(s), per src/lib/ownershipMatch.ts. '
  'Server-verified only - see enforce_properties_ownership_locked() below. '
  'A soft trust signal, not a hard gate: gates only the email/SMS fan-out on '
  'a new job post (src/lib/proAlerts.ts), never the post itself, never '
  'signup.';
comment on column public.properties.ownership_owner_names is
  'Owner name(s) as recorded by the county assessor (RentCast owner.names). '
  'Never shown to other users.';
comment on column public.properties.ownership_owner_type is
  'Assessor owner.type, normalized lowercase: individual or organization.';
comment on column public.properties.ownership_owner_occupied is
  'RentCast ownerOccupied flag, as reported by the assessor record.';
comment on column public.properties.ownership_checked_at is
  'When the ownership check last ran: at claim time, or lazily on first job '
  'post for a property claimed before this feature shipped. Null means '
  'never checked.';

-- =============================================================================
-- Column lock trigger, mirroring enforce_contractor_leads_locked() (0087):
-- non-privileged writes to the ownership columns (plus the legacy
-- ownership_verified boolean) are silently reverted/reset rather than
-- rejected, so a client write to unrelated columns on the same row still
-- lands - only the forged ownership fields are neutralized.
-- =============================================================================
create or replace function public.enforce_properties_ownership_locked()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_privileged boolean := coalesce(current_setting('hearth.ownership_write', true), '') = 'on';
begin
  if tg_op = 'INSERT' then
    if not v_privileged then
      -- A forged insert (claimPropertyAction's extendedRow/baseRow are built
      -- from client-submitted form fields - see the comment in
      -- src/app/onboarding/actions.ts) never gets to claim verified
      -- ownership up front: every new property starts unverified/unchecked
      -- regardless of what the insert statement asked for.
      new.ownership_status := 'unverified';
      new.ownership_owner_names := null;
      new.ownership_owner_type := null;
      new.ownership_owner_occupied := null;
      new.ownership_checked_at := null;
      new.ownership_verified := false;
    end if;
    return new;
  end if;

  if tg_op = 'UPDATE' then
    if not v_privileged then
      if new.ownership_status is distinct from old.ownership_status then
        new.ownership_status := old.ownership_status;
      end if;
      if new.ownership_owner_names is distinct from old.ownership_owner_names then
        new.ownership_owner_names := old.ownership_owner_names;
      end if;
      if new.ownership_owner_type is distinct from old.ownership_owner_type then
        new.ownership_owner_type := old.ownership_owner_type;
      end if;
      if new.ownership_owner_occupied is distinct from old.ownership_owner_occupied then
        new.ownership_owner_occupied := old.ownership_owner_occupied;
      end if;
      if new.ownership_checked_at is distinct from old.ownership_checked_at then
        new.ownership_checked_at := old.ownership_checked_at;
      end if;
      if new.ownership_verified is distinct from old.ownership_verified then
        new.ownership_verified := old.ownership_verified;
      end if;
    end if;
    return new;
  end if;

  return new;
end;
$$;

drop trigger if exists properties_ownership_locked on public.properties;
create trigger properties_ownership_locked
  before insert or update on public.properties
  for each row execute function public.enforce_properties_ownership_locked();

-- =============================================================================
-- record_ownership_check: the only path allowed to set ownership_status and
-- the facts it was decided from. Called server-side only (never from client
-- code), both right after a claim (src/app/onboarding/actions.ts) and
-- lazily on first job post for a property claimed before this feature
-- shipped (src/app/(app)/contractors/actions.ts, ownership_checked_at null).
-- =============================================================================
create or replace function public.record_ownership_check(
  p_property_id uuid,
  p_status text,
  p_owner_names jsonb,
  p_owner_type text,
  p_owner_occupied boolean
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_status not in ('verified', 'unverified') then
    raise exception 'record_ownership_check: invalid status %', p_status;
  end if;

  perform set_config('hearth.ownership_write', 'on', true);

  update public.properties
     set ownership_status = p_status,
         ownership_owner_names = p_owner_names,
         ownership_owner_type = p_owner_type,
         ownership_owner_occupied = p_owner_occupied,
         ownership_checked_at = now()
   where id = p_property_id;
end;
$$;

-- Service-role only: called exclusively from server actions with the admin
-- client, never from client code. Same treatment as reverse_deposit /
-- reverse_membership_credit (0090).
revoke all on function public.record_ownership_check(uuid, text, jsonb, text, boolean) from public;
revoke all on function public.record_ownership_check(uuid, text, jsonb, text, boolean) from anon;
revoke all on function public.record_ownership_check(uuid, text, jsonb, text, boolean) from authenticated;
grant execute on function public.record_ownership_check(uuid, text, jsonb, text, boolean) to service_role;
