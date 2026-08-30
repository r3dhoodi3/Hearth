// When to ask somebody to turn on phone notifications, and how to remember
// that we asked.
//
// The rule this file exists to enforce: NEVER ask cold. A browser only gives
// out notification permission once - a "no" is close to permanent, and it can
// only be undone in browser settings that most people never open. So the ask
// has to land right after a moment that makes it obvious why: a job just
// posted, a message just arrived. Asking on page load, before anything has
// happened, is how a feature gets denied forever on the first day.
//
// All state is localStorage, keyed per account, and every read and write is
// wrapped: a browser with storage disabled simply never shows the prompt,
// which is the safe direction.

// Set by markPushMoment() when something worth being notified about just
// happened. Not per user: the moment is a property of this browser tab right
// now, and the per-user keys below are what decide whether to act on it.
const MOMENT_KEY = "hearth_push_moment";

// How long a moment stays "fresh". Long enough to survive the redirect after
// posting a job, short enough that reopening the app tomorrow does not surface
// a card about something that happened yesterday.
export const MOMENT_FRESH_MS = 2 * 60 * 1000;

// Dismissed: quiet for two weeks. One tap should not decide forever (that is
// what the browser's own "deny" is for), but nagging is how a person learns to
// dismiss without reading.
export const SNOOZE_MS = 14 * 24 * 60 * 60 * 1000;

// Fired by markPushMoment so a card already on screen can react immediately
// instead of waiting for the next mount.
export const PUSH_MOMENT_EVENT = "hearth:push-moment";

function snoozeKey(userId: string): string {
  return `hearth_push_snoozed_until:${userId}`;
}

// Written once permission is granted. The prompt is finished for good at that
// point: there is nothing left to ask for.
function doneKey(userId: string): string {
  return `hearth_push_done:${userId}`;
}

function readNumber(key: string): number {
  try {
    return Number(window.localStorage.getItem(key) ?? "0") || 0;
  } catch {
    return 0;
  }
}

// Call this the instant something happens that the person would want a
// notification about next time: they posted a job, they got a message. Safe to
// call from anywhere, including a browser with no storage.
export function markPushMoment(): void {
  try {
    window.localStorage.setItem(MOMENT_KEY, String(Date.now()));
  } catch {
    // No storage: the event below still lets a mounted prompt react now, it
    // just will not survive a navigation.
  }
  try {
    window.dispatchEvent(new CustomEvent(PUSH_MOMENT_EVENT));
  } catch {
    // Nothing to do; the stamp above is the durable half.
  }
}

// Did something notification-worthy happen in the last couple of minutes?
export function hasFreshMoment(now: number = Date.now()): boolean {
  const at = readNumber(MOMENT_KEY);
  return at > 0 && now - at < MOMENT_FRESH_MS;
}

// Clear the moment once it has been acted on, so one job post produces one
// card and not one per page view for the next two minutes.
export function clearPushMoment(): void {
  try {
    window.localStorage.removeItem(MOMENT_KEY);
  } catch {
    // Best effort.
  }
}

export function isPushPromptSnoozed(
  userId: string,
  now: number = Date.now()
): boolean {
  return now < readNumber(snoozeKey(userId));
}

export function snoozePushPrompt(userId: string, now: number = Date.now()): void {
  try {
    window.localStorage.setItem(snoozeKey(userId), String(now + SNOOZE_MS));
  } catch {
    // Worst case it can appear again after the next moment.
  }
}

export function isPushPromptDone(userId: string): boolean {
  try {
    return window.localStorage.getItem(doneKey(userId)) === "1";
  } catch {
    return false;
  }
}

export function markPushPromptDone(userId: string): void {
  try {
    window.localStorage.setItem(doneKey(userId), "1");
  } catch {
    // Not fatal: the prompt also checks the live permission state, which is
    // the real answer to "is this already on".
  }
}
