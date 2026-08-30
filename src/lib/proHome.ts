import { PRO_LEADS_HREF } from "@/lib/constants";
import type { SetupItem } from "@/components/pro/SetupChecklist";

// Shared loaders for the pro side's two tabs. The pro screen split into Home
// (/pro) and Leads (/pro/leads) on 2026-08-29, and both need some of the same
// facts: the setup checklist, how many homeowners are waiting on a reply, and
// which compliance date is about to lapse. Everything here is either a pure
// function over rows the caller already loaded, or one small bounded query, so
// neither page pays for the other's work.
//
// PURE HALF. No Supabase, no server-only, so every sentence and every
// checklist rule can be unit tested without a database. The one query this
// pair needs lives in src/lib/proHomeServer.ts, the same split askLimits.ts /
// aiUsage.ts and freeAiTaste.ts / freeAiTasteServer.ts already use.

// The first-session setup checklist. Pure: every item comes from data both
// pages already load (the contractor row, the wallet, my_applications), so it
// costs nothing extra and hides itself once every step is done.
//
// It used to be built inline on the leads board. Home shows it too now (it is
// the screen a new pro lands on), so it lives here rather than in two copies
// that would drift the first time either got touched.
export function buildSetupItems(input: {
  contractor: any;
  balanceCents: number;
  applicationCount: number;
  // Can this account actually upload a logo? The logo is a Pro-member
  // cosmetic, so for everyone else that step is a door that does not open and
  // is marked optional instead of nagging forever.
  canUploadLogo: boolean;
}): SetupItem[] {
  const { contractor, balanceCents, applicationCount, canUploadLogo } = input;
  const logoDone = Boolean(contractor.logo_url);

  // License state, as the checklist reads it: a number alone is not the finish
  // line, the CSLB saying yes is (license_verified_status, 0037/0055).
  const licenseStatus = contractor.license_verified_status ?? "unverified";
  const licenseFailed =
    Boolean(contractor.license_number) && licenseStatus === "failed";
  // A number on file that is neither confirmed nor refused is waiting on a
  // check this pro cannot hurry along, so it stays visible and unticked but
  // does not hold the whole card open forever (same reasoning as `optional`
  // on the members-only logo step).
  const licenseAwaitingCheck =
    Boolean(contractor.license_number) &&
    licenseStatus !== "verified" &&
    licenseStatus !== "failed";

  return [
    {
      label: "Complete your company profile",
      done: Boolean(contractor.name) && (contractor.categories ?? []).length > 0,
      href: "/pro/profile",
      linkLabel: "Complete profile",
    },
    // Only a CSLB-verified license counts as done. A number that the CSLB
    // refused used to tick this box, which told a pro their license was
    // handled while /pro/profile showed "Not confirmed" on the same row - and
    // left the one step they had to act on looking finished.
    {
      label: licenseFailed ? "License not confirmed" : "Put your license on file",
      done: licenseStatus === "verified",
      href: "/pro/profile",
      linkLabel: licenseFailed ? "Fix license" : "Add license",
      optional: licenseAwaitingCheck,
    },
    // Plain outbound links only (0110). Done as soon as either is on file; no
    // reason to require both. Pros with review links get more quotes accepted,
    // so this comes right after license, ahead of the members-only logo step.
    {
      label: "Add your Yelp or Google reviews link",
      hint: "Pros with review links get more quotes accepted.",
      done: Boolean(contractor.yelp_url) || Boolean(contractor.google_reviews_url),
      href: "/pro/profile#reviews",
      linkLabel: "Add reviews link",
    },
    {
      label: canUploadLogo ? "Upload your logo" : "Upload your logo (Pro)",
      done: logoDone,
      href: canUploadLogo ? "/pro/profile" : "/pro/plus?reason=logo",
      linkLabel: canUploadLogo ? "Add logo" : "See Hearth Pro",
      optional: !canUploadLogo,
    },
    {
      label: "Fund your wallet",
      done: balanceCents > 0,
      href: "/pro/billing",
      linkLabel: "Add funds",
    },
    {
      // The board is on the Leads tab now, so this anchor has to carry the
      // route as well as the hash or it points at whatever page is showing.
      label: "Apply to your first job",
      done: applicationCount > 0,
      href: `${PRO_LEADS_HREF}#open-jobs`,
      linkLabel: "Browse jobs",
    },
  ];
}

// How many days until a stored compliance date lapses, or null when there is
// no date on file / the value cannot be read as one. Negative means it already
// lapsed. Plain UTC date math, because license_expires and insurance_expires
// are Postgres `date` columns with no time or zone on them (the compliance
// cron does the same).
export function daysUntil(
  dateStr: string | null | undefined,
  now: Date = new Date()
): number | null {
  if (!dateStr) return null;
  const t = Date.parse(`${String(dateStr).slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(t)) return null;
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((t - today) / 86_400_000);
}

// How close a renewal has to be before the Home tab says anything. 45 days is
// long enough that a pro can book the CSLB or their broker without rushing,
// short enough that the chip is not permanently on screen.
export const EXPIRY_WARN_DAYS = 45;

export type ExpiryChip = { label: string; href: string; overdue: boolean };

// The license / insurance countdown chips for the Home tab. Pure so the
// wording is testable without a database. Empty array when nothing is close,
// which is the normal case and renders nothing at all.
//
// Both dates are set from the same place, the compliance card inside the
// Account panel on /pro/business, so both chips link there.
export function expiryChips(
  contractor: any,
  now: Date = new Date()
): ExpiryChip[] {
  const chips: ExpiryChip[] = [];
  const rows: Array<{ what: string; value: string | null | undefined }> = [
    { what: "License", value: contractor?.license_expires },
    { what: "Insurance", value: contractor?.insurance_expires },
  ];
  for (const r of rows) {
    const days = daysUntil(r.value, now);
    if (days === null || days > EXPIRY_WARN_DAYS) continue;
    chips.push({
      label:
        days < 0
          ? `${r.what} expired`
          : days === 0
            ? `${r.what} expires today`
            : `${r.what} expires in ${days} day${days === 1 ? "" : "s"}`,
      href: "/pro/business#account",
      overdue: days <= 0,
    });
  }
  return chips;
}

// The one-line subtitle under the Home greeting: what is actually waiting on
// this pro right now, in plain counts, never a slogan. Pure, so the sentence
// can be tested without a database.
export function homeSubtitle(input: {
  openJobs: number;
  awaitingReply: number;
  directRequests: number;
}): string {
  const parts: string[] = [];
  if (input.directRequests > 0) {
    parts.push(
      `${input.directRequests} homeowner${
        input.directRequests === 1 ? "" : "s"
      } asked for you`
    );
  }
  if (input.openJobs > 0) {
    parts.push(
      `${input.openJobs} new job${input.openJobs === 1 ? "" : "s"} in your trades`
    );
  }
  if (input.awaitingReply > 0) {
    parts.push(
      `${input.awaitingReply} homeowner${
        input.awaitingReply === 1 ? "" : "s"
      } waiting on your reply`
    );
  }
  if (!parts.length) return "Nothing waiting on you right now.";
  // Sentence case, commas between, a full stop at the end. No exclamation, no
  // urgency the numbers do not carry on their own.
  const sentence = parts.join(", ");
  return `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`;
}

// "Good morning" / "Good afternoon" / "Good evening" for a given hour. Pure,
// hour injected, so a test does not depend on when it runs.
export function greetingForHour(hour: number): string {
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}
