-- =============================================================================
-- READ-ONLY status check: has PASTE-ME-live-2026-08-30-night.sql (migration
-- 0151) been applied to this database? Changes NOTHING. Paste the whole file
-- into the Supabase SQL editor and read the 7 rows: every "applied" should be
-- true. Any false row means that part of 0151 is not live yet and the full
-- PASTE-ME still needs to run (it has its own precheck that refuses a
-- double-run, so running it with some parts applied is safe: it will refuse
-- rather than duplicate).
-- =============================================================================

select 'part 1: is_pro_member counts active only (trial gets no lead discount)' as item,
       coalesce((select prosrc like '%''active''%' and prosrc not like '%''trialing''%'
                   from pg_proc
                  where proname = 'is_pro_member'
                    and pronamespace = 'public'::regnamespace
                  limit 1), false) as applied
union all
select 'part 2: household member cap trigger',
       exists (select 1 from pg_trigger
                where tgrelid = 'public.household_members'::regclass
                  and tgname = 'household_members_cap')
union all
select 'part 3: system-message forgery lock',
       coalesce((select prosrc like '%system markers only%'
                   from pg_proc
                  where proname = 'enforce_message_sender_role'
                    and pronamespace = 'public'::regnamespace
                  limit 1), false)
union all
select 'part 4: contractors public-text constraints (all three)',
       (select count(*) = 3 from pg_constraint
         where conrelid = 'public.contractors'::regclass
           and conname in ('contractors_name_public_shape',
                           'contractors_about_public_shape',
                           'contractors_owner_name_public_shape'))
union all
select 'part 5: expire_bonus revoked from anon and authenticated',
       case when to_regprocedure('public.expire_bonus()') is null then false
            else not has_function_privilege('authenticated', 'public.expire_bonus()', 'execute')
             and not has_function_privilege('anon', 'public.expire_bonus()', 'execute')
       end
union all
select 'part 6: messages delete policy (own message, first hour)',
       exists (select 1 from pg_policy
                where polrelid = 'public.messages'::regclass
                  and polname = 'messages delete')
union all
select 'part 7: properties unique index (no duplicate homes)',
       exists (select 1 from pg_indexes
                where schemaname = 'public'
                  and tablename = 'properties'
                  and indexname = 'properties_owner_address_unique');

-- Bonus heads-up (read-only): homes already over the 4-member cap. Ideally
-- zero rows; any row listed here can no longer accept a new member claim once
-- part 2 is live, which is the intended effect on abused homes.
select property_id, count(*) as members
  from public.household_members
 group by property_id
having count(*) >= 4
 order by count(*) desc;
