# Hearth handoff (2026-08-21)

Snapshot to continue from after clearing the chat. Durable context also lives in
the Claude memory files (the real cross-session handoff); this is the readable
summary. Everything below is committed and pushed unless marked otherwise.

## Current state (verified, not aspirational)

- Branch `main` at `c5ba31a` == origin. **Next.js 15.5 + React 19** since
  `c5dfeb1`. `tsc --noEmit` clean, 196 Vitest tests passing (14 files), full
  `npm run build` exits 0 on Windows (112/112 pages; the old Windows
  `/opengraph-image` prerender failure is gone on Next 15).
- LIVE Supabase DB at migration **0126**. On 08-20 the live `properties`
  table had drifted: RLS not enforced and the `authenticated` grant missing,
  so a fresh account could read every home's address. Fixed with
  `supabase/PASTE-ME-live-fix-properties-grants.sql` then
  `supabase/PASTE-ME-live-audit-rls.sql` (drops any policy on properties that
  is not one of the five from 0002/0051). Verified with a throwaway user
  (deleted): fresh account sees [] on properties, home_systems, issues,
  documents, contractor_leads, contractors; only its own users row; anon is
  denied. Landen never pasted the audit's 1a/1b output, so other tables are
  spot-checked, not audited.
- **Free Vercel test site: https://hearth-seven-pink.vercel.app** (Vercel
  project `hearth`, team slug `hearth-test`, Hobby plan). Builds from branch
  `deploy/free-test`, whose only intended difference from main is an empty
  cron list in `vercel.json` (Hobby allows 2 crons, main declares 17).
  `.github/workflows/sync-test-deploy.yml` merges main into that branch on
  every push to main, so the test site follows main automatically. Env vars
  live in Vercel (Supabase URL/publishable/service role, Stripe TEST keys and
  price ids, Gemini, `NEXT_PUBLIC_SITE_URL` = the vercel URL). Supabase Auth
  URL config: Site URL = vercel URL, redirect allowlist has vercel URL `/**`
  and `http://localhost:3000/**`.
- Dev server: `npm run dev` on :3000, running in background at handoff time
  (Next 15; `.next` was wiped and deps reinstalled after the merge).
- Launch area unchanged: HB, FV, Seal Beach, Westminster, Midway City, Garden
  Grove, Santa Ana, Costa Mesa, Newport Beach. `unlock_direct_request` still
  deliberately has no city gate.

## What shipped 2026-08-20 and 08-21 (commit order)

1. `44f268a` - README rewritten to match the real app (it still described
   the Phase 1 scaffold); properties grant fix file checked in.
2. `20944d2` - Stripe client is lazy (`src/lib/stripe.ts`). `new Stripe("")`
   threw at import and `subscription.ts` is imported by ~42 files, so a
   machine without `STRIPE_SECRET_KEY` could not render any page. README and
   `.env.local.example` now say what is required (Supabase URL, publishable
   key, service role key) vs optional.
3. `f5e90e6` - RLS audit + properties hard-reset paste file.
4. `6fd5145` - GitHub Action that auto-syncs main into `deploy/free-test`.
5. `c5dfeb1` - **Next 15 merged** (branch `upgrade/next-15`, re-merged with
   main first; 5 conflicts resolved: async `searchParams`, `await
   createClient()`, layout no longer reads flash server-side, README).
6. `c5ba31a` - App header is ONE row at every width (Nav + ProNav): brand and
   home switcher left (truncating), search / bell / profile pinned top-right,
   wordmark and "for Pros" desktop-only. Installable on iPhone: web app
   manifest (`src/app/manifest.ts`), generated Apple touch icon
   (`src/app/apple-icon.tsx`, allowlisted in `src/lib/supabase/middleware.ts`
   next to `/opengraph-image`), `appleWebApp` tags, light/dark `themeColor`.
   Also carries the two `await createClient()` fixes the merge missed.

Findings from the day that are NOT code:
- Supabase's built-in mailer only delivers to project TEAM MEMBERS and caps
  at ~2/hour. Any other address fails signup with `email_address_invalid`,
  shown as "That didn't go through". Unblock: Resend SMTP in Supabase Auth
  settings (go-live item) or invite the tester on the Supabase org Team tab.
  Google sign-in works for anyone now.
- Landen's friend tried running the repo locally in VS Code; that path needs
  the service role key and is not worth it. The test site is the answer.

## Next steps (priority order)

1. **Landen: check the header + install on an actual iPhone** at the test
   site: one-row top bar with controls right; Safari Share -> Add to Home
   Screen gives a house icon that opens full-screen. Then the Next 15 smoke
   test on the same site (save something + toast, sign out/in, demo video,
   pro billing glance). Report anything off; formatting is the next focus.
2. **Next 16**: a background agent was attempting it on branch
   `upgrade/next-16` in worktree `.claude/worktrees/agent-a271b33cb247f403a`
   when this handoff was written (uncommitted edits to package.json,
   plus/page.tsx, contractor.ts, ogFont.ts at that moment). Result unknown.
   Next session: inspect that worktree, run tsc/test/build, check
   `npm audit --omit=dev` for the 3 highs, and only merge when green. It is
   the same drift risk as next-15: re-merge main FIRST, commit the fixes IN
   the branch, verify on the branch tip, then merge.
