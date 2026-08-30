import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { toObjectPath } from "./storage";

// An IDOR sweep found four places where a server action took an id or a
// storage key straight off FormData and wrote it into a row without ever
// asking whether it belonged to the home being edited. Every one of them is
// invisible in a diff: the fix is a single filter or a single scoped select,
// and deleting it leaves code that still compiles, still passes every other
// test, and still works perfectly for an honest user.
//
// So these are source-text tests, the same route-table-as-fixture trick
// aiReason.test.ts and guardedSegments.test.ts use. They read the action files
// and assert the guard is present. Delete the guard, this file goes red.

function appSource(rel: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../app/${rel}`, import.meta.url)),
    "utf8"
  );
}

// Every action file that pulls the `photo_urls` hidden field out of FormData.
// Named explicitly rather than globbed so ADDING a file to this list is a
// deliberate act: a new uploader path has to come here and prove it checks.
const PHOTO_URL_ACTION_FILES = [
  "(app)/contractors/actions.ts",
  "(app)/issues/actions.ts",
  "(app)/profile/actions.ts",
];

describe("client-chosen storage keys", () => {
  // The exploit this closes: photos.url is what migration 0104's
  // can_view_job_photo_full / can_preview_job_photo match a signed url
  // against, and /api/job-photo signs with the ADMIN client once that gate
  // says yes. Storing another property's object key in your own photos row
  // therefore hands you (and every board-eligible pro) that property's
  // private photos at full resolution.
  it("every action that reads photo_urls checks the key belongs to the home", () => {
    for (const rel of PHOTO_URL_ACTION_FILES) {
      const src = appSource(rel);
      expect(src, `${rel} reads photo_urls`).toContain('"photo_urls"');
      expect(src, `${rel} must guard photo_urls`).toContain(
        "isOwnedStoragePath"
      );
    }
  });

  it("the job poster runs its photo keys through the shared guard", () => {
    const src = appSource("(app)/contractors/actions.ts");
    // Length alone was the whole check before. A key of the right length
    // pointing at somebody else's folder passed it.
    expect(src).toMatch(/isOwnedStoragePath\(u,\s*propertyId\)/);
    expect(src).toMatch(/validPhotoUrls\(formData,\s*property\.id\)/);
  });

  // The singular sibling of the list above: the emergency prep card posts one
  // hidden `photo_url`, not a `photo_urls` list, so it never joined
  // PHOTO_URL_ACTION_FILES and for a while a length check was its whole guard.
  it("the emergency prep slot checks its single photo key too", () => {
    const src = appSource("(app)/emergency/actions.ts");
    expect(src).toContain('formData.get("photo_url")');
    expect(src).toMatch(/isOwnedStoragePath\(rawUrl,\s*property\.id\)/);
    // The old check, which accepted any string under 1000 characters.
    expect(src).not.toMatch(/rawUrl\.length <= 1000 \? rawUrl : ""/);
  });

  it("the system editor's photo attach filters on the owning property", () => {
    const src = appSource("(app)/profile/actions.ts");
    expect(src).toMatch(/isOwnedStoragePath\(u,\s*propertyId\)/);
    // .filter(Boolean) was the old check: it only asked whether the string
    // was non-empty.
    expect(src).not.toMatch(
      /getAll\("photo_urls"\)[\s\S]*?\.filter\(Boolean\)/
    );
  });
});

describe("client-chosen row ids on the homeowner side", () => {
  // issue_id lands on contractor_leads.issue_id, which is what
  // open_jobs_for_me aggregates photo_urls by and what the 0104 photo gates
  // bind a signed url to. A lead pointed at somebody else's issue publishes
  // that home's photo keys to the job board.
  it("postJobAction pins issue_id to the home before storing it", () => {
    const src = appSource("(app)/contractors/actions.ts");
    expect(src).toContain('const issueIdRaw = (formData.get("issue_id")');
    // The verification: scoped select on issues by BOTH the id and the home.
    expect(src).toMatch(
      /from\("issues"\)[\s\S]{0,200}?\.eq\("id",\s*issueIdRaw\)[\s\S]{0,120}?\.eq\("property_id",\s*property\.id\)/
    );
    // And the raw value must never be what gets written.
    expect(src).not.toMatch(/issue_id:\s*issueIdRaw/);
  });

  it("reportIssueAction pins system_id to the home before storing it", () => {
    const src = appSource("(app)/issues/actions.ts");
    expect(src).toMatch(
      /from\("home_systems"\)[\s\S]{0,200}?\.eq\("id",\s*systemIdRaw\)[\s\S]{0,120}?\.eq\("property_id",\s*property\.id\)/
    );
    // The insert takes the verified value, never the raw form field.
    expect(src).toMatch(/system_id:\s*systemId,/);
    expect(src).not.toMatch(
      /system_id:\s*\(formData\.get\("system_id"\) as string\)/
    );
  });

  it("updateSystemAction pins the system to the active home before writing", () => {
    const src = appSource("(app)/profile/actions.ts");
    expect(src).toMatch(
      /from\("home_systems"\)[\s\S]{0,200}?\.eq\("id",\s*id\)[\s\S]{0,120}?\.eq\("property_id",\s*property\.id\)/
    );
    // A miss has to stop the action, not fall through to the update.
    expect(src).toMatch(/if\s*\(!ownedSystem\)\s*\{/);
    // The check has to come BEFORE the first write, or it is decoration.
    const checkAt = src.indexOf("ownedSystem");
    const updateAt = src.search(
      /\.from\("home_systems"\)\s*\n\s*\.update\(/
    );
    expect(checkAt).toBeGreaterThan(-1);
    expect(updateAt).toBeGreaterThan(-1);
    expect(checkAt).toBeLessThan(updateAt);
  });

  it("says the same thing for a missing system as for someone else's", () => {
    const src = appSource("(app)/profile/actions.ts");
    // Two refusals, one wording: a different message for "not yours" would
    // turn this action into an id oracle.
    const misses = src.match(
      /Couldn't find that system\. Please refresh and try again\./g
    );
    expect(misses?.length).toBe(2);
  });
});

describe("the guard these fixes lean on", () => {
  it("is one shared implementation, not a per-file copy", () => {
    const src = readFileSync(
      fileURLToPath(new URL("./ownedStoragePath.ts", import.meta.url)),
      "utf8"
    );
    expect(src).toContain("export function isOwnedStoragePath");
    // The two properties the homeowner-side fixes depend on: the key must sit
    // under the property folder, and traversal out of it must be refused.
    expect(src).toContain("path.startsWith(prefix)");
    expect(src).toContain('decoded.includes("..")');
  });

  // Migration 0131 adds storage_object_key(), a SQL twin of toObjectPath, and
  // the whole point is that the two agree: if the database checked a DIFFERENT
  // reading of the same stored string than /api/img signs, an attacker would
  // aim at the gap between the two readings.
  //
  // There is no Postgres in this test run, so this cannot execute the SQL. What
  // it CAN do is pin the TypeScript side to the exact pairs the migration's
  // verify query 2 tells the operator to expect. If toObjectPath ever changes,
  // this goes red and the SQL twin is known to be stale.
  it("pins the normalizer contract the SQL twin has to reproduce", () => {
    const cases: [string, string | null][] = [
      ["abc/x.png", "abc/x.png"],
      ["home-photos/abc/x.png", "abc/x.png"],
      [
        "https://p.supabase.co/storage/v1/object/public/home-photos/abc/x.png",
        "abc/x.png",
      ],
      ["abc/x.png?t=123", "abc/x.png"],
      ["abc/x.png#frag", "abc/x.png"],
      ["", null],
      ["?t=1", null],
      ["home-photos/", null],
    ];
    for (const [input, expected] of cases) {
      expect(toObjectPath(input), `toObjectPath(${JSON.stringify(input)})`).toBe(
        expected
      );
    }
    // And the migration must actually ship the twin plus its call sites.
    const sql = readFileSync(
      fileURLToPath(
        new URL("../../supabase/migrations/0131_db_layer_ownership.sql", import.meta.url)
      ),
      "utf8"
    );
    expect(sql).toContain("create or replace function public.storage_object_key");
    expect(sql).toContain("create or replace function public.enforce_photo_url_owned");
    expect(sql).toContain("create trigger photos_url_owned");
  });
});

// ---------------------------------------------------------------------------
// The AI drafter reads a job back and echoes its issue_description into the
// generated message, so "may this pro see this job" has to be answered before
// the model call, not after it.
// ---------------------------------------------------------------------------
describe("the apply drafter only drafts against this pro's own board", () => {
  const routeSrc = () => appSource("api/draft-apply/route.ts");

  it("asks open_jobs_for_me on the user-scoped client", () => {
    const src = routeSrc();
    expect(src).toContain('rpc("open_jobs_for_me")');
    // The user-scoped client, never the admin one: the RPC is SECURITY
    // DEFINER and derives auth.uid() itself, which is the whole point.
    expect(src).toMatch(/authClient as any\)\.rpc\("open_jobs_for_me"\)/);
  });

  it("decides eligibility BEFORE the job is read back and before the model", () => {
    const src = routeSrc();
    const eligibilityAt = src.indexOf('rpc("open_jobs_for_me")');
    const adminReadAt = src.indexOf("const admin = createAdminClient()");
    const modelAt = src.indexOf("generateText(");
    expect(eligibilityAt).toBeGreaterThan(-1);
    expect(adminReadAt).toBeGreaterThan(-1);
    expect(modelAt).toBeGreaterThan(-1);
    expect(eligibilityAt).toBeLessThan(adminReadAt);
    expect(eligibilityAt).toBeLessThan(modelAt);
  });

  it("answers a not-eligible job exactly like a missing one", () => {
    const src = routeSrc();
    // Both refusals are the same 404 with the same wording. The old
    // hand-rolled gates answered 400 "no longer open" and 403 "not in your
    // categories", each of which confirmed a guessed lead id exists.
    expect(src).not.toContain("This job is no longer open.");
    expect(src).not.toContain("This job isn't in your categories.");
    const notFound = src.match(/\{ error: "Job not found\." \}, \{ status: 404 \}/g);
    expect(notFound?.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Two SECURITY DEFINER helpers take their target as a parameter and never
// consult auth.uid(). Postgres hands EXECUTE to PUBLIC by default, so the
// posture has to be stated explicitly in SQL, not assumed.
// ---------------------------------------------------------------------------
describe("SECURITY DEFINER helpers are not executable by client roles", () => {
  const migrationSql = (name: string) =>
    readFileSync(
      fileURLToPath(new URL(`../../supabase/migrations/${name}`, import.meta.url)),
      "utf8"
    ).replace(/--[^\n]*/g, "");

  it("0131 revokes execute on get_or_create_wallet from every client role", () => {
    const sql = migrationSql("0131_db_layer_ownership.sql");
    for (const role of ["public", "anon", "authenticated"]) {
      expect(sql).toContain(
        `revoke all on function public.get_or_create_wallet(uuid) from ${role};`
      );
    }
    // service_role is the only thing that may call it: every real caller is
    // another SECURITY DEFINER function, which runs as the owner anyway.
    expect(sql).toContain(
      "grant execute on function public.get_or_create_wallet(uuid) to service_role;"
    );
  });

  it("0131 revokes execute on recompute_contractor_rating and grants nothing back", () => {
    const sql = migrationSql("0131_db_layer_ownership.sql");
    for (const role of ["public", "anon", "authenticated"]) {
      expect(sql).toContain(
        `revoke all on function public.recompute_contractor_rating(uuid) from ${role};`
      );
    }
    // No grant back at all: its only caller is the reviews_sync_rating trigger
    // function (0016), which is itself SECURITY DEFINER, so a homeowner
    // writing a review still works with authenticated revoked.
    expect(sql).not.toMatch(
      /grant execute on function public\.recompute_contractor_rating/
    );
  });

  it("neither function is re-created after 0020's lockdown without re-stating it", () => {
    // CREATE OR REPLACE preserves grants, but a DROP + CREATE would silently
    // restore the default PUBLIC grant. If a future migration re-creates
    // either function, it has to re-assert the posture the way 0131 does.
    const dir = fileURLToPath(new URL("../../supabase/migrations", import.meta.url));
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    for (const f of files) {
      if (f < "0020") continue;
      const sql = readFileSync(`${dir}/${f}`, "utf8").replace(/--[^\n]*/g, "");
      for (const fn of ["get_or_create_wallet", "recompute_contractor_rating"]) {
        if (new RegExp(`drop\\s+function[^;]*${fn}`, "i").test(sql)) {
          expect(
            sql,
            `${f} drops ${fn}, so it must re-state the execute posture`
          ).toMatch(new RegExp(`revoke all on function public\\.${fn}`, "i"));
        }
      }
    }
  });
});
