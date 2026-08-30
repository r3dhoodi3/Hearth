-- =============================================================================
-- Hearth - overnight security remediation (0151)
-- RUN THIS AGAINST THE LIVE DATABASE (Supabase SQL editor); editing repo SQL
-- alone does NOT change the already-deployed database. Apply in number order
-- with no gaps: everything through 0150 first, then this.
--
-- Seven independent fixes, one per Part below. Each Part names the finding it
-- closes (from the 2026-08-30 overnight audit ledger) and is a copy-safe,
-- idempotent statement (CREATE OR REPLACE / IF NOT EXISTS / drop-then-create /
-- guarded ADD CONSTRAINT). Nothing here drops a column, rewrites a row, or
-- moves a price. The companion PASTE-ME file carries a PRECHECK that refuses a
-- second application and the same verify queries printed at the bottom here.
--
--   MED-32  is_pro_member() counts only status = 'active' (not 'trialing'), so
--           the 10% Pro lead discount begins when money does, matching the
--           deposit-boost rule (webhook active-only).
--   HIGH-47 a BEFORE INSERT/UPDATE trigger on household_members enforces the
--           4-member-per-home cap the app only checks in TypeScript, closing
--           the direct-PostgREST cap bypass (and the concurrent-insert race).
--   MED-53  the message "system" voice can no longer be forged: the three
--           exact thread-marker bodies are the ONLY system rows accepted, and
--           enforce_message_sender_role() now REJECTS any other system (or
--           non homeowner/contractor) sender_role instead of passing it through.
--   LOW-54  DB-level shape guards on the public-text columns contractors.name /
--           about / owner_name (bidi-override, email, phone shapes) so a direct
--           PATCH cannot store unmoderated public text. Slur/content moderation
--           stays app-side (see the residual note in Part 4).
--   LOW-55  expire_bonus() EXECUTE revoked from public/anon/authenticated and
--           granted to service_role only (money-touching SECURITY DEFINER).
--   LOW-57  a DELETE policy on messages so the "unsend within an hour" UI works
--           and neither party can delete the other's messages.
--   MED-22  a unique index on properties so a double-submit cannot create two
--           identical-address home rows for one user (backstop to an app-level
--           guard another worker is adding).
--
-- Written and reasoned about, NOT executed against any database. Dry-run
-- against a staging copy before production.
-- =============================================================================


