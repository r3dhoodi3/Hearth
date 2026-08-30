// The Ask Hearth daily lock, remembered across mounts.
//
// The composer swaps for a locked bar the moment the server says the day's
// questions are spent, but that verdict only ever lived in component state:
// tapping away and coming back remounted the chat with an open composer that
// silently refuses everything typed into it. False hope, and the owner called
// it: "it doesn't allow you to enter a message, but can we just lock it".
//
// So the lock is written down. Keys are namespaced per user like the
// conversation itself (see AskHearth.tsx), and per chat surface, so the
// homeowner chat and the pro copilot on one device never share a lock.
//
// WHEN IT LIFTS. The server's day is a fixed 24 hour window aligned to the
// epoch, not to local midnight (ASK_DAY_WINDOW_SECONDS in src/lib/aiUsage.ts,
// which is server-only and cannot be imported here), and no reply carries a
// reset timestamp, so the reset is computed exactly the same way: the next
// epoch-day boundary. Nothing here GATES anything - the server is still the
// only authority on the allowance. This only decides whether a composer that
// would be refused is shown as open.

const DAY_MS = 86_400_000;

// One prefix for every lock key so a post-checkout sweep can find them all
// without knowing which chats this browser has ever opened.
const ASK_LOCK_PREFIX = "hearth_ask_limit";

export type AskLock = {
  // The allowance that was spent, so the locked bar can name the number
  // ("That's your 3 free questions for today") with no reply on screen.
  limit: number;
  // Date.now() value at which the window rolls over and the lock is void.
  resetAt: number;
};

export function askLockKey(
  storageKeyBase: string,
  userId: string | null
): string {
  return userId
    ? `${ASK_LOCK_PREFIX}:${storageKeyBase}:${userId}`
    : `${ASK_LOCK_PREFIX}:${storageKeyBase}`;
}

// The end of the 24 hour window `now` falls in, matching rate_limit_hit's
// epoch-aligned windows on the server.
export function askResetAt(now: number): number {
  return Math.floor(now / DAY_MS) * DAY_MS + DAY_MS;
}

// Pure so the expiry rules are testable without a DOM.
export function parseAskLock(raw: string | null, now: number): AskLock | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as { limit?: unknown; resetAt?: unknown };
    const limit = Number(v?.limit);
    const resetAt = Number(v?.resetAt);
    if (!Number.isFinite(limit) || limit <= 0) return null;
    if (!Number.isFinite(resetAt)) return null;
    // The window has rolled over: they have questions again.
    if (resetAt <= now) return null;
    // A clock that was wrong when the lock was written (or a hand-edited
    // value) must not shut someone out for a week. A lock can never outlast
    // one window, whatever it claims.
    if (resetAt > now + DAY_MS) return null;
    return { limit, resetAt };
  } catch {
    return null;
  }
}

export function readAskLock(key: string, now = Date.now()): AskLock | null {
  try {
    const lock = parseAskLock(localStorage.getItem(key), now);
    // Tidy up a lock that has served its day rather than re-parsing it on
    // every mount for as long as this browser lives.
    if (!lock) localStorage.removeItem(key);
    return lock;
  } catch {
    return null;
  }
}

export function writeAskLock(key: string, limit: number, now = Date.now()) {
  try {
    localStorage.setItem(
      key,
      JSON.stringify({ limit, resetAt: askResetAt(now) })
    );
  } catch {
    /* ignore: a locked composer is a nicety, not a gate */
  }
}

export function clearAskLock(key: string) {
  try {
    localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

// Every lock on this device, for the one moment they are all certainly wrong:
// someone just paid for a bigger allowance. Prefix scan rather than key
// building, because the caller (PlusWelcome, right after checkout) knows
// neither the user id nor which chats have been opened here.
export function clearAllAskLocks() {
  try {
    const doomed: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(ASK_LOCK_PREFIX)) doomed.push(k);
    }
    doomed.forEach((k) => localStorage.removeItem(k));
  } catch {
    /* ignore */
  }
}
