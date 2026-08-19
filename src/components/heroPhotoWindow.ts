// Mount window for the landing hero photo cycler.
//
// The cycler used to mount all twelve photos at once, stacked in the visible
// hero box. Because they were all in the viewport from the first paint,
// loading="lazy" bought nothing: the browser fired twelve image requests
// immediately and they competed with everything else above the fold.
//
// Instead the cycler mounts a growing prefix of the list, so a photo only
// enters the DOM (and only asks the network for bytes) a couple of beats
// before the crossfade needs it. At 3s per beat that is roughly one request
// every 3s, staggered behind the ones that matter.
//
// The window only ever GROWS: a photo that has been shown once stays mounted.
// Unmounting the outgoing photo would cut the 1s crossfade short (it would
// vanish instead of fading), and once the loop has been all the way around
// every photo is cached anyway.

/** Photos kept mounted ahead of the active one, so each has time to decode. */
export const LOOKAHEAD = 2;

/**
 * How many photos to mount at the very start, before any cycling: the first
 * one plus its lookahead.
 */
export function initialMountCount(total: number): number {
  return Math.min(total, LOOKAHEAD + 1);
}

/**
 * Next mount count, given the current one and the photo that just became
 * active. Monotonic and clamped to the list length, so it is safe to call
 * repeatedly with the same arguments.
 */
export function nextMountCount(current: number, activeIndex: number, total: number): number {
  return Math.min(total, Math.max(current, activeIndex + 1 + LOOKAHEAD));
}
