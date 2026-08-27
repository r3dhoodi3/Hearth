import { describe, expect, it, vi, beforeEach } from "vitest";

// The page renders the "set a new password" form off ?step=update. It used to
// render it off that query string ALONE, which meant anyone sitting at an
// already-signed-in browser - an unattended laptop, a shared machine, a
// borrowed session - could type the URL and take the account over without ever
// knowing the old password. The form's own updateUser() call needs a session,
// so a signed-out stranger got nothing; the signed-in walk-up got everything.
//
// The fix is a second, unforgeable signal: an httpOnly cookie that only
// /auth/callback or /auth/confirm can set, and only after a recovery exchange
// has actually succeeded AND the request carried ?type=recovery. Both routes
// key on that one parameter and nothing else - an earlier draft also accepted
// "?next= points at /reset-password", which any OAuth sign-in can supply, so
// the cookie would have been mintable by signing in with a chosen query
// string. src/lib/hardening0132.test.ts guards that.

const cookieValue = { current: undefined as string | undefined };

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "hearth_pwrecovery" && cookieValue.current !== undefined
        ? { name, value: cookieValue.current }
        : undefined,
  }),
}));

// The form is a client component with hooks and a Supabase client; the page's
// only decision is which step it hands over, so a stub is enough to read that.
vi.mock("./ResetPasswordForm", () => ({
  default: (props: { step: string }) => props,
}));

import ResetPasswordPage from "./page";
import {
  PW_RECOVERY_COOKIE,
  PW_RECOVERY_MAX_AGE_SECONDS,
  passwordRecoveryCookieOptions,
} from "@/lib/passwordRecovery";

async function stepFor(
  step: string | undefined,
  cookie: string | undefined
): Promise<string> {
  cookieValue.current = cookie;
  const element = (await ResetPasswordPage({
    searchParams: Promise.resolve(step === undefined ? {} : { step }),
  })) as { props: { step: string } };
  return element.props.step;
}

beforeEach(() => {
  cookieValue.current = undefined;
});

describe("reset-password step gating", () => {
  it("renders the update step only with BOTH the query and the cookie", async () => {
    expect(await stepFor("update", "1")).toBe("update");
  });

  it("falls back to the request step on a walk-up with no cookie", async () => {
    // This is the attack: the URL typed by hand in a signed-in browser.
    expect(await stepFor("update", undefined)).toBe("request");
  });

  it("ignores a cookie that is not the value the auth routes set", async () => {
    expect(await stepFor("update", "")).toBe("request");
    expect(await stepFor("update", "true")).toBe("request");
    expect(await stepFor("update", "0")).toBe("request");
  });

  it("renders the request step for a normal visit, cookie or not", async () => {
    expect(await stepFor(undefined, undefined)).toBe("request");
    expect(await stepFor(undefined, "1")).toBe("request");
    expect(await stepFor("request", "1")).toBe("request");
    expect(await stepFor("anything-else", "1")).toBe("request");
  });
});

describe("the recovery cookie itself", () => {
  it("cannot be minted or read by script on the page", () => {
    expect(passwordRecoveryCookieOptions().httpOnly).toBe(true);
  });

  it("survives the top-level navigation the emailed link performs", () => {
    // The click arrives as a cross-site top-level GET, so strict would drop it
    // and the flow would never work.
    expect(passwordRecoveryCookieOptions().sameSite).toBe("lax");
  });

  it("is short-lived - long enough to type a password, far shorter than a session", () => {
    expect(PW_RECOVERY_MAX_AGE_SECONDS).toBe(15 * 60);
    expect(passwordRecoveryCookieOptions().maxAge).toBe(15 * 60);
  });

  it("is Secure in production and not in development", () => {
    const original = process.env.NODE_ENV;
    try {
      vi.stubEnv("NODE_ENV", "production");
      expect(passwordRecoveryCookieOptions().secure).toBe(true);
      vi.stubEnv("NODE_ENV", "development");
      // A Secure cookie is dropped on http://localhost, which would make the
      // reset flow untestable on a developer machine.
      expect(passwordRecoveryCookieOptions().secure).toBe(false);
    } finally {
      vi.unstubAllEnvs();
      expect(process.env.NODE_ENV).toBe(original);
    }
  });

  it("has the name both auth routes and the page agree on", () => {
    expect(PW_RECOVERY_COOKIE).toBe("hearth_pwrecovery");
  });
});
