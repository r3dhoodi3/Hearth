// Which side of the app a signing-in user belongs on, and where to send them.
//
// Pure functions, no imports on purpose (same reasoning as proDashboard.ts):
// /auth/callback's role decision is the piece that broke - a pro signing in
// with Google from /homeowner-signup got stamped "homeowner" because the door
// they came through was the only signal consulted - so it is worth having the
// ordering of those signals somewhere it can be unit tested without Supabase,
// cookies, or a request context. src/lib/contractor.ts re-exports all of this,
// and every caller imports it from there; nothing else should import this file
// directly except its test.

export type Role = "homeowner" | "contractor";

// Is `path` the given route, or something inside it? Compared segment-wise on
// purpose: a plain startsWith("/pro") also swallows the PUBLIC /pros landing
// page and /pro-terms, and startsWith("/emergency") swallows the anonymous
// /emergency-help page. Query strings and fragments still count as "inside"
// ("/onboarding?next=/join/x" is /onboarding).
function isUnder(path: string, route: string): boolean {
  if (!path.startsWith(route)) return false;
  const rest = path.slice(route.length);
  return (
    rest === "" ||
    rest.startsWith("/") ||
    rest.startsWith("?") ||
    rest.startsWith("#")
  );
}

// The contractor side of the app.
export function isProPath(path: string): boolean {
  return isUnder(path, "/pro");
}

// Pages inside the homeowner shell (the src/app/(app) route group, plus
// /onboarding). These are exactly the destinations whose own layout bounces a
// contractor to /pro, so sending a contractor straight there instead of
// through them changes nothing except the number of redirects.
//
// Deliberately a list of homeowner routes rather than "anything not under
// /pro": the callback also handles password reset (?next=/reset-password),
// the role picker, and household QR invites (/join/...), and NONE of those
// belong to either shell. Bouncing a contractor off /reset-password would
// leave them unable to set a password at all. Being wrong in the other
// direction is harmless - a missing entry just means the destination's own
// layout does the redirect, exactly as it does today.
const HOMEOWNER_SHELL_ROUTES = [
  "/onboarding",
  "/dashboard",
  "/account",
  "/ask",
  "/chats",
  "/contractors",
  "/documents",
  "/emergency",
  "/feedback",
  "/forecast",
  "/home-report",
  "/inspection",
  "/issues",
  "/learn",
  "/plus",
  "/profile",
  "/quote-check",
  "/search",
  "/taxes",
  "/value",
  "/walkthrough",
];

export function isHomeownerShellPath(path: string): boolean {
  return HOMEOWNER_SHELL_ROUTES.some((route) => isUnder(path, route));
}

// The two signup pages always build their confirmation link's ?next= as
// /onboarding or /pro/onboarding (confirmRedirectUrl() in each), so landing on
// one of those is the signal that this code exchange is a signup confirmation
// and not some other use of the callback (password reset, plain sign-in).
export function isSignupConfirmationPath(path: string): boolean {
  return isUnder(path, "/pro/onboarding") || isUnder(path, "/onboarding");
}

// The claim-your-home wizard: the destination /homeowner-signup builds for a
// brand-new account (oauthNextPath there). An account that already owns a home
// has finished it, and for them that same page is the "add another home"
// screen - which on the free plan is the cap wall. See destinationForSignIn
// below.
export function isFirstHomeSetupPath(path: string): boolean {
  return isUnder(path, "/onboarding");
}

// One query-string value off a relative path. No `new URL(path, base)`: a base
// would have to be invented here, and this file deliberately knows nothing
// about the request. Returns null when there is no query string or no such
// key.
function queryParam(path: string, key: string): string | null {
  const q = path.indexOf("?");
  if (q === -1) return null;
  const hash = path.indexOf("#", q);
  const query = hash === -1 ? path.slice(q + 1) : path.slice(q + 1, hash);
  return new URLSearchParams(query).get(key);
}

// A destination the signup funnel parked inside /onboarding?next=..., safe to
// follow. Same relative-path contract as safeNextPath (src/lib/safeNext.ts),
// re-checked rather than imported because this value never went through it:
// the OUTER ?next= was validated by the route, its inner one was not.
// /onboarding inside /onboarding is rejected too, since following it walks
// straight back into the page this rewrite exists to avoid.
//
// The control-character and backslash rules are not decoration, they are the
// whole reason this cannot be a bare startsWith("/") check. safeNextPath saw
// the OUTER value "/onboarding?next=/%5Cevil.com", which is a perfectly
// ordinary relative path of ours. URLSearchParams.get() then percent-DECODES
// the inner one, so what lands here is "/\evil.com" - and the WHATWG URL
// parser normalizes that backslash to a slash, making new URL(inner, origin)
// resolve to https://evil.com/. A C0 control character (the %09 form) is
// stripped by the same parser, with the same result. Both must be rejected
// against the DECODED value, which is exactly what this function holds.
function innerNext(path: string): string | null {
  const inner = queryParam(path, "next");
  if (!inner) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(inner)) return null;
  if (inner.includes("\\")) return null;
  if (!inner.startsWith("/") || inner.startsWith("//")) return null;
  if (isFirstHomeSetupPath(inner)) return null;
  return inner;
}

