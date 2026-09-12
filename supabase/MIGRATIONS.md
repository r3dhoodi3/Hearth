# Database migrations

Migrations used to be hand-pasted into the Supabase dashboard SQL editor. That
worked, but it left no record of what had been applied, so the live schema could
drift from `supabase/migrations/` without anyone noticing. This document sets up
the CLI so that stops.

The CLI is now a devDependency (`supabase`), so `npm run db:push` works without a
global install. Use `npx supabase ...` for anything not covered by an npm script.

## Duplicate version numbers: RESOLVED (PR #6, 2026-08-19)

The CLI keys every migration by the number before the first underscore, so two
files cannot share a prefix. The three duplicate pairs (old 0019/0020/0021) were
renumbered in PR #6, before any baseline was recorded, so every file now has a
unique version. Two pairs ended up in alphabetical rather than historical order
(`0021_lower_bonus_threshold` before `0022_notification_prefs`, and
`0023_private_storage` before `0024_support_messages`); both pairs were verified
to touch disjoint objects, so the order does not matter. The numbering has gaps
(e.g. 0109, 0111, 0122) - harmless, the CLI does not require contiguity.

The baseline below must use these post-rename version numbers.

## One-time setup (not done yet - needs two credentials)

`0001`-`0066` are already applied to the live project, but they were applied by
hand, so the `supabase_migrations.schema_migrations` bookkeeping table does not
know about them. **Running `npm run db:push` before completing this baseline will
try to re-run all 68 migrations against a live database and fail partway
through.** Do the baseline first.

### 1. Get an access token

<https://supabase.com/dashboard/account/tokens> -> "Generate new token".
Then, in the shell (do not commit it):

```
npx supabase login
```

### 2. Link the repo to the live project

```
npx supabase link --project-ref tubkvvfkwggaddcmcjqv
```

This prompts for the **database password**. That is not the anon key or the
service-role key. If nobody remembers it, reset it at
Dashboard -> Project Settings -> Database -> "Reset database password".

### 3. Baseline the existing migrations

Tell the CLI that everything already applied is applied, so it does not try to
re-run it:

```
npx supabase migration repair --status applied 0001 0002 ... 0066
```

To generate that full argument list rather than typing 66 version numbers:

```
ls supabase/migrations/*.sql | sed 's/.*\///; s/_.*//' | tr '\n' ' '
```

Then verify the CLI and the live database now agree:

```
npx supabase migration list
```

Every migration should show as applied on both local and remote, with nothing
pending. If anything shows as pending that you know is already live, repair that
version too before pushing. **Do not push until this list is clean.**

## Normal workflow after that

```
npx supabase migration new some_change   # creates the next numbered .sql file
# edit the generated file
npm run db:push                          # applies only what is pending
```

To refresh generated types after a schema change, note that the existing
`db:types` script targets a *local* stack (`--local`). Against the hosted
project use:

```
npx supabase gen types typescript --project-id tubkvvfkwggaddcmcjqv > src/lib/database.types.ts
```

Keeping this file current is what prevents the `as any` casts that accumulated
around the `0066` enrichment columns.

## Gotchas

- **The one-time paste bundles are gone.** This directory used to hold a pile of
  hand-apply bundles (`apply_*.sql`, `PASTE-ME-*.sql`, `PRECHECK-*.sql`,
  `COMBINED-*.sql`, `FIX-*.sql`). Every one of them had been applied to the live
  database, none were re-runnable, and they were deleted on 2026-09-12. Git
  history still has them if a body is ever needed. `supabase/migrations/` is the
  only source of truth for schema. The single exception is
  `supabase/PASTE-ME-ALL-PENDING-2026-09-12.sql`, which is still pending.
- **Write new migrations to be idempotent** (`create policy if not exists`, or
  `drop policy if exists` first) so a partial failure can be retried.
- The anon and service-role keys cannot run DDL. They talk to PostgREST only.
  That is why this needs a real database password or an access token.