3. **William (security/infra, per Landen 08-21)**: run audit queries 1a/1b
   from `PASTE-ME-live-audit-rls.sql` and confirm both empty; Resend SMTP in
   Supabase; CLI migration baseline (`supabase/MIGRATIONS.md`); go-live keys
   per `docs/GO-LIVE-WIRING.md`; rotate the service role key; later Vercel
   Pro + Supabase Pro. Frame these as notes for William, not tasks for Landen.
4. **Landen (owner-only)**: Apple sign-in portal (`docs/APPLE-SIGN-IN-SETUP.md`
   + 5-month JWT reminder); legal track (CA LLC, DMCA agent, attorney review,
   legal contact off Gmail); Stripe test-mode checklist then live-mode
   verification; domain purchase.
5. **Formatting / iPhone polish** is what Landen wants to spend sessions on
   now. Rules in memory: compact UI, no per-trade pictograms, honest copy.
   Method: Landen lists what looks off on his phone, fix in batches; or run a
   screen-by-screen visual audit of the test site and hand him a ranked list.
6. Open product decisions unchanged: direct-request city-gate exception;
   `/p/[id]` full staticization; landlord/tenant idea (not before launch);
   delete Landen's duplicate 17860 Santa Mariana property (not authorized).
7. Untracked leftover `supabase/PASTE-ME-live-0118-0119.sql` (already
   applied live) still needs a `git add` when someone is in there.

## What went bad (learn from these)

- **Live `properties` table drifted to wide open** and nothing in the repo
  could have caused it: a dashboard click. Policy edits in the Supabase UI
  leave no trace. Check `pg_policies` for stray policies FIRST when a
  permission symptom appears, and never use dashboard policy templates.
- **The Next 15 merge went out missing two one-line fixes.** They were made
  in the worktree after the merge commit and never committed, so `main`
  failed tsc until the next push. Verify on the merged branch tip, not on a
  dirty worktree.
- **Instruction tables got pasted literally into Vercel.** A cell reading
  "https://hearth-test.vercel.app for now; you'll correct it in step 4"
  became the env value and broke the build (`new URL()`); four env names in
  one cell failed validation. Give Landen one value per line, nothing else.
- **`hearth-test.vercel.app` was never Landen's site** (names are global; his
  is `hearth-seven-pink.vercel.app`). The "You need access" wall was someone
  else's deployment. Confirm the real URL from Settings -> Domains first.
- **README claimed optional env vars degrade gracefully; Stripe did not.**
  Docs that state runtime behavior have to be checked against the code.
- **Building another branch in the main checkout while the dev server ran**
  corrupted `.next` (`__webpack_modules__[moduleId] is not a function`).
  Build branches in the worktree, or stop the server first.
- **Probing RLS by minting a magic link on Landen's account was blocked**
  (correctly). A throwaway admin-created user, then deleted, is the way.
- Browser screenshot verification of the signed-in header failed: Claude
  cannot enter credentials and the resize did not take. Landen's phone is
  the verification path for signed-in mobile UI.

## What went well (keep doing)

- Reproducing against the live API with curl before theorizing (signup
  probe found the team-member mailer rule; the anon probe found the leak).
- Verifying the RLS fix with a real authenticated throwaway user instead of
  trusting the SQL editor's "chart".
- Green-before-merge held for Next 15: tsc, tests, and full build on the
  re-merged branch, then merge.
- Automation at the GitHub level (sync workflow) instead of a memory note
  that depends on Claude remembering to push twice.
- Memory files updated during the session (`hearth-test-deploy`,
  `hearth-owners`), so a fresh chat starts with the deploy and ownership facts.

## Working agreements (carried forward; also in Claude memory)

- Fable plans + reviews; Opus subagents execute; separate verifier re-checks
  money/security. Commit + push routine inside an active directive; STILL ASK
  before merges (PRs and big branches), force pushes, destructive/irreversible
  actions. (Landen explicitly authorized the Next 15 merge on 08-21.)
- No em dashes anywhere (prose or code).
- UI: clean and compact; NO per-trade/category pictograms; general icons stay.
  Landen's new priorities: iPhone-first formatting, controls top-right.
- Live DB changes ship as PASTE-ME files; Landen pastes the CONTENTS (not the
  path, and no surrounding prose); Claude verifies read-only afterward.
- William owns security/infra go-live work from 08-21; Landen keeps the
  owner-only accounts/money items.
- Don't `git add -A` without excluding handoff leftovers; `.claude/` is
  gitignored agent scratch.

## Gotchas for the next session

- Next 15: `cookies()`, `headers()`, `params`, `searchParams` are async and
  `createClient()` from `src/lib/supabase/server.ts` is async. tsc catches
  missed awaits except behind `any` casts; grep `createClient()` without
  `await` after any merge.
- `deploy/free-test` keeps its own `vercel.json`; cron changes on main never
  reach the test site by design.
- `NEXT_PUBLIC_SITE_URL` is baked in at build time on Vercel; changing it
  needs a redeploy. No trailing slash.
- `/apple-icon` and `/opengraph-image` are extensionless generated routes
  and must stay on the middleware public list or they 307 to /signin.
- Gemini thinking budget (512) is billed inside maxOutputTokens (1024); raise
  maxOutputTokens if Ask Hearth truncates.
- The FlashToast effect deliberately has no dependency array; don't "fix" it.
- `next.config.mjs` changes need a dev-server restart; stale `.next` fix is
  stop server, delete `.next`, restart.
- vitest include is `src/**/*.test.{ts,tsx}`; 14 files / 196 tests.
