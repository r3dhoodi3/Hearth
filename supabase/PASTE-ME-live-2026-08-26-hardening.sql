-- ============================================================================
-- HEARTH LIVE-DB BUNDLE: migration 0132 (2026-08-26)
--
-- THIS FILE IS IN TWO PARTS AND THEY ARE RUN SEPARATELY.
--
--   PART A - six read-only SELECT queries. Run these FIRST, on their own.
--            Every one must come back with ZERO rows.
--   PART B - the migration. Run this ONLY once Part A is clean.
--
-- DO NOT paste the whole file at once. Part B adds CHECK constraints and then
-- VALIDATEs them, and a VALIDATE that hits one bad row raises an error. If
-- both parts were run as one statement batch, that error would take the whole
-- paste down with it - including the parts that had nothing to do with the bad
-- row - and you would have to work out how far it got. Part A tells you the
-- answer before anything is written, in a form you can act on: each query
-- returns the exact rows that would fail, with the id and the offending value.
--
-- Part B is safe to re-run: every statement in it is idempotent.
-- Live DB should be at 0131 before this. After running, live is at 0132.
--
-- ORDER MATTERS. 0130 (account risk) MUST already be applied: this migration's
-- has_open_chargeback() reads abuse_flags, and the new leave_review gate reads
-- account_signals. Both are written to survive those tables being absent (they
-- fail OPEN: nobody is frozen and nobody is refused a review), so running this
-- out of order does not break anything - it just quietly does less than it
-- says. Run 0130 first and both gates come alive with no further work.
--
-- 0130 ALSO CHANGED. It gained one column, abuse_flags.cleared_at, which is
-- how a resolved dispute gets un-frozen without deleting the record that it
-- happened. If you have ALREADY run the 0130 bundle, run this one line before
-- Part B, or just run it anyway - it is idempotent:
--
--   alter table public.abuse_flags add column if not exists cleared_at timestamptz;
--
-- ----------------------------------------------------------------------------
-- CHECK THE PROJECT REF BEFORE YOU RUN PART B
-- ----------------------------------------------------------------------------
-- The logo_url constraint contains a hard-coded storage host:
--
--   https://tubkvvfkwggaddcmcjqv.supabase.co
--
-- A CHECK constraint is a stored expression; it cannot read an environment
-- variable, so the project ref has to be written out. CONFIRM THAT REF IS THE
-- PRODUCTION PROJECT before running Part B. If it is not - a restored project,
-- a new ref, a different environment - edit the literal in Part B first, in
-- both the constraint and Part A's query P1, or every logo save will start
-- failing the moment this lands.
--
-- Compare it against NEXT_PUBLIC_SUPABASE_URL in the deployed environment, not
-- against .env.local.example: the example file's value carries a TRAILING
-- SLASH (`https://your_project_ref.supabase.co/`), and the constraint's
-- literal has none, because that is the shape Supabase Storage actually
-- produces in a stored URL. Do not copy the trailing slash into the literal.
--
-- ----------------------------------------------------------------------------
-- WHAT THIS IS, in one line each
-- ----------------------------------------------------------------------------
--   1. CHECK constraints on the six contractors columns a pro can write
--      directly over PostgREST, so the server-action validators stop being the
--      only thing enforcing them.
--   2. lead_previews loses its last SELECT grant (authenticated). Zero readers
--      in the app; it was publishing live lead ids to every account.
--   3. has_open_chargeback(), and a freeze on apply_to_lead and
--      unlock_direct_request while a pro has an open payment dispute.
--   4. leave_review refuses a reviewer whose account shares a card, an email,
--      or a phone number with the pro being reviewed.
--   5. public_pro_profile stops serving pros that browse and the sitemap hide.
--
-- NOTHING A CUSTOMER DOES TODAY CHANGES SHAPE. Reviews still work exactly as
-- they do now: an assigned pro is the requirement, same as always. An earlier
-- draft of this migration also demanded the job be marked 'closed' first; it
-- was withdrawn, because only the PRO can set that status and the rule would
-- have handed the reviewed party a veto over their own reviews.
--
-- ============================================================================
-- PART A - PRE-CHECKS. RUN THIS PART FIRST, BY ITSELF.
-- ============================================================================
-- Six read-only queries. Nothing here writes anything.
--
-- WHAT YOU WANT: six empty results.
-- IF ONE RETURNS ROWS: fix those values (each query says how), then re-run
-- that query until it is empty, then run Part B.

-- P1. logo_url pointing anywhere other than this pro's own folder in the
--     pro-logos bucket. Three shapes are legal, because legacy rows hold a
--     bare object path rather than a full public URL, and the share-card
--     routes already normalize both:
--       https://<project>.supabase.co/storage/v1/object/public/pro-logos/<id>/...
--       pro-logos/<id>/...
--       <id>/...
--     A row here holds something none of those cover. FIX: set it to null (the
--     public page falls back to the business name, nothing else breaks), or
--     have the pro re-upload through /pro/profile.
select id, name, logo_url
  from public.contractors
 where logo_url is not null
   and not (
     logo_url not like '%..%'
     and (
       logo_url like
         'https://tubkvvfkwggaddcmcjqv.supabase.co/storage/v1/object/public/pro-logos/'
         || id::text || '/%'
       or ltrim(logo_url, '/') like 'pro-logos/' || id::text || '/%'
       or ltrim(logo_url, '/') like id::text || '/%'
     )
   );

