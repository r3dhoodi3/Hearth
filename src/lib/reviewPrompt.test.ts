import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  isEligibleForReviewPrompt,
  isExcludedPath,
  isFirstSession,
  requestNativeReview,
} from "@/lib/reviewPrompt";

const repoFile = (rel: string) =>
  fileURLToPath(new URL(`../../${rel}`, import.meta.url));
const read = (rel: string) => readFileSync(repoFile(rel), "utf8");

const baseSignals = {
  pathname: "/dashboard",
  isFirstSession: false,
  alreadyShownOrAnswered: false,
  hasMeaningfulActivity: true,
};

describe("isEligibleForReviewPrompt: once per account", () => {
  it("refuses when this account has already been shown or has answered", () => {
    expect(
      isEligibleForReviewPrompt({ ...baseSignals, alreadyShownOrAnswered: true })
    ).toBe(false);
  });

  it("allows when nothing has been recorded for this account yet", () => {
    expect(isEligibleForReviewPrompt(baseSignals)).toBe(true);
  });

  it("a dismissed-with-X 'prompt_shown' row is enough to refuse - no separate 'answered' flag needed", () => {
    // The trigger helper only ever sees one boolean either way: whoever calls
    // it (src/app/(app)/feedback/actions.ts) folds "shown" and "answered"
    // into the same alreadyShownOrAnswered check, because a bare
    // 'prompt_shown' row already satisfies "at most once".
    expect(
      isEligibleForReviewPrompt({ ...baseSignals, alreadyShownOrAnswered: true })
    ).toBe(false);
  });
});

describe("isEligibleForReviewPrompt: meaningful-action gate", () => {
  it("refuses an account that has not done anything meaningful yet", () => {
    expect(
      isEligibleForReviewPrompt({ ...baseSignals, hasMeaningfulActivity: false })
    ).toBe(false);
  });

  it("allows once the account has (claimed a home / posted a job / asked 3+ / a pro applied)", () => {
    expect(
      isEligibleForReviewPrompt({ ...baseSignals, hasMeaningfulActivity: true })
    ).toBe(true);
  });
});

describe("isEligibleForReviewPrompt: session and page gates", () => {
  it("never shows during the first session", () => {
    expect(
      isEligibleForReviewPrompt({ ...baseSignals, isFirstSession: true })
    ).toBe(false);
  });

  it("never shows on an excluded page even when every other gate passes", () => {
    for (const pathname of [
      "/feedback",
      "/plus",
      "/onboarding",
      "/signin",
      "/checkout",
      "/plus/upgrade",
    ]) {
      expect(
        isEligibleForReviewPrompt({ ...baseSignals, pathname }),
        pathname
      ).toBe(false);
    }
  });

  it("shows on an ordinary signed-in page once every gate passes", () => {
    for (const pathname of ["/dashboard", "/issues", "/contractors", "/chats"]) {
      expect(isEligibleForReviewPrompt({ ...baseSignals, pathname }), pathname).toBe(
        true
      );
    }
  });
});

describe("isExcludedPath", () => {
  it("matches the route itself, anything inside it, and a query string", () => {
    expect(isExcludedPath("/feedback")).toBe(true);
    expect(isExcludedPath("/feedback/thanks")).toBe(true);
    expect(isExcludedPath("/plus")).toBe(true);
    expect(isExcludedPath("/plus?reason=ask")).toBe(true);
    expect(isExcludedPath("/plus/upgrade?ref=x")).toBe(true);
    expect(isExcludedPath("/plus#plans")).toBe(true);
  });

  it("excludes the sign-in route that actually exists", () => {
    // The list said "/sign-in" for a route that is spelled /signin, so the
    // prompt could appear over the sign-in page while excluding a page that
    // has never existed.
    expect(isExcludedPath("/signin")).toBe(true);
    expect(isExcludedPath("/signin?next=/dashboard")).toBe(true);
    expect(isExcludedPath("/sign-in")).toBe(false);
  });

  it("matches segment-wise, so a route that merely starts the same is not excluded", () => {
    // The bare startsWith() this replaced excluded /plusters too.
    expect(isExcludedPath("/plusters")).toBe(false);
    expect(isExcludedPath("/feedbackery")).toBe(false);
    expect(isExcludedPath("/signing-up")).toBe(false);
    expect(isExcludedPath("/dashboard")).toBe(false);
  });
});

// A minimal Storage stand-in so isFirstSession() is testable without jsdom -
// this file runs in vitest's default "node" environment.
function fakeStorage(initial: Record<string, string> = {}): Storage {
  const store = { ...initial };
  return {
    getItem: (k: string) => (k in store ? store[k] : null),
    setItem: (k: string, v: string) => {
      store[k] = v;
    },
    removeItem: (k: string) => {
      delete store[k];
    },
    clear: () => {
      for (const k of Object.keys(store)) delete store[k];
    },
    key: (i: number) => Object.keys(store)[i] ?? null,
    get length() {
      return Object.keys(store).length;
    },
  } as Storage;
}

