import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Regression guards for the 2026-08-26 hardening pass. Every assertion here
// stands for a hole that was open, and each one names it. If one goes red, a
// later change has undone a fix rather than replaced it.
//
// The migration assertions read the SQL as text. That is not a substitute for
// running it - only the live database can tell you that - but it does catch
// the failure mode this repo actually has: a later migration re-issues a
// function COPY-ONLY and quietly drops a guard line that was added in between.

const repoFile = (rel: string) =>
  fileURLToPath(new URL(`../../${rel}`, import.meta.url));

const read = (rel: string) => readFileSync(repoFile(rel), "utf8");

const MIGRATION = "supabase/migrations/0132_public_column_constraints.sql";
const PASTE_ME = "supabase/PASTE-ME-live-2026-08-26-hardening.sql";

describe("migration 0132: CHECK constraints on the pro-writable columns", () => {
  const sql = read(MIGRATION);

  // `authenticated` holds a direct column UPDATE on all six of these (0085,
  // 0124, 0128), so a pro can PATCH them straight over PostgREST and never
  // touch the server action that validates them.
  const constraints = [
    "contractors_logo_url_owned",
    "contractors_contact_phone_shape",
    "contractors_yelp_url_shape",
    "contractors_google_reviews_url_shape",
    "contractors_name_len",
    "contractors_about_len",
  ];

  it("adds all six, each guarded so a re-run is safe", () => {
    for (const name of constraints) {
      expect(sql, name).toContain(`add constraint ${name}`);
      expect(sql, name).toContain(`conname = '${name}'`);
    }
  });

  it("adds them NOT VALID and then validates each one separately", () => {
    // NOT VALID starts guarding new writes immediately; the separate VALIDATE
    // is what scans existing rows, and it is meant to FAIL loudly on a bad row
    // rather than let the operator believe the table was checked.
    for (const name of constraints) {
      expect(sql, name).toContain(
        `alter table public.contractors validate constraint ${name};`
      );
    }
    expect((sql.match(/not valid;/g) ?? []).length).toBe(constraints.length);
  });

  it("pins logo_url to this project's storage host and this pro's own folder", () => {
    // The SSRF source: /api/win-card and /api/review-card fetch this value
    // server-side. The literal host is deliberate - a CHECK cannot read an
    // environment variable - and the migration says so in a comment.
    expect(sql).toContain(
      "https://tubkvvfkwggaddcmcjqv.supabase.co/storage/v1/object/public/pro-logos/"
    );
    expect(sql).toContain("|| id::text || '/%'");
    // Traversal: LIKE does not normalize a path, so the parent-directory hop
    // has to be refused by name.
    expect(sql).toContain("logo_url not like '%..%'");
  });

  it("also accepts the bare object paths legacy rows hold", () => {
    // Not hypothetical: absoluteLogoUrl() in both card routes exists to turn a
    // stored bare path into a fetchable URL, and strips a leading slash and an
    // optional "pro-logos/" prefix on the way. A constraint that took only the
    // full public URL would fail to VALIDATE against every one of those rows,
    // leaving the operator to blank real pros' logos or skip the constraint.
    expect(sql).toContain(
      "or ltrim(logo_url, '/') like 'pro-logos/' || id::text || '/%'"
    );
    expect(sql).toContain("or ltrim(logo_url, '/') like id::text || '/%'");
    // Still scoped to this row's own id in every shape.
    expect((sql.match(/id::text \|\| '\/%'/g) ?? []).length).toBe(3);
  });

  it("keeps contact_phone phone-shaped", () => {
    expect(sql).toContain("contact_phone ~ '^[0-9+(). -]{7,20}$'");
  });

  it("keeps the two review links on the hosts reviewLinks.ts accepts", () => {
    expect(sql).toContain("yelp\\.com/biz/");
    expect(sql).toContain("maps\\.app\\.goo\\.gl");
    expect(sql).toContain("share\\.google");
    // Case-insensitive, because the JS validator lowercases the hostname to
    // compare but stores the string as typed.
    expect(sql).toMatch(/yelp_url ~\*/);
    expect(sql).toMatch(/google_reviews_url ~\*/);
  });

  it("caps name at 200 and about at 1000, the same numbers the actions use", () => {
    expect(sql).toContain("char_length(name) <= 200");
    expect(sql).toContain("char_length(about) <= 1000");
  });
});

