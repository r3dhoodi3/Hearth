-- =============================================================================
-- Hearth - blocking, and reporting beyond the chat thread
--
-- WHY: App Store guideline 1.2 (user-generated content) asks for three things
-- on any app where strangers can talk to each other: a way to REPORT
-- objectionable content, a way to BLOCK an abusive user, and a published way
-- to reach the people who run the service. Hearth already had the first one
-- for chat only (public.reports, migration 0009) and the third one (the
-- /contact form, migration 0024's support_messages). This migration adds the
-- block half and widens reporting to cover reviews and pro profiles.
--
-- WHAT THIS FILE DOES, in order:
--   1. public.user_blocks - one row per "I never want to hear from this
--      account again". Self-scoped RLS: you can only see, create and remove
--      YOUR OWN blocks. Nobody can read who blocked them.
--   2. public.blocked_between(uuid, uuid) and public.lead_has_block(uuid) -
--      the two read helpers everything below shares, so the rule lives in one
--      place instead of being re-typed into four call sites. blocked_between
--      is service_role only (a grant to `authenticated` would publish it as a
--      PostgREST RPC and let anyone ask "did that account block me?");
--      lead_has_block must stay callable by `authenticated` because a policy
--      evaluates it as the querying role, so it carries its own
--      can_access_lead() guard instead.
--   3. Messages: a BEFORE INSERT trigger (clear error message) AND the
--      "messages insert" policy (the real fence). Both, on purpose - see the
--      comment above them.
--   4. open_jobs_for_me(): a blocked homeowner's jobs vanish from that pro's
--      board. 0124's body, byte for byte, plus ONE where-clause predicate.
--   5. apply_to_lead(): a blocked pro cannot buy their way onto the job
--      anyway, in case they kept a lead id from before the block. 0132's
--      body, byte for byte, plus ONE gate placed before any money moves.
--   6. public.reports gains an optional target (target_type/target_id) and
--      lead_id becomes nullable, so a review or a pro profile can be
--      reported by the same table and the same inbox as a chat.
--   7. contractor_reviews() and public_pro_profile() return each review's id,
--      which is what the new "Report" link on a review targets.
--      contractor_reviews() also picks up public_pro_profile's visibility
--      gate, so a delisted or never-claimed pro's reviews stop being readable
--      from a page that no longer exists.
--
-- WHAT DOES NOT CHANGE: no column is dropped, no row is rewritten, no price
-- moves, and both functions re-issued below are copies of their latest
-- definition with the named lines added and nothing else edited.
--
-- IF THIS FILE HAS NOT BEEN RUN ON LIVE YET: nothing breaks. Every read the
-- app makes against user_blocks is wrapped so a 42P01 (relation does not
-- exist) or a PostgREST 404 comes back as "no blocks", the /account/blocks
-- page renders its empty state, the Block button reports an honest failure
-- instead of claiming success, and the review Report link simply never
-- appears (it is gated on a review id the old RPC does not return).
--
-- Idempotent: every object is IF NOT EXISTS / CREATE OR REPLACE / drop-then-
-- create. Safe to re-run.
-- =============================================================================


-- =============================================================================
-- Part 1: public.user_blocks
-- =============================================================================
-- UUID primary key, like every other table here: a sequential id would let
-- anyone holding one block id guess at the volume and ordering of everyone
-- else's.
--
-- ON DELETE CASCADE on both sides: a deleted account should not leave a block
-- row pointing at a user that no longer exists, and "delete my account and all
-- associated data" (account/security) has to mean it.
create table if not exists public.user_blocks (
  id              uuid primary key default gen_random_uuid(),
  blocker_user_id uuid not null references auth.users (id) on delete cascade,
  blocked_user_id uuid not null references auth.users (id) on delete cascade,
  reason          text,
  created_at      timestamptz not null default now(),
  unique (blocker_user_id, blocked_user_id)
);

-- Nobody may block themselves. A self-block would make lead_has_block() true
-- for every thread that account is on and lock them out of their own chats.
alter table public.user_blocks
  drop constraint if exists user_blocks_not_self;
alter table public.user_blocks
  add constraint user_blocks_not_self
  check (blocker_user_id <> blocked_user_id);

-- The unique constraint above already indexes (blocker_user_id, ...), which
-- serves "my blocks" and "did A block B". This one serves the other
-- direction, "did anyone block B", which lead_has_block and open_jobs_for_me
-- both ask on every call.
create index if not exists user_blocks_blocked_idx
  on public.user_blocks (blocked_user_id);

alter table public.user_blocks enable row level security;

-- Self-scoped, all three verbs on blocker_user_id = auth.uid(). There is
-- deliberately NO policy that lets the blocked side read the row: being told
-- "X blocked you" is itself a message from someone who asked not to send you
-- any. The enforcement everywhere else runs through SECURITY DEFINER helpers,
-- which do not need a select policy to see the row.
drop policy if exists "user_blocks self select" on public.user_blocks;
create policy "user_blocks self select" on public.user_blocks
  for select to authenticated
  using (blocker_user_id = auth.uid());

drop policy if exists "user_blocks self insert" on public.user_blocks;
create policy "user_blocks self insert" on public.user_blocks
  for insert to authenticated
  with check (blocker_user_id = auth.uid());

drop policy if exists "user_blocks self delete" on public.user_blocks;
create policy "user_blocks self delete" on public.user_blocks
  for delete to authenticated
  using (blocker_user_id = auth.uid());

-- Grants matching the neighbouring tables (0130's account_signals pattern,
-- inverted: this one IS user-facing, so authenticated keeps exactly the three
-- verbs the policies above scope). No UPDATE: a block is created or removed,
-- never edited, so there is no way to re-point an existing row at somebody
-- else. anon gets nothing.
revoke all on public.user_blocks from anon;
grant select, insert, delete on public.user_blocks to authenticated;
grant all on public.user_blocks to service_role;

comment on table public.user_blocks is
  'One row per "this account never wants to hear from that account again". '
  'RLS is self-scoped to blocker_user_id = auth.uid() for select/insert/'
  'delete, so nobody can discover that they have been blocked. Enforced by '
  'blocked_between()/lead_has_block(), which the messages insert policy, the '
  'messages_block_guard trigger, open_jobs_for_me() and apply_to_lead() all '
  'read. No UPDATE grant: rows are created and removed, never re-pointed.';


-- =============================================================================
-- Part 2: the two read helpers
-- =============================================================================
-- SECURITY DEFINER because every caller needs to see blocks in BOTH
-- directions, and RLS above deliberately hides the ones pointing at you.
-- Both return a bare boolean and never a row, an id, or a reason, so a caller
-- learns "you two cannot interact" and nothing about who decided that.
--
-- blocked_between is NOT granted to `authenticated`, on purpose. Supabase
-- publishes every public function an ordinary role may execute as a PostgREST
-- RPC, so that grant would have made this a block oracle: any signed-in
-- account could POST /rest/v1/rpc/blocked_between with two ids and get a
-- yes/no - including its own id and the id of whoever it suspects blocked it,
-- which each side of a lead already learns from messages.sender_id. That is
-- exactly the thing the table comment above says is impossible. Nothing needs
-- the grant: apply_to_lead (Part 5) is itself SECURITY DEFINER and calls this
-- as the function owner, and the app's own path (isBlockedBetween in
-- src/lib/blocks.ts) goes through the service-role client.
create or replace function public.blocked_between(p_a uuid, p_b uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.user_blocks b
    where (b.blocker_user_id = p_a and b.blocked_user_id = p_b)
       or (b.blocker_user_id = p_b and b.blocked_user_id = p_a)
  );
