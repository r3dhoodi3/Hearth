// Free-tier allowance rules for the homeowner Ask Hearth chat, kept pure so
// they can be tested without a DOM.
//
// The server tells the client where it stands on every reply (`freeRemaining`
// and `freeLimit`), and it only sends those two fields to FREE homeowners.
// Members and the pro copilot never get them, so "do we have a limit in hand?"
// is also the answer to "should this viewer see a meter at all?". Nothing here
// gates access; the server is the only authority on that.

export type AskLink = { href: string; label: string };

// Where the upsell points when the server did not attach its own link (for
// example the reply that spends the last free question, which is a normal
// answer with no link on it).
export const ASK_PLUS_LINK: AskLink = {
  href: "/plus?reason=ask",
  label: "See what Hearth Plus adds",
};

function pair(
  remaining: unknown,
  limit: unknown
): { remaining: number; limit: number } | null {
  if (typeof remaining !== "number" || typeof limit !== "number") return null;
  if (!Number.isFinite(remaining) || !Number.isFinite(limit)) return null;
  if (limit <= 0) return null;
  return { remaining, limit };
}

// Show the quiet meter whenever a free homeowner still has questions left. At
// zero the locked bar takes over, so the meter stands down rather than saying
// "0 of 3" next to it.
export function shouldShowMeter(remaining: unknown, limit: unknown): boolean {
  const p = pair(remaining, limit);
  return !!p && p.remaining > 0 && p.remaining <= p.limit;
}

// Out of questions for today: swap the input row for the locked bar.
export function isFreeLocked(remaining: unknown, limit: unknown): boolean {
  const p = pair(remaining, limit);
  return !!p && p.remaining <= 0;
}

export function meterLabel(remaining: number, limit: number): string {
  return `${remaining} of ${limit} free question${
    limit === 1 ? "" : "s"
  } left today`;
}

// Fallback copy for the locked bar. Used when the lock arrived with a normal
// answer (the third question) rather than the server's over-limit message.
export function freeLockText(limit: number | null): string {
  return limit
    ? `That's your ${limit} free questions for today. They reset tomorrow.`
    : "That's your free questions for today. They reset tomorrow.";
}
