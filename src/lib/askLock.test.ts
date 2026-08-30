// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  askLockKey,
  askResetAt,
  clearAllAskLocks,
  clearAskLock,
  parseAskLock,
  readAskLock,
  writeAskLock,
} from "./askLock";

// The bug these rules exist for: running out of Ask Hearth questions, tapping
// away, and coming back to an open composer that silently refuses everything
// typed into it. The lock has to survive the trip, and it has to end when the
// server's day does - never later.

const DAY = 86_400_000;
// A time in the middle of an epoch day, so "the next boundary" is unambiguous.
const NOON = 1_700_000_000_000;

beforeEach(() => window.localStorage.clear());
afterEach(() => window.localStorage.clear());

describe("askLockKey", () => {
  it("namespaces by chat surface and user, so two accounts on one phone and the two chats never share a lock", () => {
    expect(askLockKey("hearth_ask_chat", "user-1")).not.toBe(
      askLockKey("hearth_ask_chat", "user-2")
    );
    expect(askLockKey("hearth_ask_chat", "user-1")).not.toBe(
      askLockKey("hearth_pro_ask_chat", "user-1")
    );
  });

  it("falls back to a bare key while the user id is still resolving", () => {
    expect(askLockKey("hearth_ask_chat", null)).toBe(
      "hearth_ask_limit:hearth_ask_chat"
    );
  });
});

describe("askResetAt", () => {
  it("is the next epoch-day boundary, matching the server's fixed 24 hour window", () => {
    const reset = askResetAt(NOON);
    expect(reset).toBeGreaterThan(NOON);
    expect(reset - NOON).toBeLessThanOrEqual(DAY);
    expect(reset % DAY).toBe(0);
  });
});

describe("parseAskLock", () => {
  it("keeps a lock whose window has not rolled over yet", () => {
    const raw = JSON.stringify({ limit: 3, resetAt: NOON + 1000 });
    expect(parseAskLock(raw, NOON)).toEqual({ limit: 3, resetAt: NOON + 1000 });
  });

  it("drops a lock the moment its window is up", () => {
    expect(parseAskLock(JSON.stringify({ limit: 3, resetAt: NOON }), NOON)).toBeNull();
    expect(
      parseAskLock(JSON.stringify({ limit: 3, resetAt: NOON - 1 }), NOON)
    ).toBeNull();
  });

  it("refuses a lock that claims more than one window, so a wrong clock can't shut someone out for a week", () => {
    expect(
      parseAskLock(JSON.stringify({ limit: 3, resetAt: NOON + DAY * 5 }), NOON)
    ).toBeNull();
  });

  it("refuses nonsense rather than locking on it", () => {
    expect(parseAskLock(null, NOON)).toBeNull();
    expect(parseAskLock("", NOON)).toBeNull();
    expect(parseAskLock("not json", NOON)).toBeNull();
    expect(parseAskLock(JSON.stringify({ limit: 0, resetAt: NOON + 5 }), NOON)).toBeNull();
    expect(parseAskLock(JSON.stringify({ resetAt: NOON + 5 }), NOON)).toBeNull();
    expect(parseAskLock(JSON.stringify({ limit: 3 }), NOON)).toBeNull();
  });
});

describe("readAskLock / writeAskLock", () => {
  const key = askLockKey("hearth_ask_chat", "user-1");

  it("survives the round trip, which is the whole point", () => {
    writeAskLock(key, 3, NOON);
    expect(readAskLock(key, NOON + 1000)).toEqual({
      limit: 3,
      resetAt: askResetAt(NOON),
    });
  });

  it("is gone once the day has rolled over, and cleans up after itself", () => {
    writeAskLock(key, 3, NOON);
    expect(readAskLock(key, askResetAt(NOON) + 1)).toBeNull();
    expect(window.localStorage.getItem(key)).toBeNull();
  });

  it("clears on demand, for the reply that says there are questions left again", () => {
    writeAskLock(key, 3, NOON);
    clearAskLock(key);
    expect(readAskLock(key, NOON)).toBeNull();
  });
});

describe("clearAllAskLocks", () => {
  it("lifts every lock on the device (someone just bought a bigger allowance) and touches nothing else", () => {
    writeAskLock(askLockKey("hearth_ask_chat", "user-1"), 3, NOON);
    writeAskLock(askLockKey("hearth_pro_ask_chat", "user-1"), 8, NOON);
    window.localStorage.setItem("hearth_ask_chat:user-1", "[]");
    clearAllAskLocks();
    expect(readAskLock(askLockKey("hearth_ask_chat", "user-1"), NOON)).toBeNull();
    expect(
      readAskLock(askLockKey("hearth_pro_ask_chat", "user-1"), NOON)
    ).toBeNull();
    expect(window.localStorage.getItem("hearth_ask_chat:user-1")).toBe("[]");
  });
});
