import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  FEEDBACK_CREDIT_CENTS,
  FEEDBACK_MIN_MESSAGE,
  FEEDBACK_MAX_MESSAGE,
  FEEDBACK_PROMO_KEY,
  FEEDBACK_CARD_TITLE,
  FEEDBACK_DEAL_NOTE,
  FEEDBACK_REPEAT_NOTE,
  FEEDBACK_THANKS_NOTE,
  FEEDBACK_ERROR_COPY,
  feedbackCreditDollars,
  validateFeedback,
} from "@/lib/proFeedback";

function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

// Drops // and -- comment lines and JSDoc continuations, so an assertion can
// say "this word must not appear in the CODE" while the comment right above it
// is free to explain exactly why.
function stripComments(body: string): string {
  return body
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return (
        !t.startsWith("//") &&
        !t.startsWith("--") &&
        !t.startsWith("*") &&
        !t.startsWith("/*")
      );
    })
    .join("\n");
}

describe("pro feedback credit: the shape of the offer", () => {
  it("is $5 of credit, once per contractor account", () => {
    expect(FEEDBACK_CREDIT_CENTS).toBe(500);
    expect(feedbackCreditDollars()).toBe("$5");
    expect(FEEDBACK_PROMO_KEY).toBe("pro_feedback_credit");
    expect(FEEDBACK_CARD_TITLE).toContain("$5 in lead credit");
  });

  it("states the money rule honestly and never promises pay for later reports", () => {
    // First report pays instantly; later reports are read by a person and MAY
    // earn a discretionary thank-you. "will" would be a promise the code does
    // not keep, so it must not appear in either sentence about later reports.
    expect(FEEDBACK_DEAL_NOTE).toContain("first report earns the $5");
    expect(FEEDBACK_DEAL_NOTE).toContain("do not pay on their own");
    expect(FEEDBACK_DEAL_NOTE).toContain("at our discretion");
    expect(FEEDBACK_REPEAT_NOTE).toContain("already earned the $5");
    expect(FEEDBACK_REPEAT_NOTE).toContain("at our discretion");
    for (const note of [FEEDBACK_DEAL_NOTE, FEEDBACK_REPEAT_NOTE]) {
      expect(note).not.toMatch(/will earn|will pay|will get/);
    }
  });

  it("keeps the later-report confirmation quiet about money", () => {
    expect(FEEDBACK_THANKS_NOTE).not.toContain("$");
    expect(FEEDBACK_THANKS_NOTE.toLowerCase()).not.toContain("credit");
  });
});

describe("validateFeedback", () => {
  const long = "x".repeat(FEEDBACK_MIN_MESSAGE);

  it("needs a score in 1..5", () => {
    expect(validateFeedback({ score: 0, message: long })).toBe("score");
    expect(validateFeedback({ score: 6, message: long })).toBe("score");
    expect(validateFeedback({ score: 2.5, message: long })).toBe("score");
    expect(validateFeedback({ score: Number.NaN, message: long })).toBe("score");
  });

  it("needs a real note, measured after trimming", () => {
    expect(validateFeedback({ score: 3, message: "  too short  " })).toBe(
      "message_short"
    );
    expect(
      validateFeedback({ score: 3, message: " ".repeat(50) })
    ).toBe("message_short");
  });

  it("refuses a note longer than the column can hold", () => {
    expect(
      validateFeedback({
        score: 3,
        message: "y".repeat(FEEDBACK_MAX_MESSAGE + 1),
      })
    ).toBe("message_long");
  });

  it("accepts a real answer", () => {
    expect(validateFeedback({ score: 5, message: long })).toBeNull();
  });

  it("has one sentence for every refusal it can return", () => {
    for (const key of [
      "score",
      "message_short",
      "message_long",
      "already",
      "rate_limited",
      "failed",
    ] as const) {
      expect(FEEDBACK_ERROR_COPY[key].length).toBeGreaterThan(10);
    }
  });
});

describe("pro feedback credit: it is never a store rating", () => {
  // App Store Review Guidelines 1.1.7 / 3.2.2 and Google Play policy forbid
  // paying for ratings, and src/lib/reviewPrompt.ts names this exact idea as
  // one that cannot be built against a rating. It is built against a private
  // product note instead, and these assertions are what keeps it there.
  const files = [
    "./proFeedback.ts",
    "./proFeedbackServer.ts",
    "../app/pro/feedback/page.tsx",
    "../app/pro/feedback/FeedbackForm.tsx",
    "../app/pro/feedback/actions.ts",
  ];

  it("never uses the word 'rating' in user-facing copy", () => {
    for (const f of files) {
      // Comments are allowed to explain the rule; rendered strings are not
      // allowed to say it.
      expect(stripComments(src(f)).toLowerCase(), f).not.toContain("rating");
    }
  });

  it("never reads or writes the app_feedback rating events", () => {
    for (const f of files) {
      // Comments are allowed to name the table they must stay away from -
      // that is the whole point of them. Code is not.
      const code = stripComments(src(f));
      expect(code, f).not.toContain("app_feedback");
      expect(code, f).not.toContain("rate_clicked");
      expect(code, f).not.toContain("rate_deferred");
    }
  });

  it("stores its rows on pro_feedback, its own table", () => {
    expect(src("./proFeedbackServer.ts")).toContain('.from("pro_feedback")');
  });
});