--     If P1 returns rows and you have looked at them and they are all junk,
--     this is the one-line clear. Read the list first; this blanks logos.
--   update public.contractors set logo_url = null
--    where logo_url is not null
--      and not (
--        logo_url not like '%..%'
--        and (
--          logo_url like
--            'https://tubkvvfkwggaddcmcjqv.supabase.co/storage/v1/object/public/pro-logos/'
--            || id::text || '/%'
--          or ltrim(logo_url, '/') like 'pro-logos/' || id::text || '/%'
--          or ltrim(logo_url, '/') like id::text || '/%'
--        )
--      );

-- P2. contact_phone that is not phone-shaped, or is longer than 20 characters.
--     THIS IS THE ONE MOST LIKELY TO RETURN SOMETHING: the app caps this field
--     at 40 characters and checks nothing else, so an "ext 12" suffix or a
--     second number in the same box lands here. FIX: trim each one to a single
--     number by hand. These are real pros' phone numbers, so do not bulk-null
--     them.
select id, name, contact_phone, char_length(contact_phone) as len
  from public.contractors
 where contact_phone is not null
   and contact_phone !~ '^[0-9+(). -]{7,20}$';

-- P3. yelp_url that is not a yelp.com business page.
--     FIX: set to null, or correct the address.
select id, name, yelp_url
  from public.contractors
 where yelp_url is not null
   and (
     char_length(yelp_url) > 300
     or yelp_url !~* '^https://(www\.|m\.)?yelp\.com/biz/'
   );

-- P4. google_reviews_url that is not on a Google business/reviews host.
--     FIX: set to null, or correct the address.
select id, name, google_reviews_url
  from public.contractors
 where google_reviews_url is not null
   and (
     char_length(google_reviews_url) > 300
     or google_reviews_url !~*
       '^https://(www\.google\.com|google\.com|maps\.google\.com|maps\.app\.goo\.gl|g\.page|g\.co|share\.google)([/?#]|$)'
   );

-- P5. name longer than 200 characters. FIX: shorten it, in agreement with the
--     pro - this is their business name.
select id, char_length(name) as len, left(name, 80) as name_start
  from public.contractors
 where char_length(name) > 200;

-- P6. about longer than 1,000 characters. FIX: trim it.
select id, name, char_length(about) as len
  from public.contractors
 where about is not null and char_length(about) > 1000;

-- ============================================================================
-- END OF PART A. Six empty results? Then run PART B below.
-- ============================================================================

-- ============================================================================
-- PART B - THE MIGRATION. Run this only once every Part A query is empty.
-- ============================================================================

-- >>>>>>>>>> BEGIN 0132_public_column_constraints.sql >>>>>>>>>>

