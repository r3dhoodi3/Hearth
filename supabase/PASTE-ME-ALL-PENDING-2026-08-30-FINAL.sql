-- =============================================================================
-- PASTE-ME-ALL-PENDING  (built 2026-08-30, late evening)
--
-- THE ONE FILE. Live DB was confirmed through migration 0150 on 2026-08-30
-- (you ran PASTE-ME-ALL-PENDING-2026-08-30-day.sql). The ONLY migration that
-- exists after 0150 is 0151, so this file IS everything pending: it is the
-- full content of PASTE-ME-live-2026-08-30-night.sql (migration
-- 0151_night_security_2026_08_30).
--
-- Safe to run even if you are not sure whether you already ran it: the
-- PRECHECK below raises and applies NOTHING on a database where 0151 is
-- already in. To just LOOK without changing anything, run
-- supabase/VERIFY-0151-STATUS.sql instead (7 true/false rows).
--
-- What 0151 contains: is_pro_member active-only (no lead discount on a free
-- trial), household 4-member DB cap, system-message forgery lock, contractors
-- public-text CHECK constraints, expire_bonus revoke, messages delete policy,
-- properties unique index. Verify queries are at the bottom.
-- =============================================================================

-- =============================================================================
-- Hearth - PASTE ME (live) - overnight security remediation, 2026-08-30 night
-- =============================================================================
-- This is migration 0151_night_security_2026_08_30.sql, wrapped in a PRECHECK
-- that REFUSES to run if it has already been applied (so it is safe to paste
-- exactly once), followed by the same statements and a VERIFY block.
--
-- HOW TO RUN: paste the whole file into the Supabase SQL editor and run it
-- once. If any part of 0151 is already live, the PRECHECK raises and nothing is
-- changed - fix nothing, you are already applied. Live DB must be through 0150
-- first, in number order with no gaps.
--
-- WHAT IT DOES (see 0151's per-Part headers for the full reasoning):
--   MED-32  is_pro_member() = status 'active' only (no trial lead discount).
--   HIGH-47 household_members 4-member cap enforced by a trigger.
--   MED-53  message "system" voice forgery closed (guard reject + policy split).
--   LOW-54  contractors name/about/owner_name public-text shape constraints.
--   LOW-55  expire_bonus() EXECUTE to service_role only.
--   LOW-57  messages DELETE policy for unsend (own + within the hour).
--   MED-22  properties unique index against duplicate home rows.
-- =============================================================================


-- =============================================================================
-- PRECHECK: refuse a second application. Raises if ANY part of 0151 is already
-- live. Because every statement below is independently idempotent, a partial
-- prior run is also caught here (whichever piece landed first trips it), so you
-- can clean up and re-paste knowing this will stop you if it is already done.
-- =============================================================================
do $$
begin
  -- MED-32: is_pro_member already narrowed to active-only.
  if exists (
    select 1 from pg_proc
    where proname = 'is_pro_member'
      and pronamespace = 'public'::regnamespace
      -- Match the QUOTED literal from 0149's status list, not the bare word:
      -- 0151's own body comment contains "trialing", so a substring test on
      -- %trialing% would never see this function as narrowed. The quoted
      -- '\'trialing\'' text only ever appears in 0149's `in ('active','trialing')`.
      and prosrc not like '%''trialing''%'
  ) then
    raise exception 'PRECHECK: is_pro_member() is already active-only (MED-32 applied). 0151 appears already run. Nothing was changed.';
  end if;

  -- HIGH-47: the household cap trigger already exists.
  if exists (
    select 1 from pg_trigger
    where tgrelid = 'public.household_members'::regclass
      and tgname = 'household_members_cap'
  ) then
    raise exception 'PRECHECK: trigger household_members_cap already exists (HIGH-47 applied). 0151 appears already run. Nothing was changed.';
  end if;

  -- MED-53: the sender-role guard already carries the reject.
  if exists (
    select 1 from pg_proc
    where proname = 'enforce_message_sender_role'
      and pronamespace = 'public'::regnamespace
      and prosrc like '%system markers only%'
  ) then
    raise exception 'PRECHECK: enforce_message_sender_role() already rejects forged system rows (MED-53 applied). 0151 appears already run. Nothing was changed.';
  end if;

  -- LOW-54: any of the three public-text shape constraints already exists.
  if exists (
    select 1 from pg_constraint
    where conrelid = 'public.contractors'::regclass
      and conname in ('contractors_name_public_shape',
                      'contractors_about_public_shape',
                      'contractors_owner_name_public_shape')
  ) then
    raise exception 'PRECHECK: a contractors public-text shape constraint already exists (LOW-54 applied). 0151 appears already run. Nothing was changed.';
  end if;

  -- LOW-55: intentionally NOT a precheck sentinel. expire_bonus() EXECUTE was
  -- already revoked from authenticated/anon back in migration 0020, so
  -- has_function_privilege() is already false on every live DB through 0150 -
  -- testing it here would raise on a FRESH database and abort the whole paste.
  -- The Part 5 revoke/grant statements below are idempotent re-assertions.

  -- LOW-57: the messages delete policy already exists.
  if exists (
    select 1 from pg_policy
    where polrelid = 'public.messages'::regclass
      and polname = 'messages delete'
  ) then
    raise exception 'PRECHECK: policy "messages delete" already exists (LOW-57 applied). 0151 appears already run. Nothing was changed.';
  end if;

  -- MED-22: the properties unique index already exists.
  if exists (
    select 1 from pg_class
    where relname = 'properties_owner_address_unique'
      and relnamespace = 'public'::regnamespace
  ) then
    raise exception 'PRECHECK: index properties_owner_address_unique already exists (MED-22 applied). 0151 appears already run. Nothing was changed.';
  end if;
end
$$;


-- =============================================================================
-- Part 1 (MED-32): is_pro_member - active members only, no trial discount
-- =============================================================================
-- 0149's body with the status predicate narrowed from ('active','trialing') to
-- = 'active', so the 10% Pro lead discount begins only once a pro pays - same
-- posture as the deposit boost (webhook active-only). is_pro_member is called
-- only from inside apply_to_lead (SECURITY DEFINER), so it keeps its revokes
-- and needs no user-facing EXECUTE grant.
--
-- COORDINATION NOTE: the TypeScript preview (leadPricing.ts bestLeadDiscount /
-- subscription.ts isLiveProPlanRow) still treats 'trialing' as live, so a pro
-- mid-trial may SEE a 10% preview while this now charges full price. Align the
-- preview in a follow-up so shown and charged agree. The charge is correct.
create or replace function public.is_pro_member(p_user uuid)
returns boolean language sql stable set search_path = public as $$
  select exists (
    select 1
    from public.subscriptions s
    where s.user_id = p_user
      and s.plan like 'pro\_%' escape '\'
      -- MED-32: 'active' only. A trialing pro has not paid yet, so no lead
      -- discount until the trial converts - same posture as the deposit boost.
      and s.status = 'active'
      and (s.current_period_end is null or s.current_period_end > now())
  );
$$;

revoke all on function public.is_pro_member(uuid) from public;
revoke all on function public.is_pro_member(uuid) from anon;
revoke all on function public.is_pro_member(uuid) from authenticated;


-- =============================================================================
-- Part 2 (HIGH-47): household_members - enforce the member cap at the DB
-- =============================================================================
-- The 4-member-per-home cap lives only in app code (MAX_MEMBERS_PER_HOME = 4)
-- and in the QR redeem RPC (0097's literal 4); 0051 grants authenticated a
-- direct INSERT, so a Plus owner can POST past the cap at PostgREST. A BEFORE
-- INSERT/UPDATE trigger counts and rejects, under a per-property advisory lock
-- so concurrent inserts cannot race past the cap (0108's pattern). The count
-- excludes the row being written (id <> NEW.id), so an invitee claiming their
-- own pending invite (invited -> active) on a full home is never falsely
-- blocked. No 'declined' status exists (declining DELETEs the row), so
-- "count of all rows" is the app's own cap. SECURITY DEFINER so it sees every
-- row on the property. Keep the literal 4 in sync with the app and 0097.
create or replace function public.enforce_household_members_cap()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int;
begin
  perform pg_advisory_xact_lock(hashtext('hearth_household_cap'),
                                hashtext(new.property_id::text));

  select count(*) into v_count
  from public.household_members hm
  where hm.property_id = new.property_id
    and hm.id <> new.id;

  if v_count >= 4 then
    raise exception
      'This home already has the maximum of 4 members.'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists household_members_cap on public.household_members;
create trigger household_members_cap
  before insert or update on public.household_members
  for each row execute function public.enforce_household_members_cap();


-- =============================================================================
-- Part 3 (MED-53): messages - stop forgery of the platform "system" voice
-- =============================================================================
-- 0089's enforce_message_sender_role() passed every non homeowner/contractor
-- role straight through, and 0138's insert policy accepted any sender_role with
-- any body whenever no block existed, so a party could POST a 'system' row with
-- arbitrary body and have it render as a centered platform notice. Fixed in two
-- places: the guard now REJECTS any sender_role that is not homeowner/
-- contractor unless it is a 'system' row whose body is one of the three exact
-- thread markers postSystem() posts; and the insert policy is restructured so
-- the system allow-list is its own branch (accepted unconditionally for the
-- three markers, so close/reopen still works under a block) and real speech is
-- the other branch, gated on no-block. Keep the three marker literals in sync
-- with LeadChat and with 0138's block guard.
create or replace function public.enforce_message_sender_role()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_property uuid; v_contractor uuid; v_role text;
begin
  if new.sender_role in ('homeowner', 'contractor') then
    select property_id, contractor_id into v_property, v_contractor
      from public.contractor_leads where id = new.lead_id;

    if public.owns_property(v_property) then
      v_role := 'homeowner';
    elsif v_contractor is not null and exists (
      select 1 from public.contractors
      where id = v_contractor and user_id = auth.uid()
    ) then
      v_role := 'contractor';
    else
      raise exception 'Not authorized to post to this lead';
    end if;

    new.sender_role := v_role;
    return new;
  end if;

  -- MED-53: the ONLY non-party voice allowed is 'system', and ONLY for the
  -- three exact thread-marker bodies postSystem() posts. Any other 'system'
  -- body, or any other sender_role, is a forgery of the platform's own voice
  -- and is refused (system markers only) - the reject 0089 was missing.
  if new.sender_role = 'system'
     and new.body in (
       'Conversation closed by the homeowner.',
       'Conversation closed by the contractor.',
       'Conversation reopened.'
     ) then
    return new;
  end if;

  raise exception 'Unsupported message sender_role (system markers only)';
end; $$;

drop trigger if exists messages_sender_role_guard on public.messages;
create trigger messages_sender_role_guard
  before insert on public.messages
  for each row execute function public.enforce_message_sender_role();

drop policy if exists "messages insert" on public.messages;
create policy "messages insert" on public.messages
  for insert to authenticated
  with check (
    public.can_access_lead(lead_id)
    and sender_id = auth.uid()
    and (
      (
        sender_role = 'system'
        and body in (
          'Conversation closed by the homeowner.',
          'Conversation closed by the contractor.',
          'Conversation reopened.'
        )
      )
      or (
        sender_role in ('homeowner', 'contractor')
        and not public.lead_has_block(lead_id)
      )
    )
  );


-- =============================================================================
-- Part 4 (LOW-54): contractors public text - DB-level shape guards
-- =============================================================================
-- name, about and owner_name render verbatim on the public /p/<id> page.
-- isAcceptablePublicText (src/lib/publicText.ts) rejects bidi overrides, phone/
-- email off-platform contact routes and the censor() slur list before a save,
-- but 0085/0141 grant authenticated a DIRECT column UPDATE, so a raw PATCH
-- skips it. 0132/0141's LENGTH caps already exist and are validated live; this
-- adds the SQL-expressible SHAPE half as NOT VALID CHECKs (mirroring 0132's
-- logo_url/yelp_url pattern):
--   - bidi override/isolate chars (\u202A-\u202E, \u2066-\u2069) - zero false
--     positive, they never appear in a legitimate name/blurb.
--   - an email address (mirrors EMAIL_RE incl. (at)/[at]).
--   - a 10-digit North-American phone SHAPE (mirrors PHONE_RE; the lookbehind
--     PHONE_RE uses is written as (^|non-digit)...(non-digit|$) because
--     Postgres regex has no lookbehind). A license number, a ZIP pair, a year
--     range and a review count all pass, exactly as the app intends.
--
-- NOT VALID AND LEFT UNVALIDATED on purpose: it enforces on every future insert
-- and update (the direct-PATCH attack is an UPDATE, so it is covered now) while
-- skipping the historical scan, so a seeded/legacy row cannot make this paste
-- fail. The verify block lists violators; once clean an operator runs VALIDATE.
--
-- RESIDUAL: the censor() slur list and the app's NFKC/homoglyph folding cannot
-- run in a CHECK, so a homoglyph phone/email spelling can still slip past. The
-- complete closure is to revoke the direct grants and route writes through a
-- SECURITY DEFINER RPC calling isAcceptablePublicText - a larger follow-up.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.contractors'::regclass
      and conname = 'contractors_name_public_shape'
  ) then
    alter table public.contractors
      add constraint contractors_name_public_shape
      check (
        name is null
        or (
          name !~ '[\u202A-\u202E\u2066-\u2069]'
          and name !~* '[a-z0-9._%+-]+[[:space:]]*(@|\(at\)|\[at\])[[:space:]]*[a-z0-9.-]+\.[a-z]{2,}'
          and name !~ '(^|[^0-9])(\+?1[ .-]?)?(\([0-9]{3}\)|[0-9]{3})[ .-]?[0-9]{3}[ .-]?[0-9]{4}([^0-9]|$)'
        )
      ) not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.contractors'::regclass
      and conname = 'contractors_about_public_shape'
  ) then
    alter table public.contractors
      add constraint contractors_about_public_shape
      check (
        about is null
        or (
          about !~ '[\u202A-\u202E\u2066-\u2069]'
          and about !~* '[a-z0-9._%+-]+[[:space:]]*(@|\(at\)|\[at\])[[:space:]]*[a-z0-9.-]+\.[a-z]{2,}'
          and about !~ '(^|[^0-9])(\+?1[ .-]?)?(\([0-9]{3}\)|[0-9]{3})[ .-]?[0-9]{3}[ .-]?[0-9]{4}([^0-9]|$)'
        )
      ) not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.contractors'::regclass
      and conname = 'contractors_owner_name_public_shape'
  ) then
    alter table public.contractors
      add constraint contractors_owner_name_public_shape
      check (
        owner_name is null
        or (
          owner_name !~ '[\u202A-\u202E\u2066-\u2069]'
          and owner_name !~* '[a-z0-9._%+-]+[[:space:]]*(@|\(at\)|\[at\])[[:space:]]*[a-z0-9.-]+\.[a-z]{2,}'
          and owner_name !~ '(^|[^0-9])(\+?1[ .-]?)?(\([0-9]{3}\)|[0-9]{3})[ .-]?[0-9]{3}[ .-]?[0-9]{4}([^0-9]|$)'
        )
      ) not valid;
  end if;
