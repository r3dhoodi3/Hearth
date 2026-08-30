// "Is this an iPhone, and has Hearth been added to the Home Screen yet?"
//
// Extracted from src/components/AddToHomeScreenNudge.tsx, which had these two
// checks private to itself, because the push notification UI needs exactly the
// same answer and must not guess it differently. On iOS, Web Push works ONLY in
// an installed Home Screen app (Safari 16.4+); in a Safari tab there is no
// permission to ask for, so the button has to say "add it to your Home Screen
// first" instead of failing on a tap.
//
// Everything here fails closed: any thrown error (a missing matchMedia, private
// browsing quirks) resolves to the conservative answer rather than a crash.

// iOS Safari only. iPhone/iPad is the target; other iOS browsers (Chrome,
// Firefox, Edge, DuckDuckGo) all render on WebKit and carry "Safari" in their
// user agent string too, but "Add to Home Screen" behaves differently (or is
// unavailable) there, so they're explicitly excluded. iPadOS 13+ reports its
// user agent as a plain Mac, so a touch-capable "Macintosh" UA counts as iOS
// too.
export function isIosSafari(): boolean {
  try {
    const ua = window.navigator.userAgent;
    const isIosDevice =
      /iPad|iPhone|iPod/.test(ua) ||
      (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
    if (!isIosDevice) return false;
    return !/CriOS|FxiOS|EdgiOS|OPiOS|DuckDuckGo|Mercury/i.test(ua);
  } catch {
    return false;
  }
}

// True once the app is already installed and running full-screen.
// navigator.standalone is iOS Safari's own flag; the display-mode media query
// is the standards-track fallback other engines use.
//
// Fails closed to TRUE: for the install nudge that means "don't nudge", and for
// the push card it means "don't tell an Android user to add Hearth to their
// Home Screen", both of which are the harmless answer.
export function isStandalone(): boolean {
  try {
    const nav = window.navigator as Navigator & { standalone?: boolean };
    if (nav.standalone === false) return false;
    if (nav.standalone === true) return true;
    return window.matchMedia("(display-mode: standalone)").matches;
  } catch {
    return true;
  }
}

// The one case where the "Turn on notifications" button cannot work and must
// explain itself instead: an iPhone in a Safari TAB. Android Chrome subscribes
// happily from a plain tab, and an installed Hearth on iOS is fine.
export function needsHomeScreenInstallForPush(): boolean {
  return isIosSafari() && !isStandalone();
}