-- =============================================================================
-- Hearth - CHECK constraints on the columns a pro can write directly, an open
-- chargeback freeze, and two review-integrity gates (0132)
-- RUN THIS AGAINST THE LIVE DATABASE (Supabase SQL editor); editing repo SQL
-- alone does NOT change the already-deployed database. 0131 is the last
-- migration in this folder, so this is the next one to apply, in order, with
-- no gaps. 0130 in particular must be applied BEFORE this one: has_open_
-- chargeback() reads abuse_flags, and the leave_review gate reads
-- account_signals.
--
-- WHY THIS EXISTS
--
-- 1. THE APP-LAYER VALIDATORS ON contractors ARE OPTIONAL, AND ALWAYS WERE.
--    0085 revoked the table-level UPDATE on public.contractors and re-granted
--    it column by column; 0124 and 0128 extended that allowlist. What that
--    means in practice is that `authenticated` holds a DIRECT column UPDATE on
--    contractors.logo_url, contact_phone, name, about, yelp_url and
--    google_reviews_url. Supabase publishes the table over PostgREST with the
--    public anon key and the caller's own session JWT, so a pro never has to
--    call savePublicPageAction or saveCompanyAction at all:
--
--      PATCH /rest/v1/contractors?id=eq.<my id>
--      { "logo_url": "https://attacker.example/x.png" }
--
--    goes straight through. Every one of these fields is validated carefully
--    in src/app/pro/actions.ts and src/app/pro/profile/actions.ts, and every
--    one of those checks is skippable. isOwnedStoragePath, the reviewLinks.ts
--    host allowlist, the 200/1000-character caps: all of them are advice.
--
--    So the same rules are restated as CHECK constraints, which PostgREST
--    cannot skip. The point is not that the app checks are wrong - they are
--    right, and they stay, because they produce a friendly message instead of
--    a 400. The point is that until now nothing enforced them.
--
--    logo_url matters most: it is fetch()ed SERVER-SIDE by /api/win-card and
--    /api/review-card to inline the logo into a share image. A pro who can
--    write an arbitrary URL there has a server-side request forgery primitive
--    pointed at anything the Vercel function can reach. Those two routes now
--    also re-check the origin and refuse redirects, but the column being
--    unable to hold a foreign URL in the first place is the real fix.
--
--    ADDED NOT VALID FIRST, THEN VALIDATED as a separate statement, the same
--    shape 0128 used. NOT VALID takes a brief lock and starts enforcing on
--    every new and updated row immediately; VALIDATE then scans the existing
--    rows without blocking writes. If a legacy row breaks one of these rules,
--    the VALIDATE is the statement that FAILS, loudly, and that is deliberate:
--    a silent pass would leave the operator believing rows were checked when
--    they were not. The constraint still stands and still guards every future
--    write. Fix the row and re-run the one validate. The PASTE-ME file for
--    this migration carries a pre-check query per constraint that lists
--    exactly which rows would fail, so this can be settled before anything is
--    run.
--
-- 2. lead_previews IS STILL READABLE BY EVERY SIGNED-IN ACCOUNT.
--    0120 revoked the anon SELECT and stopped there, because that was the
--    finding at the time. The view runs with its OWNER's rights, so RLS on
--    contractor_leads does not apply to it, and it publishes a row per open
--    lead - including the lead id. Nothing in src/ has ever read it: the only
--    reference anywhere is the generated row type in database.types.ts. An
--    unused view that leaks real lead ids to every account on the platform is
--    not worth keeping open, and a lead id is the parameter every RPC in the
--    money path takes.
--
-- 3. A PRO CAN KEEP SPENDING WHILE A CHARGEBACK IS OPEN.
--    The Stripe webhook writes an abuse_flags row of kind 'chargeback' on
--    charge.dispute.created (0130). Nothing read it at the moment a pro buys
--    something. A wallet top-up that has been charged back is money the
--    platform has already lost, and the wallet balance still shows it, so the
--    disputed funds buy leads until somebody notices by hand.
--    has_open_chargeback() plus the two gates below close that. 0130 gains a
--    cleared_at column in the same pass so a dispute that is won or withdrawn
--    can be resolved without deleting the history that it happened.
--
-- 4. A PRO COULD REVIEW THEMSELVES FROM A SECOND ACCOUNT.
--    leave_review()'s bar was "a pro is assigned", and 0082 added "and the
--    reviewer is not literally the pro's own account". That second check is
--    one signup away from useless: make a second account, post a job, get
--    assigned to it, leave five stars. The rating on /p/<slug> is the number
--    homeowners choose on. ONE gate below closes it, using the account_signals
--    links (0130) the trial-abuse scorer already records - a shared card,
--    email or phone between reviewer and pro.
--
--    NOT ADDED, deliberately: a requirement that the job be 'closed' first. A
--    draft carried one. Only the PRO can set that status (it is a stage in
--    their own CRM), so the rule would have handed the reviewed party a veto
--    over their own reviews, and the pro least likely to close a job is the
--    one who did it worst. The full reasoning is in the function body.
--
-- 5. /p/<id> SERVED PAGES browse AND THE SITEMAP BOTH HIDE.
--    public_pro_profile() filtered on the contractor id alone, while
--    browse_pros() and src/app/sitemap.ts both also require user_id is not
--    null and serves_orange_county. So an unclaimed, seeded, or out-of-market
--    row still had a full public business page. The predicate moves into the
--    function, which is the one place every caller goes through.
--
-- WHAT DOES NOT CHANGE: no column is dropped, no data is rewritten, no RLS
-- policy is touched, no price moves, and every function re-issued below is a
-- COPY of its latest definition with the named lines added and nothing else
-- edited. Signatures are unchanged, so CREATE OR REPLACE preserves each
-- function's existing EXECUTE grants.
--
-- Idempotent: every constraint is added only when absent, REVOKE is naturally
-- re-runnable, and the functions are CREATE OR REPLACE. Safe to re-run.
-- =============================================================================


-- =============================================================================
-- Part 1: CHECK constraints on the pro-writable columns of public.contractors
-- =============================================================================
-- THE STORAGE HOST IS WRITTEN OUT LITERALLY, ON PURPOSE.
-- A CHECK constraint is stored as a parsed expression; it cannot read an
-- environment variable, and current_setting() would only move the problem to a
-- database setting nothing else in this schema uses. So the value below is the
-- project's own NEXT_PUBLIC_SUPABASE_URL, copied by hand:
--
--   https://tubkvvfkwggaddcmcjqv.supabase.co
--
-- IF THE SUPABASE PROJECT IS EVER MOVED OR RESTORED UNDER A NEW REF, THIS
-- CONSTRAINT HAS TO BE RE-ISSUED WITH THE NEW HOST, or every logo save starts
-- failing. That is the trade for having the rule enforced at all, and it is
-- the same host isOwnedStoragePath (src/app/pro/profile/actions.ts) derives
-- from the environment at runtime.
--
-- THREE SHAPES ARE ACCEPTED, NOT ONE.
-- savePublicPageAction writes the full public URL:
--   <supabase url>/storage/v1/object/public/pro-logos/<contractor id>/<key>
-- but LEGACY ROWS HOLD A BARE OBJECT PATH. That is not speculation: it is
-- written down in both card routes (src/app/api/win-card/[leadId]/route.tsx,
-- src/app/api/review-card/[reviewId]/route.tsx), whose absoluteLogoUrl()
-- exists specifically to turn a stored bare path into a fetchable URL, and it
-- strips a leading slash and an optional "pro-logos/" prefix on the way. A
-- constraint that accepted only the full URL would fail to VALIDATE against
-- every one of those rows, and the operator's only options would be to blank
-- a pro's logo or to skip the constraint.
--
-- So all three live shapes are allowed, and every one of them is still pinned
-- to THIS row's own contractor id:
--   https://<project>.supabase.co/storage/v1/object/public/pro-logos/<id>/...
--   pro-logos/<id>/...
--   <id>/...
-- ltrim(logo_url, '/') covers the leading-slash variants of the last two,
-- exactly as absoluteLogoUrl does. ltrim(text, text) is immutable, so it is
-- legal in a CHECK.
--
-- The trailing id and slash are what scope a logo to the pro who owns it, and
-- `id` inside a CHECK refers to this row's own id, so one constraint covers
-- every pro.
--
-- The "not like" clause is the traversal half. LIKE knows nothing about path
-- normalization, so without it a value ending in a parent-directory hop
-- satisfies the prefix and still resolves somewhere else entirely.
-- isOwnedStoragePath gets that for free by parsing with new URL(); a LIKE has
-- to say it out loud. It is applied to all three shapes.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.contractors'::regclass
      and conname = 'contractors_logo_url_owned'
  ) then
    alter table public.contractors
      add constraint contractors_logo_url_owned
      check (
        logo_url is null
        or (
          logo_url not like '%..%'
          and (
            logo_url like
              'https://tubkvvfkwggaddcmcjqv.supabase.co/storage/v1/object/public/pro-logos/'
              || id::text || '/%'
            or ltrim(logo_url, '/') like 'pro-logos/' || id::text || '/%'
            or ltrim(logo_url, '/') like id::text || '/%'
          )
        )
      ) not valid;
  end if;