end
$$;

-- After the verify query below returns 0 violators, an operator may enforce
-- these over existing rows too:
--   alter table public.contractors validate constraint contractors_name_public_shape;
--   alter table public.contractors validate constraint contractors_about_public_shape;
--   alter table public.contractors validate constraint contractors_owner_name_public_shape;


-- =============================================================================
-- Part 5 (LOW-55): expire_bonus() - service_role only
-- =============================================================================
-- expire_bonus() (0010) is a money-touching SECURITY DEFINER daily job created
-- with the default PUBLIC EXECUTE and never revoked, so anon/authenticated can
-- call it over PostgREST (free full-scan-and-write on the wallet ledger). It is
-- only ever run by the scheduled job as service_role, which bypasses grants.
revoke all on function public.expire_bonus() from public;
revoke all on function public.expire_bonus() from anon;
revoke all on function public.expire_bonus() from authenticated;
grant execute on function public.expire_bonus() to service_role;


-- =============================================================================
-- Part 6 (LOW-57): messages - a scoped DELETE policy for unsend
-- =============================================================================
-- messages had no DELETE policy, so the "unsend" control (LeadChat.tsx, which
-- deletes your own message within the last hour from your own session) fails
-- closed ("It isn't enabled in the database yet."). This adds exactly that: you
-- may delete a row only when it is YOURS and RECENT. BOTH predicates are
-- required - sender_id alone lets a party erase their own history forever, the
-- time bound alone lets a party delete the other side's recent messages.
-- The DELETE table grant is restated for self-documentation; on stock Supabase
-- it is already present (only the policy was missing), so it is a no-op there.
grant delete on public.messages to authenticated;

