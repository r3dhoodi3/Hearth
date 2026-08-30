import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

// Source test, same shape as src/lib/leadCreatedAtPin0150.test.ts: reads
// migration and component source as plain text rather than exercising the
// database or rendering a component, because the thing being pinned is an
// absence, not a behaviour. A pro should never be able to buy a better
// review, a better position in the review list, or a better star average by
// paying more, holding a bigger wallet deposit, joining Pro membership, or
// winning more leads. That is the whole trust promise of a Hearth rating:
// the same reviews a $5-deposit pro gets, a top-deposit-tier Pro member
// gets, in the same order.
//
// Checked as identifiers (deposit_tiers, m.live, s.plan, "member", "plan",
// "wallet", "subscription", "lead_count", "leads_won"), not as a ban on
// English words, and only inside the narrow slices of code that actually
// decide what a review list contains or how it is ordered. Some of the files
// below legitimately say "member" elsewhere (Pro perks like the AI back
// office or logo display are real and gated on it) - this file never asserts
// the whole file is clean, only the review path inside it.

const root = path.resolve(__dirname, "..", "..");
const migrationsDir = path.join(root, "supabase/migrations");

function read(rel: string): string {
  return readFileSync(path.join(root, rel), "utf8");
}

function laterMigrationsRedefining(pinnedFile: string, needle: string): string[] {
  const pinnedNum = pinnedFile.slice(0, 4);
  return readdirSync(migrationsDir)
    .filter((f) => /^\d{4}_/.test(f) && f.slice(0, 4) > pinnedNum)
    .filter((f) => readFileSync(path.join(migrationsDir, f), "utf8").includes(needle));
}

// What a paid perk, not a trust fact, looks like in code. None of these
// identifiers may appear in a review-ordering or review-display code path.
const FORBIDDEN: RegExp[] = [
  /\bmember\b/i, // "member", "membership", the m.live / c.member style flags
  /\bplan\b/i, // subscriptions.plan, PRO_PLAN, PLUS_PLAN
  /deposit/i, // deposit_tiers, a deposit amount or tier name
  /wallet/i,
  /subscription/i,
  /lead_count/i,
  /leads_won/i,
];

function assertClean(label: string, text: string) {
  expect(text.length, `${label}: extraction found nothing, marker text moved`).toBeGreaterThan(0);
  for (const re of FORBIDDEN) {
    expect(text, `${label} matched forbidden pattern ${re}`).not.toMatch(re);
  }
}

describe("leave_review() never reads what a pro paid", () => {
  const PINNED = "0132_public_column_constraints.sql";
  const migration = read(`supabase/migrations/${PINNED}`);

  it("its gates are ownership, self-review, and linked-account fraud signals only", () => {
    const start = migration.indexOf("create or replace function public.leave_review(");
    expect(start).toBeGreaterThan(-1);
    const end = migration.indexOf("\n$$;", start);
    const body = migration.slice(start, end);
    assertClean(`leave_review() (${PINNED})`, body);
    // The real gates, so a passing test can't be an empty extraction.
    expect(body).toContain("owns_property");
    expect(body).toContain("account_signals");
  });

  it("stays clean in any later re-issue of the function", () => {
    for (const f of laterMigrationsRedefining(PINNED, "function public.leave_review(")) {
      const text = readFileSync(path.join(migrationsDir, f), "utf8");
      const start = text.indexOf("create or replace function public.leave_review(");
      const end = text.indexOf("\n$$;", start);
      assertClean(`leave_review() (${f})`, text.slice(start, end));
    }
  });
});