end
$$;

alter table public.contractors validate constraint contractors_logo_url_owned;

-- contact_phone: a phone-shaped string or nothing. Digits, the punctuation a
-- person actually types, and a length window wide enough for a full
-- "+1 (714) 555-0100" and narrow enough that the column stops being a free
-- text field. saveCompanyAction caps this at 40 characters and checks nothing
-- else, so today it will happily store a sentence.
--
-- The hyphen is written LAST inside the bracket expression rather than
-- escaped: in a bracket expression a trailing hyphen is a literal hyphen, and
-- that sidesteps the question of how a backslash behaves inside brackets in
-- this dialect. The set is character for character the one the audit asked
-- for: digits, plus, parentheses, period, space, hyphen.
--
-- NOTE FOR THE OPERATOR: the app still caps this field at 40 characters
-- (cappedFieldOrNull in src/app/pro/actions.ts) while this constraint stops at
-- 20, and the app allows characters this does not (an "ext 12" suffix, for
-- instance). That gap is why the pre-check query in the PASTE-ME file matters:
-- this is the one constraint here that can refuse a value an honest pro typed.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.contractors'::regclass
      and conname = 'contractors_contact_phone_shape'
  ) then
    alter table public.contractors
      add constraint contractors_contact_phone_shape
      check (
        contact_phone is null
        or contact_phone ~ '^[0-9+(). -]{7,20}$'
      ) not valid;
  end if;
end
$$;

alter table public.contractors validate constraint contractors_contact_phone_shape;

-- yelp_url / google_reviews_url: the same host and path rules validateYelpUrl
-- and validateGoogleReviewsUrl apply in src/lib/reviewLinks.ts, plus that
-- file's MAX_LEN of 300. Matched case-insensitively because the JS check
-- lowercases the hostname before comparing but stores the string as typed, so
-- an uppercase host is a value the app accepts today.
--
-- These two are the columns 0128 handed `authenticated` a direct grant on, and
-- they render as outbound "See our reviews" buttons on the public page. An
-- unconstrained column here is an open redirect with a pro's name on it.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.contractors'::regclass
      and conname = 'contractors_yelp_url_shape'
  ) then
    alter table public.contractors
      add constraint contractors_yelp_url_shape
      check (
        yelp_url is null
        or (
          char_length(yelp_url) <= 300
          and yelp_url ~* '^https://(www\.|m\.)?yelp\.com/biz/'
        )
      ) not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.contractors'::regclass
      and conname = 'contractors_google_reviews_url_shape'
  ) then
    alter table public.contractors
      add constraint contractors_google_reviews_url_shape
      check (
        google_reviews_url is null
        or (
          char_length(google_reviews_url) <= 300
          and google_reviews_url ~*
            '^https://(www\.google\.com|google\.com|maps\.google\.com|maps\.app\.goo\.gl|g\.page|g\.co|share\.google)([/?#]|$)'
        )
      ) not valid;
  end if;
end
$$;

alter table public.contractors validate constraint contractors_yelp_url_shape;
alter table public.contractors validate constraint contractors_google_reviews_url_shape;

-- name and about: the caps the two server actions already apply (200 and
-- 1,000), restated where they cannot be skipped. Both strings are rendered
-- verbatim on the public /p/<slug> page, the browse cards and the share
-- images, so an unbounded paste lands in front of homeowners.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.contractors'::regclass
      and conname = 'contractors_name_len'
  ) then
    alter table public.contractors
      add constraint contractors_name_len
      check (char_length(name) <= 200) not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.contractors'::regclass
      and conname = 'contractors_about_len'
  ) then
    alter table public.contractors
      add constraint contractors_about_len
      check (about is null or char_length(about) <= 1000) not valid;
  end if;
end
$$;

alter table public.contractors validate constraint contractors_name_len;
alter table public.contractors validate constraint contractors_about_len;


-- =============================================================================
-- Part 2: lead_previews - revoke the authenticated SELECT grant
-- =============================================================================
-- 0006 granted SELECT to `anon, authenticated`. 0120 revoked anon and left
-- authenticated standing, "in case a signed-in surface ever wants it". No
-- signed-in surface has ever wanted it: a grep of src/ finds zero readers, the
-- only reference is the generated row type. Meanwhile the view runs with owner
-- rights over contractor_leads with no RLS behind it, and one of the columns
-- it publishes is the lead id - the parameter apply_to_lead,
-- unlock_direct_request, choose_applicant and leave_review all take. Handing
-- every signed-in account a list of live lead ids is a starting point for
-- every one of those, and the view earns nothing back.
--
-- Nothing else is dropped. The view stays defined so its history and its
-- warning comment survive, and re-granting it later is one line - by which
-- point somebody will have had to decide what reads it.
revoke select on public.lead_previews from authenticated;

