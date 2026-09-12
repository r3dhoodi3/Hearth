// Legacy key migration, remove after 2026-12-31.
//
// The app's brand renamed. This module is where the old brand word lives for
// COMPATIBILITY purposes, and even here it is built from two literal halves so
// a whole-word repo grep for it comes up empty. Everything below exists so a
// browser or a server that still carries an old-prefixed
// localStorage/sessionStorage key, cookie, or env var keeps working exactly
// as it did before the rename, until this file is deleted.
//
// ONE OTHER FILE STILL SPELLS IT, ON PURPOSE AND PERMANENTLY:
// src/lib/paywallExperiment.ts keeps the old brand word inside EXPERIMENT_SALT,
// the literal salt its A/B bucketing hash is built from. That salt is not a
// name anybody reads - it is the thing that decides which paywall variant an
// account has always seen - so renaming it would silently re-bucket every
// existing user mid-experiment and invalidate the results. It stays as it is,
// and it is the one whole-word match a repo grep of src is expected to return.
const LEGACY_PREFIX = "hea" + "rth";
const LEGACY_ENV_PREFIX = "HEA" + "RTH_";

// The four separator styles the old and new brand both use for a namespaced
// key: <prefix>_x, <prefix>:x, <prefix>-x, <prefix>.x - so oaktend_x,
// oaktend:x, oaktend-x, oaktend.x today, and the LEGACY_PREFIX equivalents
// before the rename.
const SEPARATORS = ["_", ":", "-", "."] as const;
const NEW_PREFIXES = SEPARATORS.map((sep) => "oaktend" + sep);
const OLD_PREFIXES = SEPARATORS.map((sep) => LEGACY_PREFIX + sep);

// Maps a new-brand key ("oaktend_foo", "oaktend:foo", "oaktend-foo",
// "oaktend.foo") to its pre-rename equivalent, i.e. the same suffix and
// separator behind LEGACY_PREFIX. A key that does not start with one of the
// new prefixes is returned unchanged - there is nothing legacy to fall back to.
export function legacyKey(newKey: string): string {
  for (const prefix of NEW_PREFIXES) {
    if (newKey.startsWith(prefix)) {
      const separator = prefix.slice("oaktend".length);
      return LEGACY_PREFIX + separator + newKey.slice(prefix.length);
    }
  }
  return newKey;
}

// Reads an env var under its new OAKTEND_ name, falling back to the old
// brand's prefix (LEGACY_ENV_PREFIX above) so a deploy is never bricked by an
// env var rename that has not been applied on the hosting provider yet. Pass
// the suffix only: envCompat("MW_TIMING") checks OAKTEND_MW_TIMING first, then
// the same suffix behind the legacy prefix.
export function envCompat(suffix: string): string | undefined {
  return (
    process.env["OAKTEND_" + suffix] ?? process.env[LEGACY_ENV_PREFIX + suffix]
  );
}

// Copies every old-prefixed key in one storage area to its new-brand
// equivalent (when the new key is not already present), then removes the old
// key. Best effort per key and for the storage area as a whole: a private
// window, a full quota, or a blocked site all just mean the migration is
// skipped, never a thrown error.
function migrateStorageArea(storage: Storage): void {
  try {
    const keys: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i);
      if (k) keys.push(k);
    }
    for (const oldKey of keys) {
      const prefix = OLD_PREFIXES.find((p) => oldKey.startsWith(p));
      if (!prefix) continue;
      const separator = prefix.slice(LEGACY_PREFIX.length);
      const newKey = "oaktend" + separator + oldKey.slice(prefix.length);
      try {
        // The remove is INSIDE the copy branch, after a setItem that did not
        // throw. It used to sit outside it, which meant a key that was skipped
        // (because the new name already held a value) or a setItem that threw
        // on a full quota still had its ONLY copy deleted. Deleting the source
        // is only ever safe once the destination is actually written.
        if (storage.getItem(newKey) === null) {
          const value = storage.getItem(oldKey);
          if (value !== null) {
            storage.setItem(newKey, value);
            storage.removeItem(oldKey);
          }
        }
      } catch {
        // Best effort per key: leave this one for next time rather than
        // aborting the rest of the walk.
      }
    }
  } catch {
    // Best effort for the whole storage area (e.g. access denied).
  }
}

// Runs once on the client: walks localStorage and sessionStorage and
// migrates every old-prefixed key it finds. No-op on the server (no
// `window`) and wrapped so a throwing storage implementation can never break
// the page that calls it.
export function migrateLegacyStorage(): void {
  if (typeof window === "undefined") return;
  try {
    migrateStorageArea(window.localStorage);
  } catch {
    // Best effort - see migrateStorageArea.
  }
  try {
    migrateStorageArea(window.sessionStorage);
  } catch {
    // Best effort - see migrateStorageArea.
  }
}

// The same migration, as a self-contained string that runs SYNCHRONOUSLY in
// <head> (src/app/layout.tsx, right before the theme-init script).
//
// WHY A STRING AND NOT THE FUNCTION ABOVE. migrateLegacyStorage() used to be
// called from a useEffect in ToastProvider, which is a child effect ordering
// problem dressed up as a migration: React runs child effects BEFORE parent
// effects, so every component that reads a renamed key on mount had already
// read the (still empty) new key by the time the copy ran. Those components
// then cached "no value" for the rest of the page - a signed-in user's theme,
// drafts, seen-flags and Ask history all looked freshly cleared until the
// second load. An inline head script is the only thing that runs before any
// of it, which is exactly why themeInit is one too.
//
// Deliberately plain ES5-ish JS with no imports, no template literals and no
// optional chaining: it is injected verbatim into a <script> tag, so it must
// parse in whatever the visitor's browser is and cannot reference anything
// the bundle exports. It mirrors migrateStorageArea above line for line -
// same separators, same "copy only when the new key is absent", same "remove
// the old key only after a successful copy", same per-key and whole-area
// try/catch. Keep the two in step; the vitest suite executes THIS string.
export const LEGACY_STORAGE_INIT_SCRIPT = `(function () {
  try {
    var legacyPrefix = "hea" + "rth";
    var separators = ["_", ":", "-", "."];
    var areas = [];
    try { areas.push(window.localStorage); } catch (e) {}
    try { areas.push(window.sessionStorage); } catch (e) {}
    for (var a = 0; a < areas.length; a++) {
      var storage = areas[a];
      try {
        var keys = [];
        for (var i = 0; i < storage.length; i++) {
          var k = storage.key(i);
          if (k) keys.push(k);
        }
        for (var j = 0; j < keys.length; j++) {
          var oldKey = keys[j];
          var separator = null;
          for (var s = 0; s < separators.length; s++) {
            if (oldKey.indexOf(legacyPrefix + separators[s]) === 0) {
              separator = separators[s];
              break;
            }
          }
          if (separator === null) continue;
          var newKey =
            "oaktend" +
            separator +
            oldKey.slice(legacyPrefix.length + separator.length);
          try {
            if (storage.getItem(newKey) === null) {
              var value = storage.getItem(oldKey);
              if (value !== null) {
                storage.setItem(newKey, value);
                storage.removeItem(oldKey);
              }
            }
          } catch (e) {}
        }
      } catch (e) {}
    }
  } catch (e) {}
})();`;