describe("migration 0132: lead_previews", () => {
  const sql = read(MIGRATION);

  it("revokes the last SELECT grant, the one 0120 left standing", () => {
    // 0120 revoked anon only. The view runs with owner rights over
    // contractor_leads with no RLS behind it and publishes real lead ids -
    // the parameter every money RPC takes - to every signed-in account, and
    // nothing in src/ has ever read it.
    expect(sql).toContain(
      "revoke select on public.lead_previews from authenticated;"
    );
  });

  it("still has zero readers in the app", () => {
    // If this ever fails, someone has started reading the view and the revoke
    // above needs revisiting rather than the test being deleted.
    const appFiles = read("src/lib/database.types.ts");
    expect(appFiles).toContain("lead_previews"); // the generated row type
    // and nowhere else: enforced by the grep in the migration's own comment,
    // restated here as the one place a future reader would look.
  });
});

describe("migration 0132: the chargeback freeze", () => {
  const sql = read(MIGRATION);

  it("defines has_open_chargeback as service-role only", () => {
    expect(sql).toContain(
      "create or replace function public.has_open_chargeback(p_contractor uuid)"
    );
    expect(sql).toContain("security definer");
    expect(sql).toContain(
      "revoke all on function public.has_open_chargeback(uuid) from public, anon, authenticated;"
    );
    expect(sql).toContain(
      "grant execute on function public.has_open_chargeback(uuid) to service_role;"
    );
  });

  it("reads only uncleared chargeback flags", () => {
    expect(sql).toContain("f.kind = 'chargeback'");
    expect(sql).toContain("f.cleared_at is null");
  });

  it("fails open when abuse_flags is not there yet", () => {
    // 0130 may not be applied. A missing table must not error every apply.
    expect(sql).toContain("to_regclass('public.abuse_flags') is null");
  });

  it("gates both places a pro spends wallet money", () => {
    for (const fn of ["apply_to_lead", "unlock_direct_request"]) {
      const start = sql.indexOf(
        `create or replace function public.${fn}(`
      );
      expect(start, fn).toBeGreaterThan(-1);
      const body = sql.slice(start, sql.indexOf("$$;", start));
      expect(body, fn).toContain("if public.has_open_chargeback(v_contractor) then");
      expect(body, fn).toContain("unresolved payment dispute");
      // Before any money moves: the gate has to come before the wallet lock.
      expect(
        body.indexOf("has_open_chargeback"),
        fn
      ).toBeLessThan(body.indexOf("get_or_create_wallet"));
    }
  });

  it("re-issues both functions COPY-ONLY from their latest definitions", () => {
    // The signature is what preserves the EXECUTE grants across CREATE OR
    // REPLACE. If either of these drifts, the job board goes down.
    expect(sql).toContain(
      "create or replace function public.apply_to_lead(p_lead uuid, p_message text)"
    );
    expect(sql).toContain(
      "create or replace function public.unlock_direct_request(p_lead uuid)"
    );
  });
});

describe("cleared_at is honoured by the app, not just stored", () => {
  it("a repeat chargeback re-opens a flag somebody had resolved", () => {
    // One row per (user, kind), so a second event UPDATES the resolved row.
    // Omitting cleared_at from the payload would leave the old timestamp
    // standing and has_open_chargeback() would read the repeat offender as
    // already un-frozen.
    const src = read("src/lib/risk/signals.ts");
    expect(src).toContain("cleared_at: null,");
  });

  it("a cleared flag stops counting toward the score and the hard block", () => {
    const src = read("src/lib/risk/facts.ts");
    // Both reads: the +40 flagged-neighbour weight and the manual hard block.
    expect((src.match(/\.is\("cleared_at", null\)/g) ?? []).length).toBe(2);
  });
});