comment on view public.lead_previews is
  'UNUSED public job-board feed, NOW READABLE BY NOBODY: the anon SELECT was '
  'revoked in 0120 and the authenticated SELECT in 0132. Nothing in src/ has '
  'ever read it. It runs with owner rights over contractor_leads with no RLS '
  'behind it and publishes real lead ids, which are the parameter every RPC in '
  'the money path takes. Do not re-grant without deciding what reads it and '
  'why. NEVER add homeowner_name, homeowner_email, homeowner_phone, '
  'property_address, property_id, issue_id or issue_description.';


-- =============================================================================
-- Part 3: has_open_chargeback(uuid)
-- =============================================================================
-- True while the account behind this contractor carries an abuse_flags row of
-- kind 'chargeback' that nobody has cleared. One question, asked in the two
-- places a pro spends money.
--
-- SECURITY DEFINER because abuse_flags is service-role only (0130: RLS on,
-- zero policies, privileges revoked from anon and authenticated). This
-- function is the one supported way to ask, and it returns a single boolean -
-- never the note, never the timestamp, never the row - so a pro cannot mine it
-- for what support wrote down.
--
-- EXECUTE is granted to service_role ONLY, matching linked_accounts (0130).
-- apply_to_lead and unlock_direct_request still call it fine: they are
-- themselves SECURITY DEFINER, so inside them the effective user is the
-- function owner, who owns this function too. `authenticated` cannot call it
-- directly over PostgREST, which is the point - a pro has no business polling
-- their own abuse status.
--
-- Guarded on abuse_flags existing so a database where 0130 has not been
-- applied gets `false` (fail open, nobody frozen) rather than an undefined
-- table error on every apply. Same posture src/lib/risk/* takes.
create or replace function public.has_open_chargeback(p_contractor uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_open boolean;
begin
  if to_regclass('public.abuse_flags') is null then
    return false;
  end if;

  select exists (
    select 1
      from public.abuse_flags f
      join public.contractors c on c.user_id = f.user_id
     where c.id = p_contractor
       and f.kind = 'chargeback'
       and f.cleared_at is null
  ) into v_open;

  return coalesce(v_open, false);
end;
$$;

revoke all on function public.has_open_chargeback(uuid) from public, anon, authenticated;
grant execute on function public.has_open_chargeback(uuid) to service_role;

comment on function public.has_open_chargeback(uuid) is
  'True while the account behind this contractor has an uncleared abuse_flags '
  'row of kind chargeback. Read by apply_to_lead and unlock_direct_request to '
  'freeze spending during a dispute. Service role only; returns a bare boolean '
  'and never any detail of the flag. Clear a dispute by setting '
  'abuse_flags.cleared_at, which only the service role can write.';


-- =============================================================================
-- Part 4: apply_to_lead - 0126's body, plus the chargeback gate
-- =============================================================================
-- COPY-ONLY. This is 0126's definition character for character with ONE block
-- added, immediately after v_contractor resolves. Nothing later than 0126
-- redefines apply_to_lead in this folder (checked across every migration), so
-- that is the live body. The signature is unchanged, so CREATE OR REPLACE
-- preserves the existing EXECUTE grant to `authenticated`.
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
-- Part 5: unlock_direct_request - 0115's body, plus the same gate
-- =============================================================================
-- COPY-ONLY, same discipline as Part 4. 0115 is the latest definition of
-- unlock_direct_request in this folder (0105 created it, 0115 re-issued it for
-- the intro price, nothing since). One block added in the same position, for
-- the same reason: this is the other place a pro spends wallet money, and a
-- freeze that covered only the job board would just push a disputing pro
-- toward direct requests.
create or replace function public.unlock_direct_request(p_lead uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare
  v_contractor uuid; v_wallet uuid;
  v_direct_to uuid; v_lead_contractor uuid; v_status text; v_category text;
  v_declined timestamptz; v_unlocked timestamptz; v_price bigint;
  v_cash bigint; v_bonus bigint; v_grant_sum bigint; v_bonus_avail bigint;
  v_from_cash bigint; v_from_bonus bigint;
  v_remaining bigint; v_grant record; v_cash_first boolean;
  v_cash_after bigint; v_bonus_after bigint;
begin
  -- Privileged flag: the contractor_leads_locked trigger (0077, latest body
  -- 0088) strips any client write to contractor_id/paid/paid_at/status unless
  -- this session flag is set, exactly as apply_to_lead/choose_applicant do
  -- (0087). Without it, the final assignment UPDATE below would be silently
  -- reverted after the wallet was already debited. Must be the FIRST statement.
  perform set_config('hearth.lead_write', 'on', true);

  select id into v_contractor from contractors where user_id = auth.uid();
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

  -- Lock the lead and price the fee from its age, same as apply_to_lead.
  -- 0113: category is read too, so the intro price below can tell whether
  -- this is a major-tier request.
  select direct_to, contractor_id, status, category,
         direct_declined_at, direct_unlocked_at,
         public.lead_fee_cents(payout_amount, created_at)
    into v_direct_to, v_lead_contractor, v_status, v_category,
         v_declined, v_unlocked, v_price
    from contractor_leads where id = p_lead
    for update;
  if v_direct_to is null then raise exception 'Not a direct request'; end if;
  if v_direct_to <> v_contractor then raise exception 'Not your request'; end if;

  -- Already unlocked: by me -> idempotent success; otherwise impossible.
  if v_lead_contractor is not null then
    if v_lead_contractor = v_contractor then return true; end if;
    raise exception 'Request already assigned';
  end if;
  if v_declined is not null then raise exception 'Request was declined'; end if;
  if v_status <> 'new' then raise exception 'Request no longer available'; end if;

  v_wallet := get_or_create_wallet(v_contractor);
  -- 0065/0087 hardening: FOR UPDATE so a concurrent charge against this same
  -- wallet (a different lead, an apply, a ghost recharge) can't read a stale
  -- balance and push cash/bonus negative.
  select cash_balance_cents, bonus_balance_cents into v_cash, v_bonus
    from wallets where id = v_wallet
    for update;
  v_cash := coalesce(v_cash, 0);
  v_bonus := coalesce(v_bonus, 0);

  -- 0113: first big-ticket lead intro price, after the wallet lock for the
  -- same serialization reason as apply_to_lead (see 0113's header).
  v_price := public.major_lead_price_cents(v_contractor, v_category, v_price);

  -- Only bonus backed by live, unexpired grants is spendable. Capping at the
  -- grant sum makes the insufficient check honest and guarantees the FIFO drain
  -- below finds enough, so it can never zero out grants and then bail after the
  -- lead was already treated as unlockable (0087).
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
    if v_remaining > 0 then return false; end if;  -- safety
  end if;

  update wallets
     set cash_balance_cents  = cash_balance_cents  - v_from_cash,
         bonus_balance_cents = bonus_balance_cents - v_from_bonus,
         updated_at = now()
   where id = v_wallet
   returning cash_balance_cents, bonus_balance_cents into v_cash_after, v_bonus_after;

  -- History row for the paid unlock (also the row ghost_refund_direct marks).
  insert into lead_applications (lead_id, contractor_id, message, status, fee_cents)
    values (p_lead, v_contractor, null, 'chosen', v_price);

  insert into wallet_transactions
    (wallet_id, type, cash_delta_cents, bonus_delta_cents,
     cash_balance_after_cents, bonus_balance_after_cents, lead_id, note)
    values (v_wallet, 'direct_unlock', -v_from_cash, -v_from_bonus,
            v_cash_after, v_bonus_after, p_lead, 'Direct request unlocked');

  -- Assign + open chat: contractor_id set is what unlocks contact and messages.
  update contractor_leads
     set contractor_id = v_contractor, status = 'accepted',
         paid = true, paid_at = now(), direct_unlocked_at = now()
   where id = p_lead;

  return true;
end; $$;

-- =============================================================================
-- Part 6: leave_review - 0082's body, plus the linked-account gate
-- =============================================================================
-- COPY-ONLY, same discipline. 0082 is the latest definition (0017 created it,
-- 0082 added the self-review guard, nothing since). ONE gate added; every
-- other line is 0082's, and the SELECT reads the same two columns it always
-- did. 0082 recorded that leave_review keeps its
-- default PUBLIC/authenticated EXECUTE grant, and CREATE OR REPLACE on an
-- unchanged signature leaves that exactly as it is.
create or replace function public.leave_review(
  p_lead uuid, p_rating smallint, p_comment text
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_contractor uuid;
  v_property   uuid;
  v_pro_user   uuid;
  v_linked     boolean;
begin
  if p_rating is null or p_rating < 1 or p_rating > 5 then
    raise exception 'Rating must be between 1 and 5';
  end if;

  select contractor_id, property_id
    into v_contractor, v_property
    from contractor_leads
   where id = p_lead;

  if v_property is null then
    raise exception 'Job not found';
  end if;
  -- Only the homeowner who owns the job's property can review it.
  if not public.owns_property(v_property) then
    raise exception 'You can only review your own job';
  end if;
  -- And only once a pro was actually assigned to that job.
  if v_contractor is null then
    raise exception 'No pro was assigned to this job';
  end if;

  -- NO STATUS REQUIREMENT, DELIBERATELY. A draft of this migration also
  -- required contractor_leads.status = 'closed', on the reasoning that a
  -- review should mean work that finished. That was withdrawn, and the reason
  -- is worth writing down so nobody adds it back:
  --
  --   ONLY THE PRO CAN SET 'closed'. It is a stage in the pro's own CRM
  --   (src/app/pro/actions.ts). A rule that says "you may review once the job
  --   is closed" therefore hands the reviewed party a veto over their own
  --   reviews: a pro who never advances a job past 'accepted' can never be
  --   reviewed for it, and the pro most motivated to leave it there is exactly
  --   the one who did the worst job. That is a worse failure than the fake
  --   review it was meant to stop, because it is silent and it favours the bad
  --   actor.
  --
  -- The fake-review path it was aimed at is closed by the link gate below
  -- instead, which does not depend on anything the pro controls.
  --
  -- Self-review guard (0080): reject when the caller's account is the same
  -- one linked to the assigned contractor, i.e. an account that owns both
  -- the property and the pro company on this job.
  select user_id into v_pro_user from contractors where id = v_contractor;
  if v_pro_user is not null and v_pro_user = auth.uid() then
    raise exception 'You can not review your own company';
  end if;

  -- 0132's one new gate: the same person with two accounts. 0080 catches only
  -- the literal case - one account owning both sides - which is one signup
  -- away from useless. account_signals (0130) already knows when two accounts
  -- share a payment card, a normalized email address, or a phone number,
  -- because the trial-abuse scorer records exactly that.
  --
  -- Only those three kinds count here, and the choice is the whole point:
  --   card       - the same payment instrument is close to proof of one person
  --   email_norm - the same inbox with the dots and the +tag moved around
  --   phone      - the same number on both accounts
  -- 'device', 'fingerprint', 'ip' and 'parcel' are deliberately EXCLUDED. A
  -- homeowner reviewing the pro who just worked on their house is very likely
  -- to have shared a wifi network with them that afternoon, and a household
  -- shares every one of those signals. Blocking on them would refuse honest
  -- reviews constantly, and a refused honest review is worse than a missed
  -- fake one here: the honest reviewer has no appeal path.
  --
  -- Guarded on the table existing so this function still works on a database
  -- where 0130 has not been applied yet - it degrades to 0080's behaviour
  -- rather than throwing 42P01 at every reviewer. The same fail-open posture
  -- src/lib/risk/* takes.
  if v_pro_user is not null
     and to_regclass('public.account_signals') is not null then
    select exists (
      select 1
        from public.account_signals mine
        join public.account_signals theirs
          on theirs.kind = mine.kind
         and theirs.value_hash = mine.value_hash
       where mine.user_id = auth.uid()
         and theirs.user_id = v_pro_user
         and mine.kind in ('card', 'email_norm', 'phone')
    ) into v_linked;
    if coalesce(v_linked, false) then
      raise exception 'This account is linked to that pro, so it can not leave a review';
    end if;
  end if;

  insert into public.reviews (lead_id, contractor_id, property_id, rating, comment)
    values (p_lead, v_contractor, v_property, p_rating, nullif(btrim(p_comment), ''))
  on conflict (lead_id) do update
    set rating     = excluded.rating,
        comment    = excluded.comment,
        created_at = now();
end;
$$;

-- =============================================================================
-- Part 7: public_pro_profile - 0113's body, plus the visibility predicate
-- =============================================================================
-- COPY-ONLY, same discipline. 0113 is the latest definition (0112 freed the
-- trust badges, 0113 added the two review links, and 0114/0123 touch
-- browse_pros only). Two predicates added to the final WHERE; the entire
-- payload above it is 0113's, unchanged.
--
-- The grants are restated here rather than relied on, because this is the one
-- function in the file whose EXECUTE reaches `anon`: /p/<id> is a signed-out
-- page. CREATE OR REPLACE would have preserved them anyway; saying them out
-- loud means a reader of this file can see exactly who may call it.
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
                 'rating',     r.rating,
                 'comment',    r.comment,
                 'created_at', r.created_at
               ) order by r.created_at desc)
      from (
        select rating, comment, created_at
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

comment on function public.public_pro_profile(uuid) is
  'Public business page payload for /p/<id>. Returns nothing unless the row is '
  'claimed (user_id is not null) and in the launch market '
  '(serves_orange_county), the same two filters browse_pros and the sitemap '
  'apply, so the public page can never show a pro the directory hides.';

-- <<<<<<<<<< END 0132_public_column_constraints.sql <<<<<<<<<<

-- ============================================================================
-- VERIFY (run these after Part B; expected results in the comments)
-- ============================================================================

-- 1. All six CHECK constraints exist AND are validated. Expected: 6 rows, every
--    one with convalidated = true. A row with convalidated = false means the
--    constraint is guarding new writes but its VALIDATE did not finish - go
--    back to the matching Part A query, fix the rows it lists, and run that one
--    `alter table public.contractors validate constraint ...;` again.
--   select conname, convalidated
--     from pg_constraint
--    where conrelid = 'public.contractors'::regclass
--      and conname in (
--        'contractors_logo_url_owned',
--        'contractors_contact_phone_shape',
--        'contractors_yelp_url_shape',
--        'contractors_google_reviews_url_shape',
--        'contractors_name_len',
--        'contractors_about_len'
--      )
--    order by conname;

-- 2. The constraints actually bite. Expected: ERROR on each of these three, and
--    NO row changed. Run them one at a time against a contractor row you own
--    (swap in a real id); each should fail with "violates check constraint".
--   update public.contractors set logo_url = 'https://example.com/x.png' where id = '<a real contractor id>';
--   update public.contractors set contact_phone = 'call me maybe, any time after six' where id = '<a real contractor id>';
--   update public.contractors set yelp_url = 'https://evil.example/biz/x' where id = '<a real contractor id>';

-- 3. lead_previews has NO select grant left, to anyone but its owner.
--    Expected: 0 rows.
--   select grantee, privilege_type
--     from information_schema.role_table_grants
--    where table_schema = 'public'
--      and table_name = 'lead_previews'
--      and grantee in ('anon', 'authenticated');

-- 4. has_open_chargeback exists and is service-role only.
--    Expected: exactly one row, and it says service_role. If `authenticated`
--    or PUBLIC appears here, the revoke did not take.
--   select r.rolname as grantee
--     from pg_proc p
--     cross join lateral aclexplode(p.proacl) a
--     join pg_roles r on r.oid = a.grantee
--    where p.pronamespace = 'public'::regnamespace
--      and p.proname = 'has_open_chargeback'
--      and a.privilege_type = 'EXECUTE';

-- 5. has_open_chargeback answers. Expected: false for any pro with no open
--    dispute, which right after this migration should be every pro.
--   select c.id, c.name, public.has_open_chargeback(c.id) as frozen
--     from public.contractors c
--    where c.user_id is not null
--    order by c.created_at desc
--    limit 20;
--
--    And the list of accounts that WOULD be frozen. Expected: 0 rows on a
--    healthy platform; every row here is a pro who cannot spend until somebody
--    sets cleared_at.
--   select f.user_id, f.created_at, f.note
--     from public.abuse_flags f
--    where f.kind = 'chargeback' and f.cleared_at is null;

-- 6. The chargeback gate is really inside both money functions. Expected: 2
--    rows, both true.
--   select p.proname,
--          pg_get_functiondef(p.oid) like '%has_open_chargeback%' as has_gate
--     from pg_proc p
--    where p.pronamespace = 'public'::regnamespace
--      and p.proname in ('apply_to_lead', 'unlock_direct_request')
--    order by p.proname;

-- 7. leave_review carries the linked-account gate, and does NOT carry a status
--    requirement. Expected: 1 row, has_link_gate true and has_status_gate
--    FALSE. The second column is the regression guard for a rule that was
--    deliberately withdrawn: only the pro can set status = 'closed', so gating
--    reviews on it lets the reviewed party veto their own reviews.
--   select pg_get_functiondef(p.oid) like '%account_signals%'   as has_link_gate,
--          pg_get_functiondef(p.oid) like '%''closed''%'        as has_status_gate
--     from pg_proc p
--    where p.pronamespace = 'public'::regnamespace
--      and p.proname = 'leave_review';

-- 8. public_pro_profile hides what browse hides. Expected: the two counts
--    match - one row per pro the directory shows, and the same number of
--    non-null payloads out of the function.
--   select count(*) filter (where user_id is not null and serves_orange_county) as visible_pros,
--          count(*) filter (where public.public_pro_profile(id) is not null)    as profile_returns
--     from public.contractors;
--
--    And a spot check that an unclaimed row now returns nothing.
--    Expected: null.
--   select public.public_pro_profile(id)
--     from public.contractors
--    where user_id is null
--    limit 1;

-- 9. The EXECUTE grants on public_pro_profile survived the replace.
--    Expected: 2 rows, anon and authenticated. /p/<id> is a signed-out page,
--    so anon disappearing here would 404 every public pro page.
--   select r.rolname as grantee
--     from pg_proc p
--     cross join lateral aclexplode(p.proacl) a
--     join pg_roles r on r.oid = a.grantee
--    where p.pronamespace = 'public'::regnamespace
--      and p.proname = 'public_pro_profile'
--      and a.privilege_type = 'EXECUTE'
--    order by 1;

-- 10. apply_to_lead kept ITS grant too. Expected: authenticated present.
--     This is the one that would take the job board offline if it were lost.
--   select r.rolname as grantee
--     from pg_proc p
--     cross join lateral aclexplode(p.proacl) a
--     join pg_roles r on r.oid = a.grantee
--    where p.pronamespace = 'public'::regnamespace
--      and p.proname in ('apply_to_lead', 'unlock_direct_request', 'leave_review')
--      and a.privilege_type = 'EXECUTE'
--    order by p.proname, 1;

-- ============================================================================
-- SAVED QUERIES (keep these; they are the admin surface for the freeze)
-- ============================================================================

-- A. FREEZE AN ACCOUNT BY HAND. Same table the Stripe webhook writes, so a
--    manual freeze behaves exactly like a real dispute. cleared_at is reset to
--    null on conflict, which is also what a repeat chargeback does.
--   insert into public.abuse_flags (user_id, kind, note)
--   values ('00000000-0000-0000-0000-000000000000', 'chargeback', 'why, and who decided')
--   on conflict (user_id, kind) do update
--     set note = excluded.note, cleared_at = null;

-- B. UNFREEZE. The dispute was won, withdrawn, or filed by mistake. The row
--    stays so the history survives; cleared_at is what ends the freeze.
--   update public.abuse_flags
--      set cleared_at = now(),
--          note = coalesce(note, '') || ' | cleared <date>: <why>'
--    where user_id = '00000000-0000-0000-0000-000000000000'
--      and kind = 'chargeback';

-- C. WHO IS FROZEN RIGHT NOW, with their email and their wallet balance, so a
--    support conversation can start from facts.
--   select f.user_id, u.email, c.name as company, f.created_at, f.note,
--          w.cash_balance_cents, w.bonus_balance_cents
--     from public.abuse_flags f
--     left join auth.users u on u.id = f.user_id
--     left join public.contractors c on c.user_id = f.user_id
--     left join public.wallets w on w.contractor_id = c.id
--    where f.kind = 'chargeback' and f.cleared_at is null
--    order by f.created_at desc;

-- D. REVIEWS FROM AN ACCOUNT LINKED TO THE PRO. The rows the new gate would
--    refuse today. Not a cleanup instruction - existing rows stand - but it is
--    the honest measure of what the old rule let through, and worth reading
--    once. Empty is the expected and healthy answer.
--   select r.id, r.rating, r.created_at, s.kind as linked_by
--     from public.reviews r
--     join public.contractor_leads l on l.id = r.lead_id
--     join public.properties pr on pr.id = r.property_id
--     join public.contractors c on c.id = r.contractor_id
--     join public.account_signals mine on mine.user_id = pr.user_id
--     join public.account_signals s
--       on s.user_id = c.user_id
--      and s.kind = mine.kind
--      and s.value_hash = mine.value_hash
--    where mine.kind in ('card', 'email_norm', 'phone')
--    order by r.created_at desc
--    limit 50;