drop policy if exists "messages delete" on public.messages;
create policy "messages delete" on public.messages
  for delete to authenticated
  using (
    sender_id = auth.uid()
    and created_at > now() - interval '1 hour'
  );


-- =============================================================================
-- Part 7 (MED-22): properties - unique index against duplicate home rows
-- =============================================================================
-- properties has only its id PK (0001) and the home-cap trigger (0108) caps
-- COUNT not duplicates, so a double-submit can create two identical-address
-- rows for one user. This is the DB backstop to an app-level check-then-insert
-- guard another worker is adding. Key: user_id, lower(btrim(address_line1)),
-- zip, unit. UNIT IS IN THE KEY DELIBERATELY (0127) so condo/townhome units at
-- one street address stay distinct and a landlord owning units 4 and 5 is not
-- blocked. coalesce(..., '') so a null zip/unit does not make every row unique.
--
-- Plain CREATE INDEX (not CONCURRENTLY): this paste runs in one transaction and
-- CONCURRENTLY cannot; properties is tiny, so the brief lock is a non-issue.
-- The guard below raises a clear message (not a bare unique_violation) if
-- duplicate rows already exist, so the operator gets a precise cleanup list.
do $$
declare v_dupes int;
begin
  select count(*) into v_dupes from (
    select 1
    from public.properties
    group by user_id, lower(btrim(address_line1)),
             coalesce(zip, ''), coalesce(unit, '')
    having count(*) > 1
  ) d;
  if v_dupes > 0 then
    raise exception
      'MED-22: % duplicate (user_id, address, zip, unit) group(s) already exist in public.properties. Merge/delete the duplicates before this index can be built (see the verify query below). Nothing was changed.',
      v_dupes;
  end if;