// ===========================================================================
// A STALE FIRST-HOME DESTINATION. SIGNING IN NEVER EVALUATES THE HOME CAP.
//
// Google and Apple have ONE button for both sign-up and sign-in
// (GoogleSignInButton/AppleSignInButton), and /homeowner-signup builds it with
// next=/onboarding. An EXISTING homeowner who tapped "Continue with Apple"
// there therefore came back to the claim-your-home wizard, and for an account
// that already owns a home that page is the "add another home" screen: on the
// free plan it renders the cap wall, "Your first home is free. Adding another
// home is part of Hearth Plus." Someone who did nothing but sign in was told
// to upgrade, with no way on except a link to /plus.
//
// The cap is a rule about the add-a-home ACTION, so no sign-in landing may go
// near it. Three cases, in order:
//   - ?add=home is the one explicit "I am adding a home" intent in the app
//     (ProNav, setPreferredSideAction). Asked for, so honored - cap wall
//     included, which is exactly where that wall belongs.
//   - a destination the funnel parked in the inner ?next=, notably a household
//     QR invite (/join/...), is handed over directly. That is what /onboarding
//     itself does with that URL (see its page.tsx), so nothing about the
//     invite flow changes.
//   - otherwise their dashboard, which getActiveProperty() resolves to the
//     active home or the first one, so an owner at or over the cap still lands
//     on a real home.
//
// Only ever narrows a destination that no longer applies: an account with no
// home of its own is untouched and still goes to onboarding. Exported because
// both halves of the same door need it - /auth/callback through
// resolveAuthRole below, and /auth/confirm (magic link, email confirmation)
// directly, since that route decides no role and needs none to apply this.
// ===========================================================================
export function destinationForSignIn(
  next: string,
  hasPropertyRow: boolean
): string {
  if (!hasPropertyRow) return next;
  if (!isFirstHomeSetupPath(next)) return next;
  if (queryParam(next, "add") === "home") return next;
  return innerNext(next) ?? "/dashboard";
}

// What an account actually HAS, which is what every layout and landing
// decision gates on. One account may hold both sides at once: a pro who also
// owns a home has a contractors row AND properties rows, and neither cancels
// the other out.
//
// `preferred` is only the side they LAND on (user_metadata.role). It is a
// preference, not a permission: nothing may use it to deny access to a side
// the account demonstrably has, and nothing may use it to grant a side the
// account does not have. Populated by getSides() in src/lib/contractor.ts,
// which re-exports this type.
export type Sides = {
  hasPro: boolean;
  hasHome: boolean;
  preferred: Role | null;
};

// The role picker. Named here because landingFor() returns it and every caller
// that redirects to landingFor() has to recognize it (see /welcome/role, which
// must not bounce a visitor back to itself).
export const ROLE_PICKER_PATH = "/welcome/role";

// Where to drop this account when no destination was asked for. The preferred
// side wins whenever the account actually has it; otherwise whichever side
// exists.
//
// An account with NEITHER side and no preference has not answered the one
// question the app needs answered, so it goes to the picker. It used to be
// dropped straight into /onboarding, which silently decided "homeowner" for a
// person who never said so - a contractor who signed up and bailed before
// company setup came back to a claim-your-home wizard with no way across.
// A preference on file is still an answer: it just has not been acted on yet,
// so those two cases keep going to their own onboarding.
export function landingFor(sides: Sides): string {
  if (sides.preferred === "contractor" && sides.hasPro) return "/pro";
  if (sides.preferred === "homeowner" && sides.hasHome) return "/dashboard";
  // No preference, or a preference for a side they have not built yet: send
  // them to a side that exists. Pro first when both do, matching the rest of
  // the app's read that a company row is the more deliberate signal.
  if (sides.hasPro) return "/pro";
  if (sides.hasHome) return "/dashboard";
  if (sides.preferred === "contractor") return "/pro/onboarding";
  if (sides.preferred === "homeowner") return "/onboarding";
  return ROLE_PICKER_PATH;
}

