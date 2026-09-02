import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  isStaleDeployError,
  recoverFromStaleDeploy,
  __resetStaleDeployLatch,
} from "./staleDeploy";

// A minimal sessionStorage stand-in so the node environment can exercise the
// cooldown without jsdom.
function fakeStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    store,
  };
}

describe("isStaleDeployError", () => {
  it("matches Next's stale server action refusal, either sentence", () => {
    expect(
      isStaleDeployError(
        new Error(
          'Failed to find Server Action "70296b63aca168982ab10d2ef437f6a8f01e7ba8be". ' +
            "This request might be from an older or newer deployment."
        )
      )
    ).toBe(true);
    expect(
      isStaleDeployError(
        new Error("This request might be from an older or newer deployment.")
      )
    ).toBe(true);
  });

  it("matches chunk-load failures by name and by message", () => {
    const byName = new Error("Loading failed");
    byName.name = "ChunkLoadError";
    expect(isStaleDeployError(byName)).toBe(true);
    expect(
      isStaleDeployError(new Error("Loading chunk 4821 failed. (missing: ...)"))
    ).toBe(true);
    expect(
      isStaleDeployError(
        new TypeError("Failed to fetch dynamically imported module: /x.js")
      )
    ).toBe(true);
  });

  it("looks one level into .cause", () => {
    const wrapped = new Error("action failed", {
      cause: new Error('Failed to find Server Action "abc".'),
    });
    expect(isStaleDeployError(wrapped)).toBe(true);
  });

  it("rejects plain network and app errors, and junk", () => {
    expect(isStaleDeployError(new TypeError("Failed to fetch"))).toBe(false);
    expect(isStaleDeployError(new Error("Job is full"))).toBe(false);
    expect(isStaleDeployError(null)).toBe(false);
    expect(isStaleDeployError(undefined)).toBe(false);
    expect(isStaleDeployError({})).toBe(false);
    expect(isStaleDeployError("random string")).toBe(false);
  });
});

describe("recoverFromStaleDeploy", () => {
  beforeEach(() => {
    __resetStaleDeployLatch();
  });

  it("reloads and stamps the storage timestamp on a first call", () => {
    const reload = vi.fn();
    const storage = fakeStorage();
    expect(recoverFromStaleDeploy(reload, storage, 1_000_000)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(storage.store.get("hearth-stale-reload-at")).toBe("1000000");
  });

  it("refuses within the cooldown after a previous reload", () => {
    const reload = vi.fn();
    const storage = fakeStorage({ "hearth-stale-reload-at": "1000000" });
    expect(recoverFromStaleDeploy(reload, storage, 1_030_000)).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it("reloads again once the cooldown has passed", () => {
    const reload = vi.fn();
    const storage = fakeStorage({ "hearth-stale-reload-at": "1000000" });
    expect(recoverFromStaleDeploy(reload, storage, 1_061_000)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("latches per page load even when storage is unavailable", () => {
    const reload = vi.fn();
    expect(recoverFromStaleDeploy(reload, null, 1_000_000)).toBe(true);
    expect(recoverFromStaleDeploy(reload, null, 2_000_000)).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("survives a storage that throws on read", () => {
    const reload = vi.fn();
    const storage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(recoverFromStaleDeploy(reload, storage, 1_000_000)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