$$;

revoke all on function public.blocked_between(uuid, uuid) from public, anon, authenticated;
grant execute on function public.blocked_between(uuid, uuid) to service_role;

comment on function public.blocked_between(uuid, uuid) is
  'True when either account has blocked the other. Symmetric on purpose: a '
  'block stops the conversation in both directions, so the blocked party '
  'cannot keep talking at someone who left. Returns a bare boolean, never '
  'which side blocked or why. Service role only: a grant to authenticated '
  'would expose it as a PostgREST RPC and turn it into a block oracle. '
  'apply_to_lead calls it as its own definer, so no user-facing grant is '
  'needed.';

-- The lead-shaped version: does a block sit between the two people on this
-- thread? LEFT JOINs so a lead with no property row or no assigned contractor
-- yields nulls, which the join predicate treats as "no block" - the opposite
-- posture from the launch-city gate, and the right one here: an unassigned
-- lead has no second party to have blocked anyone.
--
-- The homeowner side is the PROPERTY OWNER, not household members. A block is
-- between two people; a shared household member who has not blocked anyone is
-- not silenced by their co-owner's block, and does not gain a way to keep
-- messaging a pro their co-owner blocked either (that pro's own thread is
-- gated on the owner's row, which is the one the pro is talking to).
--
-- Unlike blocked_between, this one HAS to keep its `authenticated` grant: RLS
-- evaluates a policy's function calls as the querying role, and the "messages
-- insert" policy below calls it. So the caller check lives inside the body
-- instead: `public.can_access_lead(p_lead)` (0007), the same helper the
-- messages policies and Part 6 already use. Without it this is a narrower
-- version of the same oracle - hand it any lead id and it tells you whether
-- those two strangers have blocked each other.
--
-- It changes nothing about the two real callers. The "messages insert" policy
-- already requires can_access_lead(lead_id) in the same WITH CHECK, so the
-- added conjunct is true whenever the rest of that policy is. The
-- messages_block_guard trigger is SECURITY DEFINER, but definer only swaps
-- the privilege role - auth.uid() reads the request's JWT claims from a GUC,
-- so inside the trigger it is still the inserting user, who is on the lead by
-- construction (every message insert in the app runs on that person's own
-- session client). A caller who is NOT on the lead now gets `false` here and
-- is refused a line later by the policy's own can_access_lead, which is the
-- same outcome by a better route.
create or replace function public.lead_has_block(p_lead uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select public.can_access_lead(p_lead) and exists (
    select 1
    from public.contractor_leads l
    left join public.properties pr on pr.id = l.property_id
    left join public.contractors c on c.id = l.contractor_id
    join public.user_blocks b
      on (b.blocker_user_id = pr.user_id and b.blocked_user_id = c.user_id)
      or (b.blocker_user_id = c.user_id and b.blocked_user_id = pr.user_id)
    where l.id = p_lead
  );
$$;

revoke all on function public.lead_has_block(uuid) from public, anon;
grant execute on function public.lead_has_block(uuid) to authenticated, service_role;

comment on function public.lead_has_block(uuid) is
  'True when the caller is on this lead AND the homeowner who owns its '
  'property and the contractor assigned to it have a block between them in '
  'either direction. Read by the "messages insert" policy and the '
  'messages_block_guard trigger. Granted to authenticated because RLS '
  'evaluates policy functions as the querying role, which is also why the '
  'can_access_lead guard has to sit inside the body rather than in a grant.';


-- =============================================================================
-- Part 3: messages - the trigger AND the policy
-- =============================================================================
-- BOTH, deliberately, and they are not redundant:
--
--   The POLICY is the fence. Policies are what a direct PostgREST insert from
--   a crafted client hits, and what stays true if a future migration replaces
--   the trigger. It is the thing that cannot be bypassed.
--
--   The TRIGGER is the sentence. An RLS refusal surfaces as "new row violates
--   row-level security policy for table messages", which tells a real person
--   nothing. The trigger fires first (BEFORE INSERT runs before the WITH
--   CHECK is evaluated) and raises a sentence the chat can print as is.
--
-- Both exempt sender_role = 'system', and both exempt it ONLY for the three
-- exact bodies LeadChat actually posts (CLOSE_PREFIX + role, and REOPEN_BODY,
-- in src/components/LeadChat.tsx). Those rows are not speech: somebody who has
-- just blocked the other side must still be able to close the thread, and
-- taking that away would leave the conversation stuck open with no way out.
--
-- Red team (2026-08-28): the exemption used to be sender_role = 'system' and
-- nothing else. enforce_message_sender_role (0089) only checks that a
-- 'homeowner'/'contractor' row matches who is sending, so it never rejects a
-- 'system' row - which left a blocked party free to POST
-- {"sender_role":"system","body":"anything"} straight at PostgREST and have it
-- land in the thread. Matching the exact marker bodies closes that: close and
-- reopen still work from either side, arbitrary text under a system label does
-- not. If those strings ever change in LeadChat, change them here too.
create or replace function public.enforce_message_not_blocked()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if not (
       new.sender_role = 'system'
       and new.body in (
         'Conversation closed by the homeowner.',
         'Conversation closed by the contractor.',
         'Conversation reopened.'
       )
     ) and public.lead_has_block(new.lead_id) then
    raise exception
      'You can no longer message this person. One of you has blocked the other.';
  end if;
  return new;
end; $$;

-- Name sorts before messages_rate_limit and messages_sender_role_guard, and
-- same-timing triggers fire in name order, so a blocked send is refused
-- before it consumes any of that sender's rate-limit budget.
drop trigger if exists messages_block_guard on public.messages;
create trigger messages_block_guard
  before insert on public.messages
  for each row execute function public.enforce_message_not_blocked();

-- 0007's policy, with the block predicate added and nothing else changed.
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
      or not public.lead_has_block(lead_id)
    )
  );