export type AuthRoleDecision = {
  // The role we're confident about, or null when there is no signal at all and
  // the user has to be asked (/welcome/role).
  role: Role | null;
  // True when user_metadata.role does not already say `role` and must be
  // (re)written. Also true for the mis-stamped case: metadata says homeowner
  // but a contractors row exists.
  needsStamp: boolean;
  // Where to send the browser. Not always `next`: a contractor pointed at a
  // homeowner page (and vice versa) would only be bounced by that page's own
  // layout, and when the stamped role disagrees with the row, those bounces
  // chase each other in a loop.
  redirect: string;
  // Which terms doc to record, or null to record nothing. Only signup
  // confirmations record; password resets and plain sign-ins must not, since
  // that user did not just agree to anything.
  termsDoc: "terms" | "pro_terms" | null;
};

// Decides who this user is and where they belong, from three inputs and
// nothing else.
//
// The ordering is the whole point. A contractors row OUTRANKS `next`: a pro
// who signs in with Google from /homeowner-signup arrives with
// next=/onboarding, and inferring "homeowner" from that door used to stamp
// them as a homeowner, after which /onboarding sent them to /pro, the pro
// layout read role=homeowner and sent them to /dashboard, the homeowner
// layout found no property and sent them back to /onboarding - forever, until
// the error boundary caught it ("Something went sideways"). `next` is only a
// guess about a stranger, so it is consulted last, and only for someone we
// know nothing else about.
export function resolveAuthRole(input: {
  metadataRole?: string | null;
  hasContractorRow: boolean;
  // Does this account already own a home? Two consumers: alongside a
  // contractors row it recognizes the account that has BOTH sides, and on its
  // own it says the claim-a-home wizard is a finished step for this person
  // (destinationForSignIn). Defaults to false, so every caller that never asks
  // keeps the old behavior: single-side correction, and onboarding still
  // reachable.
  hasPropertyRow?: boolean;
  next: string;
}): AuthRoleDecision {
  const { hasContractorRow, next } = input;
  const hasPropertyRow = input.hasPropertyRow ?? false;
  const known =
    input.metadataRole === "contractor" || input.metadataRole === "homeowner"
      ? input.metadataRole
      : null;
  const isSignup = isSignupConfirmationPath(next);
  // A company row AND a home: this account genuinely owns both sides, so
  // there is no wrong side to correct them off. Their stamped preference
  // stands (it is a landing preference now, not a permission), and `next` is
  // honored exactly as given - a pro-who-owns-a-home asking for /dashboard
  // means /dashboard.
  const hasBothSides = hasContractorRow && hasPropertyRow;

  let role: Role | null;
  if (hasBothSides) {
    // Only fall back to "contractor" when there is no preference on file: with
    // both rows present, the metadata is the only thing that says which side
    // they want, and a contractors row is the more deliberate of the two acts.
    role = known ?? "contractor";
  } else if (hasContractorRow) {
    // A company row means they are a pro, whatever the metadata or the door
    // they came through says. This is the same signal getRole()'s legacy
    // fallback already trusts.
    role = "contractor";
  } else if (known) {
    role = known;
  } else if (isSignup) {
    // Genuinely new: no row, no role. Here the door they walked through IS
    // their choice, and only contractor-signup's buttons point at
    // /pro/onboarding.
    role = isProPath(next) ? "contractor" : "homeowner";
  } else {
    role = null;
  }

  if (!role) {
    // No signal anywhere (a Google sign-in from the plain /signin page by
    // someone who never picked a side). Guessing here would half-initialize
    // them on the wrong side of the app, so ask instead.
    return {
      role: null,
      needsStamp: false,
      redirect: `/welcome/role?next=${encodeURIComponent(next)}`,
      termsDoc: null,
    };
  }

  let redirect = next;
  // Side correction only applies to an account that has ONE side. For a dual
  // account there is no wrong destination to correct them off.
  if (!hasBothSides) {
    if (
      role === "contractor" &&
      !isProPath(next) &&
      isHomeownerShellPath(next)
    ) {
      redirect = "/pro";
    } else if (role === "homeowner" && isProPath(next)) {
      // Let the homeowner shell take it from here: it sends them to
      // /onboarding itself if they have no claimed home yet.
      redirect = "/dashboard";
    }
  }

  // Never hand an account that already owns a home back to the claim-a-home
  // wizard, whichever side it is on: that page is the add-another-home screen
  // for them, and on the free plan it is the cap wall. Full reasoning on
  // destinationForSignIn above. Applied after the side correction so it sees
  // the destination they will really get, and a no-op for the brand-new
  // account this route mostly serves (hasPropertyRow defaults to false).
  redirect = destinationForSignIn(redirect, hasPropertyRow);

  return {
    role,
    needsStamp: input.metadataRole !== role,
    redirect,
    termsDoc: isSignup ? (role === "contractor" ? "pro_terms" : "terms") : null,
  };
}
