-- ============================================================================
-- HEARTH PRE-CHECK before COMBINED-2026-08-26-migrations-0129-0132.sql
-- Run each SELECT below. Every one must return ZERO rows. If a query returns
-- rows, apply its FIX line to those rows first, then run the combined file.
-- Read-only: nothing here changes data.
-- ============================================================================

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
