-- =============================================================================
-- Hearth - household QR-code invites (0095)
-- RUN THIS AGAINST THE LIVE DATABASE (Supabase SQL editor); editing repo SQL
-- alone does NOT change the already-deployed database.
--
-- WHY: 0048_household_sharing.sql built the household_members invite/accept
-- flow (invite an email, the invitee's own account claims it). This adds a
-- SECOND way to reach the exact same membership: a homeowner shows a QR code
-- on the household tab, someone scans it, and their signed-in session
-- redeems a short-lived token into the same active household_members row
-- the classic email flow produces. Nothing about membership itself changes -
-- same table, same cap, same RLS-gated day to day access via owns_property().
--
-- TOKEN LIFECYCLE:
--   mint   - the owner's "household" tab mints a fresh token (10 min expiry)
--            when opened and again every 10 min while it stays open (app
--            code, src/app/(app)/account/household/actions.ts). Minting also
--            deletes that owner's own old/expired tokens first, so this
--            table self-cleans with no cron needed and never accumulates
--            more than a small number of rows per owner.
--   redeem - the joiner's browser hits /join/household/[token]. If they are
--            signed in, the page calls redeem_household_invite_token(token)
--            under THEIR OWN session. If they are signed out, the page shows
--            a chooser (sign in / create account) that carries the token URL
--            through as ?next= and lands back here afterward, at which point
--            the token may or may not still be live - an expired token by
--            then is a normal, honest "ask for a fresh code" outcome, not a
--            bug (see the join page for the timing note).
--   expire - expires_at is checked at redeem time (expires_at > now()). No
--            separate expiry job: an expired row simply never matches, and
--            the next mint from that owner sweeps it away.
--
-- household_invite_tokens: SERVICE-ROLE ONLY, no client policies at all
-- (RLS enabled, zero policies = nobody gets a row via PostgREST). Every
-- legitimate touch goes through code that already runs with elevated
-- privilege: the mint server action uses the admin client, and the redeem
-- RPC below is SECURITY DEFINER. A client can never list, guess-and-select,
-- or tamper with a token row directly - the token's own uuid entropy (122
-- random bits from gen_random_uuid()) plus the 10-minute expiry are what
-- make a leaked/screenshotted code go stale fast, not RLS.
--
-- Safe to re-run.
-- =============================================================================

create table if not exists public.household_invite_tokens (
  token       uuid primary key default gen_random_uuid(),
  property_id uuid not null references public.properties(id) on delete cascade,
  created_by  uuid not null references auth.users(id) on delete cascade,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null
);

comment on table public.household_invite_tokens is
  'Short-lived (10 min) unguessable tokens minted by a property owner and '
  'shown as a QR code on the household tab. Redeeming one (via the RPC '
  'below, never a direct table write) grants the SAME active household '
  'membership the email-invite flow in household_members grants. '
  'Service-role only: no client-facing RLS policy exists on this table.';

-- Fast lookup for the owner's own self-cleanup sweep on every mint.
create index if not exists household_invite_tokens_owner_idx
  on public.household_invite_tokens (created_by);

alter table public.household_invite_tokens enable row level security;
-- No policies. RLS with zero policies denies every row to every client role;
-- only service_role (which bypasses RLS entirely) and this migration's own
-- SECURITY DEFINER function can ever touch this table.

revoke all on public.household_invite_tokens from public;
revoke all on public.household_invite_tokens from anon;
revoke all on public.household_invite_tokens from authenticated;
-- Deliberately no grant to authenticated: the mint action writes through the
-- ADMIN client (service_role, which owns every privilege regardless of
-- table grants), and the redeem RPC is SECURITY DEFINER, so it reads this
-- table as its owning role, not as the calling authenticated user. A grant
-- to authenticated here would be dead weight at best and a bypass path
-- around the RPC's own checks at worst.

-- ---- redeem_household_invite_token: the one client-reachable entry point ---
--
-- Validates the token, enforces the SAME constraints household_members'
-- owner-insert / invitee-claim RLS policies enforce for the email flow
-- (membership cap, one row per property+email, idempotent re-claim), and
-- either upgrades an existing pending invite for this caller's email or
-- inserts a brand new active row. Runs as the caller (auth.uid() must be a
-- real signed-in user - see grants below), always returns exactly one row
-- so the caller never has to distinguish "empty result" from "RPC error":
-- ok=false with a reason is itself the well-formed failure case.
--
-- MAX_MEMBERS_PER_HOME mirrors the app-side constant in
-- src/app/(app)/account/household/actions.ts and page.tsx (no DB-level cap
-- constraint exists today - 0048 never added one - so this RPC enforcing the
-- same number here is what stops a QR redemption from exceeding the cap the
-- classic invite path only checks in application code). If that constant
-- ever changes, update the literal 4 below too.
create or replace function public.redeem_household_invite_token(p_token uuid)
returns table (
  ok             boolean,
  property_id    uuid,
  member_id      uuid,
  already_member boolean,
  reason         text
) language plpgsql security definer set search_path = public as $$
declare
  v_uid          uuid := auth.uid();
  v_property_id  uuid;
  v_created_by   uuid;
  v_email        text;
  v_is_owner     boolean;
  v_existing_id  uuid;
  v_existing_status text;
  v_member_count int;
  v_new_id       uuid;
  v_allowed      boolean;
