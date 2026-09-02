// Detects and recovers from the one failure every deploy inflicts on pages
// that are already open in someone's browser: the page's JavaScript still
// references the PREVIOUS build, so its next form submit posts a Server
// Action id the new server no longer knows ("Failed to find Server Action"),
// and its next navigation can request a hashed JS chunk that no longer exists
// (ChunkLoadError). Both used to surface as the generic "That didn't go
// through" / "Something went sideways" with a page that keeps failing until
// the person thinks to refresh by hand - which is exactly what happened to
// the owner on /onboarding the night of the 2026-09-01 redeploy.
//
// The recovery is a full reload: it pulls the new build, and every form here
// either lives behind a draft (the onboarding wizard mirrors keystrokes into
// localStorage) or is short enough to retype. The reload is guarded to ONCE
// per minute per tab, so a reload that does not clear the error (the server
// really is broken) falls through to the normal error UI instead of looping.
//
// Client-side only by nature (it reads window/sessionStorage), but written so
// the pure detector is testable in the node environment and the recovery
// takes its effects as injectable arguments.

// Message fingerprints, matched case-insensitively against the error and one
// level of .cause. Kept to shapes that ONLY occur when the running page and
// the deployed build disagree:
//   * Next's stale-action refusal, whose message is stable across 14/15 and
//     names the situation outright ("older or newer deployment").
//   * Webpack/Next chunk-load failures, thrown when a navigation requests a
//     content-hashed chunk file the new deploy deleted.
// Plain network failures ("Failed to fetch" alone) are deliberately NOT
// matched: offline is not a version skew, and reloading an offline page
// throws away state for nothing.
const STALE_PATTERNS = [
  /failed to find server action/i,
  /older or newer deployment/i,
  /loading chunk [^ ]+ failed/i,
  /failed to fetch dynamically imported module/i,
];

function messageOf(err: unknown): string {
  if (!err) return "";
  if (typeof err === "string") return err;
  const e = err as { message?: unknown; name?: unknown };
  const parts = [e.name, e.message].filter(
    (p): p is string => typeof p === "string"
  );
  return parts.join(": ");
}

// True when this error means "the page is from a different deployment than
// the server", checking the error itself and one level of .cause (React
// sometimes wraps the action failure).
export function isStaleDeployError(err: unknown): boolean {
  const own = messageOf(err);
  const cause = messageOf((err as { cause?: unknown } | null)?.cause);
  const name =
    typeof (err as { name?: unknown } | null)?.name === "string"
      ? ((err as { name: string }).name)
      : "";
  if (name === "ChunkLoadError") return true;
  return STALE_PATTERNS.some((p) => p.test(own) || p.test(cause));
}

// sessionStorage key holding the epoch-ms of the last automatic reload. Session
// scope on purpose: the guard should reset when the tab closes, and it must
// not leak between tabs (each tab skews independently).
const RELOAD_AT_KEY = "hearth-stale-reload-at";

// Belt for the braces: if sessionStorage is unavailable (private mode with
// storage blocked), this module-level flag still stops a same-page loop. It
// does not survive the reload - that is what the storage timestamp is for -
// but a reload that brings back a working page never re-enters here anyway.
let reloadedThisPage = false;

const RELOAD_COOLDOWN_MS = 60_000;

// Reloads the page to pick up the current deployment, at most once per minute
// per tab. Returns true when a reload was initiated (callers should show a
// quiet "reloading" state and stop), false when the guard held (callers show
// their normal error UI - the last reload did not fix it, so this is not, or
// not only, a stale page). The two effects are injectable for tests; app code
// calls it bare.
export function recoverFromStaleDeploy(
  reload: () => void = () => window.location.reload(),
  storage: Pick<Storage, "getItem" | "setItem"> | null = (() => {
    try {
      return window.sessionStorage;
    } catch {
      return null;
    }
  })(),
  now: number = Date.now()
): boolean {
  if (reloadedThisPage) return false;

  let last = 0;
  try {
    last = Number(storage?.getItem(RELOAD_AT_KEY) ?? 0);
  } catch {
    last = 0;
  }
  if (Number.isFinite(last) && last > 0 && now - last < RELOAD_COOLDOWN_MS) {
    return false;
  }

  reloadedThisPage = true;
  try {
    storage?.setItem(RELOAD_AT_KEY, String(now));
  } catch {
    // Storage refused the write: the in-memory flag above still prevents a
    // same-page loop, and the worst post-reload case is one extra reload.
  }
  reload();
  return true;
}

// Test seam: recoverFromStaleDeploy latches per page load by design, which a
// test file's second case would otherwise inherit. Not used by app code.
export function __resetStaleDeployLatch(): void {
  reloadedThisPage = false;
}

// The one line shown wherever a stale page heals itself. Short and calm on
// purpose: the reload is already happening, nothing is being asked of them.
export const STALE_RELOAD_MESSAGE =
  "Hearth just updated. Reloading this page...";
