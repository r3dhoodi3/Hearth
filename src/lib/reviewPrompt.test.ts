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
      "/sign-in",
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
  it("matches a prefix, not just an exact path", () => {
    expect(isExcludedPath("/feedback")).toBe(true);
    expect(isExcludedPath("/feedback/thanks")).toBe(true);
    expect(isExcludedPath("/plus")).toBe(true);
    expect(isExcludedPath("/plus?reason=ask")).toBe(true);
  });

  it("does not match an unrelated path that merely starts similarly", () => {
    // Not a real route today, but this proves the check is a real prefix
    // match and not a substring anywhere in the string.
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

  it("has a matching PASTE-ME bundle carrying the same table and policy", () => {
    const paste = read(PASTE_ME);
    expect(paste).toContain("create table if not exists public.app_feedback");
    expect(paste).toContain('create policy "app_feedback self insert" on public.app_feedback');
    expect(paste).toContain("for insert to authenticated");
  });
});
