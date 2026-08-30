# Backups, and proving a restore actually works

Owner: Landen. No code is involved in any of this, so nothing in the repo can
tell you whether it is working. The only way to know is to do it.

The one sentence that matters: **a backup you have never restored is not a
backup, it is a hope.** This document is a drill you run three times, on
purpose, while nothing is on fire.

Related, do not duplicate: `docs/deploy-runbook.md` has the RPO/RTO discussion
(how much data a daily snapshot can cost you, how long a restore takes) and the
"if the DB is lost" checklist. This file is the hands-on procedure.

---

## 0. First, settle a contradiction in our own notes

Two documents in this repo disagree about the plan:

- `docs/deploy-runbook.md` says "This project is on Pro's default daily-backup
  RPO today."
- `docs/WILLIAM-SECURITY-INFRA.md` item 10 lists "Supabase Pro (backups, no
  pausing)" under **Soon after launch**, i.e. as something not yet done.

They cannot both be right, and the difference is the difference between having
backups and having none. **Check it first**, before anything else in this file:

1. supabase.com/dashboard, pick the Hearth project (ref `tubkvvfkwggaddcmcjqv`).
2. Left sidebar, bottom: **Project Settings** -> **Billing**.
3. Read the plan name at the top of the page.

- **Free**: there are NO backups at all, and the project pauses after 7 idle
  days. Stop here and upgrade. Project Settings -> Billing -> Change plan ->
  Pro ($25/month). Nothing else in this document works until you do.
- **Pro**: you have daily backups with 7 days of retention. Continue.

Write the answer down in the log at the bottom.

---

## 1. What Supabase gives you, in plain terms

| Plan | What you get | How much data a failure can cost you |
| --- | --- | --- |
| Free | Nothing. No backups. Project pauses when idle. | Everything. |
| Pro ($25/mo) | One automatic snapshot per day, kept 7 days. | Up to 24 hours. |
| Pro + PITR add-on (from $100/mo, needs the Small compute add-on) | Continuous, restore to any minute in the window. | About 2 minutes. |

Two things the snapshot does **not** include, and this catches people out:

- **Storage objects are not in the Postgres backup.** Every homeowner photo,
  document, inspection PDF, chat image, pro logo and compliance document lives
  in Supabase Storage, which is a separate service. Restoring the database
  restores the *rows that point at* those files, not the files. See section 6.
- **Auth users are in the backup** (they live in the `auth` schema, which the
  snapshot covers), but the Supabase Auth *settings* (SMTP, providers, redirect
  URLs, the Apple client secret) are project configuration, not data. A restore
  into a fresh project starts with those blank.

**Recommendation:** stay on daily backups until real money moves through
Stripe, then add PITR. A once-a-day snapshot means a bad migration at 4pm loses
everything since that morning, which is survivable with ten customers and not
survivable with a thousand.

---

## 2. Confirm backups are actually running (2 minutes, do this weekly)

1. supabase.com/dashboard -> the Hearth project.
2. Left sidebar: **Database** -> **Backups**.
3. You should see a list of daily snapshots, most recent at the top.

What you are checking, in order:

- **Is there a row dated today or yesterday?** If the newest is older than two
  days, backups are not running. That is an emergency, not a to-do.
- **Are there roughly seven rows?** Pro keeps 7 days. Fewer than that on a
  project that has been up for a week means something is wrong.
- **Does the size look sane?** It should grow slowly, not jump or collapse. A
  snapshot that is suddenly a tenth of yesterday's size is a red flag.

Add this to the weekly check in `docs/deploy-runbook.md`:

> **Backups:** Supabase -> Database -> Backups. Newest snapshot dated today or
> yesterday, about seven in the list, size in line with last week. If not, stop
> and fix it before anything else this week.

---

## 3. The restore drill

**THE RULE, AND IT HAS NO EXCEPTIONS: never restore over production.**

The Supabase dashboard has a restore button that overwrites the project you are
looking at, with no undo. Pressing it to "test" a backup destroys every row
written since that snapshot. The drill below never touches the live project.

There are two safe ways to do it. **Option A is the one to use.** Option B is
there for when you want to be thorough without spending anything.

### Option A: restore into a throwaway Supabase project (recommended)

Takes about 45 minutes, most of it waiting. Costs a few dollars of prorated Pro
time on a project you delete the same day.

1. **Note the target.** Supabase -> Hearth project -> Database -> Backups. Pick
   the newest snapshot. Write its date and time in the log.

2. **Record the numbers you are going to check.** Still in the LIVE project:
   SQL Editor -> New query -> run this and copy the result:

   ```sql
   select 'users' as table_name, count(*) from public.users
   union all select 'properties', count(*) from public.properties
   union all select 'contractors', count(*) from public.contractors
   union all select 'contractor_leads', count(*) from public.contractor_leads
   union all select 'messages', count(*) from public.messages
   union all select 'reviews', count(*) from public.reviews
   union all select 'subscriptions', count(*) from public.subscriptions
   order by 1;
   ```

   Also run `select max(created_at) from public.messages;` and write that down.

3. **Create the scratch project.** supabase.com/dashboard -> New project.
   - Organisation: the same one.
   - Name: `hearth-restore-drill` (NOT `hearth-staging`, which is a permanent
     project from `docs/ENVIRONMENTS.md`; you are going to delete this one).
   - Database password: generate one, paste it into your password manager.
   - Region: the same region as the live project.
   - Plan: it has to be on a paid plan to accept a restore. Upgrade it right
     after creation: Project Settings -> Billing -> Pro.

