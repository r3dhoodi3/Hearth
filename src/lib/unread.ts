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
