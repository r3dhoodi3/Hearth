# Performance

How Hearth measures and guards app speed, and where the numbers from the
2026-08-30 speed wave (five agents, P1-P5) live. Re-measure using the steps
below whenever a change is meant to move one of these numbers.

## How to re-measure

Builds for measurement always use an isolated dist dir and port, never the
one `next dev` or the live deploy use (a shared `.next` corrupts between
`dev` and `build`):

```
NEXT_DIST_DIR=.next-measure npx next build
NEXT_DIST_DIR=.next-measure npx next start -p 3199
```

Then, against `http://localhost:3199`:

- **First Load JS per route**: printed directly in the `next build` output
  table (the "First Load JS" column). This is what `perf-budget.json` and
  `npm run perf:budget` track.
- **Lighthouse**: `npx lighthouse http://localhost:3199/<route> --preset=mobile --only-categories=performance --view` (three runs, take the median; a single run has too much noise to compare against a budget).
- **Server round trips per page**: instrument the data helpers in
  `src/lib/**` or watch Supabase's own request log while loading a page once.
- **Web Vitals from real visitors**: query `app_events` where
  `event = 'web_vitals'` (see docs/ANALYTICS.md query 6) - this is field data
  from the 10% of page views that get sampled, not a lab measurement, so it
  takes real traffic to fill in.

When done, delete the isolated dist dir and, if `tsconfig.json`'s `include`
array still lists it, remove that line too.

## Bundle-size budget (CI)

`perf-budget.json` checks in a First Load JS baseline (bytes) for the routes
listed below. `scripts/checkBundleBudget.mjs` (`npm run perf:budget`) builds
the app and fails if any tracked route grew more than 10% over its baseline
number. `.github/workflows/bundle-budget.yml` runs this on every PR into
`main` and on every push to `main`.

Growing a route on purpose (a real new feature, not bloat) means updating its
number in `perf-budget.json` in the same PR and saying why in the
description - the budget exists to catch accidents, not to block real work.

This workflow could not be run against GitHub Actions from this environment
(no CI runner access here); it was validated locally by feeding a real
`next build` log through `scripts/checkBundleBudget.mjs`'s parsing and
comparison functions (`scripts/checkBundleBudget.test.mjs`, and a manual run
against the actual `next build` table - both matched the checked-in
baseline exactly). Confirm the first real PR run goes green before relying
on it.

## Web Vitals reporting

`src/components/WebVitals.tsx`, mounted once from `NewMessageNotifier.tsx`
(the one component both the homeowner and pro shells already render),
samples 10% of page views (`WEB_VITALS_SAMPLE_RATE` in `src/lib/webVitals.ts`)
and reports LCP, INP, CLS, and TTFB into the existing `app_events` pipeline
via the "web-vitals" library - first-party only, no RUM vendor, same rule as
every other event (docs/ANALYTICS.md). Each row carries only
`{ metric, value, rating, path, sample_rate }`: `path` is a normalized route
PATTERN (e.g. `/pro/crm/:id`, never a raw id or full URL), and the "web-vitals"
library is dynamically imported so it never lands in the shared bundle for
the 90% of page views that skip reporting.

Known limitation: "web-vitals" is built for classic full-page loads. LCP/CLS/
TTFB are measured for the document that mounted `WebVitals`; a client-side
route change inside the app (most navigation here) does not re-arm them for
the new route. INP still tracks interactions across the page's lifetime. In
practice this means the sample mostly reflects whichever route a session
*entered* the app on, not every route visited in it - still useful for "how
fast does Hearth feel when someone opens it," less so for a route reached
only by in-app navigation.

## Skeletons and loading states

Every route with `page.tsx` under `src/app` was checked for a `loading.tsx`
or a `Suspense` fallback. Added skeletons (`src/components/Skeleton.tsx`
primitives) for the pages that had two or more sequential server-side
lookups and no fallback: `(app)/feedback`, `pro/feedback`, `pro/help`,
`pro/profile`, and `welcome/role`. Every other page with real server work
already had one.

## Optimistic UI

Checked the two actions named in the brief as feeling slow:

- **Mark-as-seen** (`src/components/MarkChatSeen.tsx`,
  `src/components/MarkChatsSeen.tsx`): already optimistic. The seen timestamp
  is written to `localStorage` and the badge-clearing event dispatched
  BEFORE the server action is awaited; the server call runs in the
  background and re-dispatches on success, with failure handled silently
  (the local clear already happened, and a lost server write only means the
  badge might reappear on the next load).
- **Checklist toggles** (`src/app/(app)/dashboard/ReminderItem.tsx`):
  already optimistic. `toggle()` and `remove()` both flip local state
  immediately and roll back with a toast on failure.

Neither needed a change. Both files are outside P5's ownership for this wave
(src/components/** and src/app/(app)/dashboard/** are P1's), so this is a
verification note, not a diff.

## Prefetch on hover/touchstart for the tab bar

Not done in this wave: the bottom tab bar's links live in
`src/components/NavLinks.tsx`, which is inside P1's ownership boundary for
this wave (`src/components/**` except ProNav/NotificationBell), not P5's.
Left for P1 or a follow-up pass. Next's `<Link>` already prefetches routes
that enter the viewport by default; the open question is whether an explicit
`router.prefetch()` on `touchstart`/`pointerdown` (ahead of `click`) measurably
helps on top of that for a bar that's in the viewport from first paint.

## Baseline numbers (fill in per agent)

| Route | First Load JS (before) | First Load JS (after) | LCP (mobile) | Notes |
|---|---|---|---|---|
| /dashboard | | | | P1/P2 |
| /pro | | | | P1/P2 |
| /ask | | | | P1 |
| /chats | | | | P1 |
| / | | | | P3 |
| /pricing | | | | P3 |
| /pros | | | | P3 |
| one guide | | | | P3 |
| /signin | | | | P3/P4 |

Middleware time per request (P4): before ____ ms, after ____ ms.

Server round trips per page, top 8 signed-in pages (P2): fill in per page.

`perf-budget.json`'s checked-in numbers (P5, `next build` on
2026-08-30, mid-wave - see that file's `generatedFrom`):

| Route | First Load JS |
|---|---|
| / | 116 kB |
| /dashboard | 132 kB |
| /ask | 120 kB |
| /chats | 205 kB |
| /pro | 201 kB |
| /pro/ask | 120 kB |
| /pro/business | 122 kB |
| /pro/chats | 194 kB |
| /pro/leads | 202 kB |
| /pro/plus | 119 kB |
| /pro/profile | 195 kB |
| /pros | 116 kB |
| /signin | 179 kB |
| /plus | 120 kB |
| /pricing | 106 kB |
| /guides/home-maintenance-schedule | 107 kB |
