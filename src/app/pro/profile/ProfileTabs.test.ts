import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

// Source test, same reason ./page.test.ts is one: ProfileTabs imports its own
// "./actions", which pulls the service-role Supabase client in transitively
// (createAdminClient -> "server-only") and throws the moment it is imported
// outside a real server render. The two facts pinned here are about the tab
// list's shape and its hash map, which read straight off the source.
function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

const tabs = src("./ProfileTabs.tsx");

describe("ProfileTabs: the Credentials tab", () => {
  it("sits between Public Profile and Your Public Page", () => {
    const publicTab = tabs.indexOf('key: "public" as const');
    const credentials = tabs.indexOf('key: "credentials" as const');
    const page = tabs.indexOf('key: "page" as const');
    expect(publicTab).toBeGreaterThan(-1);
    expect(credentials).toBeGreaterThan(publicTab);
    expect(page).toBeGreaterThan(credentials);
  });

  it("renders CredentialsCard for that tab", () => {
    expect(tabs).toContain('import CredentialsCard from "./CredentialsCard"');
    expect(tabs).toContain("<CredentialsCard contractor={contractor} />");
  });

  // Five tabs have to fit a 390px phone: the strip is overflow-x-auto, so a
  // long phone label does not wrap, it silently scrolls the last tab out of
  // sight. "Public page" shortened to "Page" to make room for "Credentials",
  // which is the one label here that cannot be shortened honestly.
  it("keeps the phone labels short enough for five tabs", () => {
    const shorts = Array.from(tabs.matchAll(/short: "([^"]+)"/g)).map(
      (m) => m[1]
    );
    expect(shorts).toEqual([
      "Profile",
      "Credentials",
      "Page",
      "Projects",
      "Security",
    ]);
    // ~7px per character at text-sm, plus px-2 either side, against ~342px of
    // usable width on a 390px screen.
    const estimated = shorts.reduce((sum, s) => sum + s.length * 7 + 16, 8);
    expect(estimated).toBeLessThan(390);
  });
});

describe("ProfileTabs: HASH_TAB", () => {
  it("maps both credential anchors to the Credentials tab", () => {
    // Only the selected panel is rendered, so a deep link's target does not
    // exist until the tab that owns it is showing - this map is what switches
    // to it. #insurance is INSURANCE_UPLOAD_HREF's fragment
    // (src/lib/insuranceGate.ts); #license is where saveLicenseNumberAction
    // sends the pro back to.
    const map = tabs.slice(
      tabs.indexOf("const HASH_TAB"),
      tabs.indexOf("export default function ProfileTabs")
    );
    expect(map).toContain('insurance: "credentials"');
    expect(map).toContain('license: "credentials"');
  });

  it("no longer maps #reviews, whose feature is gone", () => {
    // The outbound Yelp / Google link pair was removed 2026-09-12, so a
    // reviews -> "public" entry would switch tabs to find nothing.
    const map = tabs.slice(
      tabs.indexOf("const HASH_TAB"),
      tabs.indexOf("export default function ProfileTabs")
    );
    expect(map).not.toContain('reviews: "public"');
  });
});