end
$$;

create unique index if not exists properties_owner_address_unique
  on public.properties (
    user_id,
    lower(btrim(address_line1)),
    coalesce(zip, ''),
    coalesce(unit, '')
  );

comment on index public.properties_owner_address_unique is
  'MED-22: one home per (owner, normalized street line, zip, unit). Backstop to '
  'the app-level check-then-insert guard in onboarding/actions.ts against a '
  'double-submit creating two identical-address property rows for one user. '
  'unit is in the key so condo/townhome units at one street address stay '
  'distinct (0127).';


-- =============================================================================
-- VERIFY (run after applying; each should come back as described)
-- =============================================================================

-- Part 1 (MED-32):
--   select prosrc like '%''active''%' as active_only,
--          prosrc not like '%''trialing''%' as no_trial
--     from pg_proc
--    where proname = 'is_pro_member' and pronamespace = 'public'::regnamespace;
--   -> active_only = t, no_trial = t

-- Part 2 (HIGH-47):
--   select tgname from pg_trigger
--    where tgrelid = 'public.household_members'::regclass
--      and tgname = 'household_members_cap';
--   -> one row
--   Before applying, list any home already over the 4-member cap - once the
--   trigger exists, those homes can no longer accept a pending-invite claim
--   (intended: they are the abused ones), so know which they are first:
--     select property_id, count(*) from public.household_members
--      group by property_id having count(*) >= 4 order by count(*) desc;
--   -> ideally zero rows.

