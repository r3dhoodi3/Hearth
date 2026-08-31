import "server-only";
import { headers, cookies } from "next/headers";
import { createAdminClient } from "@/lib/supabase/admin";
import { riskHash, SALT_VERSION, type SignalKind } from "./hash";
import { normalizeEmail } from "./emailNorm";
import { DEVICE_COOKIE, FINGERPRINT_COOKIE } from "./cookies";
import { clientIpFromHeaders } from "@/lib/clientIp";

// Writing signals into public.account_signals (migration 0130).
//
// The contract every function in this file keeps: NOTHING THROWS, and nothing
// raw is stored. Recording a signal is always a side errand alongside something
// the user actually asked for - signing up, claiming a home, saving a company,
// buying a membership - and none of those may fail because an abuse-detection
// write did. So every path here swallows its errors after logging, and a
// database that has not run migration 0130 yet simply records nothing.
//
// Everything is hashed with a server-side salt before it leaves this module
// (src/lib/risk/hash.ts). A raw IP address, device id, card fingerprint, phone
// number, parcel id or email address must never reach the table.

// Normalization per kind: what counts as "the same value" for linking purposes.
// The hash itself does no more than trim and lowercase, on purpose - the
// judgement calls live here, where they can be read and argued with.
function normalizeSignalValue(kind: SignalKind, raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;

  switch (kind) {
    case "phone":
      // Digits only, and drop a leading US country code, so "(714) 555-0134",
      // "714-555-0134" and "+1 714 555 0134" are one number. Fewer than 7
      // digits is not a phone number anybody can be reached at, so it is not
      // worth linking two accounts over.
      {
        const digits = value.replace(/\D+/g, "");
        const local =
          digits.length === 11 && digits.startsWith("1")
            ? digits.slice(1)
            : digits;
        return local.length >= 7 ? local : null;
      }

    case "company_name":
      // Punctuation stripped, whitespace collapsed, lowercased, and the common
      // legal suffixes removed, so "Ramirez Plumbing, Inc." and "ramirez
      // plumbing llc" match. Deliberately NOT fuzzy: near-match logic on
      // company names produces false links between genuinely different local
      // businesses ("Bay Plumbing" vs "Bays Plumbing"), and a false link here
      // costs a real contractor their free trial.
      {
        const flat = value
          .toLowerCase()
          .replace(/[^a-z0-9\s]/g, " ")
          .replace(/\b(inc|llc|l l c|ltd|co|corp|company|the)\b/g, " ")
          .replace(/\s+/g, " ")
          .trim();
        return flat.length >= 3 ? flat : null;
      }

    case "parcel":
      // Assessor parcel numbers are written with dashes in some counties and
      // without in others, and the same parcel can arrive either way.
      {
        const flat = value.replace(/[^a-z0-9]/gi, "").toLowerCase();
        return flat.length >= 4 ? flat : null;
      }

    case "ip":
      // Kept whole. A /24 rollup would be a stronger anti-VPN signal and a much
      // worse privacy story (it would link neighbours who have never met), and
      // the score's IP weights are small precisely because carrier NAT makes a
      // shared IP weak evidence anyway.
      return value.toLowerCase();

    default:
      return value.toLowerCase();
  }
}

// Record one signal for one account. Upserts, so a repeat sighting bumps
// last_seen instead of piling up rows, and first_seen keeps saying when this
// account was first seen with this value.
export async function recordSignal(
  userId: string,
  kind: SignalKind,
  rawValue: string | null | undefined,
  context: string
): Promise<void> {
  if (!userId || !rawValue) return;
  const normalized = normalizeSignalValue(kind, String(rawValue));
  if (!normalized) return;

  // No configured RISK_HASH_SALT means no hash, which means NO SIGNAL. There is
  // no repo-constant fallback on purpose (see src/lib/risk/hash.ts): storing an
  // unsalted or weakly-salted hash of somebody's IP address would be worse than
  // storing nothing, and hashing under a rotatable key would silently reset the
  // whole system the day that key is rotated. riskHash has already logged.
  const valueHash = riskHash(kind, normalized);
  if (!valueHash) return;

  try {
    const admin = createAdminClient() as any;
    // first_seen is DELIBERATELY absent from this payload. An upsert only
    // updates the columns it carries, so leaving it out means a brand-new row
    // takes the column default (now()) while a repeat sighting bumps last_seen
    // and leaves first_seen alone. That matters: first_seen is what the "3
    // accounts on this network within 7 days" style questions are measured
    // against, and rewriting it on every request would erase the history.
    const { error } = await admin.from("account_signals").upsert(
      {
        user_id: userId,
        kind,
        value_hash: valueHash,
        salt_version: SALT_VERSION,
        last_seen: new Date().toISOString(),
        context,
      },
      { onConflict: "user_id,kind,value_hash" }
    );
    if (error) {
      console.error("account_signals upsert failed:", error.message ?? error);
    }
  } catch (err) {
    console.error("account_signals upsert threw:", err);
  }
}

