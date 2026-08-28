-- =============================================================================
-- Hearth - first-run app guide, "seen" stamps (0137)
-- RUN THIS AGAINST THE LIVE DATABASE (Supabase SQL editor); editing repo SQL
-- alone does NOT change the already-deployed database.
--
-- WHY THIS EXISTS
-- The phone landing page is being cut down to a sign-in button and little
-- else: somebody who installed the app already knows what Hearth is, and
-- everything else was in the way of the two taps they came for. The explaining
-- moves to the first screen AFTER sign-in - four short cards, one set for
-- homeowners, one for contractors (src/components/AppGuide.tsx) - shown once
-- and then never again.
--
-- "Never again" is the whole point of these two columns. The browser also
-- remembers in localStorage (so a slow write can't show it twice in one
-- session), but localStorage is per-device: without a stamp on the account,
-- the same person gets the same tour again the first time they open Hearth on
-- a laptop. Null means "has not been through it"; the timestamp is stamped by
-- markGuideSeenAction (src/lib/appGuideActions.ts) the moment they close it,
-- whether they read all four cards or tapped Skip on the first.
--
-- TWO COLUMNS, NOT ONE, because one account can hold both sides at once (a pro
-- who also owns a home - see the notes in both layouts), the two guides say
-- completely different things, and finishing the homeowner one must not
-- silently eat the pro one.
--
-- NO NEW POLICY OR GRANT NEEDED. The "users self select" and "users self
-- update" policies from migration 0002 already cover a user reading and
-- writing their own row, which is exactly and only what this needs - the
-- action updates through the caller's own session client filtered to their own
-- id, so RLS is the second lock on it. Same shape as free_plan_used_at (0101)
-- and notification_prefs (0022), which added columns here the same way.
--
-- NOTHING BREAKS IF YOU DELAY THIS. AppGuideMount reads the stamp through a
-- select *, so a database without these columns just reports "not seen", and
-- the localStorage mirror carries the feature at once-per-browser until the
-- SQL is pasted. The update in markGuideSeenAction errors and is swallowed.
--
-- Safe to re-run: both statements are idempotent.
-- =============================================================================

alter table public.users
  add column if not exists guide_seen_at timestamptz;

alter table public.users
  add column if not exists pro_guide_seen_at timestamptz;

comment on column public.users.guide_seen_at is
  'When this account closed the homeowner first-run app guide (src/components/AppGuide.tsx). Null = never shown yet. Stamped once, never cleared by the app.';
comment on column public.users.pro_guide_seen_at is
  'When this account closed the contractor first-run app guide. Separate from guide_seen_at because one account can hold both sides.';