-- Part 3 (MED-53):
--   select prosrc like '%system markers only%' as rejects_system
--     from pg_proc
--    where proname = 'enforce_message_sender_role'
--      and pronamespace = 'public'::regnamespace;
--   -> rejects_system = t

-- Part 4 (LOW-54): constraints exist, NOT validated yet by design.
--   select conname, convalidated from pg_constraint
--    where conrelid = 'public.contractors'::regclass
--      and conname in ('contractors_name_public_shape',
--                      'contractors_about_public_shape',
--                      'contractors_owner_name_public_shape')
--    order by conname;
--   -> three rows, convalidated = f
--   Existing violators to clean before VALIDATE:
--   select id, 'name' as col from public.contractors
--     where name ~ '[\u202A-\u202E\u2066-\u2069]'
--        or name ~* '[a-z0-9._%+-]+[[:space:]]*(@|\(at\)|\[at\])[[:space:]]*[a-z0-9.-]+\.[a-z]{2,}'
--        or name ~ '(^|[^0-9])(\+?1[ .-]?)?(\([0-9]{3}\)|[0-9]{3})[ .-]?[0-9]{3}[ .-]?[0-9]{4}([^0-9]|$)'
--   union all
--   select id, 'about' from public.contractors
--     where about ~ '[\u202A-\u202E\u2066-\u2069]'
--        or about ~* '[a-z0-9._%+-]+[[:space:]]*(@|\(at\)|\[at\])[[:space:]]*[a-z0-9.-]+\.[a-z]{2,}'
--        or about ~ '(^|[^0-9])(\+?1[ .-]?)?(\([0-9]{3}\)|[0-9]{3})[ .-]?[0-9]{3}[ .-]?[0-9]{4}([^0-9]|$)'
--   union all
--   select id, 'owner_name' from public.contractors
--     where owner_name ~ '[\u202A-\u202E\u2066-\u2069]'
--        or owner_name ~* '[a-z0-9._%+-]+[[:space:]]*(@|\(at\)|\[at\])[[:space:]]*[a-z0-9.-]+\.[a-z]{2,}'
--        or owner_name ~ '(^|[^0-9])(\+?1[ .-]?)?(\([0-9]{3}\)|[0-9]{3})[ .-]?[0-9]{3}[ .-]?[0-9]{4}([^0-9]|$)';
--   -> ideally zero rows.

-- Part 5 (LOW-55):
--   select has_function_privilege('authenticated', 'public.expire_bonus()', 'execute') as auth_can,
--          has_function_privilege('anon', 'public.expire_bonus()', 'execute')          as anon_can,
--          has_function_privilege('service_role', 'public.expire_bonus()', 'execute')  as svc_can;
--   -> auth_can = f, anon_can = f, svc_can = t

-- Part 6 (LOW-57):
--   select polname, pg_get_expr(polqual, polrelid) as using_expr
--     from pg_policy
--    where polrelid = 'public.messages'::regclass and polname = 'messages delete';
--   -> using_expr references BOTH sender_id = auth.uid() AND created_at > now() - '01:00:00'

-- Part 7 (MED-22):
--   select indexname from pg_indexes
--    where schemaname = 'public' and tablename = 'properties'
--      and indexname = 'properties_owner_address_unique';
--   -> one row