describe("contractor_reviews() lists reviews newest first, nothing else", () => {
  const PINNED = "0138_user_blocks.sql";
  const migration = read(`supabase/migrations/${PINNED}`);

  it("orders by created_at only, with no tier or membership filter", () => {
    const start = migration.indexOf("create or replace function public.contractor_reviews(");
    expect(start).toBeGreaterThan(-1);
    const end = migration.indexOf("\n$$;", start);
    const body = migration.slice(start, end);
    assertClean(`contractor_reviews() (${PINNED})`, body);
    expect(body).toContain("order by r.created_at desc");
  });

  it("stays clean in any later re-issue of the function", () => {
    for (const f of laterMigrationsRedefining(PINNED, "function public.contractor_reviews(")) {
      const text = readFileSync(path.join(migrationsDir, f), "utf8");
      const start = text.indexOf("create or replace function public.contractor_reviews(");
      const end = text.indexOf("\n$$;", start);
      assertClean(`contractor_reviews() (${f})`, text.slice(start, end));
    }
  });
});

// public_pro_profile() legitimately reads m.live (the Pro-membership flag)
// for real paid perks elsewhere in its payload: the logo, the about text,
// before/after photo labels. The two slices below are the only parts of the
// function that decide the star average and the review list, so those are
// the only parts checked.
function ratingAndReviewsClauses(text: string): { rating: string; reviews: string } {
  const ratingStart = text.indexOf("'rating',");
  const ratingEnd = text.indexOf("'member',", ratingStart);
  const reviewsStart = text.indexOf("'reviews', coalesce((");
  const reviewsEnd = text.indexOf("'projects', coalesce((", reviewsStart);
  return {
    rating: text.slice(ratingStart, ratingEnd),
    reviews: text.slice(reviewsStart, reviewsEnd),
  };
}

describe("public_pro_profile()'s rating and review list ignore membership", () => {
  const PINNED = "0141_contractors_owner_name.sql";
  const migration = read(`supabase/migrations/${PINNED}`);

  it("the rating and reviews keys never touch m.live or s.plan", () => {
    const { rating, reviews } = ratingAndReviewsClauses(migration);
    assertClean(`public_pro_profile() rating clause (${PINNED})`, rating);
    assertClean(`public_pro_profile() reviews clause (${PINNED})`, reviews);
    // A real average off real rows, never a seeded or placeholder value.
    expect(rating).toContain("case when c.review_count > 0 then c.rating end");
    expect(reviews).toContain("order by created_at desc");
  });

  it("stays clean in any later re-issue of the function", () => {
    for (const f of laterMigrationsRedefining(PINNED, "function public.public_pro_profile(")) {
      const text = readFileSync(path.join(migrationsDir, f), "utf8");
      const { rating, reviews } = ratingAndReviewsClauses(text);
      assertClean(`public_pro_profile() rating clause (${f})`, rating);
      assertClean(`public_pro_profile() reviews clause (${f})`, reviews);
    }
  });
});

describe("the app-side review paths never read what a pro paid", () => {
  it("ContractorReviews.tsx (the applicant-card review list) is plain rating, comment, date", () => {
    const view = read("src/app/(app)/contractors/ContractorReviews.tsx");
    assertClean("ContractorReviews.tsx", view);
  });

  it("saveReviewAction (the only place a review is written) is plain rating, comment, ownership", () => {
    const actions = read("src/app/(app)/contractors/actions.ts");
    const start = actions.indexOf("export async function saveReviewAction(");
    expect(start).toBeGreaterThan(-1);
    const end = actions.indexOf("\nexport async function ", start + 1);
    assertClean("saveReviewAction", actions.slice(start, end));
  });

  it("the public profile page's review list (/p/<id>) renders reviews with no filter or sort of its own", () => {
    const page = read("src/app/p/[id]/page.tsx");
    const start = page.indexOf("{profile.reviews.length === 0");
    const end = page.indexOf("Moderation row", start);
    expect(start).toBeGreaterThan(-1);
    const block = page.slice(start, end);
    assertClean("/p/[id]/page.tsx reviews block", block);
    // profile.reviews is rendered in the order the RPC already returned it -
    // no client-side .sort() or .filter() call of its own to drift from that.
    expect(block).not.toMatch(/\.sort\(|\.filter\(/);
  });
});