4. **Restore into it.** In the SCRATCH project: Database -> Backups ->
   **Restore to a new project** is not always offered, so the reliable path is:
   go to the LIVE project -> Database -> Backups -> the three-dot menu on the
   snapshot -> **Download**, then upload/restore that dump into the scratch
   project (Option B step 4 has the command). If the dashboard does offer
   "restore into another project", use it and pick `hearth-restore-drill`.

   **Read every confirmation dialog and confirm the project name it shows is
   `hearth-restore-drill`.** This is the one step where a misclick is
   destructive.

5. **Wait.** Ten to thirty minutes is normal. The project is unusable while it
   runs.

6. **Check the numbers.** In the SCRATCH project's SQL Editor, run the exact
   same count query from step 2. Compare.
   - Counts should match, or be slightly LOWER than live (rows written after
     the snapshot was taken are legitimately absent).
   - `max(created_at)` on messages should be at or just before the snapshot
     time.
   - Any count that is HIGHER than live, or zero, means the restore did not do
     what you think it did. Write down exactly what you saw and stop.

7. **Check one row by hand.** Pick your own account:
   `select id, email, created_at from auth.users order by created_at limit 5;`
   Your first accounts should be there, with the right emails. This is the
   check that catches "the restore succeeded and restored the wrong thing".

8. **Delete the scratch project.** Project Settings -> General -> scroll to the
   bottom -> **Delete project**. Type the name to confirm. Do this the same day:
   a paid project you forgot about bills every month, and a second copy of every
   customer's data sitting around is its own problem.

9. **Write the result in the log below.**

### Option B: restore locally into Docker (free, no second project)

Same proof, no money, more typing. Needs Docker Desktop running.

1. Live project -> Database -> Backups -> three-dot menu on the newest snapshot
   -> **Download**. You get a `.backup` or `.sql.gz` file. Put it somewhere
   outside the repo, e.g. `C:\Users\lande\hearth-backups\`.

   **That file is a complete copy of every customer's data.** Do not put it in
   the repo, do not put it in Dropbox, delete it when the drill is done.

2. Start a throwaway Postgres:

   ```
   docker run --name hearth-restore-drill -e POSTGRES_PASSWORD=drill -p 55432:5432 -d postgres:15
   ```

3. Wait about ten seconds for it to come up.

4. Restore into it:

   ```
   docker exec -i hearth-restore-drill psql -U postgres -d postgres < C:\Users\lande\hearth-backups\<the-file>.sql
   ```

   For a `.backup` (custom format) file use `pg_restore` instead:

   ```
   docker exec -i hearth-restore-drill pg_restore -U postgres -d postgres --no-owner --no-acl < C:\Users\lande\hearth-backups\<the-file>.backup
   ```

   Expect some errors about roles that do not exist locally (`supabase_admin`,
   `authenticated`, `anon`). Those are fine: they are Supabase's roles, not your
   data. Errors about *tables* are not fine.

5. Count the rows:

   ```
   docker exec -i hearth-restore-drill psql -U postgres -d postgres -c "select 'users', count(*) from public.users union all select 'properties', count(*) from public.properties union all select 'contractors', count(*) from public.contractors union all select 'contractor_leads', count(*) from public.contractor_leads union all select 'messages', count(*) from public.messages order by 1;"
   ```

   Compare against the live numbers from Option A step 2.

6. Tear it down and delete the file:

   ```
   docker rm -f hearth-restore-drill
   del C:\Users\lande\hearth-backups\<the-file>
   ```

7. Write the result in the log below.

---

## 4. Run it three times

Once is a coincidence. The point of three is that the second and third are
boring, which is how you find out the procedure is repeatable rather than
something that worked once because you happened to click the right thing.

- **Drill 1:** now, before launch. Expect to hit something that does not match
  this document. Fix the document.
- **Drill 2:** a week later. Should take half as long.
- **Drill 3:** the week before you take the first real payment. This one is the
  one that counts, because from then on a restore has money attached to it.

After that, once a quarter, and after any change to the database plan.

---

## 5. Log

Fill this in each time. An empty row is the honest answer until the drill runs.

| # | Date | Plan (Free/Pro/Pro+PITR) | Method (A or B) | Snapshot used | Row counts matched? | How long it took | What went wrong |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 0 | | | plan check only (section 0) | n/a | n/a | | |
| 1 | | | | | | | |
| 2 | | | | | | | |
| 3 | | | | | | | |

---

## 6. The part the database backup does not cover: Storage

Every uploaded file lives in one of three buckets, and **none of them are in the
Postgres snapshot**:

| Bucket | What is in it | Public? |
| --- | --- | --- |
| `home-photos` | homeowner photos, vault documents, inspection PDFs, chat images | private |
| `pro-docs` | contractor licenses, certificates of insurance | private |
| `pro-logos` | pro logos and project portfolio photos | **public** |

If the project is lost, restoring the database gives you rows pointing at files
that no longer exist: every photo in the app becomes a broken image.

Supabase does not back Storage up for you on any plan. The options, cheapest
first:

1. **Accept it, for now.** Photos are re-uploadable and no money depends on
   them. This is the right answer today; write it down as a decision rather
   than leaving it as an oversight.
2. **Periodic manual export.** `supabase storage cp -r ss://home-photos ./backup`
   with the CLI, run by hand every month or so, to a drive that is not the
   laptop. Cheap, manual, easy to forget.
3. **Enable S3-compatible access and mirror it.** Supabase Storage speaks the
   S3 protocol; a nightly `rclone sync` to Backblaze B2 (about $6/TB/month)
   gives you a real off-site copy. This is the answer once there are paying
   customers whose documents are in there.

Whichever you pick, note it in `docs/deploy-runbook.md`'s "If the DB is lost"
checklist so the recovery procedure stops saying "Storage needs its own plan"
and starts naming the plan.
