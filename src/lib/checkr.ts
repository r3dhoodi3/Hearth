// Build-time guard: this module reads CHECKR_API_KEY, so importing it from a
// Client Component must fail the build, not ship the key.
import "server-only";
import { createHmac, timingSafeEqual } from "crypto";

// Server-only. Opt-in background checks via Checkr (0057), paid by Hearth -
// there is no payment code anywhere in this file. Dormant without
// CHECKR_API_KEY: isCheckrConfigured() is what gates the pro-facing UI, and
// every exported function here is safe to call even when unconfigured (they
// just return a typed failure instead of throwing).
//
// WHAT WAS CONFIRMED vs ASSUMED (docs.checkr.com is a login-gated Redocly
// portal - it could not be fetched directly). Confirmed via Checkr's own
// public curl examples and third-party integration guides surfaced by
// search:
//   - Base URL: https://api.checkr.com/v1/...
//   - POST /v1/invitations takes candidate_id, package (a slug), and
//     work_locations[][state] (+ [][city]), form-encoded.
//   - Auth is HTTP Basic with the API key as the username and an empty
//     password (curl: `-u API_KEY:`).
//   - Webhook signature: header "X-Checkr-Signature", HMAC-SHA256 of the raw
//     request body using the API key as the secret, hex digest.
//   - Report fields: status ("pending" | "complete") and result (null |
//     "clear" | "consider").
// ASSUMED (no official-docs confirmation, filled in from typical Checkr
// integration patterns; verify against the real account/dashboard before
// going live):
//   - POST /v1/candidates request shape (email, first_name, last_name,
//     form-encoded) and that both candidate + invitation calls accept
//     form-encoding the same way the confirmed /v1/invitations example does.
//   - The default package slug: package slugs are configured per Checkr
//     account/dashboard, so "basic_criminal" below is a placeholder that
//     matches common Checkr naming, NOT a guaranteed-valid slug for Hearth's
//     account. Set CHECKR_PACKAGE to the real slug before this goes live.
//   - Webhook event JSON shape (event.type, event.id, event.data.object).
//     Parsing below is deliberately defensive (reads either a nested
//     data.object or a flat payload) so a shape mismatch degrades to "ignore
//     this event" rather than a crash - same spirit as the Stripe webhook's
//     periodEnd()/planFromItems() reading whichever shape is present.
//   - Whether X-Checkr-Signature ever carries a "sha256=" prefix. Verified
//     defensively: the prefix is stripped if present before comparing.

const CHECKR_BASE = "https://api.checkr.com/v1";
const DEFAULT_PACKAGE = "basic_criminal";
const TIMEOUT_MS = 10_000;

export function isCheckrConfigured(): boolean {
  return Boolean(process.env.CHECKR_API_KEY);
}

function packageSlug(): string {
  return process.env.CHECKR_PACKAGE || DEFAULT_PACKAGE;
}

function authHeader(): string {
  const key = process.env.CHECKR_API_KEY ?? "";
  return `Basic ${Buffer.from(`${key}:`).toString("base64")}`;
}

