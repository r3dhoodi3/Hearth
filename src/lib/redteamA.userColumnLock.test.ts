import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// RED-TEAM A (2026-08-28): public.users has no column lock, so every paywall
// counter that lives on it is writable by the account it is meant to limit.
//
// THE HOLE. Migration 0002 is the only thing standing over public.users:
//
//   create policy "users self update" on public.users
//     for update using (id = auth.uid()) with check (id = auth.uid());
//
// No WHERE on columns, no column-level GRANT, no BEFORE UPDATE trigger, and
// no `revoke update ... on public.users` anywhere in supabase/migrations. The
// row is the unit of protection, so a signed-in homeowner may rewrite ANY
// column on their own row through PostgREST with the anon key and their own
// session JWT - both of which their browser already holds:
//
//   curl -X PATCH "$SUPABASE_URL/rest/v1/users?id=eq.$MY_UID" \
//     -H "apikey: $NEXT_PUBLIC_SUPABASE_ANON_KEY" \
//     -H "Authorization: Bearer $MY_ACCESS_TOKEN" \
//     -H "Content-Type: application/json" \
//     -d '{"free_doc_reads_used":0,"free_inspection_reads_used":0,
//          "free_quote_used_at":null,"free_plan_used_at":null}'
//
// That resets, in one request, tonight's brand-new free-AI-taste paywall
// (migration 0135: 2 lifetime document reads, 1 lifetime inspection import),
// the free quote check (0030) and the free maintenance-plan build (0101).
// claim_free_ai_taste being atomic and service-role-only does not help: the
// counter it reads is the one the caller just zeroed.
//
// 0135's own header reasons about this and stops one word short - it says the
// existing policies "already cover a homeowner READING their own counters"
// and never asks who may write them.
//
// THE FIX, either shape. A column-scoped revoke on the counters:
//
//   revoke update (free_doc_reads_used, free_inspection_reads_used,
//                  free_quote_used_at, free_plan_used_at)
//     on public.users from authenticated, anon;
//
// (Postgres needs a matching `grant update (col, ...)` for the columns a
// homeowner legitimately edits, since a column-level revoke against a
// table-level grant is a no-op - so the safer shape is to revoke UPDATE on the
// table and grant it back per column.) Or the guard trigger this repo already
// uses on contractors (0085) and contractor_leads (0079/0121): a BEFORE UPDATE
// trigger on public.users that raises when a locked column changes and the
// caller is not the service role.

const migrationsDir = fileURLToPath(
  new URL("../../supabase/migrations", import.meta.url)
);

const allMigrationSql = readdirSync(migrationsDir)
  .filter((f) => f.endsWith(".sql"))
  .map((f) => readFileSync(`${migrationsDir}/${f}`, "utf8"))
  .join("\n");

// The columns on public.users that decide whether a paid feature is available.
// Anything added here later must be locked the same way.
const MONEY_COLUMNS = [
  "free_doc_reads_used",
  "free_inspection_reads_used",
  "free_quote_used_at",
  "free_plan_used_at",
];

// Does the migration history lock this column against a self-update?
function isLocked(column: string): boolean {
  // Shape 1: a column-scoped revoke naming it.
  const revoked = new RegExp(
    `revoke[\\s\\S]{0,200}update[\\s\\S]{0,200}\\b${column}\\b[\\s\\S]{0,200}on\\s+(?:table\\s+)?public\\.users`,
    "i"
  ).test(allMigrationSql);
  // Shape 2: UPDATE revoked on the table, then granted back per column, with
  // this one deliberately left out of the grant list.
  const tableRevoked =
    /revoke\s+(?:all|update)[^;]{0,120}\son\s+(?:table\s+)?public\.users\s+from[^;]*;/i.test(
      allMigrationSql
    );
  const grantedBack = new RegExp(
    `grant\\s+update\\s*\\([^)]*\\b${column}\\b[^)]*\\)\\s*\\n?\\s*on\\s+(?:table\\s+)?public\\.users`,
    "i"
  ).test(allMigrationSql);
  // Shape 3: a BEFORE UPDATE guard trigger on public.users that names it.
  const guarded =
    /before\s+update\s+on\s+public\.users/i.test(allMigrationSql) &&
    new RegExp(`\\b${column}\\b`, "i").test(allMigrationSql) &&
    /raise\s+exception/i.test(allMigrationSql);

  return revoked || (tableRevoked && !grantedBack) || guarded;
}

describe("red-team A: paywall counters on public.users", () => {
  it("has some column lock on public.users at all", () => {
    const hasAnyLock =
      /revoke[^;]{0,200}on\s+(?:table\s+)?public\.users/i.test(
        allMigrationSql
      ) || /before\s+update\s+on\s+public\.users/i.test(allMigrationSql);
    expect(
      hasAnyLock,
      "public.users has no REVOKE and no BEFORE UPDATE guard anywhere in supabase/migrations, so \"users self update\" (0002) lets an account rewrite every column on its own row"
    ).toBe(true);
  });

  for (const column of MONEY_COLUMNS) {
    it(`locks users.${column} against a self-update`, () => {
      expect(
        isLocked(column),
        `public.users.${column} decides whether a paid feature is available and can be reset by the account it limits (PATCH /rest/v1/users?id=eq.<self>)`
      ).toBe(true);
    });
  }
});