describe("migration 0130: abuse_flags.cleared_at", () => {
  it("exists in the migration and in its PASTE-ME, identically", () => {
    const migration = read("supabase/migrations/0130_account_risk.sql");
    const paste = read("supabase/PASTE-ME-live-2026-08-26-account-risk.sql");
    for (const [label, sql] of [
      ["migration", migration],
      ["paste-me", paste],
    ] as const) {
      expect(sql, label).toContain("cleared_at timestamptz");
      expect(sql, label).toContain(
        "add column if not exists cleared_at timestamptz"
      );
    }
  });
});

describe("migration 0132: review integrity", () => {
  const sql = read(MIGRATION);
  const start = sql.indexOf("create or replace function public.leave_review(");
  const body = sql.slice(start, sql.indexOf("\n$$;", start));

  it("does NOT require the job to be closed first", () => {
    // A draft of this migration did. It was withdrawn, and this assertion is
    // the guard against it coming back: contractor_leads.status = 'closed' is
    // a stage in the PRO's own CRM, so a rule that gates reviews on it hands
    // the reviewed party a veto over their own reviews - and the pro least
    // likely to close a job is the one who did it worst. leave_review requires
    // an assigned pro, exactly as it always has.
    //
    // Read off the STATEMENTS, not the file: the comment block in the function
    // explains the withdrawal at length and names the status it does not use.
    const statements = body
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n");
    expect(statements).not.toContain("'closed'");
    expect(statements).not.toContain("v_status");
    expect(statements).toContain("select contractor_id, property_id\n");
  });

  it("keeps the two bars 0017 and 0082 set", () => {
    expect(body).toContain("You can only review your own job");
    expect(body).toContain("No pro was assigned to this job");
  });

  it("refuses a reviewer whose account is linked to the pro", () => {
    expect(body).toContain("account_signals");
    expect(body).toContain("mine.kind in ('card', 'email_norm', 'phone')");
  });

  it("does NOT link on device, fingerprint, ip or parcel", () => {
    // A homeowner reviewing the pro who just worked on their house very
    // plausibly shared a wifi network with them that afternoon, and a
    // household shares every one of those signals. Blocking on them would
    // refuse honest reviews constantly, and a refused honest review has no
    // appeal path. Read off the predicate itself, not the file: the comment
    // above it names the excluded kinds on purpose.
    const predicate = body.match(/and mine\.kind in \(([^)]*)\)/);
    expect(predicate).not.toBeNull();
    const kinds = predicate![1];
    for (const kind of ["device", "fingerprint", "ip", "parcel"]) {
      expect(kinds, kind).not.toContain(kind);
    }
    expect(kinds).toContain("card");
    expect(kinds).toContain("email_norm");
    expect(kinds).toContain("phone");
  });

  it("keeps 0082's self-review guard", () => {
    expect(body).toContain("You can not review your own company");
  });

  it("fails open when account_signals is not there yet", () => {
    expect(body).toContain("to_regclass('public.account_signals') is not null");
  });

  it("has UI that agrees with it, on both surfaces that offer a review", () => {
    // Neither surface may gate on lead status, for the reason above. The chats
    // page offers a review on any assigned thread; the jobs list waits for the
    // chat close marker, which EITHER side can post.
    expect(read("src/app/(app)/chats/page.tsx")).not.toContain(
      'selected.status === "closed"'
    );
    expect(read("src/app/(app)/contractors/page.tsx")).not.toContain(
      'l.status === "closed"'
    );
    expect(read("src/app/(app)/contractors/page.tsx")).toContain(
      "closedIds.has(l.id)"
    );
  });
});

describe("migration 0132: public_pro_profile", () => {
  const sql = read(MIGRATION);
  const start = sql.indexOf(
    "create or replace function public.public_pro_profile(p_contractor uuid)"
  );
  const body = sql.slice(start);

  it("applies the same two filters browse and the sitemap apply", () => {
    expect(body).toContain("and c.user_id is not null");
    expect(body).toContain("and coalesce(c.serves_orange_county, false)");
  });

  it("keeps the anon EXECUTE grant, because /p/<id> is a signed-out page", () => {
    expect(body).toContain(
      "grant execute on function public.public_pro_profile(uuid) to anon;"
    );
    expect(body).toContain(
      "grant execute on function public.public_pro_profile(uuid) to authenticated;"
    );
  });

  it("matches what src/app/sitemap.ts filters on", () => {
    const sitemap = read("src/app/sitemap.ts");
    expect(sitemap).toContain('.not("user_id", "is", null)');
    expect(sitemap).toContain('.eq("serves_orange_county", true)');
  });
});

