import { describe, expect, it } from "vitest";
import { hasAuthCookie } from "./authCookie";

// hasAuthCookie is the cheap "is there anything to check" gate in front of the
// real auth call on "/" and "/pros", and the same predicate the middleware uses
// to decide whether an unreachable auth server should fail open. It is only
// ever safe in one direction - false means "definitely signed out" - so these
// tests are mostly about the false side being right.
const c = (...names: string[]) => names.map((name) => ({ name }));

describe("hasAuthCookie", () => {
  it("is false for a request with no cookies at all", () => {
    expect(hasAuthCookie([])).toBe(false);
  });

  it("is false for a browser carrying only non-auth cookies", () => {
    // hearth_did is planted by attachDeviceCookie the first time a visitor
    // loads a signup or payment page, so an anonymous visitor browsing on from
    // there has cookies but no session.
    // Getting this wrong would put the auth call back on the landing page for
    // essentially every real anonymous visitor.
    expect(hasAuthCookie(c("hearth_did", "hearth_fp", "theme"))).toBe(false);
  });

  it("is true for the standard Supabase session cookie", () => {
    expect(hasAuthCookie(c("sb-tubkvvfkwggaddcmcjqv-auth-token"))).toBe(true);
  });

  it("is true for a chunked session cookie", () => {
    // @supabase/ssr splits a token too large for one cookie into .0/.1 parts,
    // and a browser can carry the chunks without the unsuffixed name.
    expect(
      hasAuthCookie(
        c("sb-tubkvvfkwggaddcmcjqv-auth-token.0", "sb-tubkvvfkwggaddcmcjqv-auth-token.1")
      )
    ).toBe(true);
  });

  it("finds the auth cookie among unrelated ones", () => {
    expect(
      hasAuthCookie(c("hearth_did", "sb-abc-auth-token", "theme"))
    ).toBe(true);
  });

  it("is false for other sb- cookies that are not the session", () => {
    // The code verifier is written during the PKCE handshake and is not a
    // session. Treating it as one would send a signed-out visitor through the
    // full verification path for nothing.
    expect(hasAuthCookie(c("sb-abc-auth-token-code-verifier"))).toBe(true);
    expect(hasAuthCookie(c("sb-abc-provider-token"))).toBe(false);
  });

  it("does not match a lookalike name from another origin", () => {
    expect(hasAuthCookie(c("my-sb-auth-token", "auth-token"))).toBe(false);
  });
});
