import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertProductionEnvSeparation,
  EnvSeparationError,
  findEnvSeparationProblems,
  resetEnvGuardCacheForTests,
} from "@/lib/envGuard";

// The two failures this guard exists to catch, both of which are silent on
// their own: a production deploy reading the staging database (it answers
// happily) and live checkout on a test-mode Stripe key (it returns success and
// takes no money). See docs/ENVIRONMENTS.md for the configuration these back
// up.

const LIVE = "https://livelivelivelive.supabase.co";
const STAGING = "https://stagingstagingstg.supabase.co";

function env(over: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return over as NodeJS.ProcessEnv;
}

afterEach(() => {
  resetEnvGuardCacheForTests();
});

describe("findEnvSeparationProblems", () => {
  it("flags a production deploy pointed at the staging Supabase project", () => {
    const problems = findEnvSeparationProblems(
      env({
        VERCEL_ENV: "production",
        NEXT_PUBLIC_SUPABASE_URL: STAGING,
        STAGING_SUPABASE_URL: STAGING,
      })
    );
    expect(problems.map((p) => p.variable)).toEqual([
      "NEXT_PUBLIC_SUPABASE_URL",
    ]);
    expect(problems[0].message).toContain("staging");
  });

  it("matches the staging project by ref, ignoring a trailing slash", () => {
    const problems = findEnvSeparationProblems(
      env({
        VERCEL_ENV: "production",
        NEXT_PUBLIC_SUPABASE_URL: `${STAGING}/`,
        STAGING_SUPABASE_PROJECT_REF: "stagingstagingstg",
      })
    );
    expect(problems).toHaveLength(1);
  });

  it("flags a test-mode Stripe key in production once REQUIRE_LIVE_STRIPE=1", () => {
    const problems = findEnvSeparationProblems(
      env({
        VERCEL_ENV: "production",
        NEXT_PUBLIC_SUPABASE_URL: LIVE,
        STAGING_SUPABASE_URL: STAGING,
        STRIPE_SECRET_KEY: "sk_test_abc123",
        REQUIRE_LIVE_STRIPE: "1",
      })
    );
    expect(problems.map((p) => p.variable)).toEqual(["STRIPE_SECRET_KEY"]);
  });

  it("only warns about a test-mode Stripe key until REQUIRE_LIVE_STRIPE=1 (the live site runs test mode before launch)", () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const problems = findEnvSeparationProblems(
      env({
        VERCEL_ENV: "production",
        NEXT_PUBLIC_SUPABASE_URL: LIVE,
        STAGING_SUPABASE_URL: STAGING,
        STRIPE_SECRET_KEY: "sk_test_abc123",
      })
    );
    expect(problems).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("TEST mode"));
    warn.mockRestore();
  });

  it("passes a correctly wired production deploy", () => {
    expect(
      findEnvSeparationProblems(
        env({
          VERCEL_ENV: "production",
          NEXT_PUBLIC_SUPABASE_URL: LIVE,
          STAGING_SUPABASE_URL: STAGING,
          STRIPE_SECRET_KEY: "sk_live_abc123",
        })
      )
    ).toEqual([]);
  });

  // Preview is where the test key and the staging project BELONG, so the guard
  // must never fire there or every preview deploy would 500.
  it("never fires outside a Vercel production deploy", () => {
    for (const vercelEnv of ["preview", "development", undefined]) {
      expect(
        findEnvSeparationProblems(
          env({
            VERCEL_ENV: vercelEnv,
            NEXT_PUBLIC_SUPABASE_URL: STAGING,
            STAGING_SUPABASE_URL: STAGING,
            STRIPE_SECRET_KEY: "sk_test_abc123",
            REQUIRE_LIVE_STRIPE: "1",
          })
        )
      ).toEqual([]);
    }
  });

  // Until the owner creates hearth-staging there is no ref to compare against.
  // The check must stay quiet rather than guess.
  it("says nothing about Supabase when no staging project is named", () => {
    expect(
      findEnvSeparationProblems(
        env({
          VERCEL_ENV: "production",
          NEXT_PUBLIC_SUPABASE_URL: LIVE,
          STRIPE_SECRET_KEY: "sk_live_abc123",
        })
      )
    ).toEqual([]);
  });
});

describe("assertProductionEnvSeparation", () => {
  it("throws EnvSeparationError naming every problem at once", () => {
    let caught: unknown;
    try {
      assertProductionEnvSeparation(
        env({
          VERCEL_ENV: "production",
          NEXT_PUBLIC_SUPABASE_URL: STAGING,
          STAGING_SUPABASE_URL: STAGING,
          STRIPE_SECRET_KEY: "sk_test_abc123",
          REQUIRE_LIVE_STRIPE: "1",
        })
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(EnvSeparationError);
    const problems = (caught as EnvSeparationError).problems;
    expect(problems.map((p) => p.variable).sort()).toEqual([
      "NEXT_PUBLIC_SUPABASE_URL",
      "STRIPE_SECRET_KEY",
    ]);
  });

  it("does not throw when the deploy is wired correctly", () => {
    expect(() =>
      assertProductionEnvSeparation(
        env({
          VERCEL_ENV: "production",
          NEXT_PUBLIC_SUPABASE_URL: LIVE,
          STAGING_SUPABASE_URL: STAGING,
          STRIPE_SECRET_KEY: "sk_live_abc123",
        })
      )
    ).not.toThrow();
  });
});
