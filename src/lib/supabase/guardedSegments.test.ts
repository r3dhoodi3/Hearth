import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isGuardedPath, isPublicPath } from "@/lib/supabase/middleware";
import { isHomeownerShellPath } from "@/lib/roleRouting";

// The middleware has no access to Next's route table, so GUARDED_SEGMENTS
// (src/lib/supabase/middleware.ts) is a hand-maintained copy of it. A page
// added to src/app/(app) without a matching entry there is served to a signed
// -out stranger as a plain 404 instead of a redirect to /signin - and worse,
// renders for real if the page itself leans on the middleware for its auth.
// That is exactly how /ask shipped: the directory existed for days before
// anything noticed the segment was missing from both lists.
//
// So the route table IS the fixture here. Reading the directory means the test
// fails the moment a new page is added without being declared, which is the
// only version of this check that cannot itself go stale.
//
// Resolved from this file rather than process.cwd() so the test passes no
// matter where vitest is invoked from.
const APP_GROUP_DIR = fileURLToPath(new URL("../../app/(app)", import.meta.url));
const APP_DIR = fileURLToPath(new URL("../../app", import.meta.url));

// Directories only: the group also holds layout.tsx, loading.tsx and error.tsx,
// which are files, not routes.
function appGroupSegments(): string[] {
  return readdirSync(APP_GROUP_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    // Next's own conventions: a (group) is not a URL segment, and an
    // _internal folder is never routed at all.
    .filter((entry) => !entry.name.startsWith("(") && !entry.name.startsWith("_"))
    .map((entry) => entry.name);
}

describe("GUARDED_SEGMENTS", () => {
  it("covers every page in the (app) route group", () => {
    const segments = appGroupSegments();
    // A sanity floor: if the read silently returned nothing, an empty
    // forEach below would pass while checking exactly zero routes.
    expect(segments.length).toBeGreaterThan(5);
    const missing = segments.filter((name) => !isGuardedPath(`/${name}`));
    expect(missing).toEqual([]);
  });

  it("guards the blocked-accounts pages on both sides", () => {
    // Migration 0138's two new routes. Neither needed a new GUARDED_SEGMENTS
    // entry - the guard is first-segment only, and "account" and "pro" are
    // both already in the list - but that is exactly the kind of reasoning
    // that is worth a test rather than a comment: if either parent segment is
    // ever removed, these two pages would start serving to a signed-out
    // stranger and nothing else would notice.
    expect(isGuardedPath("/account/blocks")).toBe(true);
    expect(isGuardedPath("/pro/blocks")).toBe(true);
    expect(isHomeownerShellPath("/account/blocks")).toBe(true);
  });

  it("still guards deeper paths and leaves unrouted ones alone", () => {
    // A bad id under a guarded section is still private territory.
    expect(isGuardedPath("/chats/does-not-exist")).toBe(true);
    // Nothing serves this, so it belongs to Next's 404, not to /signin.
    expect(isGuardedPath("/some-missing-page")).toBe(false);
    expect(isGuardedPath("/")).toBe(false);
  });
});

// The second list with the same drift problem. HOMEOWNER_SHELL_ROUTES
// (src/lib/roleRouting.ts) decides where /auth/callback sends a contractor who
// asked for a homeowner page; a missing entry only costs an extra redirect
// rather than leaking anything, but it drifts for the same reason and is
// fixed by the same fixture.
// The (app) group above is only half the route table. The OTHER half sits at
// the root of src/app - /onboarding, /pro, /join, /welcome, every marketing
// and legal page, /p, /pricing - and nothing checked it at all. A new
// top-level section that is neither named in GUARDED_SEGMENTS nor matched by
// isPublicPath is served to a signed-out stranger on a GET, because the
// unrouted-path fallthrough in updateSession cannot tell "a section nobody
// declared" from "a URL nothing serves". That is precisely the /ask failure
// mode the fixture above exists for, one directory level up.
//
// So: every top-level directory in src/app must be classified, one way or the
// other, on purpose.
function appRootSegments(): string[] {
  return readdirSync(APP_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    // Next's own conventions: a (group) is not a URL segment, and an
    // _internal folder is never routed at all.
    .filter((entry) => !entry.name.startsWith("(") && !entry.name.startsWith("_"))
    .map((entry) => entry.name);
}

// The two exceptions, named rather than waved through by a pattern. Both are
// single-file PWA icon routes (src/app/icon-192.png/route.tsx and its 512
// twin) fetched by the browser from the web manifest, often with no session:
// they must answer 200 signed out, which they do via the unrouted-GET
// fallthrough, and there is nothing private behind either. Anything ELSE that
// wants to be anonymous belongs in isPublicPath, where the reason gets
// written down.
const ANONYMOUS_BY_DESIGN = new Set(["icon-192.png", "icon-512.png"]);

describe("every top-level section in src/app is classified", () => {
  it("is either guarded or public", () => {
    const segments = appRootSegments();
    // Sanity floor, same reasoning as the (app) fixture: an empty read must
    // not pass by checking nothing.
    expect(segments.length).toBeGreaterThan(10);
    const unclassified = segments.filter((name) => {
      if (ANONYMOUS_BY_DESIGN.has(name)) return false;
      if (isGuardedPath(`/${name}`)) return false;
      // Both the bare segment and a path INSIDE it. Some public sections only
      // ever serve children (/p/<pro id> is a real page, /p is not), and
      // isPublicPath matches those with a trailing-slash prefix, so testing
      // only the bare segment would report a declared section as undeclared.
      return !isPublicPath(`/${name}`) && !isPublicPath(`/${name}/child`);
    });
    expect(unclassified).toEqual([]);
  });

  it("keeps the two icon routes reachable with no session", () => {
    // Guarding one of these by accident would replace the installed app's
    // icon with a redirect to /signin, which renders as a broken image.
    for (const name of ANONYMOUS_BY_DESIGN) {
      expect(isGuardedPath(`/${name}`)).toBe(false);
    }
  });
});

describe("HOMEOWNER_SHELL_ROUTES", () => {
  it("covers every page in the (app) route group", () => {
    const missing = appGroupSegments().filter(
      (name) => !isHomeownerShellPath(`/${name}`)
    );
    expect(missing).toEqual([]);
  });
});
