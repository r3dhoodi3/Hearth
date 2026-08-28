import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Migration 0140 closes the one spending path 0138's blocking work left
// open: unlock_direct_request never got the block gate apply_to_lead and
// open_jobs_for_me already carry. None of the enforcement (a SECURITY
// DEFINER function body) can be exercised from a unit test - what CAN be
// checked here is the same failure mode src/lib/blocks0138.test.ts guards
// against: a function re-issued COPY-ONLY that quietly loses, misplaces or
// mis-orders the one guard line added in between - plus the shape of the two
// constraint changes on user_blocks.
//
// Same approach and the same limits as blocks0138.test.ts. Reading the SQL as
// text is not a substitute for running it against the live database. See the
// PASTE-ME file for the queries that do that.

const repoFile = (rel: string) =>
  fileURLToPath(new URL(`../../${rel}`, import.meta.url));

const read = (rel: string) => readFileSync(repoFile(rel), "utf8");

const MIGRATION = "supabase/migrations/0140_blocks_direct_requests.sql";
const PASTE_ME = "supabase/PASTE-ME-live-2026-08-28-blocks-direct-requests.sql";

const sql = read(MIGRATION);

// The body of one function in the file, from its CREATE to its closing $$;.
function bodyOf(text: string, name: string): string {
  const start = text.indexOf(`create or replace function public.${name}(`);
  expect(start, name).toBeGreaterThan(-1);
  const end = text.indexOf("$$;", start);
  expect(end, name).toBeGreaterThan(start);
  return text.slice(start, end);
}

describe("migration 0140: unlock_direct_request gains the block gate", () => {
  it("re-issues the function with its signature unchanged", () => {
    // The signature is what preserves the EXECUTE grant across CREATE OR
    // REPLACE. If it drifts, direct requests go down.
    expect(sql).toContain(
      "create or replace function public.unlock_direct_request(p_lead uuid)"
    );
  });

  it("keeps every existing check in unlock_direct_request", () => {
    const body = bodyOf(sql, "unlock_direct_request");
    // 0132's chargeback freeze and every availability check from 0105/0115
    // survive the copy.
    expect(body).toContain("if public.has_open_chargeback(v_contractor) then");
    expect(body).toContain("raise exception 'Not a direct request'");
    expect(body).toContain("raise exception 'Not your request'");
    expect(body).toContain("raise exception 'Request already assigned'");
    expect(body).toContain("raise exception 'Request was declined'");
    expect(body).toContain("raise exception 'Request no longer available'");
  });

  it("adds the block gate after the availability checks and before the wallet is touched", () => {
    const body = bodyOf(sql, "unlock_direct_request");
    expect(body).toContain(
      "blocked_between(auth.uid(), pr.user_id)"
    );
    // Vague on purpose, matching apply_to_lead's wording: a pro must not
    // learn from this which side blocked whom.
    expect(body).toContain("This job is not available to you.");

    const afterAvailability = body.indexOf(
      "raise exception 'Request no longer available'"
    );
    const blockGate = body.indexOf("blocked_between(auth.uid(), pr.user_id)");
    const wallet = body.indexOf("get_or_create_wallet(v_contractor)");

    // Placed after every existing "is this request even available" check...
    expect(afterAvailability).toBeGreaterThan(-1);
    expect(blockGate).toBeGreaterThan(afterAvailability);
    // ...and before the wallet is ever read.
    expect(wallet).toBeGreaterThan(-1);
    expect(blockGate).toBeLessThan(wallet);
    // Before every mutation: no insert or update between the gate and the
    // end of the function may run ahead of it.
    expect(blockGate).toBeLessThan(body.indexOf("insert into lead_applications"));
    expect(blockGate).toBeLessThan(
      body.lastIndexOf("update contractor_leads")
    );
  });

  it("matches apply_to_lead's gate in 0138: same helper, same message", () => {
    // Not a copy of 0138's file - just confirming the two gates speak the
    // same language, since a pro comparing the two error messages must not
    // be able to tell the two spending paths apart.
    const migration0138 = read("supabase/migrations/0138_user_blocks.sql");
    const applyBody = bodyOf(migration0138, "apply_to_lead");
    expect(applyBody).toContain("public.blocked_between(auth.uid(), v_owner)");
    expect(applyBody).toContain("This job is not available to you.");
  });
});

describe("migration 0140: user_blocks.reason gets a length cap", () => {
  it("drops then adds a named length constraint", () => {
    expect(sql).toContain(
      "alter table public.user_blocks drop constraint if exists user_blocks_reason_len;"
    );
    expect(sql).toContain("add constraint user_blocks_reason_len");
    expect(sql).toContain("check (reason is null or char_length(reason) <= 500)");
  });
});

describe("migration 0140: the pair-uniqueness constraint is named", () => {
  it("drops both the default-named and the named constraint before adding the named one", () => {
    expect(sql).toContain(
      "drop constraint if exists user_blocks_blocker_user_id_blocked_user_id_key;"
    );
    expect(sql).toContain("drop constraint if exists user_blocks_pair_uniq;");
    expect(sql).toContain("add constraint user_blocks_pair_uniq");
    expect(sql).toContain("unique (blocker_user_id, blocked_user_id)");
  });
});

describe("the live-DB bundle", () => {
  it("exists and carries the whole migration", () => {
    expect(existsSync(repoFile(PASTE_ME))).toBe(true);
    const paste = read(PASTE_ME);
    expect(paste).toContain(
      "create or replace function public.unlock_direct_request(p_lead uuid)"
    );
    expect(paste).toContain("add constraint user_blocks_reason_len");
    expect(paste).toContain("add constraint user_blocks_pair_uniq");
  });

  it("matches the migration statement for statement, modulo comments", () => {
    // Strip full-line SQL comments (-- ...) and blank lines from both, then
    // compare: every real statement in the PASTE-ME must be identical to the
    // migration's. Wrapper prose (headers, footers, VERIFY queries, which are
    // themselves commented out) disappears in this comparison, which is the
    // point.
    const strip = (text: string) =>
      text
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith("--"))
        .join("\n");

    const migrationBody = strip(sql);
    const pasteBody = strip(read(PASTE_ME));

    expect(migrationBody.length).toBeGreaterThan(0);
    expect(pasteBody).toContain(migrationBody);
  });

  it("says how to verify the run", () => {
    const paste = read(PASTE_ME);
    expect(paste).toContain("VERIFY");
    expect(paste).toContain("user_blocks_reason_len");
    expect(paste).toContain("user_blocks_pair_uniq");
  });
});