describe("grant_feedback_credit (migration 0144)", () => {
  const sql = readFileSync(
    fileURLToPath(
      new URL("../../supabase/migrations/0144_pro_feedback_credit.sql", import.meta.url)
    ),
    "utf8"
  );

  // The function's idempotency cannot run in vitest (there is no Postgres
  // here), so these assert the properties the SQL has to have for the action's
  // "exactly once, ever" promise to hold.
  it("gates the credit on a promo_claims insert, not on a read", () => {
    expect(sql).toContain("insert into promo_claims (user_id, promo_key, ref)");
    expect(sql).toContain("on conflict (user_id, promo_key) do nothing");
    expect(sql).toContain("v_claimed := found;");
    expect(sql).toContain("if not v_claimed then\n    return false;");
  });

  it("refuses to pay when no feedback was ever sent", () => {
    expect(sql).toContain(
      "if not exists (select 1 from pro_feedback where contractor_id = p_contractor)"
    );
  });

  it("locks the wallet before the claim", () => {
    expect(sql).toContain("perform 1 from wallets where id = v_wallet for update;");
  });

  it("writes all three money rows, in the house order", () => {
    const grant = sql.indexOf("insert into bonus_grants");
    const wallet = sql.indexOf("update wallets");
    const ledger = sql.indexOf("insert into wallet_transactions");
    expect(grant).toBeGreaterThan(-1);
    expect(wallet).toBeGreaterThan(grant);
    expect(ledger).toBeGreaterThan(wallet);
    expect(sql).toContain("'feedback_credit'");
    expect(sql).toContain("'Feedback thank-you credit'");
  });

  it("is service-role only", () => {
    expect(sql).toContain(
      "revoke all on function public.grant_feedback_credit(uuid, bigint)\n  from public, anon, authenticated;"
    );
    expect(sql).toContain("grant execute on function public.grant_feedback_credit(uuid, bigint)\n  to service_role;");
  });

  it("never touches app_feedback", () => {
    // The table's own COMMENT names app_feedback to say it is NOT that table,
    // which is the point of the comment. What must not exist is a statement
    // that reads or writes it.
    const code = stripComments(sql);
    expect(code).not.toMatch(/(from|into|update|join)\s+(public\.)?app_feedback/i);
    // ...and the function body must not mention it at all.
    const fn = code.slice(code.indexOf("create or replace function"));
    expect(fn).not.toContain("app_feedback");
  });
});

describe("repeat reports (migration 0152)", () => {
  // 0152 lifts the one-row-per-business cap so later bug reports can be
  // stored. It must do ONLY that: the money's once-ever gate lives in
  // promo_claims (0144, above) and no statement here may go near it.
  const sql = readFileSync(
    fileURLToPath(
      new URL(
        "../../supabase/migrations/0152_pro_feedback_repeat_reports.sql",
        import.meta.url
      )
    ),
    "utf8"
  );

  it("drops every unique constraint on pro_feedback, found by shape", () => {
    expect(sql).toContain("and contype = 'u'");
    expect(sql).toContain(
      "'alter table public.pro_feedback drop constraint %I'"
    );
  });

  it("replaces the lookup index the unique one doubled as", () => {
    expect(sql).toContain(
      "create index if not exists pro_feedback_contractor_idx"
    );
    expect(sql).toContain("on public.pro_feedback (contractor_id);");
  });

  it("moves no money and touches no money table", () => {
    // The table COMMENT is allowed to NAME the money gate, the same way
    // 0144's comments name app_feedback: that is documentation. What must not
    // exist is a statement that reads, writes, or reshapes money, or that
    // redefines the grant function.
    const code = stripComments(sql);
    expect(code).not.toMatch(
      /(from|into|update|join|alter\s+table|delete\s+from)\s+(public\.)?(promo_claims|wallets|bonus_grants|wallet_transactions)/i
    );
    expect(code).not.toContain("create or replace function");
    expect(code).not.toMatch(
      /(from|into|update|join)\s+(public\.)?app_feedback/i
    );
  });
});
