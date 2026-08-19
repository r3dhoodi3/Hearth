# Database migrations

Migrations used to be hand-pasted into the Supabase dashboard SQL editor. That
worked, but it left no record of what had been applied, so the live schema could
drift from `supabase/migrations/` without anyone noticing. This document sets up
the CLI so that stops.

The CLI is now a devDependency (`supabase`), so `npm run db:push` works without a
global install. Use `npx supabase ...` for anything not covered by an npm script.

## BLOCKER: duplicate version numbers must be resolved first

## Duplicate versions fixed as of 8/18 
The CLI keys every migration by the number before the first underscore, so two
files cannot share a prefix. Three pairs currently collide:

| Version | Files |
| --- | --- |
| `0019` | `0019_documents_vault.sql`, `0019_security_hardening.sql` |
| `0020` | `0020_lower_bonus_threshold.sql`, `0020_notification_prefs.sql` |
| `0021` | `0021_private_storage.sql`, `0021_support_messages.sql` |

## Gap fixed as of 8/18
There is also a gap: `0051` is followed by `0053`, with no `0052`. The gap is
harmless (the CLI does not require contiguous numbering); the duplicates are not.

Renaming a file changes its version identity, so this must be settled BEFORE the
baseline below, and the chosen numbers must match whatever gets repaired. The
safe fix is to renumber one file of each pair into the free slots, preserving the
order in which they were actually applied to the live database - which needs to
be confirmed from git history, not guessed, since applying
`0021_private_storage` before or after `0021_support_messages` may not commute.

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

- **The old bundles are not re-runnable.** `apply_wallet.sql` and
  `apply_contractor_side.sql` in this directory are historical hand-apply
  bundles. Tables use `if not exists`, but the `create policy` statements will
  error on a second run. They are kept for reference only. Do not re-run them.
- **Write new migrations to be idempotent** (`create policy if not exists`, or
  `drop policy if exists` first) so a partial failure can be retried.
- The anon and service-role keys cannot run DDL. They talk to PostgREST only.
  That is why this needs a real database password or an access token.
