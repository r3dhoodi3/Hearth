// Build-time guard: this module reads SUPABASE_SERVICE_ROLE_KEY as its signing
// secret, so importing it from a Client Component must fail the build, not ship
// the key. Same guard as src/lib/supabase/admin.ts and src/lib/stripe.ts; it
// was the only module reading that variable without one.
import "server-only";
import { createHmac, timingSafeEqual } from "crypto";

// Signs and verifies the per-user unsubscribe link embedded in every outgoing
// email (src/lib/notify.ts sendEmail). HMAC-SHA256 over the user id, keyed by
// SUPABASE_SERVICE_ROLE_KEY - a server-only secret that is always present
// wherever email is sent (createAdminClient already requires it) and never
// reaches the browser, so a recipient can't forge an opt-out for someone
// else's account. Same createHmac(...).digest("hex") + timingSafeEqual idiom
// as the Checkr / Twilio webhook signature checks (src/lib/checkr.ts,
// src/app/api/twilio/inbound/route.ts).

function signingSecret(): string {
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secret) {
    throw new Error("unsubscribeToken: SUPABASE_SERVICE_ROLE_KEY is unset");
  }
  return secret;
}

export function signUnsubscribeToken(userId: string): string {
  return createHmac("sha256", signingSecret())
    .update(userId, "utf8")
    .digest("hex");
}

// Never throws: returns false (reject) on missing input, missing secret, or
// any mismatch. Constant-time compare, only once both buffers are the same
// non-zero length, exactly like the webhook verifiers.
export function verifyUnsubscribeToken(
  userId: string,
  token: string
): boolean {
  if (!userId || !token) return false;

  let expected: string;
  try {
    expected = signUnsubscribeToken(userId);
  } catch {
    return false;
  }

  const provided = Buffer.from(token, "utf8");
  const expectedBuf = Buffer.from(expected, "utf8");
  if (provided.length !== expectedBuf.length || provided.length === 0) {
    return false;
  }
  try {
    return timingSafeEqual(provided, expectedBuf);
  } catch {
    return false;
  }
}
