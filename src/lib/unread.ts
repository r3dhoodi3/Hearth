// Shared "is this newer than that" comparison for unread/read-receipt state
// (see Nav.tsx around the liveBadge comment, UnreadProvider.tsx, and the
// per-conversation "New" flag on both chats list pages).
//
// A Postgres timestamptz round-trips through PostgREST looking like
// "2026-08-27T12:00:00.123456+00:00" (microsecond precision, "+00:00"
// suffix, trailing zero digits trimmed), while a JS `Date.toISOString()`
// value - which is what the "seen" cookie/localStorage timestamps are made
// of - always looks like "2026-08-27T12:00:00.123Z" (exactly 3 fractional
// digits, "Z" suffix). UnreadProvider.tsx and the homeowner chats page
// already avoid comparing these two formats with plain string `<`/`>` for
// exactly that reason; the pro chats page was the one holdout still doing
// `seenAt < lastMessageAt` as a raw string compare. Centralizing on epoch
// millis here removes the format mismatch as a variable entirely, so this
// class of bug can't reappear as the two pages' logic drifts apart.
export function isAfter(a: string, b: string): boolean {
  return new Date(a).getTime() > new Date(b).getTime();
}

// True when the last message in a thread is newer than the last time that
// thread was seen, or the thread has never been seen at all.
export function isUnreadSince(
  seenAt: string | null | undefined,
  lastMessageAt: string
): boolean {
  return !seenAt || isAfter(lastMessageAt, seenAt);
}

// How long a "seen" cookie lives. Chosen, not defaulted: the writers used to
// pass `{ path: "/" }` and nothing else, which makes a SESSION cookie - close
// the browser and every conversation goes back to looking unread. Six months
// covers any realistic gap between visits and matches the "Persistent" the
// cookie notice (src/content/legal/cookies.md) promises.
export const CHAT_SEEN_COOKIE_MAX_AGE_SECONDS = 180 * 24 * 60 * 60;

// The seen cookie's options, in one place so the homeowner and pro inboxes
// cannot drift apart. NOT httpOnly, deliberately: UnreadProvider reads this
// same cookie from document.cookie to keep the nav badge accurate without a
// server round trip. Nothing sensitive is in it - it is a map of the user's
// own lead ids to timestamps they already have on screen.
export function chatSeenCookieOptions() {
  return {
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: CHAT_SEEN_COOKIE_MAX_AGE_SECONDS,
  };
}

// Parse a chat-seen cookie into a { leadId: ISO timestamp } map.
//
// THE COOKIE IS ATTACKER-CONTROLLED. It is not httpOnly (see above), so any
// page script - or anyone typing into devtools, or a stale value from an older
// format - can put arbitrary JSON in it. A bare JSON.parse is not enough:
// `"[1,2]"`, `"null"`, `"7"` and `{"a":{"b":1}}` all parse fine and then blow
// up (or silently misbehave) downstream, and on a server component that throw
// is a 500 on the whole inbox. So: parse, require a plain non-null,
// non-array object, and keep only the entries whose key AND value are both
// strings. Anything else reads as "nothing has been seen", which is the safe
// answer - the worst case is a thread showing as unread once.
export function parseSeenMap(raw: string | null | undefined): Record<string, string> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed)
  ) {
    return {};
  }
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof key === "string" && typeof value === "string") {
      clean[key] = value;
    }
  }
  return clean;
}
