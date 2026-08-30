// Redact anything that should never reach a log line.
//
// WHY. Server logs on Vercel are retained by a third party, readable by anyone
// with project access, and they are the one place a secret gets copied to
// without anybody deciding to copy it. The rule everywhere in this repo is to
// log an id and an error message and nothing else, and the existing call sites
// follow it. This helper exists for the handful of places that log a value the
// SHAPE of which we do not control - a caller-supplied analytics payload, a
// provider error object - where "just don't log the bad fields" is not
// something the code can know in advance.
//
// It is a redactor, not a serializer: it does not try to be clever, it walks
// the object once, drops the keys named below, truncates long strings, and
// stops at a small depth so a pathological payload cannot turn one log line
// into a megabyte.
//
// It is NOT a licence to start logging objects. Prefer logging an id.

// Key names that are dropped outright, matched case-insensitively as a
// substring so "authToken", "access_token", "stripeSecretKey", "cardLast4" and
// "userEmail" are all caught by the short list.
const REDACTED_KEY_PARTS = [
  "token",
  "password",
  "passwd",
  "secret",
  "authorization",
  "auth",
  "cookie",
  "session",
  "credential",
  "apikey",
  "api_key",
  "card",
  "cvc",
  "cvv",
  "iban",
  "ssn",
  "email",
  "phone",
  "otp",
  "code_verifier",
  "signature",
  "key",
];

const MAX_STRING = 200;
const MAX_DEPTH = 3;
const MAX_KEYS = 30;
const MAX_ARRAY = 20;

function isRedactedKey(key: string): boolean {
  const lower = key.toLowerCase();
  return REDACTED_KEY_PARTS.some((part) => lower.includes(part));
}

/**
 * A copy of `value` with sensitive keys replaced by "[redacted]", long strings
 * cut, and depth/size bounded. Safe to hand straight to console.error.
 */
export function redact(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;

  if (typeof value === "string") {
    return value.length > MAX_STRING
      ? `${value.slice(0, MAX_STRING)}...[${value.length} chars]`
      : value;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  // A function or a symbol in a payload is never information worth logging.
  if (typeof value !== "object") return "[unloggable]";

  if (depth >= MAX_DEPTH) return "[deep]";

  // An Error is the common case and its useful parts are name + message. The
  // stack is deliberately left out: it carries file paths and sometimes the
  // arguments that caused the throw.
  if (value instanceof Error) {
    return { name: value.name, message: redact(value.message, depth + 1) };
  }

  if (Array.isArray(value)) {
    const out = value.slice(0, MAX_ARRAY).map((v) => redact(v, depth + 1));
    if (value.length > MAX_ARRAY) out.push(`[+${value.length - MAX_ARRAY} more]`);
    return out;
  }

  const out: Record<string, unknown> = {};
  let seen = 0;
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (seen >= MAX_KEYS) {
      out["..."] = "[truncated]";
      break;
    }
    seen += 1;
    out[key] = isRedactedKey(key) ? "[redacted]" : redact(v, depth + 1);
  }
  return out;
}

/**
 * console.error with every argument passed through {@link redact} first. Use it
 * where the value being logged is not something this code chose the shape of.
 */
export function logErrorSafe(...args: unknown[]): void {
  console.error(...args.map((a) => redact(a)));
}

/**
 * console.log counterpart, same rules. Server-side only, same as the rest of
 * this module.
 */
export function logSafe(...args: unknown[]): void {
  console.log(...args.map((a) => redact(a)));
}