-- SELECT is untouched on purpose. A block stops new messages; it does not
-- delete the history either side already has, which both people may need if
-- the thing they are blocking each other over ends up in front of support.


-- =============================================================================
-- Part 4: open_jobs_for_me - 0124's body, plus the block predicate
-- =============================================================================
-- COPY-ONLY. 0124 is the latest definition of open_jobs_for_me in this folder
-- (0131 and 0132 only mention it in comments), so that is the live body. The
-- diff is exactly ONE where-clause block and nothing else. CREATE OR REPLACE
-- with an unchanged signature preserves the existing EXECUTE grants.
--
-- The predicate is a NOT EXISTS rather than blocked_between(pr.user_id,
-- auth.uid()): the board is a set-returning query over up to 200 rows and the
-- planner can drive this straight off user_blocks' two indexes, whereas a
-- per-row SECURITY DEFINER call cannot be inlined.
create or replace function public.open_jobs_for_me()
returns table (
  id                 uuid,
  category           text,
  timing             text,
  issue_description  text,
  issue_severity     text,
  payout_amount      numeric,
  created_at         timestamptz,
  application_count  bigint,
  has_photos         boolean,
  plus_poster        boolean,
  budget_range       text,
  city               text,
  ownership_verified boolean,
  photo_urls         text[],
  square_footage     integer,
  material_notes     text,
  has_plans_permits  boolean
) language sql security definer set search_path = public as $$
  select cl.id, cl.category, cl.timing, cl.issue_description,
         cl.issue_severity, cl.payout_amount, cl.created_at,
         (select count(*) from lead_applications la
           where la.lead_id = cl.id and la.refunded_at is null),
         (cl.issue_id is not null and exists (
           select 1 from photos p
           where p.related_type = 'issue' and p.related_id = cl.issue_id)),
         exists (
           select 1
           from subscriptions s
           where s.user_id = pr.user_id
             and (s.side = 'homeowner'
                  or s.plan is null
                  or s.plan not like 'pro\_%' escape '\')
             and s.status in ('active', 'trialing')
             and (s.current_period_end is null or s.current_period_end > now())
         ) as plus_poster,
         cl.budget_range,
         pr.city,
         coalesce(pr.ownership_status = 'verified', false) as ownership_verified,
         (select array_agg(p.url order by p.uploaded_at)
            from photos p
           where p.related_type = 'issue'
             and p.related_id = cl.issue_id) as photo_urls,
         cl.square_footage,
         cl.material_notes,
         cl.has_plans_permits
  from contractor_leads cl
  join contractors c on c.user_id = auth.uid()
  left join properties pr on pr.id = cl.property_id
  where cl.contractor_id is null
    and cl.status = 'new'
    and cl.direct_to is null
    and (c.categories is null or cl.category = any (c.categories))
    and (c.service_state is null
         or pr.state is null
         or upper(btrim(pr.state)) = upper(btrim(c.service_state)))
    and c.serves_orange_county = true
    and public.launch_city_for_zip(pr.zip) = any (c.launch_cities)
    -- 0138: a block hides the job board from each other, both ways. A
    -- homeowner who blocked this pro stops seeing them apply, and a pro who
    -- blocked a homeowner stops being shown that homeowner's work.
    and not exists (
      select 1 from user_blocks b
      where (b.blocker_user_id = auth.uid() and b.blocked_user_id = pr.user_id)
         or (b.blocker_user_id = pr.user_id and b.blocked_user_id = auth.uid())
    )
    and not exists (
      select 1 from lead_applications la
      where la.lead_id = cl.id and la.contractor_id = c.id
    )
  order by plus_poster desc, cl.created_at desc
  limit 200;
$$;


-- =============================================================================
-- Part 5: apply_to_lead - 0132's body, plus the block gate
-- =============================================================================
-- COPY-ONLY, same discipline as Part 4. 0132 is the latest definition of
-- apply_to_lead in this folder. ONE block added and nothing else edited; the
-- signature is unchanged, so CREATE OR REPLACE preserves the EXECUTE grant to
-- `authenticated`.
--
-- WHERE THE GATE SITS: immediately after v_owner resolves (the "one live lead
-- per relationship" select is the first statement that knows who the
-- homeowner is), which is after the cheap idempotent returns - a pro who
-- already applied and was blocked afterwards still gets the honest `true` on
-- a retry rather than an error for a lead they already hold - and well before
-- get_or_create_wallet, the wallet FOR UPDATE, the bonus drain, the debit, or
-- any insert. Nothing between the select and the gate mutates anything.
--
-- Part 4 already hides these jobs from the board; this is the half that
-- matters for a lead id kept from before the block or lifted from a URL.
create or replace function public.apply_to_lead(p_lead uuid, p_message text)
returns boolean language plpgsql security definer set search_path = public as $$
declare
  v_contractor uuid; v_wallet uuid; v_cats text[]; v_oc boolean;
  v_launch_cities text[]; v_lead_city text;
  v_lead_contractor uuid; v_status text; v_category text; v_price bigint;
  v_property uuid; v_owner uuid;
  v_cash bigint; v_bonus bigint; v_grant_sum bigint; v_bonus_avail bigint;
  v_from_cash bigint; v_from_bonus bigint;
  v_remaining bigint; v_grant record; v_cash_first boolean;
  v_cash_after bigint; v_bonus_after bigint;
begin
  perform set_config('hearth.lead_write', 'on', true);

  select id, categories, serves_orange_county, launch_cities
    into v_contractor, v_cats, v_oc, v_launch_cities
    from contractors where user_id = auth.uid();
  if v_contractor is null then raise exception 'Not a contractor'; end if;

  -- 0132: an open payment dispute freezes spending. has_open_chargeback() is
  -- true only while this pro's account carries an uncleared abuse_flags row of
  -- kind 'chargeback' (written by the Stripe webhook on
  -- charge.dispute.created). Placed here, immediately after the contractor
  -- resolves and BEFORE the job is read, before any wallet lock, and before a
  -- single cent moves: a pro who has charged back a wallet top-up is spending
  -- money the platform has already lost, and the wallet balance still says it
  -- is there. Cleared by setting abuse_flags.cleared_at (service role only), so
  -- a dispute that is won or withdrawn unfreezes the account without erasing
  -- that it happened.
  if public.has_open_chargeback(v_contractor) then
    raise exception 'There is an unresolved payment dispute on your account. Contact support.';
  end if;

  -- 0087 fix (MED): reproduce open_jobs_for_me()'s hard Orange County launch
  -- gate here too, so a pro who never confirmed serves_orange_county can't
  -- bypass the board by applying directly against a leaked/guessed lead id.
  if not coalesce(v_oc, false) then
    raise exception 'Confirm the cities you serve in your profile before applying to jobs';
  end if;

  -- Price the fee from the job's age at apply time (the aging deal). FOR UPDATE
  -- serializes concurrent applies to the same job so the cap below can't be
  -- raced past 3.
  select contractor_id, status, category, property_id,
         public.lead_fee_cents(payout_amount, created_at)
    into v_lead_contractor, v_status, v_category, v_property, v_price
    from contractor_leads where id = p_lead
    for update;
  if v_category is null then raise exception 'Job not found'; end if;

  if v_lead_contractor is not null then return false; end if;  -- already assigned
  if v_status <> 'new' then return false; end if;              -- not open
  if v_cats is not null and not (v_category = any (v_cats)) then
    raise exception 'Job is not in your categories';
  end if;
  if exists (
    select 1 from lead_applications
    where lead_id = p_lead and contractor_id = v_contractor
  ) then
    return true;  -- idempotent: already applied
  end if;

  -- 0124: the per-city half of the launch gate, mirroring the identical line
  -- open_jobs_for_me() filters the board on. Deliberately AFTER the
  -- already-applied idempotent return above: a pro who paid for this lead and
  -- later narrowed their launch_cities still gets the honest `true` on a
  -- retry, never a geography error for a job they already hold. Still before
  -- any money moves or any row is written.
  select public.launch_city_for_zip(p.zip) into v_lead_city
    from properties p where p.id = v_property;
  if v_lead_city is null or not (v_lead_city = any (coalesce(v_launch_cities, '{}'))) then
    raise exception 'This job is outside the cities you serve. Update your service area in your profile.';
  end if;

  -- One live lead per relationship (0060's rule): refuse when the pro already
  -- has an active job (not closed/lost) in this category on a property with
  -- the same owner. Closed/lost jobs never block, so rehires and repeat
  -- business stay wide open.
  select pr.user_id into v_owner from properties pr where pr.id = v_property;

  -- 0138: a block between these two people. Symmetric, and worded without
  -- saying which side blocked whom - the pro must not be able to use this
  -- error to learn that a particular homeowner blocked them. Placed on the
  -- first line that knows who the homeowner is, and still before every wallet
  -- read, every debit, and every insert.
  if v_owner is not null and public.blocked_between(auth.uid(), v_owner) then
    raise exception 'This job is not available to you.';
  end if;

  if v_owner is not null and exists (
    select 1
    from contractor_leads active
    join properties ap on ap.id = active.property_id
    where active.contractor_id = v_contractor
      and active.category = v_category
      and active.status not in ('closed', 'lost')
      and ap.user_id = v_owner
  ) then
    raise exception 'Already working with this homeowner';
  end if;

  -- Applicant cap: 3 live (non-refunded) applications fill a job. Keep in sync
  -- with MAX_APPLICANTS_PER_JOB in src/lib/constants.ts.
  if (select count(*) from lead_applications
      where lead_id = p_lead and refunded_at is null) >= 3 then
    raise exception 'Job is full';
  end if;

  v_wallet := get_or_create_wallet(v_contractor);
  -- 0065 fix: FOR UPDATE so a concurrent charge against this same wallet
  -- (a different lead, or a ghost recharge) can't read a stale balance and
  -- push cash/bonus negative. See migration header for the race.
  select cash_balance_cents, bonus_balance_cents into v_cash, v_bonus
    from wallets where id = v_wallet
    for update;
  v_cash := coalesce(v_cash, 0);
  v_bonus := coalesce(v_bonus, 0);

  -- 0113: first big-ticket lead intro price. Deliberately placed AFTER the
  -- wallet FOR UPDATE above: all of a pro's charges serialize on that lock,
  -- so two racing major applies can never both read "no prior major payment"
  -- (see 0113's header). No-op for non-major categories and for any pro who
  -- has ever paid for a major lead.
  v_price := public.major_lead_price_cents(v_contractor, v_category, v_price);

  -- Only bonus backed by live, unexpired grants is spendable. Capping at the
  -- grant sum makes the insufficient check honest and guarantees the FIFO drain
  -- below finds enough, so it can never zero out grants and then bail.
  select coalesce(sum(remaining_cents), 0) into v_grant_sum
    from bonus_grants
    where wallet_id = v_wallet and remaining_cents > 0 and expires_at > now();
  v_bonus_avail := least(v_bonus, v_grant_sum);

  if v_cash + v_bonus_avail < v_price then
    return false;  -- insufficient: prompt a deposit
  end if;

  select spend_cash_first into v_cash_first from wallet_config where id = 1;
  if v_cash_first then
    v_from_cash := least(v_cash, v_price);
    v_from_bonus := v_price - v_from_cash;
  else
    v_from_bonus := least(v_bonus_avail, v_price);
    v_from_cash := v_price - v_from_bonus;
  end if;

  if v_from_bonus > 0 then
    v_remaining := v_from_bonus;
    for v_grant in
      select * from bonus_grants
      where wallet_id = v_wallet and remaining_cents > 0 and expires_at > now()
      order by expires_at asc, created_at asc
    loop
      exit when v_remaining <= 0;
      if v_grant.remaining_cents >= v_remaining then
        update bonus_grants set remaining_cents = remaining_cents - v_remaining
         where id = v_grant.id;
        v_remaining := 0;
      else
        v_remaining := v_remaining - v_grant.remaining_cents;
        update bonus_grants set remaining_cents = 0 where id = v_grant.id;
      end if;
    end loop;
    if v_remaining > 0 then return false; end if;  -- unreachable safety net
  end if;

  update wallets
     set cash_balance_cents  = cash_balance_cents  - v_from_cash,
         bonus_balance_cents = bonus_balance_cents - v_from_bonus,
         updated_at = now()
   where id = v_wallet
   returning cash_balance_cents, bonus_balance_cents into v_cash_after, v_bonus_after;

  insert into lead_applications (lead_id, contractor_id, message, status, fee_cents)
    values (p_lead, v_contractor, nullif(btrim(p_message), ''), 'applied', v_price);

  insert into wallet_transactions
    (wallet_id, type, cash_delta_cents, bonus_delta_cents,
     cash_balance_after_cents, bonus_balance_after_cents, lead_id, note)
    values (v_wallet, 'apply_fee', -v_from_cash, -v_from_bonus,
            v_cash_after, v_bonus_after, p_lead, 'Applied to job');

  return true;
end; $$;


-- =============================================================================
-- Part 6: public.reports gains a target, so more than a chat can be reported
-- =============================================================================
-- 0009 created reports with `lead_id uuid not null`, which pinned every report
-- to a chat thread. A review or a pro's public profile has no lead, so the
-- column has to become nullable and the row has to be able to name what it is
-- about instead. Existing rows are untouched: they keep their lead_id and
-- carry a null target, which is exactly what they are.
alter table public.reports alter column lead_id drop not null;

alter table public.reports add column if not exists target_type text;
alter table public.reports add column if not exists target_id uuid;

-- A report has to be about SOMETHING: either a chat thread or a named target.
alter table public.reports
  drop constraint if exists reports_has_a_target;
alter table public.reports
  add constraint reports_has_a_target
  check (lead_id is not null or (target_type is not null and target_id is not null));

-- Closed vocabulary, so the moderation inbox can group by it. 'chat' is
-- implied by a null target_type on the old rows and is not re-stated here.
alter table public.reports
  drop constraint if exists reports_target_type_known;
alter table public.reports
  add constraint reports_target_type_known
  check (target_type is null or target_type in ('review', 'contractor'));

create index if not exists reports_target_idx
  on public.reports (target_type, target_id, created_at desc);

-- 0009's insert policy, widened to the new shape and nothing more. The
-- lead-shaped branch is 0009's rule byte for byte. The target-shaped branch
-- keeps the only thing that actually matters for a report - reporter_id =
-- auth.uid(), so nobody can file under someone else's name - and does NOT
-- require a relationship to the target: the whole point of reporting a public
-- review or a public profile is that a stranger who just read it can say so.
-- The server action (src/lib/reportActions.ts) verifies the target row really
-- exists before it gets here, and rate limits per account.
drop policy if exists "reports insert" on public.reports;
create policy "reports insert" on public.reports
  for insert to authenticated
  with check (
    reporter_id = auth.uid()
    and (
      (lead_id is not null and public.can_access_lead(lead_id))
      or (lead_id is null and target_type is not null and target_id is not null)
    )
  );

-- SELECT is unchanged (0009: reporter_id = auth.uid()), restated so this file
-- is self-verifying about who may read reports back.
drop policy if exists "reports select" on public.reports;
create policy "reports select" on public.reports
  for select to authenticated
  using (reporter_id = auth.uid());

comment on table public.reports is
  'Abuse reports. Either lead_id (a chat thread, 0009) or target_type/'
  'target_id (a review or a contractor profile, 0138) identifies what is '
  'being reported. Insert requires reporter_id = auth.uid(); select returns '
  'only your own. The Hearth team reads everything through the service role.';


-- =============================================================================
-- Part 7: review ids, so a single review can be reported
-- =============================================================================
-- Both review readers returned rating/comment/created_at and no id, so the
-- "Report" link on a review had nothing to point at. Adding the id changes
-- nothing about what is public: a review's id is not a secret, and neither
-- function has ever exposed the reviewer.
--
-- contractor_reviews has to be DROPped first - Postgres will not let CREATE OR
-- REPLACE change a function's return type, even by adding a column. 0018
-- created it with no explicit grant, so it ran on the default PUBLIC EXECUTE;
-- the grants below restate that intent narrowly instead (anon reads the public
-- profile page, authenticated reads the applicant expander), which is a
-- tightening, not a loosening.
--
-- It also picks up the SAME visibility gate public_pro_profile carries (0132:
-- user_id is not null and serves_orange_county). The two functions serve one
-- page and disagreed: /p/<id> would render its not-found state for a delisted
-- or never-claimed pro while this RPC still handed an anonymous caller up to
-- 100 of that pro's reviews. Ids are not enumerable (public_pro_id_for_slug
-- only resolves live pros), so this is small, but "the pro is not public" has
-- to mean the same thing in both places.
drop function if exists public.contractor_reviews(uuid);
create or replace function public.contractor_reviews(p_contractor uuid)
returns table (
  id         uuid,
  rating     smallint,
  comment    text,
  created_at timestamptz
)
language sql
security definer
stable
set search_path = public
as $$
  select r.id, r.rating, r.comment, r.created_at
  from public.reviews r
  where r.contractor_id = p_contractor
    -- Same predicate as public_pro_profile's WHERE clause below. A pro with no
    -- account behind the row, or one outside the launch market, is not public,
    -- so their reviews are not public either. Returns zero rows, which is what
    -- the review list already renders as "no reviews yet".
    and exists (
      select 1
      from public.contractors c
      where c.id = p_contractor
        and c.user_id is not null
        and coalesce(c.serves_orange_county, false)
    )
  order by r.created_at desc
  limit 100;
$$;

revoke all on function public.contractor_reviews(uuid) from public;
grant execute on function public.contractor_reviews(uuid) to anon, authenticated, service_role;

comment on function public.contractor_reviews(uuid) is
  'Public review list for one pro: id, rating, comment, created_at, newest '
  'first, capped at 100. Never returns the reviewer. Returns nothing unless '
  'the pro is publicly visible (user_id is not null and serves_orange_county), '
  'the same gate public_pro_profile applies. The id is what the "Report this '
  'review" control targets (public.reports.target_id).';

-- public_pro_profile: 0132's body, with 'id' added to each review object and
-- NOTHING else edited. Returns jsonb, so this is a plain CREATE OR REPLACE.
create or replace function public.public_pro_profile(p_contractor uuid)
returns jsonb
language sql
security definer
stable
set search_path = public
as $$
  select jsonb_build_object(
    'id',           c.id,
    'slug',         c.slug,
    'name',         c.name,
    'categories',   coalesce(c.categories, '{}'),
    'created_at',   c.created_at,
    -- Rating exactly as the rest of the app shows it: only real review
    -- averages (review_count > 0), never seeded placeholder values.
    'rating',       case when c.review_count > 0 then c.rating end,
    'review_count', c.review_count,
    'member',       m.live,
    -- Cosmetics: legitimate paid-member perks, still gated on m.live.
    'logo_url',     case when m.live then c.logo_url end,
    'about',        case when m.live then c.about end,
    -- Trust signals: FREE for every pro (0109). The gray "on file" badge is a
    -- safety fact, not a paid perk - same reasoning as license_verified_at and
    -- background_checked_at below. m.live no longer gates these.
    'has_license',  c.license_number is not null
                    and btrim(c.license_number) <> '',
    'has_insurance', c.insurance_carrier is not null
                    and btrim(c.insurance_carrier) <> '',
    -- Outbound review-page links (0110): trust signals, FREE for every pro,
    -- same policy as the "on file" booleans above - never gated on m.live. The
    -- page renders these only as plain "See our reviews" outbound buttons.
    'yelp_url',            c.yelp_url,
    'google_reviews_url',  c.google_reviews_url,
    -- Real CSLB verification (0055). Free feature, not gated on membership.
    -- Only the timestamp, never the status text or CSLB detail: a 'failed'
    -- check must never be inferable from the public payload.
    'license_verified_at', c.license_verified_at,
    -- Real Checkr background check (0057). Free feature, not gated on
    -- membership. Only the timestamp, never the status text or detail: a
    -- 'consider' or in-progress check must never be inferable from the
    -- public payload - it is indistinguishable from 'none' out here.
    'background_checked_at', c.background_checked_at,
    'reviews', coalesce((
      select jsonb_agg(
               jsonb_build_object(
                 -- 0138: the review's own id, so the public page can offer a
                 -- "Report this review" control that names one row. Not a
                 -- secret and not the reviewer.
                 'id',         r.id,
                 'rating',     r.rating,
                 'comment',    r.comment,
                 'created_at', r.created_at
               ) order by r.created_at desc)
      from (
        select id, rating, comment, created_at
        from public.reviews
        where contractor_id = c.id
        order by created_at desc
        limit 100
      ) r
    ), '[]'::jsonb),
    'projects', coalesce((
      select jsonb_agg(
               jsonb_build_object(
                 'title',       p.title,
                 'category',    p.category,
                 'description', p.description,
                 'months',      p.months,
                 'photos', coalesce((
                   select jsonb_agg(
                            jsonb_build_object(
                              'url',       ph.url,
                              -- Before/After labels are a member perk; the
                              -- photos themselves show for every pro.
                              'is_before', ph.is_before and m.live
                            ) order by ph.sort asc, ph.created_at asc)
                   from public.pro_project_photos ph
                   where ph.project_id = p.id
                 ), '[]'::jsonb)
               ) order by p.sort asc, p.created_at asc)
      from (
        select id, title, category, description, months, sort, created_at
        from public.pro_projects
        where contractor_id = c.id
        order by sort asc, created_at asc
        limit 12
      ) p
    ), '[]'::jsonb)
  )
  from public.contractors c
  cross join lateral (
    -- Mirrors hasProPlan(): a pro_ plan, active or trialing, not past a known
    -- period end. Perks only; it gates NOTHING about rating or reviews above,
    -- and as of 0109 nothing about the license/insurance trust booleans either.
    select exists (
      select 1
      from public.subscriptions s
      where s.user_id = c.user_id
        and s.plan like 'pro\_%'
        and s.status in ('active', 'trialing')
        and (s.current_period_end is null or s.current_period_end > now())
    ) as live
  ) m
  where c.id = p_contractor
    -- 0132: the same two visibility filters browse_pros() and the sitemap
    -- already apply, moved into the ONE function that serves the public page.
    --   user_id is not null  - an unclaimed/seeded row has nobody standing
    --                          behind it, so /p/<id> was a real, indexable,
    --                          shareable business page for a company that has
    --                          never had an account here. Reviews, categories,
    --                          the "license on file" badge, all of it, with no
    --                          owner to be accountable for any of it.
    --   serves_orange_county - the launch-market gate. A pro outside it cannot
    --                          be reached through the product at all, so the
    --                          page was a dead end that still ranked.
    -- Returning nothing makes /p/<id> render its not-found page, which is what
    -- browse and the sitemap were already telling everyone.
    and c.user_id is not null
    and coalesce(c.serves_orange_county, false);
$$;

grant execute on function public.public_pro_profile(uuid) to anon;
grant execute on function public.public_pro_profile(uuid) to authenticated;


-- =============================================================================
-- RISK / VERIFICATION NOTES
--
-- 1. Parts 4 and 5 are copies. Diff them against 0124's open_jobs_for_me and
--    0132's apply_to_lead: the ONLY differences should be the two blocks
--    marked "0138". Signatures are byte-identical, so CREATE OR REPLACE keeps
--    both functions' EXECUTE grants.
--
-- 2. Part 7 DROPs contractor_reviews, which is the one destructive statement
--    in this file. Between the drop and the create (same transaction when run
--    as one paste) nothing can call it. Callers:
--    src/app/(app)/contractors/ContractorReviews.tsx only. Its client reads
--    fields by name off the returned rows, so the added column is additive.
--
-- 3. Dry run for the block itself, on a copy:
--      insert into user_blocks (blocker_user_id, blocked_user_id)
--        values ('<homeowner>', '<pro user>');
--    then, as the pro: open_jobs_for_me() no longer returns that homeowner's
--    jobs; apply_to_lead('<their lead>', 'hi') raises 'This job is not
--    available to you.'; an insert into messages on a shared thread raises
--    'You can no longer message this person...'; a system-role insert whose body is
--    exactly 'Conversation reopened.' still succeeds, while a system-role
--    insert with any other body is refused by that same sentence. Delete the
--    row and all of them reverse.
--
-- 4. Self-block is refused by user_blocks_not_self. Confirm:
--      insert into user_blocks (blocker_user_id, blocked_user_id)
--        values ('<u>', '<u>');  -- must fail
--
-- 5. reports: an old row (lead_id set, target null) still satisfies both new
--    CHECK constraints, so the ALTERs cannot fail on existing data. Confirm
--    with: select count(*) from public.reports where lead_id is null
--      and (target_type is null or target_id is null);  -- must be 0
--
-- 6. Execute grants on the two helpers. blocked_between must show service_role
--    and nothing else; lead_has_block must still show authenticated:
--      select p.proname, p.proacl::text
--        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--       where n.nspname = 'public'
--         and p.proname in ('blocked_between', 'lead_has_block');
--    Then, signed in as an ordinary account, this must fail with 42501:
--      select public.blocked_between('<a>'::uuid, '<b>'::uuid);
--
-- 7. lead_has_block's caller guard. Signed in as somebody who is on neither
--    side of <lead>, it must return false even when a block really does sit
--    between that lead's two parties:
--      select public.lead_has_block('<someone else''s lead>'::uuid);  -- false
--    On a lead you ARE on, it must still return true while the block exists,
--    and the message insert must still be refused with the sentence from
--    enforce_message_not_blocked. That is the case item 3 already walks.
-- =============================================================================