-- =============================================================================
-- Part 1 (MED-32): is_pro_member - active members only, no trial discount
-- =============================================================================
-- 0149 created is_pro_member() matching status in ('active', 'trialing') and
-- apply_to_lead prices every lead through it, so a free 3-day Pro trial got the
-- flat 10% lead discount and could cancel on day 3 having paid nothing. The
-- deposit boost already gates on status = 'active' only (the Stripe webhook),
-- and the owner's rule is "if they BUY it they start off with a 10% discount".
-- So the discount must start when the money does.
--
-- This is 0149's body with the single status predicate narrowed from
-- ('active', 'trialing') to = 'active'. Everything else is verbatim: the same
-- escaped pro_ LIKE, the same period-end guard, STABLE, the same search_path,
-- and the same revokes (is_pro_member is called only from inside apply_to_lead,
-- itself SECURITY DEFINER, so it needs no user-facing EXECUTE grant).
--
-- COORDINATION NOTE: the TypeScript preview was aligned to this in the same
-- wave. src/lib/subscription.ts now exports hasActivePaidProPlan() (active-only)
-- and it is used at the two lead-price sites - src/app/pro/leads/page.tsx (the
-- card price) and src/app/pro/actions.ts (the stale-price guard) - so a pro
-- mid-trial sees the same full price this function charges. Every other pro
-- perk still reads hasProPlan() (active OR trialing), so a trial keeps its AI,
-- tools, alerts and "you're a member" copy. Shown and charged now agree.
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
-- The 4-member-per-home cap lives only in app code
-- (MAX_MEMBERS_PER_HOME = 4 in src/app/(app)/account/household/actions.ts) and
-- in the QR redeem RPC (0097's literal 4). But 0051 grants `authenticated` a
-- direct INSERT on household_members (the "owner insert" policy only checks
-- ownership + status='invited'), so a Plus owner can POST rows straight to
-- /rest/v1/household_members past the cap, each alias then claiming into an
-- active membership that inflates the owner's plan perks. This closes the hole
-- at the DB, the same way 0108 capped homes: a BEFORE INSERT/UPDATE trigger
-- that counts and rejects, under a per-property advisory lock so concurrent
-- inserts cannot race past the cap.
--
-- The count EXCLUDES the row being written (id <> NEW.id), so an invitee
-- claiming their own pending invite (an UPDATE moving invited -> active) is
-- never falsely blocked: a home at exactly the cap has (cap - 1) OTHER rows
-- besides the one being claimed, which is under the limit. On INSERT there is
-- no existing row with NEW.id, so the exclusion is a no-op and the (cap+1)th
-- insert is refused. There is no 'declined' status in this schema - declining
-- DELETEs the row (0051) - so "count of all rows" is the same as the app's own
-- cap check and the finding's "non-declined members".
--
-- SECURITY DEFINER so it counts every row on the property regardless of the
-- caller's RLS view. Keep the literal 4 in sync with MAX_MEMBERS_PER_HOME and
-- the QR RPC's literal 4 (0097).
create or replace function public.enforce_household_members_cap()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int;
begin
  -- Serialize concurrent writes for THIS property (0108's pattern) so two
  -- direct inserts cannot both read an under-cap count and both land. Keyed on
  -- the property id, released at end of transaction. Different properties never
  -- contend.
  perform pg_advisory_xact_lock(hashtext('hearth_household_cap'),
                                hashtext(new.property_id::text));

  select count(*) into v_count
  from public.household_members hm
  where hm.property_id = new.property_id
    and hm.id <> new.id;

  -- 4 = MAX_MEMBERS_PER_HOME (app) = the QR redeem RPC's literal 4 (0097).
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
-- A 'system' message renders as a centered platform notice (LeadChat.tsx), e.g.
-- a close/reopen marker - it reads as Hearth speaking, not either party. 0138's
-- messages insert policy exempted 'system' from the block gate but its OTHER
-- branch, `not lead_has_block(lead_id)`, accepted ANY sender_role (system
-- included) with any body whenever no block existed. And 0089's
-- enforce_message_sender_role() only derived/overwrote a 'homeowner'/
-- 'contractor' role and passed every other value (system, or anything else)
-- straight through. Together that let a real party POST
-- {"sender_role":"system","body":"Hearth verified this pro is licensed..."}
-- straight at PostgREST and have it land as a platform notice.
--
-- Two changes, both needed:
--   (a) enforce_message_sender_role() now REJECTS any sender_role that is not
--       'homeowner'/'contractor' UNLESS it is a 'system' row whose body is one
--       of the three exact thread markers LeadChat.postSystem() posts. This is
--       the fence at the trigger layer - it fires on every insert, including a
--       raw PostgREST one.
--   (b) the messages insert policy is restructured so the system allow-list is
--       its OWN branch (accepted unconditionally for the three markers, so
--       close/reopen still works even under a block), and real speech
--       ('homeowner'/'contractor') is the other branch, gated on no-block. A
--       system row with any other body now matches NEITHER branch and is
--       refused by the policy too.
--
-- The three marker literals are exactly LeadChat's postSystem() bodies
-- (CLOSE_PREFIX + " by the " + role + ".", and REOPEN_BODY). If those strings
-- ever change in LeadChat, change them here, in the policy below, AND in 0138's
-- enforce_message_not_blocked()/messages insert allow-list together.
create or replace function public.enforce_message_sender_role()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_property uuid; v_contractor uuid; v_role text;
begin
  -- Real speech: derive the true role from the caller's actual relationship to
  -- the lead and overwrite whatever the client sent, so neither side can post
  -- under the other's name (0089's original purpose, preserved).
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
  -- three exact thread-marker bodies postSystem() posts (close by either side,
  -- reopen). These are not speech - a party who just blocked the other side
  -- must still be able to close the thread - so they are accepted here (the
  -- block gate exempts the same three). Any OTHER 'system' body, or any other
  -- sender_role a future feature or a crafted insert introduces, is a forgery
  -- of the platform's own voice and is refused (system markers only). This is
  -- the reject 0089 was missing: it passed every non homeowner/contractor role
  -- straight through.
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

-- 0138's policy, restructured so the system allow-list is its own branch and
-- real speech is gated on no-block. Diff against 0138: the system marker check
-- is no longer OR'd against the block predicate - it stands alone, and the
-- no-block predicate now applies only to homeowner/contractor rows.
drop policy if exists "messages insert" on public.messages;
create policy "messages insert" on public.messages
  for insert to authenticated
  with check (
    public.can_access_lead(lead_id)
    and sender_id = auth.uid()
    and (
      -- System markers: the three exact close/reopen bodies, accepted
      -- unconditionally (so a blocked party can still close the thread).
      (
        sender_role = 'system'
        and body in (
          'Conversation closed by the homeowner.',
          'Conversation closed by the contractor.',
          'Conversation reopened.'
        )
      )
      -- Real speech: a homeowner or contractor line, refused when a block sits
      -- between the two people on this thread. enforce_message_not_blocked()
      -- (0138) prints the friendly sentence; this is the fence.
      or (
        sender_role in ('homeowner', 'contractor')
        and not public.lead_has_block(lead_id)
      )
    )
  );


-- =============================================================================
-- Part 4 (LOW-54): contractors public text - DB-level shape guards
-- =============================================================================
-- name, about and owner_name are rendered verbatim on the public /p/<id> page,
-- the browse cards and the share images. isAcceptablePublicText
-- (src/lib/publicText.ts) rejects bidi overrides, off-platform contact routes
-- (a phone or email address) and the censor() slur/profanity list before a save
-- - but 0085/0141 grant `authenticated` a DIRECT column UPDATE on all three, so
-- a raw PATCH skips that validator entirely and can store unmoderated text on a
-- public page.
--
-- The length caps 0132 (name <= 200, about <= 1000) and 0141 (owner_name 2..120)
-- established already exist and are validated live; this Part adds the SHAPE
-- half that is safe to express in SQL, as CHECK constraints PostgREST cannot
-- skip, mirroring exactly how 0132 constrained logo_url/yelp_url. The regexes
-- use Postgres \u escapes (standard_conforming_strings is on in Supabase, so
-- the backslash reaches the regex engine intact):
--   - BIDI override/isolate characters (customCategory.ts BIDI_CONTROL_RE =
--     /[\u202A-\u202E\u2066-\u2069]/). These change how everything AFTER them
--     renders on the public page and never appear in a legitimate name or
--     blurb, so this is a zero-false-positive guard.
--   - an EMAIL address anywhere in the value (mirrors EMAIL_RE, including the
--     (at)/[at] obfuscations).
--   - a PHONE number in North-American 3-3-4 shape (mirrors PHONE_RE). PHONE_RE
--     uses a lookbehind, which Postgres regex does not support, so the digit
--     boundaries are expressed as (^|non-digit) ... (non-digit|$) instead - the
--     same "a phone SHAPE, not enough digits" intent, so a license number, a
--     ZIP pair, a founded-in year range and a review count (all 7+ digits but
--     not a 10-digit 3-3-4 run) still pass, exactly as the app intends.
--
-- ADDED NOT VALID AND LEFT UNVALIDATED, on purpose. NOT VALID enforces on every
-- new and updated row immediately (the direct-PATCH attack is an UPDATE, so it
-- is covered from the moment this runs) while skipping the historical scan, so
-- a seeded or legacy row that predates the rule cannot make this paste fail.
-- The verify block at the bottom lists any existing violators; once clean, an
-- operator can run the commented VALIDATE lines to enforce over old rows too.
--
-- RESIDUAL (reported, not closed here): the censor() slur/profanity list cannot
-- be reproduced faithfully in a CHECK, and folding (NFKC + homoglyph mapping)
-- that the app applies before matching is not available in SQL, so a homoglyph
-- phone/email spelling can still slip past these constraints. The complete
-- closure is to REVOKE the direct name/about/owner_name column grants (0085/
-- 0141) and route every write through a SECURITY DEFINER RPC that calls
-- isAcceptablePublicText - a larger, app-coordinated change left for a
-- follow-up. Until then the app validator stays the primary gate and these
-- constraints are the backstop against the raw-PATCH bypass.
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

-- After confirming the verify query at the bottom returns 0 violators, an
-- operator may enforce these over existing rows too:
--   alter table public.contractors validate constraint contractors_name_public_shape;
--   alter table public.contractors validate constraint contractors_about_public_shape;
--   alter table public.contractors validate constraint contractors_owner_name_public_shape;


-- =============================================================================
-- Part 5 (LOW-55): expire_bonus() - service_role only
-- =============================================================================
-- expire_bonus() (0010) is a money-touching SECURITY DEFINER daily job that
-- scans bonus_grants and writes wallet_transactions/wallets. It was created
-- with the default PUBLIC EXECUTE and never revoked, so anon/authenticated can
-- call it over PostgREST - a free full-scan-and-write against the wallet ledger
-- (no balance gain, but unwanted work and writes on demand). It is only ever
-- invoked by the scheduled job through the service role, which bypasses grants,
-- so nothing legitimate loses access.
revoke all on function public.expire_bonus() from public;
revoke all on function public.expire_bonus() from anon;
revoke all on function public.expire_bonus() from authenticated;
grant execute on function public.expire_bonus() to service_role;


-- =============================================================================
-- Part 6 (LOW-57): messages - a scoped DELETE policy for unsend
-- =============================================================================
-- messages has no DELETE policy, so the "unsend" control (LeadChat.tsx, which
-- deletes your own message within the last hour from your own session client)
-- fails closed - the UI literally reports "It isn't enabled in the database
-- yet." This adds the exact policy that UI expects: you may delete a row only
-- when it is YOURS (sender_id = auth.uid()) AND it is recent (created_at within
-- the last hour). BOTH predicates are required: sender_id alone would let
-- either party delete their own messages forever (rewriting a dispute record),
-- and the time bound alone would let either party delete the OTHER side's
-- recent messages. Together they are the unsend window and nothing more.
--
-- The DELETE table privilege for `authenticated` is granted explicitly below
-- for self-documentation; on a stock Supabase project it is already present
-- (which is why only the missing policy blocked unsend), so this is a no-op
-- there. RLS still gates every delete through the policy.
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
-- onboarding/actions.ts inserts a property with no existence check, and
-- properties has only its id PK (0001); the home-cap trigger (0108) caps the
-- COUNT of homes, not duplicates. A double-submit or two-tab claim can create
-- two identical-address rows for one user, each seeding systems and billing a
-- RentCast lookup. This is the DB backstop to an app-level check-then-insert
-- guard another worker is adding.
--
-- The key is the owner plus the normalized address: user_id, the lower-cased
-- trimmed street line, the zip, and the unit. UNIT IS IN THE KEY DELIBERATELY -
-- 0127 added properties.unit precisely so condo/townhome neighbours are not
-- treated as the same home, so a landlord who legitimately owns unit 4 and
-- unit 5 at one street address must not be blocked. coalesce(..., '') keeps a
-- null zip or null unit from making every such row unique (nulls never collide
-- in a unique index otherwise).
--
-- CREATE INDEX (not CONCURRENTLY): this file is meant to be pasted as one
-- transactional script, and CONCURRENTLY cannot run inside a transaction.
-- properties is small (one or a few rows per user), so the brief lock is a
-- non-issue. The guard below raises a clear message if duplicate rows already
-- exist (the finding says they may), so the operator gets a precise cleanup
-- list instead of a bare unique_violation from the index build.
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
      'MED-22: % duplicate (user_id, address, zip, unit) group(s) already exist in public.properties. Merge/delete the duplicates before this index can be built. The verify query at the bottom of this file lists them. Nothing was changed.',
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

-- Part 1 (MED-32): the body now filters status = 'active' and no longer
-- mentions 'trialing'.
--   select prosrc like '%''active''%' as active_only,
--          prosrc not like '%''trialing''%' as no_trial
--     from pg_proc
--    where proname = 'is_pro_member' and pronamespace = 'public'::regnamespace;
--   -> one row: active_only = t, no_trial = t

-- Part 2 (HIGH-47): the trigger exists on household_members.
--   select tgname from pg_trigger
--    where tgrelid = 'public.household_members'::regclass
--      and tgname = 'household_members_cap';
--   -> one row. A 5th direct insert on a full home must raise
--      'This home already has the maximum of 4 members.'; an invitee claiming
--      their own pending invite on a full home must still succeed.
--   HEADS-UP before you apply: any property ALREADY over the cap (from the
--   pre-fix exploit) will, from the moment this trigger exists, have its
--   pending-invite claims and new invites blocked. Those are exactly the
--   abused homes, so this is intended, but list them first so it is not a
--   surprise:
--     select property_id, count(*) from public.household_members
--      group by property_id having count(*) >= 4 order by count(*) desc;
--   -> ideally zero rows. Any row is a home that was already past the limit.

-- Part 3 (MED-53): the sender-role guard carries the reject, and the insert
-- policy's system branch stands alone.
--   select prosrc like '%system markers only%' as rejects_system
--     from pg_proc
--    where proname = 'enforce_message_sender_role'
--      and pronamespace = 'public'::regnamespace;
--   -> rejects_system = t
--   A raw insert of {sender_role:'system', body:'anything else'} must raise;
--   a system row whose body is exactly 'Conversation reopened.' must still
--   succeed from a party on the lead.

-- Part 4 (LOW-54): the three constraints exist. They are NOT validated yet by
-- design; list any rows that would fail before validating.
--   select conname, convalidated from pg_constraint
--    where conrelid = 'public.contractors'::regclass
--      and conname in ('contractors_name_public_shape',
--                      'contractors_about_public_shape',
--                      'contractors_owner_name_public_shape')
--    order by conname;
--   -> three rows, convalidated = f (until an operator runs VALIDATE)
--   Existing violators (must be reviewed/cleaned before VALIDATE):
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

-- Part 5 (LOW-55): only service_role may execute expire_bonus().
--   select has_function_privilege('authenticated', 'public.expire_bonus()', 'execute') as auth_can,
--          has_function_privilege('anon', 'public.expire_bonus()', 'execute')          as anon_can,
--          has_function_privilege('service_role', 'public.expire_bonus()', 'execute')  as svc_can;
--   -> auth_can = f, anon_can = f, svc_can = t

-- Part 6 (LOW-57): the delete policy exists with both predicates.
--   select polname, pg_get_expr(polqual, polrelid) as using_expr
--     from pg_policy
--    where polrelid = 'public.messages'::regclass and polname = 'messages delete';
--   -> using_expr references BOTH sender_id = auth.uid() AND created_at > now() - '01:00:00'

-- Part 7 (MED-22): the unique index exists.
--   select indexname from pg_indexes
--    where schemaname = 'public' and tablename = 'properties'
--      and indexname = 'properties_owner_address_unique';
--   -> one row. Duplicate homes for one user now raise unique_violation.