// The two signals that ride along on any authenticated request: the network it
// came from and the first-party device cookie the middleware plants.
//
// Callable only from a request context (a server action or a route handler) -
// next/headers throws outside one, which the try/catch turns into a no-op.
export async function recordRequestSignals(
  userId: string,
  context: string
): Promise<void> {
  if (!userId) return;
  try {
    const [h, c] = await Promise.all([headers(), cookies()]);

    // Trusted client IP (src/lib/clientIp.ts): x-vercel-forwarded-for, else
    // the LAST x-forwarded-for hop. The old first-hop read let a client spoof
    // this signal (send your own X-Forwarded-For and every request gets a
    // fresh IP hash, so network-based multi-account linking never fired).
    const ip = clientIpFromHeaders(h);
    const device = c.get(DEVICE_COOKIE)?.value ?? null;
    const fingerprint = c.get(FINGERPRINT_COOKIE)?.value ?? null;

    // The fingerprint is BOUND TO THE DEVICE COOKIE before it is hashed, and is
    // skipped entirely when there is no device cookie to bind it to.
    //
    // hearth_fp is written by page script with document.cookie, so the browser
    // owns it and can put anything it likes there. Stored on its own, that is
    // not merely weak, it is a weapon: an attacker whose own site can read a
    // visitor's five fingerprint attributes could set hearth_fp to a VICTIM's
    // value, burn a few accounts under it, and leave the victim permanently
    // linked to flagged accounts for the price of one link click.
    //
    // hearth_did is httpOnly, so page script cannot read or forge it. Hashing
    // (did || fp) means a forged fp can only ever collide with a value under the
    // SAME device cookie - that is, with the forger's own browser. The victim is
    // unreachable.
    //
    // The honest cost: a fingerprint bound to the device id can no longer
    // survive a cleared cookie jar, which was the one thing it was for. What is
    // left is a corroborating signal worth 10 points next to an IP match (see
    // fingerprintAndIpMatch in src/lib/risk/score.ts), not a device identifier.
    // That is a deliberate trade: a signal that cannot be turned against an
    // innocent user beats a stronger one that can.
    const boundFingerprint =
      device && fingerprint ? `${device}|${fingerprint}` : null;

    await Promise.all([
      recordSignal(userId, "ip", ip, context),
      recordSignal(userId, "device", device, context),
      // Re-hashed server-side even though the browser already hashed it: the
      // client-side hash is unsalted (it has to be - the salt is a server
      // secret), so storing it as-is would put a reversible value in the table.
      recordSignal(userId, "fingerprint", boundFingerprint, context),
    ]);
  } catch (err) {
    console.error("recordRequestSignals failed:", err);
  }
}

// Email signals, at signup. Two rows: the normalized address (the thing that
// actually links two accounts) and the domain.
//
// The domain row carries the disposable verdict in its `context`, because the
// value itself is stored hashed and cannot be re-checked against the throwaway
// list later. src/lib/risk/facts.ts reads it back with a substring check.
export async function recordEmailSignals(
  userId: string,
  email: string | null | undefined,
  context: string
): Promise<void> {
  const parsed = normalizeEmail(email);
  if (!userId || !parsed) return;
  await Promise.all([
    recordSignal(userId, "email_norm", parsed.normalized, context),
    recordSignal(
      userId,
      "email_domain",
      parsed.domain,
      parsed.disposable ? `${context}:disposable` : context
    ),
  ]);
}

// The card fingerprint from Stripe. Stripe's `card.fingerprint` is already a
// stable, opaque id for the underlying card number (same card, same
// fingerprint, across customers), so this never touches a PAN - and it is
// hashed again on our side anyway, so a copy of our table is not a list of
// which Stripe cards we have seen.
export async function recordCardSignal(
  userId: string,
  fingerprint: string | null | undefined,
  context: string
): Promise<void> {
  await recordSignal(userId, "card", fingerprint, context);
}

// Write (or refresh) a confirmed abuse flag. Sticky by design: a signal fades
// as people change phones and IP addresses, but a chargeback or a
// cancelled-inside-the-trial event should keep costing whichever accounts share
// hardware or a card with it.
export async function flagAbuse(
  userId: string,
  kind: "trial_abuse" | "chargeback" | "manual",
  note: string
): Promise<void> {
  if (!userId) return;
  try {
    const admin = createAdminClient() as any;
    const { error } = await admin.from("abuse_flags").upsert(
      {
        user_id: userId,
        kind,
        note: note.slice(0, 500),
        created_at: new Date().toISOString(),
        // Explicitly null, not omitted. There is one row per (user, kind), so
        // a second chargeback UPDATES the row a human previously resolved by
        // stamping cleared_at (migration 0130). Leaving the field out of the
        // payload would leave that old timestamp standing, and
        // has_open_chargeback() reads exactly this column: a repeat offender
        // would come back already un-frozen, which is the opposite of what a
        // repeat event should do. Clearing it re-opens the flag every time the
        // event happens again.
        cleared_at: null,
      },
      { onConflict: "user_id,kind" }
    );
    if (error) {
      console.error("abuse_flags upsert failed:", error.message ?? error);
    }
  } catch (err) {
    console.error("abuse_flags upsert threw:", err);
  }
}