describe("isFirstSession", () => {
  it("is true the first time, and marks the browser as seen", () => {
    const storage = fakeStorage();
    expect(isFirstSession(storage)).toBe(true);
    expect(storage.getItem("hearth_first_seen_at")).not.toBeNull();
  });

  it("is false on every call after the first", () => {
    const storage = fakeStorage();
    expect(isFirstSession(storage)).toBe(true);
    expect(isFirstSession(storage)).toBe(false);
    expect(isFirstSession(storage)).toBe(false);
  });

  it("is false immediately when the browser was already seen before", () => {
    const storage = fakeStorage({ hearth_first_seen_at: "1700000000000" });
    expect(isFirstSession(storage)).toBe(false);
  });

  it("fails toward NOT showing the prompt when storage throws", () => {
    const angryStorage = {
      getItem: () => {
        throw new Error("storage disabled");
      },
      setItem: () => {
        throw new Error("storage disabled");
      },
    } as unknown as Storage;
    expect(isFirstSession(angryStorage)).toBe(true);
  });
});

describe("requestNativeReview", () => {
  it("is a no-op on the web and never throws", () => {
    expect(() => requestNativeReview()).not.toThrow();
    expect(requestNativeReview()).toBeUndefined();
  });
});

describe("migration 0133: app_feedback RLS", () => {
  const MIGRATION = "supabase/migrations/0133_app_feedback.sql";
  const PASTE_ME = "supabase/PASTE-ME-live-2026-08-27-app-feedback.sql";
  const sql = read(MIGRATION);

  it("enables row level security", () => {
    expect(sql).toContain("alter table public.app_feedback enable row level security;");
  });

  it("lets a user insert only their own row", () => {
    expect(sql).toContain('create policy "app_feedback self insert" on public.app_feedback');
    expect(sql).toContain("for insert to authenticated");
    expect(sql).toContain("with check (user_id = auth.uid());");
  });

  it("grants no select policy at all - not even a self-select", () => {
    // The whole point: an account cannot read back whether it has been shown
    // or answered the prompt, or read anyone's feedback message, including
    // its own. This is what forces getReviewPromptSignals() (the eligibility
    // check) onto the service-role client.
    expect(sql).not.toContain("for select");
    expect(sql).not.toContain("using (user_id = auth.uid())");
  });

  it("constrains kind to exactly the three prompt events", () => {
    expect(sql).toContain(
      "kind          text not null check (kind in ('prompt_shown', 'loved', 'not_really'))"
    );
  });

  it("constrains side to homeowner or pro", () => {
    expect(sql).toContain("check (side in ('homeowner', 'pro'))");
  });

  it("cascades on the user being deleted, like every other per-user table", () => {
    expect(sql).toContain(
      "user_id       uuid not null references auth.users (id) on delete cascade,"
    );
  });

  it("makes the message-less prompt events idempotent per account", () => {
    // recordReviewPromptEvent is a server action: any signed-in account can
    // call it directly, in a loop. "At most once per account" has to be a
    // database constraint, not an app-level read-then-write.
    for (const source of [sql, read(PASTE_ME)]) {
      expect(source).toContain(
        "create unique index if not exists app_feedback_one_event_per_kind_idx"
      );
      expect(source).toContain("on public.app_feedback (user_id, kind)");
      expect(source).toContain("where message is null");
    }
  });

  it("leaves the feedback form's own rows unconstrained", () => {
    // The partial index is deliberately scoped to `message is null`: a
    // homeowner with two things to tell us gets to send both notes.
    expect(sql).toMatch(
      /app_feedback_one_event_per_kind_idx[\s\S]{0,120}where message is null/
    );
  });

  it("has a matching PASTE-ME bundle carrying the same table and policy", () => {
    const paste = read(PASTE_ME);
    expect(paste).toContain("create table if not exists public.app_feedback");
    expect(paste).toContain('create policy "app_feedback self insert" on public.app_feedback');
    expect(paste).toContain("for insert to authenticated");
  });
});

// The two writes into app_feedback are both reachable as server actions with
// no form in front of them, so both need a cap and neither may hard-fail on
// the new unique index. A source-text check: the wiring compiles either way.
describe("feedback actions: rate limits and idempotent inserts", () => {
  const actions = read("src/app/(app)/feedback/actions.ts");

  it("caps prompt events per account per day", () => {
    expect(actions).toContain("`review-prompt:${user.id}`");
    expect(actions).toMatch(/p_limit: 10,[\s\S]{0,40}p_window_seconds: 86400/);
  });

  it("caps written feedback per account per hour, like the support form", () => {
    expect(actions).toContain("`feedback:${user.id}`");
    expect(actions).toMatch(/p_limit: 5,[\s\S]{0,40}p_window_seconds: 3600/);
  });

  it("fails OPEN on a limiter error: only an explicit false blocks", () => {
    // A spam bucket, not a brute-force one. `allowed == null` (the RPC errored
    // or the function is missing) must never stop a real homeowner.
    expect(actions).not.toContain("if (!allowed)");
    expect(actions.match(/allowed === false/g) ?? []).toHaveLength(2);
  });

  it("treats the unique-index collision as already recorded", () => {
    expect(actions).toContain('error.code !== "23505"');
  });
});
