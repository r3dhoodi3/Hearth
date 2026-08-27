-- =============================================================================
-- Hearth - in-app review prompt and private feedback (0133)
-- RUN THIS AGAINST THE LIVE DATABASE (Supabase SQL editor); editing repo SQL
-- alone does NOT change the already-deployed database.
--
-- WHY THIS EXISTS
-- The owner wants Hearth to ask happy users for a store review without ever
-- routing an unhappy one to the native store prompt first. The flow is:
--   1. Our own small card asks "Enjoying Hearth?" with "Love it" / "Not really".
--   2. "Love it" shows a thank-you and, on the web, a plain link to the App
--      Store (native wrapper work is a separate stub, see requestNativeReview()
--      in src/lib/reviewPrompt.ts). Nothing negative ever reaches the store.
--   3. "Not really" routes to the private /feedback form instead, which lands
--      here, not on any public review surface.
--
-- ONE TABLE does double duty: it is both the private feedback inbox (message +
-- optional contact email) AND the event ledger that keeps the prompt from
-- nagging (kind = 'prompt_shown' | 'loved' | 'not_really'). A row with kind
-- 'prompt_shown' is written the moment the card actually renders, BEFORE the
-- user does anything, which is what makes "at most once per account" hold even
-- for someone who dismisses it with the X and never answers: the app only ever
-- checks "does ANY row exist for this user", never which kind.
--
-- PRIVACY POSTURE: a user can INSERT their own row (the prompt logging its own
-- events, and the feedback form saving what someone typed) and can read
-- NOTHING back, same as support_messages' insert half but without the
-- matching self-select. The prompt's "has this account already been shown or
-- answered" check has to run BEFORE a decision to show is made, which means it
-- has to run as a query the account itself cannot perform - so it is answered
-- by the service-role client (src/app/(app)/feedback/actions.ts), never by the
-- browser's own session. That is also why a homeowner can never see their own
-- past "not really" or read anyone's feedback: this is a one-way mailbox.
--
-- Safe to re-run: every statement is idempotent.
-- =============================================================================

create table if not exists public.app_feedback (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users (id) on delete cascade,
  -- Which shell the account was using when this row was written. Only the
  -- homeowner shell is wired up today (src/app/(app)/layout.tsx); 'pro' is
  -- here so the same table can carry the pro side later without a migration.
  side          text not null default 'homeowner' check (side in ('homeowner', 'pro')),
  -- The event this row records. 'prompt_shown' is the gate: its mere
  -- existence for a user_id is what stops the card from ever appearing again,
  -- independent of whether the person answered it. 'loved' and 'not_really'
  -- are the two buttons on the card.
  kind          text not null check (kind in ('prompt_shown', 'loved', 'not_really')),
  -- The private feedback form's own fields, both null on the two prompt-event
  -- rows above. `message` is "what would make it better"; `contact_email` is
  -- only set when the homeowner opts in to being contacted about it.
  message       text,
  contact_email text,
  created_at    timestamptz not null default now()
);
create index if not exists app_feedback_user_id_idx on public.app_feedback (user_id);

alter table public.app_feedback enable row level security;

-- A user can insert their own row (either kind of prompt event, or the
-- feedback form) and nothing else: no select, update, or delete policy exists
-- for `authenticated`, which is what makes this a one-way mailbox rather than
-- a place someone could read their own or anyone else's feedback back out.
drop policy if exists "app_feedback self insert" on public.app_feedback;
create policy "app_feedback self insert" on public.app_feedback
  for insert to authenticated
  with check (user_id = auth.uid());

comment on table public.app_feedback is
  'Review-prompt event log ("prompt_shown"/"loved"/"not_really") and the private feedback form it routes an unhappy answer to. Insert-your-own-row only for authenticated: no select policy exists, so nobody can read a row back, including their own. The service role reads everything.';
