// Request-shaping helpers shared by the two chat routes (/api/ask and
// /api/pro-ask). Pure and dependency-free on purpose: the routes themselves
// import "server-only" modules, so this is the layer that can be unit-tested.

// One chat message as the clients send it (see src/components/AskHearth.tsx).
// Loose on purpose: every field here arrives as untrusted request JSON.
type LooseMessage = {
  role?: unknown;
  content?: unknown;
  image?: unknown;
};

function asMessage(m: unknown): LooseMessage | null {
  return m && typeof m === "object" ? (m as LooseMessage) : null;
}

function imageOf(m: unknown): string | null {
  const msg = asMessage(m);
  const img = msg?.image;
  return typeof img === "string" && img.length > 0 ? img : null;
}

/**
 * The newest turn the person actually sent, or null if the history has none.
 * Scans backwards rather than reading the last element, so a stray assistant
 * turn on the end (a malformed client, a replayed greeting) doesn't read as
 * "they sent nothing".
 */
export function newestUserMessage(messages: unknown): LooseMessage | null {
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = asMessage(messages[i]);
    if (!m) continue;
    if (m.role === "assistant") continue;
    return m;
  }
  return null;
}

/**
 * Is there actually a question here?
 *
 * A turn with no text (or only whitespace) and no photo produces an empty
 * content list, which the Messages API rejects with a 400 - AFTER the route
 * has already spent one of the homeowner's three daily questions on it. The
 * routes call this before anything is counted so an empty send costs nothing
 * and gets a plain answer instead of a mystery failure.
 */
export function hasAskableContent(messages: unknown): boolean {
  const newest = newestUserMessage(messages);
  if (!newest) return false;
  if (imageOf(newest)) return true;
  return typeof newest.content === "string" && newest.content.trim().length > 0;
}

// How far back an image is allowed to be re-sent from. The clients replay the
// WHOLE local conversation on every request, so without a floor here a photo
// from twenty turns ago rides along on every later text question, at full
// vision price, long after anyone stopped talking about it.
export const IMAGE_RECENT_TURNS = 6;

/**
 * Which messages' photos to actually forward to the model.
 *
 * NEWEST FIRST, and that is the whole point. Walking the history forwards and
 * stopping at the cap kept the four OLDEST photos, which is exactly backwards:
 * the photo the homeowner just attached, the one their question is about, was
 * the first to be dropped once a conversation had five pictures in it. They
 * would ask "what is this valve?" and get an answer about a water heater from
 * an hour ago.
 *
 * Returns the chosen indexes as a set, so the caller can keep mapping the
 * history in its original order and the images land back in chronological
 * position (the model reads a conversation, not a pile of pictures).
 */
export function pickImageIndexes(
  messages: readonly unknown[],
  opts: { maxImages: number; maxChars: number; recentTurns?: number }
): Set<number> {
  const chosen = new Set<number>();
  if (opts.maxImages <= 0) return chosen;
  const floor = Math.max(
    0,
    messages.length - (opts.recentTurns ?? IMAGE_RECENT_TURNS)
  );
  for (let i = messages.length - 1; i >= floor; i--) {
    const img = imageOf(messages[i]);
    if (!img || img.length > opts.maxChars) continue;
    chosen.add(i);
    if (chosen.size >= opts.maxImages) break;
  }
  return chosen;
}
