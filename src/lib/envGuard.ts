// The wrong-credentials brake: refuse to serve production traffic against
// staging or test-mode credentials.
//
// WHY THIS EXISTS. Until docs/ENVIRONMENTS.md is carried out, Vercel Preview
// and Vercel Production share one set of environment variables (they are team
// SHARED vars linked to both, see STATUS.md), which means one Supabase project
// and one Stripe key serve both. The fix is configuration, not code: two
// Supabase projects, Stripe test keys scoped to Preview only. But the moment
// those exist, a single mis-scoped variable in the Vercel UI can point the LIVE
// site at the staging database, or leave live checkout running on sk_test_ so
// no money is ever collected. Neither failure is loud on its own: the staging
// database answers queries happily, and Stripe test mode returns successful
// sessions. This module makes both loud.
//
// Dependency-free on purpose (no server-only, no Supabase, no next/*), the same
// way src/lib/outboundGuards.ts is: the rule is the part worth unit testing,
// and importing a module that pulls in the secrets would drag "server-only"
// into the test run.
//
// WHEN IT RUNS. Not at import time. Import-time throws in Next turn into build
// failures and opaque prerender errors on pages that never touch either
// credential, and a module like this gets pulled in transitively by nearly
// everything. Instead it is called at FIRST SERVER USE of each credential:
//   - src/lib/supabase/admin.ts  createAdminClient()
//   - src/lib/stripe.ts          getStripe()
// so a deployment that is wired correctly never pays for it, and one that is
// not fails on its first privileged call with a message naming the variable.

// Vercel sets VERCEL_ENV to "production", "preview" or "development". Anything
// else (a local `next dev`, a test run, a self-hosted node process) is not a
// Vercel production deploy and is left alone: local development routinely and
// legitimately runs test-mode Stripe against whatever Supabase project the
// developer points at.
function isVercelProduction(env: NodeJS.ProcessEnv): boolean {
  return env.VERCEL_ENV === "production";
}

// The staging Supabase project, named by its own variable rather than
// hard-coded. The owner sets STAGING_SUPABASE_URL (or the shorter
// STAGING_SUPABASE_PROJECT_REF, the 20-character subdomain of the project URL)
// once on BOTH environments when he creates hearth-staging. Naming it in the
// environment rather than in this file means the check starts working the day
// the project exists, with no deploy, and it cannot go stale when the project
// is re-created.
//
// Comparison is on the project ref, not the whole URL string: the same project
// is reachable as https://<ref>.supabase.co with or without a trailing slash,
// and as a custom domain later.
function projectRef(url: string | undefined): string | null {
  if (!url) return null;
  const trimmed = url.trim().replace(/\/+$/, "");
  if (!trimmed) return null;
  // https://abcdefghijklmnop.supabase.co -> abcdefghijklmnop
  const m = /^https?:\/\/([a-z0-9-]+)\.supabase\.(co|in)$/i.exec(trimmed);
  if (m) return m[1].toLowerCase();
  // Anything that is not a Supabase-hosted URL (a local `supabase start` on
  // 127.0.0.1, a custom domain) is compared as its lowercased self.
  return trimmed.toLowerCase();
}

function stagingRefs(env: NodeJS.ProcessEnv): string[] {
  const refs = new Set<string>();
  const fromUrl = projectRef(env.STAGING_SUPABASE_URL);
  if (fromUrl) refs.add(fromUrl);
  const bare = env.STAGING_SUPABASE_PROJECT_REF?.trim().toLowerCase();
  if (bare) refs.add(bare);
  return Array.from(refs);
}

export type EnvGuardProblem = {
  variable: string;
  message: string;
};

// The whole rule, as a pure function over an environment. Exported so the tests
// can hand it an object instead of mutating process.env.
export function findEnvSeparationProblems(
  env: NodeJS.ProcessEnv
): EnvGuardProblem[] {
  if (!isVercelProduction(env)) return [];

  const problems: EnvGuardProblem[] = [];

  const supabaseRef = projectRef(env.NEXT_PUBLIC_SUPABASE_URL);
  const staging = stagingRefs(env);
  if (supabaseRef && staging.includes(supabaseRef)) {
    problems.push({
      variable: "NEXT_PUBLIC_SUPABASE_URL",
      message:
        `the production deploy is pointed at the staging Supabase project ` +
        `(${supabaseRef}). Real users would read and write staging data. ` +
        `Scope NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to one ` +
        `environment each in Vercel (see docs/ENVIRONMENTS.md).`,
    });
  }

  // Stripe test mode on production is a WARNING until the owner flips
  // REQUIRE_LIVE_STRIPE=1. Tonight (2026-08-29) the live site runs on an
  // sk_test_ key on purpose (no real customers yet, test cards only), and a
  // throw here would take every checkout down on the next deploy. Once real
  // payments start, set REQUIRE_LIVE_STRIPE=1 on Production and the same
  // finding becomes fatal. The staging-database check above always throws.
  const stripeKey = env.STRIPE_SECRET_KEY?.trim();
  const requireLiveStripe = env.REQUIRE_LIVE_STRIPE === "1";
  if (stripeKey && stripeKey.startsWith("sk_test_") && !requireLiveStripe) {
    console.error(
      "[ALERT] env separation: production is running Stripe in TEST mode " +
        "(sk_test_...). Payments are not real. Set the live key, then " +
        "REQUIRE_LIVE_STRIPE=1 to make this fatal."
    );
  }
  if (stripeKey && stripeKey.startsWith("sk_test_") && requireLiveStripe) {
    problems.push({
      variable: "STRIPE_SECRET_KEY",
      message:
        `the production deploy is running Stripe in TEST mode (sk_test_...), ` +
        `so no payment taken on the live site is real. Put the live key on ` +
        `Production only and the test key on Preview only ` +
        `(see docs/ENVIRONMENTS.md).`,
    });
  }

  return problems;
}

// Thrown, not returned, so a misconfigured production deploy fails visibly on
// its first privileged call rather than quietly serving the wrong data.
export class EnvSeparationError extends Error {
  readonly problems: EnvGuardProblem[];
  constructor(problems: EnvGuardProblem[]) {
    super(
      "Environment separation check failed: " +
        problems.map((p) => `${p.variable}: ${p.message}`).join(" | ")
    );
    this.name = "EnvSeparationError";
    this.problems = problems;
  }
}

// Memoised: the environment cannot change inside a running process, and the
// call sites are hot (createAdminClient runs on most requests). `null` means
// "not checked yet", an empty array means "checked, clean".
let cached: EnvGuardProblem[] | null = null;

// Test seam. Nothing in the app calls this.
export function resetEnvGuardCacheForTests(): void {
  cached = null;
}

// Call at the first use of a privileged credential. No-ops everywhere except a
// Vercel production deploy that is wired to the wrong project or key.
export function assertProductionEnvSeparation(
  env: NodeJS.ProcessEnv = process.env
): void {
  if (cached === null) {
    cached = findEnvSeparationProblems(env);
    for (const p of cached) {
      // Greppable in the Vercel runtime logs the same way the outbound cap is,
      // because the throw below may be swallowed by a caller's try/catch.
      console.error(
        `[ALERT] env separation: ${p.variable}: ${p.message}`
      );
    }
  }
  if (cached.length > 0) throw new EnvSeparationError(cached);
}
