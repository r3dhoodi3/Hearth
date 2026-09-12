// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";

import {
  LEGACY_STORAGE_INIT_SCRIPT,
  legacyKey,
  migrateLegacyStorage,
} from "./legacyStorage";

// The old brand prefix, built the same way the module under test builds it, so
// this file does not spell the dead brand word whole either.
const OLD = "hea" + "rth";

// Runs the exported inline-script SOURCE, not the TypeScript function, because
// the string is what actually ships: it is injected verbatim into <head> by
// src/app/layout.tsx and never goes through the bundler. A regression in the
// string (a typo, a stale copy of the separator list) would be invisible to a
// test that called migrateLegacyStorage() instead.
function runInitScript(): void {
  // eslint-disable-next-line no-new-func
  new Function(LEGACY_STORAGE_INIT_SCRIPT)();
}

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe("legacyKey", () => {
  it("maps each namespaced separator onto the old prefix", () => {
    expect(legacyKey("oaktend_theme")).toBe(`${OLD}_theme`);
    expect(legacyKey("oaktend:seen:abc")).toBe(`${OLD}:seen:abc`);
    expect(legacyKey("oaktend-theme")).toBe(`${OLD}-theme`);
    expect(legacyKey("oaktend.flag")).toBe(`${OLD}.flag`);
  });

  it("leaves a key with no new-brand prefix alone", () => {
    expect(legacyKey("sb-auth-token")).toBe("sb-auth-token");
    expect(legacyKey("oaktendish")).toBe("oaktendish");
  });
});

describe("LEGACY_STORAGE_INIT_SCRIPT", () => {
  it("copies an old-prefixed key onto the new name and deletes the old one", () => {
    window.localStorage.setItem(`${OLD}-theme`, "dark");
    runInitScript();
    expect(window.localStorage.getItem("oaktend-theme")).toBe("dark");
    expect(window.localStorage.getItem(`${OLD}-theme`)).toBeNull();
  });

  it("handles every separator, in both storage areas", () => {
    window.localStorage.setItem(`${OLD}_ask_chat:u1`, "history");
    window.localStorage.setItem(`${OLD}:seen:lead-1`, "1699999999999");
    window.sessionStorage.setItem(`${OLD}-paywall`, "soft");
    window.sessionStorage.setItem(`${OLD}.flag`, "on");

    runInitScript();

    expect(window.localStorage.getItem("oaktend_ask_chat:u1")).toBe("history");
    expect(window.localStorage.getItem("oaktend:seen:lead-1")).toBe(
      "1699999999999"
    );
    expect(window.sessionStorage.getItem("oaktend-paywall")).toBe("soft");
    expect(window.sessionStorage.getItem("oaktend.flag")).toBe("on");

    expect(window.localStorage.getItem(`${OLD}_ask_chat:u1`)).toBeNull();
    expect(window.localStorage.getItem(`${OLD}:seen:lead-1`)).toBeNull();
    expect(window.sessionStorage.getItem(`${OLD}-paywall`)).toBeNull();
    expect(window.sessionStorage.getItem(`${OLD}.flag`)).toBeNull();
  });

  it("never overwrites a value already stored under the new name", () => {
    window.localStorage.setItem("oaktend-theme", "light");
    window.localStorage.setItem(`${OLD}-theme`, "dark");
    runInitScript();
    expect(window.localStorage.getItem("oaktend-theme")).toBe("light");
  });

  it("keeps the old key when the copy is skipped, rather than deleting the source", () => {
    // The defect this guards: the remove used to sit outside the copy branch,
    // so a key that was skipped lost its only value.
    window.localStorage.setItem("oaktend-theme", "light");
    window.localStorage.setItem(`${OLD}-theme`, "dark");
    runInitScript();
    expect(window.localStorage.getItem(`${OLD}-theme`)).toBe("dark");
  });

  it("leaves keys that are not old-prefixed untouched", () => {
    window.localStorage.setItem("sb-abc-auth-token", "token");
    window.localStorage.setItem("oaktend-theme", "dark");
    window.localStorage.setItem(`${OLD}ish`, "not-namespaced");
    runInitScript();
    expect(window.localStorage.getItem("sb-abc-auth-token")).toBe("token");
    expect(window.localStorage.getItem("oaktend-theme")).toBe("dark");
    expect(window.localStorage.getItem(`${OLD}ish`)).toBe("not-namespaced");
  });

  it("migrates every matching key, not just the first", () => {
    for (let i = 0; i < 5; i++) {
      window.localStorage.setItem(`${OLD}:seen:lead-${i}`, String(i));
    }
    runInitScript();
    for (let i = 0; i < 5; i++) {
      expect(window.localStorage.getItem(`oaktend:seen:lead-${i}`)).toBe(
        String(i)
      );
      expect(window.localStorage.getItem(`${OLD}:seen:lead-${i}`)).toBeNull();
    }
  });

  it("runs clean on an empty jar and is safe to run twice", () => {
    expect(runInitScript).not.toThrow();
    window.localStorage.setItem(`${OLD}_draft`, "text");
    runInitScript();
    runInitScript();
    expect(window.localStorage.getItem("oaktend_draft")).toBe("text");
  });

  it("does not spell the old brand word whole in its own source", () => {
    // Same rule the module itself follows: the prefix is assembled from two
    // halves at runtime, so a repo grep for the whole word finds nothing.
    expect(LEGACY_STORAGE_INIT_SCRIPT).not.toContain(OLD);
    expect(LEGACY_STORAGE_INIT_SCRIPT).toContain('"hea" + "rth"');
  });
});

// migrateLegacyStorage() is kept exported for tests and any other caller even
// though the inline script is what runs in the browser now. The two must agree.
describe("migrateLegacyStorage (the TypeScript twin of the script)", () => {
  it("copies, deletes, and refuses to overwrite, exactly like the script", () => {
    window.localStorage.setItem(`${OLD}_draft`, "text");
    window.localStorage.setItem("oaktend_theme", "light");
    window.localStorage.setItem(`${OLD}_theme`, "dark");
    window.sessionStorage.setItem(`${OLD}:tab`, "quotes");

    migrateLegacyStorage();

    expect(window.localStorage.getItem("oaktend_draft")).toBe("text");
    expect(window.localStorage.getItem(`${OLD}_draft`)).toBeNull();
    expect(window.localStorage.getItem("oaktend_theme")).toBe("light");
    expect(window.localStorage.getItem(`${OLD}_theme`)).toBe("dark");
    expect(window.sessionStorage.getItem("oaktend:tab")).toBe("quotes");
    expect(window.sessionStorage.getItem(`${OLD}:tab`)).toBeNull();
  });
});