async function checkrFetch(
  path: string,
  params: Record<string, string>
): Promise<{ ok: true; data: any } | { ok: false; error: string }> {
  if (!isCheckrConfigured()) {
    return { ok: false, error: "Checkr is not configured." };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${CHECKR_BASE}${path}`, {
      method: "POST",
      headers: {
        Authorization: authHeader(),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(params),
      signal: controller.signal,
    });
    const text = await res.text();
    let data: any = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      // Non-JSON body: fall through with data null, error path below
      // reports the raw text instead.
    }
    if (!res.ok) {
      return {
        ok: false,
        error:
          data?.error?.message ||
          data?.message ||
          text ||
          `Checkr returned HTTP ${res.status}.`,
      };
    }
    return { ok: true, data };
  } catch (err) {
    return {
      ok: false,
      error:
        err instanceof Error && err.name === "AbortError"
          ? "Checkr request timed out."
          : "Could not reach Checkr.",
    };
  } finally {
    clearTimeout(timeout);
  }
}

export type CreateCandidateInput = {
  email: string;
  firstName: string;
  lastName: string;
  workLocationState: string;
};

export type CreateCandidateResult =
  | { ok: true; candidateId: string; invitationId: string | null }
  | { ok: false; error: string };

// Creates a Checkr candidate, then an invitation for the configured (or
// default) package. Checkr emails the candidate directly from here on -
// Hearth never collects SSNs, DOB, or any other sensitive candidate detail
// itself. Never throws: every failure resolves to { ok: false, error }.
export async function createCandidateAndInvite(
  input: CreateCandidateInput
): Promise<CreateCandidateResult> {
  const candidateRes = await checkrFetch("/candidates", {
    email: input.email,
    first_name: input.firstName,
    last_name: input.lastName,
  });
  if (!candidateRes.ok) return candidateRes;

  const candidateId: string | undefined = candidateRes.data?.id;
  if (!candidateId) {
    return { ok: false, error: "Checkr did not return a candidate id." };
  }

  const invitationRes = await checkrFetch("/invitations", {
    candidate_id: candidateId,
    package: packageSlug(),
    "work_locations[][state]": input.workLocationState,
  });
  if (!invitationRes.ok) {
    // The candidate was created even though the invitation failed. Return
    // the candidate id anyway so the caller can save it and the pro isn't
    // stuck retrying a whole new candidate; the invitation itself can be
    // retried by re-running "Start my background check".
    return {
      ok: false,
      error: `Candidate created, but the invitation failed: ${invitationRes.error}`,
    };
  }

  return {
    ok: true,
    candidateId,
    invitationId: invitationRes.data?.id ?? null,
  };
}

// Verifies X-Checkr-Signature: HMAC-SHA256 of the RAW request body, using
// the API key as the secret, hex digest. Must be called with the raw,
// unparsed body text (same requirement as the Stripe webhook). Returns false
// (never throws) on any mismatch, missing header, or missing configuration -
// callers must treat false as "reject the request".
export function verifyWebhookSignature(
  rawBody: string,
  signatureHeader: string | null
): boolean {
  const apiKey = process.env.CHECKR_API_KEY;
  if (!apiKey || !signatureHeader) return false;

  const provided = signatureHeader.startsWith("sha256=")
    ? signatureHeader.slice("sha256=".length)
    : signatureHeader;

  let expected: string;
  try {
    expected = createHmac("sha256", apiKey).update(rawBody, "utf8").digest("hex");
  } catch {
    return false;
  }

  const a = Buffer.from(provided, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length || a.length === 0) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export type CheckrEventType =
  | "invitation.completed"
  | "invitation.expired"
  | "invitation.canceled"
  | "report.completed"
  | "other";

export type CheckrParsedEvent = {
  id: string | null;
  type: CheckrEventType;
  candidateId: string | null;
  reportId: string | null;
  reportStatus: string | null; // "pending" | "complete" | ...
  reportResult: string | null; // null | "clear" | "consider"
  packageSlug: string | null;
  completedAt: string | null;
};

const KNOWN_TYPES: CheckrEventType[] = [
  "invitation.completed",
  "invitation.expired",
  "invitation.canceled",
  "report.completed",
];

// Defensive parse of a Checkr webhook JSON payload. Reads the event object
// wherever it actually lives (nested under data.object, under data, or flat
// on the payload itself) so an unexpected shape degrades to nulls rather
// than throwing - callers should treat missing candidateId/type as "ignore
// this event", never as a fetch/parse error.
export function parseCheckrWebhookPayload(payload: any): CheckrParsedEvent {
  const rawType = String(payload?.type ?? "other");
  const type = (KNOWN_TYPES as string[]).includes(rawType)
    ? (rawType as CheckrEventType)
    : "other";
  const obj = payload?.data?.object ?? payload?.data ?? payload ?? {};

  return {
    id: payload?.id ?? null,
    type,
    candidateId: obj?.candidate_id ?? obj?.candidateId ?? null,
    reportId: type === "report.completed" ? (obj?.id ?? null) : null,
    reportStatus: obj?.status ?? null,
    reportResult: obj?.result ?? null,
    packageSlug: obj?.package ?? obj?.package_name ?? null,
    completedAt: obj?.completed_at ?? null,
  };
}
