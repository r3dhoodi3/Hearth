import "server-only";
import { createPrivateKey, createSign } from "crypto";

// =============================================================================
// Apple Sign-In token revocation on account deletion (guideline 5.1.1(v)),
// 2026-09-07, appstore-execute.
//
// Apple requires that when an account which authenticated via Sign in with
// Apple deletes itself, the app also revokes that Apple authorization via
// POST https://appleid.apple.com/auth/revoke - not just delete OakTend's own
// row for them. This module builds the one-off `client_secret` JWT Apple's
// token endpoints require (a JWT signed with the app's Sign in with Apple
// private key, NOT a static secret - Apple's own docs describe this
// construction) and calls the revoke endpoint.
//
// BEST EFFORT, NEVER BLOCKS DELETION. Same posture eraseUserData() already
// takes elsewhere in the delete flow: a failed or skipped revoke is logged
// and the account deletion proceeds regardless. Two reasons this is the
// right call, not a shortcut:
//   1. Apple's own tokens naturally EXPIRE; a user who deletes their OakTend
//      account and never returns has an authorization that goes stale on
//      its own even with no revoke call.
//   2. Blocking a CCPA/GDPR-style right-to-delete request on a THIRD PARTY'S
//      API being reachable would be a worse outcome than a best-effort
//      revoke - see the identical reasoning already in deleteAccountAction
//      for eraseUserData()'s storage/row purge.
//
// KNOWN GAP, called out explicitly rather than silently worked around:
// calling /auth/revoke correctly needs Apple's REFRESH token for that
// specific authorization (an access token also works but is short-lived and
// just as unavailable here). Supabase's OAuth flow receives a
// provider_refresh_token on the INITIAL sign-in (available for one request
// on the Session object returned from signInWithOAuth's callback exchange),
// but does NOT persist it anywhere queryable later - it is not stored on the
// user, the identity row, or exposed by admin.auth.admin.getUserById(). As
// of this pass OakTend has no code that captures and stores that token at
// sign-in time either. So today, callAppleRevoke() below can build a correct
// client_secret and would call the endpoint correctly GIVEN a token, but it
// has no persisted token to pass, and it says so via the returned reason
// rather than silently doing nothing. Storing that token at first sign-in
// (in a new column on public.users, encrypted at rest) is the real fix and
// is NOT done in this pass - flagged in the execute report and in
// docs/APP-STORE-SUBMISSION.md as follow-up work before this becomes a full
// implementation rather than a documented gap.
// =============================================================================

export type AppleRevokeResult =
  | { attempted: false; reason: string }
  | { attempted: true; ok: true }
  | { attempted: true; ok: false; reason: string };

function buildClientSecret(): string | null {
  const teamId = process.env.APPLE_TEAM_ID;
  const keyId = process.env.APPLE_KEY_ID;
  const clientId = process.env.APPLE_CLIENT_ID;
  const privateKeyPem = process.env.APPLE_PRIVATE_KEY?.replace(/\\n/g, "\n");
  if (!teamId || !keyId || !clientId || !privateKeyPem) return null;

  const header = { alg: "ES256", kid: keyId };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: teamId,
    iat: now,
    // Apple caps this JWT's lifetime at 6 months; a short-lived, per-call
    // token (5 minutes) is safer to generate fresh every time than to cache,
    // since this function is called rarely (only on account deletion).
    exp: now + 300,
    aud: "https://appleid.apple.com",
    sub: clientId,
  };

  const b64url = (input: Buffer | string) =>
    Buffer.from(input)
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");

  const encodedHeader = b64url(JSON.stringify(header));
  const encodedPayload = b64url(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  try {
    const key = createPrivateKey(privateKeyPem);
    // ES256 = ECDSA using P-256 and SHA-256. Node's createSign produces a
    // DER-encoded signature by default; JWS (and therefore Apple) requires
    // the raw R||S concatenation instead, so dsaEncoding: "ieee-p1363" asks
    // Node for that format directly rather than hand-parsing DER.
    const signature = createSign("SHA256")
      .update(signingInput)
      .sign({ key, dsaEncoding: "ieee-p1363" });
    return `${signingInput}.${b64url(signature)}`;
  } catch (err) {
    console.error("appleRevoke: failed to sign client_secret JWT:", err);
    return null;
  }
}

/**
 * Best-effort revoke of an Apple Sign-In authorization on account deletion.
 * `refreshToken` is intentionally the caller's responsibility to look up (or
 * pass null) - see the module comment above for why OakTend does not have
 * one to pass today. Never throws; every failure path returns a reason
 * instead so the caller can log it without a try/catch at every call site.
 */
export async function callAppleRevoke(
  refreshToken: string | null
): Promise<AppleRevokeResult> {
  if (!refreshToken) {
    return {
      attempted: false,
      reason:
        "no stored Apple refresh token available (Supabase does not persist provider_refresh_token beyond the initial OAuth session - see the module comment in src/lib/appleRevoke.ts)",
    };
  }

  const clientSecret = buildClientSecret();
  const clientId = process.env.APPLE_CLIENT_ID;
  if (!clientSecret || !clientId) {
    return {
      attempted: false,
      reason:
        "APPLE_TEAM_ID / APPLE_KEY_ID / APPLE_CLIENT_ID / APPLE_PRIVATE_KEY are not fully configured",
    };
  }

  try {
    const res = await fetch("https://appleid.apple.com/auth/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        token: refreshToken,
        token_type_hint: "refresh_token",
      }),
      // A deletion request should not hang indefinitely on a third party.
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { attempted: true, ok: false, reason: `Apple returned ${res.status}: ${body.slice(0, 200)}` };
    }
    return { attempted: true, ok: true };
  } catch (err: any) {
    return { attempted: true, ok: false, reason: err?.message ?? String(err) };
  }
}
