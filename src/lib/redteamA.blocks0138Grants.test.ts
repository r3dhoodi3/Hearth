import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// RED-TEAM A (2026-08-28): migration 0138's SECURITY DEFINER helpers, and who
// may call them.
//
// 0138's own table comment states the design property:
//
//   'RLS is self-scoped to blocker_user_id = auth.uid() for select/insert/
//    delete, so nobody can discover that they have been blocked.'
//
// blocked_between(uuid, uuid) breaks that in one call. It is SECURITY DEFINER
// (so it sees both directions regardless of RLS) and it is granted to
// `authenticated`, which means Supabase exposes it as an RPC any signed-in
// account can post to:
//
//   curl -X POST "$SUPABASE_URL/rest/v1/rpc/blocked_between" \
//     -H "apikey: $ANON" -H "Authorization: Bearer $MY_JWT" \
//     -H "Content-Type: application/json" \
//     -d '{"p_a":"<me>","p_b":"<them>"}'      -> true / false
//
// Each side of a lead already learns the other's auth id from messages
// (messages.sender_id is readable on a thread you can access), so a blocked
// homeowner or pro can ask this oracle directly and find out they were
// blocked - the exact thing the comment says is impossible. The same call also
// answers for two accounts the caller is not part of at all.
//
// It does not need that grant. Inside 0138 blocked_between is called from
// apply_to_lead, which is itself SECURITY DEFINER and therefore runs as the
// function owner, not as `authenticated`. The application's own path is
// isBlockedBetween in src/lib/blocks.ts, which uses the service-role client.
//
// FIX: `revoke execute on function public.blocked_between(uuid, uuid) from
// authenticated;` keeping the service_role grant.
//
// lead_has_block(uuid) is the narrower twin of the same problem: it MUST keep
// its `authenticated` grant, because the "messages insert" policy and the
// messages_block_guard trigger evaluate it as the querying role. But it takes
// any lead id from any caller and answers whether that lead's two parties have
// a block. It should refuse for a caller who is not on the lead - the file
// already has can_access_lead(p_lead) for exactly that question.

const sql = readFileSync(
  fileURLToPath(
    new URL("../../supabase/migrations/0138_user_blocks.sql", import.meta.url)
  ),
  "utf8"
);

// The text between a function's CREATE and the `$$;` that ends its body, plus
// the grant/revoke lines that follow it before the next CREATE.
function sectionFor(name: string): string {
  const start = sql.indexOf(`create or replace function public.${name}(`);
  expect(start, `${name} not found`).toBeGreaterThan(-1);
  const next = sql.indexOf("create or replace function public.", start + 1);
  return sql.slice(start, next === -1 ? undefined : next);
}

describe("red-team A: 0138 SECURITY DEFINER execute grants", () => {
  it("does not hand blocked_between() to every signed-in account", () => {
    const section = sectionFor("blocked_between");
    expect(section).toMatch(/security definer/i);
    expect(
      /grant\s+execute\s+on\s+function\s+public\.blocked_between\s*\([^)]*\)\s*to[^;]*\bauthenticated\b/i.test(
        section
      ),
      "blocked_between is a SECURITY DEFINER block oracle exposed as a PostgREST RPC to any signed-in account; apply_to_lead calls it as the definer and does not need this grant"
    ).toBe(false);
  });

  it("keeps blocked_between() available to the service role", () => {
    // The fix must revoke from `authenticated` only - server code and
    // apply_to_lead still depend on it.
    expect(sectionFor("blocked_between")).toMatch(
      /grant\s+execute\s+on\s+function\s+public\.blocked_between[\s\S]{0,120}service_role/i
    );
  });

  it("scopes lead_has_block() to a caller who is actually on the lead", () => {
    const section = sectionFor("lead_has_block");
    expect(section).toMatch(/security definer/i);
    // It has to stay callable by `authenticated` (the messages insert policy
    // evaluates it as the querying role), so the guard belongs in the body.
    expect(
      /can_access_lead\s*\(/i.test(section) || /auth\.uid\s*\(\s*\)/i.test(section),
      "lead_has_block takes any lead id from any signed-in caller and answers whether that lead's homeowner and pro have blocked each other, with no check that the caller is one of them"
    ).toBe(true);
  });
});

describe("red-team A: 0135 free-AI-taste functions", () => {
  const taste = readFileSync(
    fileURLToPath(
      new URL("../../supabase/migrations/0135_free_ai_tastes.sql", import.meta.url)
    ),
    "utf8"
  );

  // The owner's rule is "no SECURITY DEFINER unless strictly required".
  // claim_free_ai_taste and refund_free_ai_taste are granted to service_role
  // and nothing else, and Supabase's service_role carries BYPASSRLS - so the
  // definer privilege buys these two functions nothing at all, while turning
  // any future grant mistake into a privilege escalation instead of a
  // permission error. They should be SECURITY INVOKER.
  for (const name of ["claim_free_ai_taste", "refund_free_ai_taste"]) {
    it(`${name}() does not take SECURITY DEFINER it does not need`, () => {
      const start = taste.indexOf(`create or replace function public.${name}(`);
      expect(start, `${name} not found`).toBeGreaterThan(-1);
      const body = taste.slice(start, taste.indexOf("$$;", start));
      const onlyServiceRole =
        new RegExp(
          `grant\\s+execute\\s+on\\s+function\\s+public\\.${name}[\\s\\S]{0,160}to\\s+service_role\\s*;`,
          "i"
        ).test(taste) &&
        !new RegExp(
          `grant\\s+execute\\s+on\\s+function\\s+public\\.${name}[\\s\\S]{0,160}\\b(authenticated|anon|public)\\b`,
          "i"
        ).test(taste);
      expect(onlyServiceRole, `${name} should stay service_role only`).toBe(true);
      expect(
        /security definer/i.test(body),
        `${name} is executable only by service_role, which already bypasses RLS, so SECURITY DEFINER adds no capability and only widens the blast radius of a mis-issued grant`
      ).toBe(false);
    });
  }
});
