import { describe, expect, it } from "vitest";
import {
  CAPTCHA_FAILED_MESSAGE,
  friendlyAuthError,
  isCaptchaError,
  SIGNUP_EMAIL_NEUTRAL,
} from "./friendlyAuthError";

describe("friendlyAuthError", () => {
  it("maps a wrong sign-in to copy that points a new visitor at sign-up", () => {
    expect(friendlyAuthError({ message: "Invalid login credentials" })).toMatch(
      /Email or password is incorrect/
    );
  });

  it("answers an existing-email signup with the neutral message", () => {
    expect(friendlyAuthError("User already registered")).toBe(
      SIGNUP_EMAIL_NEUTRAL
    );
  });

  it("maps a CAPTCHA rejection to the refresh-the-page message", () => {
    expect(
      friendlyAuthError({
        message: "captcha protection: request disallowed (invalid-input-response)",
      })
    ).toBe(CAPTCHA_FAILED_MESSAGE);
    // Case-insensitive, and the code alone is enough when the text is generic.
    expect(friendlyAuthError({ message: "Captcha verification failed" })).toBe(
      CAPTCHA_FAILED_MESSAGE
    );
    expect(
      friendlyAuthError({ message: "Request failed", code: "captcha_failed" })
    ).toBe(CAPTCHA_FAILED_MESSAGE);
  });

  it("never echoes raw text for something it doesn't recognize", () => {
    const out = friendlyAuthError({ message: "pg: relation does not exist" });
    expect(out).toBe("That didn't go through. Please try again in a moment.");
  });

  it("has no em dash in any mapped message", () => {
    // House rule: no em dashes in copy. Written as an escape so the character
    // itself never appears in the source.
    const EM_DASH = "\u2014";
    const messages = [
      friendlyAuthError({ message: "Token has expired or is invalid" }),
      friendlyAuthError({ message: "Email rate limit exceeded" }),
      friendlyAuthError(null),
    ];
    for (const message of messages) expect(message).not.toContain(EM_DASH);
  });
});

describe("isCaptchaError", () => {
  it("is true for captcha text or the captcha_failed code", () => {
    expect(isCaptchaError("captcha verification process failed")).toBe(true);
    expect(isCaptchaError({ message: "nope", code: "captcha_failed" })).toBe(
      true
    );
  });

  it("is false for a real wrong password, so the attempt still counts", () => {
    expect(isCaptchaError({ message: "Invalid login credentials" })).toBe(false);
    expect(isCaptchaError(null)).toBe(false);
  });
});