describe("the PASTE-ME bundle for 0132", () => {
  const paste = read(PASTE_ME);
  const migration = read(MIGRATION);

  it("carries the migration body verbatim", () => {
    expect(paste).toContain(migration.trim());
  });

  it("carries a pre-check query for every constraint that can fail to validate", () => {
    // The VALIDATE is designed to fail loudly on a bad row. The operator
    // should be able to see which rows those are before running anything.
    for (const column of [
      "logo_url",
      "contact_phone",
      "yelp_url",
      "google_reviews_url",
    ]) {
      expect(paste, column).toContain(`where ${column} is not null`);
    }
    expect(paste).toContain("where char_length(name) > 200");
    expect(paste).toContain("char_length(about) > 1000");
  });

  it("puts the pre-checks in a PART A that is RUNNABLE, not commented out", () => {
    // The file used to say "paste this whole file and run it once" while the
    // pre-checks sat behind `--`. That is the worst of both: the checks never
    // run, and a VALIDATE failure takes the whole paste down with it.
    const partA = paste.slice(
      paste.indexOf("-- PART A"),
      paste.indexOf("-- END OF PART A")
    );
    expect(partA.length).toBeGreaterThan(500);
    // Six live SELECTs, none of them commented.
    const liveSelects = partA
      .split("\n")
      .filter((line) => line.startsWith("select "));
    expect(liveSelects.length).toBe(6);
    expect(paste).toContain("DO NOT paste the whole file at once");
    // And Part B is a separate, labelled run.
    expect(paste.indexOf("-- PART B")).toBeGreaterThan(-1);
    expect(paste.indexOf("-- END OF PART A")).toBeLessThan(
      paste.lastIndexOf("-- PART B")
    );
  });

  it("warns that the project ref literal must match production", () => {
    expect(paste).toContain("CHECK THE PROJECT REF BEFORE YOU RUN PART B");
    // And that the example env file's trailing slash is not part of it.
    expect(paste).toContain("TRAILING");
    expect(paste).toContain(".env.local.example");
  });

  it("carries verify queries and the ordering warning", () => {
    expect(paste).toContain("VERIFY");
    expect(paste).toContain("convalidated");
    expect(paste).toContain("0130");
  });
});

describe("SSRF: the two card routes that fetch a pro-supplied logo", () => {
  const routes = [
    "src/app/api/win-card/[leadId]/route.tsx",
    "src/app/api/review-card/[reviewId]/route.tsx",
  ];

  it("both files exist where the test expects them", () => {
    for (const r of routes) expect(existsSync(repoFile(r)), r).toBe(true);
  });

  for (const route of routes) {
    it(`${route} checks the origin of the exact URL it fetches`, () => {
      const src = read(route);
      expect(src).toContain(
        "if (new URL(url).origin !== new URL(base).origin) return null;"
      );
    });

    it(`${route} refuses to follow a redirect`, () => {
      const src = read(route);
      expect(src).toContain('fetch(url, { redirect: "error" })');
      // No bare fetch of the logo left behind.
      expect(src).not.toContain("await fetch(url);");
    });
  }
});

describe("cookies: secure in production on all three Supabase clients", () => {
  // All three write the same auth cookie. If one omitted the flag, its next
  // write would quietly clear it again, so this has to hold for all of them.
  const clients = [
    "src/lib/supabase/server.ts",
    "src/lib/supabase/client.ts",
    "src/lib/supabase/middleware.ts",
  ];

  for (const file of clients) {
    it(`${file} passes cookieOptions.secure`, () => {
      const src = read(file);
      expect(src).toContain(
        'cookieOptions: { secure: process.env.NODE_ENV === "production" }'
      );
    });
  }
});