begin
  if v_uid is null then
    ok := false; reason := 'no_session';
    return next;
    return;
  end if;

  -- Per-user throttle on top of the token's own uuid entropy + 10 minute
  -- expiry. 30 attempts per 5 minutes is generous for a real join (a page
  -- load or two, maybe a retry) while still bounding a scripted guessing
  -- loop against this signed-in user's own rate. Reuses the fixed-window
  -- limiter from 0068_rate_limits.sql; calling it directly (not via
  -- admin.rpc) works here because this function runs as its owning role,
  -- same precedent as the enforce_*_rate_limit() triggers in
  -- 0087_med_security.sql / 0089_referral_and_flood_fixes.sql.
  select public.rate_limit_hit(
    'household_qr_redeem:' || v_uid::text, 30, 300
  ) into v_allowed;
  if v_allowed is false then
    ok := false; reason := 'rate_limited';
    return next;
    return;
  end if;

  select hit.property_id, hit.created_by
    into v_property_id, v_created_by
  from public.household_invite_tokens hit
  where hit.token = p_token
    and hit.expires_at > now();

  if v_property_id is null then
    ok := false; reason := 'invalid_or_expired';
    return next;
    return;
  end if;

  -- Live email, not public.users.email: that mirror is written once at
  -- signup and never re-synced on an email change (updateEmailAction only
  -- updates auth.users), so it can go stale. 0048's invitee select/claim RLS
  -- policies already treat auth.jwt() ->> 'email' as the source of truth for
  -- claiming an invite by address; match that here, same lower() the
  -- household_members_property_email_key unique index normalizes on.
  v_email := lower(coalesce(auth.jwt() ->> 'email', ''));
  if v_email = '' then
    ok := false; reason := 'no_email';
    return next;
    return;
  end if;

  -- Owner scanning their own code: they already have full owner access, no
  -- household_members row needed or wanted.
  select exists (
    select 1 from public.properties p
    where p.id = v_property_id and p.user_id = v_uid
  ) into v_is_owner;
  if v_is_owner then
    ok := true; property_id := v_property_id; already_member := true;
    reason := 'owner';
    return next;
    return;
  end if;

  -- Same unique pairing household_members_property_email_key guards
  -- (property_id, lower(invited_email)): find any existing row for this
  -- caller's email on this property, active or still-pending from the
  -- classic email-invite flow.
  select hm.id, hm.status
    into v_existing_id, v_existing_status
  from public.household_members hm
  where hm.property_id = v_property_id
    and lower(hm.invited_email) = v_email
  limit 1;

  if v_existing_id is not null and v_existing_status = 'active' then
    -- Idempotent: already a member (including via this same QR flow before).
    ok := true; property_id := v_property_id; member_id := v_existing_id;
    already_member := true; reason := 'already_member';
    return next;
    return;
  end if;

  if v_existing_id is not null and v_existing_status = 'invited' then
    -- A pending email invite exists for this address; the QR scan claims it,
    -- same shape acceptInviteAction() produces for the email flow.
    update public.household_members
    set status = 'active', member_user_id = v_uid, accepted_at = now()
    where id = v_existing_id;
    ok := true; property_id := v_property_id; member_id := v_existing_id;
    already_member := false; reason := 'claimed_pending_invite';
    return next;
    return;
  end if;

  -- Lock the property row first: an unlocked count-then-insert lets N
  -- concurrent redemptions with different emails all read the same
  -- under-cap count and all pass, overshooting the 4-member cap (same class
  -- of race 0065_wallet_lock_on_charge.sql fixed for wallet balances).
  -- Locking here serializes concurrent redemptions for this property so
  -- each one re-counts against the other's already-committed insert.
  perform id from public.properties where id = v_property_id for update;

  -- Brand new membership: enforce the same cap inviteMemberAction() enforces
  -- (count of ALL rows - invited or active - for this property).
  select count(*) into v_member_count
  from public.household_members
  where property_id = v_property_id;
  if v_member_count >= 4 then
    ok := false; reason := 'home_full';
    return next;
    return;
  end if;

  insert into public.household_members
    (property_id, invited_email, member_user_id, status, invited_by, accepted_at)
  values
    (v_property_id, v_email, v_uid, 'active', v_created_by, now())
  returning id into v_new_id;

  ok := true; property_id := v_property_id; member_id := v_new_id;
  already_member := false; reason := 'joined';
  return next;
  return;
end; $$;

-- The joiner redeems from THEIR OWN signed-in session (auth.uid() drives
-- every check above), so this is the one piece of the QR flow that grants to
-- authenticated rather than routing through the admin client. anon and
-- public get nothing: an unauthenticated scan cannot redeem anything, which
-- is why the join page sends a signed-out visitor to sign in or sign up
-- first (carrying the token through as ?next=) rather than ever calling
-- this with no session.
revoke all on function public.redeem_household_invite_token(uuid) from public;
revoke all on function public.redeem_household_invite_token(uuid) from anon;
grant execute on function public.redeem_household_invite_token(uuid) to authenticated;
