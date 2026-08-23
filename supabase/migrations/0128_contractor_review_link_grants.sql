-- =============================================================================
-- Hearth - column grants for the review-link columns, plus an address length
-- cap on properties (0128)
-- RUN THIS AGAINST THE LIVE DATABASE (Supabase SQL editor); editing repo SQL
-- alone does NOT change the already-deployed database.
--
-- ---------------------------------------------------------------------------
-- 1. WHY EVERY PRO PROFILE SAVE WAS 500ing
-- ---------------------------------------------------------------------------
-- 0085 revoked the TABLE-LEVEL update/insert privilege on public.contractors
-- from `authenticated` and re-granted both scoped to an explicit column
-- allowlist. That is the correct lock, and it does exactly what it says: any
-- write touching a column NOT in the list fails with 42501 permission denied.
--
-- 0113 then added two new columns - yelp_url and google_reviews_url - and did
-- not extend the allowlist, because a `alter table ... add column` cannot know
-- about a grant written three migrations earlier. PublicProfileForm posts BOTH
-- fields on every save (they are ordinary optional inputs, so an empty box
-- still posts an empty string), which means saveCompanyAction() has put both
-- columns into the UPDATE payload on every single profile save since 0113
-- shipped. Result: `permission denied for table contractors`, a hard 500 on
-- POST /pro/profile for every pro, whether or not they typed a review link.
--
-- The same applies to INSERT: 0085 re-granted INSERT by column too, and the
-- pro-onboarding insert carries the same two fields when the onboarding form
-- posts them.
--
-- THE FIX: extend 0085's allowlist by exactly two columns, on both privileges.
-- Nothing else about 0085's lock changes - the trust columns
-- (license_verified_*, background_check_*, balance, rating, review_count) stay
-- out, which is the whole point of that migration.
--
-- These two are safe for a pro to write directly: they are the pro's own
-- outbound links, validated server-side by src/lib/reviewLinks.ts before the
-- write, and rendered only as plain "See our reviews" buttons. They are not
-- trust signals Hearth asserts - the public page says outright that reviews on
-- outside sites are not verified by Hearth - so a pro writing their own value
-- here forges nothing.
--
-- DELIBERATELY NOT INCLUDED: `slug`. 0085 left it out with a note to grant it
-- "if/when a slug editor ships". Re-checked against the current tree: no
-- user-scoped (createClient(), i.e. `authenticated`) call site writes slug -
-- src/app/pro/actions.ts, src/app/pro/profile/actions.ts and
-- src/app/api/pro-compliance/route.ts all read it and never write it, and the
-- only writers are service-role paths that bypass grants anyway. So slug is NOT
-- in the same situation as the two review-link columns and is left alone: a pro
-- being able to rewrite their own public URL is a real decision (link rot,
-- squatting a competitor's name) that should ship with the editor, not ahead of
-- it.
--
-- ---------------------------------------------------------------------------
-- 2. ADDRESS LENGTH CAP ON properties
-- ---------------------------------------------------------------------------
-- properties.address_line1 is plain `text` with no ceiling. The onboarding
-- form caps it at 200 characters in the browser and claimPropertyAction caps
-- it server-side, but a server action takes whatever it is handed, and the
-- column itself has never said no. 200 matches MAX_ADDRESS_LENGTH in
-- OnboardingForm.tsx and the cap the action already applies, so this constraint
-- rejects nothing an honest claim produces.
--
-- Added NOT VALID first, then VALIDATE as a separate statement: NOT VALID takes
-- only a brief lock and starts enforcing on every new/updated row immediately,
-- and VALIDATE then scans the existing table without blocking writes. If any
-- legacy row somehow exceeds 200 characters, the VALIDATE is the statement that
-- fails - the constraint still stands and still guards every future write, and
-- the offending rows can be trimmed and the validate re-run.
--
-- Safe to re-run: the grants are idempotent (re-asserting a held privilege is
-- not an error) and the constraint is added only when absent.
-- =============================================================================

-- ---- 1. review-link column grants -------------------------------------------
grant update (yelp_url, google_reviews_url) on public.contractors to authenticated;
grant insert (yelp_url, google_reviews_url) on public.contractors to authenticated;

-- `anon` gets nothing, same as 0085: every contractors write requires a
-- signed-in session.

-- ---- 2. properties.address_line1 length cap ---------------------------------
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.properties'::regclass
      and conname = 'properties_address_line1_len'
  ) then
    alter table public.properties
      add constraint properties_address_line1_len
      check (char_length(address_line1) <= 200) not valid;
  end if;
end
$$;

alter table public.properties validate constraint properties_address_line1_len;