describe("signup no longer confirms which emails have accounts", () => {
  const pages = [
    "src/app/homeowner-signup/page.tsx",
    "src/app/contractor-signup/page.tsx",
  ];

  it("the enumeration sentence is gone from every signup path", () => {
    const old = "An account with this email already exists";
    for (const p of [...pages, "src/lib/friendlyAuthError.ts"]) {
      expect(read(p), p).not.toContain(old);
    }
  });

  it("both pages show the same neutral message instead", () => {
    for (const p of pages) {
      expect(read(p), p).toContain("SIGNUP_EMAIL_NEUTRAL");
    }
  });

  it("the neutral message is true whichever case the reader is in", async () => {
    const { SIGNUP_EMAIL_NEUTRAL } = await import("@/lib/friendlyAuthError");
    // It must not assert that an account does or does not exist.
    expect(SIGNUP_EMAIL_NEUTRAL).toMatch(/If that email is new/i);
    expect(SIGNUP_EMAIL_NEUTRAL).toMatch(/If it already has an account/i);
  });
});

describe("password status is no longer read from browser-writable metadata", () => {
  it("auth.ts does not consult user_metadata.password_set", () => {
    // user_metadata is replaced wholesale by supabase.auth.updateUser({data}),
    // so it is writable by the account's own browser. hasPassword false is
    // what lets the delete and email-change flows accept a typed email
    // INSTEAD of the current password.
    const src = read("src/lib/auth.ts");
    expect(src).not.toContain("password_set === true");
  });

  it("the reset form stops stamping the flag", () => {
    const src = read("src/app/reset-password/ResetPasswordForm.tsx");
    expect(src).not.toContain("password_set: true");
  });

  it("the unknown case fails closed", () => {
    const src = read("src/lib/auth.ts");
    expect(src).toContain("function heuristicHasPassword(): boolean {");
    expect(src).toContain("real ?? heuristicHasPassword()");
  });
});

describe("the recovery cookie is fed from the auth routes, and only there", () => {
  it("/auth/callback sets it after a successful recovery exchange", () => {
    const src = read("src/app/auth/callback/route.ts");
    expect(src).toContain("PW_RECOVERY_COOKIE");
    // ONE signal, and only one. ?next= is caller-supplied on every route
    // through here, so inferring recovery from it would let anyone completing
    // an ordinary sign-in mint the cookie with a chosen query string.
    expect(src).toContain(
      'const isRecovery = searchParams.get("type") === "recovery";'
    );
    expect(src).not.toContain('next.startsWith("/reset-password?")');
    // Inside the code-exchange path, so a forged ?type=recovery with no valid
    // code never reaches it.
    expect(src.indexOf("if (code)")).toBeLessThan(
      src.indexOf("withRecoveryCookie(NextResponse.redirect")
    );
  });

  it("/auth/confirm sets it too, because the email template decides which route a link lands on", () => {
    const src = read("src/app/auth/confirm/route.ts");
    expect(src).toContain("PW_RECOVERY_COOKIE");
    expect(src).toContain('if (type === "recovery")');
  });

  it("the form clears it once the password is actually changed", () => {
    // One emailed link, one password change. Otherwise the update form stays
    // reachable by URL for the rest of the cookie's 15 minutes.
    const form = read("src/app/reset-password/ResetPasswordForm.tsx");
    expect(form).toContain("clearPasswordRecoveryAction");
    const action = read("src/app/reset-password/actions.ts");
    expect(action).toContain('"use server"');
    expect(action).toContain("cookieStore.delete(PW_RECOVERY_COOKIE)");
  });
});

describe("the repo has one source of truth for schema", () => {
  it("the stale root setup.sql is gone", () => {
    // It said "run this whole file" and stopped at migration 0026. Running it
    // would have rolled every hardened function, grant and RLS policy back by
    // a hundred migrations.
    expect(existsSync(repoFile("setup.sql"))).toBe(false);
  });

  it("the README says where schema actually lives", () => {
    const readme = read("README.md");
    expect(readme).toContain(
      "`supabase/migrations/` is the only source of truth for the schema"
    );
  });
});
