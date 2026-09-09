import { timingSafeEqual } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendNotification } from "@/lib/notify";

export const runtime = "nodejs";

// Daily job (Vercel Cron, see vercel.json) that reminds a pro before their
// contractor license or certificate of insurance lapses. OakTend only ever
// read a date off the document the pro uploaded (see /api/pro-compliance):
// this cron never claims to have verified anything, it just watches the
// dates already on file and nudges.
//
// The weekly pro digest already carries the advance notice, surfacing any
// renewal within 30 days every Tuesday. So this standalone cron only covers
// the last week and the lapse itself: it nudges once at 7 days out, and
// once the date has passed, instead of duplicating the digest's earlier
// heads-up at 60, 30, and 14 days.
//
// Noise control. One notification per contractor per document per
// threshold: the dup guard is keyed to the document's kind, its exact expiry
// date, and the threshold crossed, so a notification with that exact url
// already existing for the owner means this exact reminder was already
// sent, forever. A renewed document carries a new expiry date, so the guard
// re-arms on its own without any extra bookkeeping (same
// once-per-key-forever pattern as the insurance-renewal cron). Thresholds
// are also matched on the exact day out, so a single missed run just skips
// that one reminder; the past due bucket still fires later.

const THRESHOLDS = [7];
const HORIZON_DAYS = Math.max(...THRESHOLDS);
const MAX_CONTRACTORS = 500; // cap the work a single run does per document kind

// Lower bound on the candidate scan. The overdue nudge fires once, shortly
// after an expiry crosses zero, so a document more than a couple of weeks
// past its date has already had its reminder (or missed its window) and can
// safely drop out of the daily scan. Without this floor, never-renewed
// churned pros would accumulate at the FRONT of the ascending-ordered,
// capped window forever and eventually starve current pros' 7-day and
// expiry-day reminders. Two weeks still tolerates a stretch of missed runs.
const OVERDUE_GRACE_DAYS = 14;

const DAY_MS = 24 * 60 * 60 * 1000;

// PostgREST silently truncates every response at its max-rows cap (default
// 1000 rows). The primary queries below are explicitly ordered (soonest
// expiry first) and capped well under that limit; the follow-up user lookups
// are chunked .in() calls, and the dup guard is a per-candidate exact query,
// never a bulk read that could be truncated.
const QUERY_CHUNK = 200;
const SEND_CHUNK = 20;

function isAuthorized(req: NextRequest): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;
  // Vercel Cron automatically sends "Authorization: Bearer <CRON_SECRET>" when
  // the CRON_SECRET env var is set. Also accept an explicit x-cron-secret header
  // for manual runs / other schedulers.
  const auth = req.headers.get("authorization");
  const bearer = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
  const provided = bearer ?? req.headers.get("x-cron-secret");
  if (!provided) return false;
  // Constant-time compare (mirrors src/lib/checkr.ts / the twilio inbound
  // webhook): only call timingSafeEqual once both buffers are a confirmed
  // equal length, since it throws on a length mismatch.
  const providedBuf = Buffer.from(provided, "utf8");
  const expectedBuf = Buffer.from(expected, "utf8");
  if (providedBuf.length !== expectedBuf.length) return false;
  try {
    return timingSafeEqual(providedBuf, expectedBuf);
  } catch {
    return false;
  }
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// Date-only math in UTC, since license_expires/insurance_expires are plain
// date columns (same approach as the maintenance-reminders cron).
function utcTodayMs(): number {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

function daysFromToday(dateStr: string): number {
  const due = new Date(`${dateStr}T00:00:00Z`).getTime();
  return Math.round((due - utcTodayMs()) / DAY_MS);
}

function fmtDate(d: string): string {
  return new Date(`${d}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

// Which reminder bucket (if any) today's gap matches: one of the four
// lookahead thresholds, exactly, or "overdue" for anything at or past zero.
function bucketFor(diffDays: number): string | null {
  if (diffDays <= 0) return "overdue";
  return THRESHOLDS.includes(diffDays) ? String(diffDays) : null;
}

const DOC_LABEL: Record<"license" | "insurance", string> = {
  license: "contractor license",
  insurance: "certificate of insurance",
};

function titleFor(
  kind: "license" | "insurance",
  diffDays: number,
  expires: string
): string {
  const label = DOC_LABEL[kind];
  if (diffDays > 0) {
    return `Your ${label} expires in ${diffDays} day${
      diffDays === 1 ? "" : "s"
    }, on ${fmtDate(expires)}`;
  }
  if (diffDays === 0) return `Your ${label} expires today`;
  const overdue = Math.abs(diffDays);
  return `Your ${label} expired ${overdue} day${overdue === 1 ? "" : "s"} ago`;
}

type ContractorRow = {
  id: string;
  user_id: string | null;
  license_expires?: string | null;
  insurance_expires?: string | null;
};

type Reminder = {
  userId: string;
  kind: "license" | "insurance";
  expires: string;
  bucket: string;
  title: string;
};

async function runCron(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const supabase = createAdminClient();
  const horizonStr = new Date(utcTodayMs() + HORIZON_DAYS * DAY_MS)
    .toISOString()
    .slice(0, 10);
  const floorStr = new Date(utcTodayMs() - OVERDUE_GRACE_DAYS * DAY_MS)
    .toISOString()
    .slice(0, 10);

  // license_expires is a migration 0051 column not yet in the generated
  // types, so both queries go through a cast. Soonest expiry first so the
  // recipient set stays stable if a run hits the cap; bounded below at
  // OVERDUE_GRACE_DAYS so long-expired rows can't consume the window (see
  // the constant's comment). If the migration hasn't run yet, Postgres
  // rejects the select: log and exit cleanly.
  const [{ data: rawLicense, error: licenseError }, { data: rawInsurance, error: insuranceError }] =
    await Promise.all([
      (supabase.from("contractors") as any)
        .select("id, user_id, license_expires")
        .not("license_expires", "is", null)
        .gte("license_expires", floorStr)
        .lte("license_expires", horizonStr)
        .order("license_expires", { ascending: true })
        .limit(MAX_CONTRACTORS),
      (supabase.from("contractors") as any)
        .select("id, user_id, insurance_expires")
        .not("insurance_expires", "is", null)
        .gte("insurance_expires", floorStr)
        .lte("insurance_expires", horizonStr)
        .order("insurance_expires", { ascending: true })
        .limit(MAX_CONTRACTORS),
    ]);

  if (licenseError || insuranceError) {
    console.error(
      "pro-compliance cron: contractors query failed (has migration 0051 run?):",
      licenseError?.message ?? insuranceError?.message
    );
    return NextResponse.json(
      {
        checked: 0,
        notified: 0,
        error: licenseError?.message ?? insuranceError?.message,
      },
      { status: 200 }
    );
  }

  const candidates: { row: ContractorRow; kind: "license" | "insurance" }[] = [
    ...((rawLicense ?? []) as ContractorRow[]).map((row) => ({
      row,
      kind: "license" as const,
    })),
    ...((rawInsurance ?? []) as ContractorRow[]).map((row) => ({
      row,
      kind: "insurance" as const,
    })),
  ];

  let checked = 0;
  const reminders: Reminder[] = [];
  for (const { row, kind } of candidates) {
    checked += 1;
    if (!row.user_id) continue;
    const expires = kind === "license" ? row.license_expires : row.insurance_expires;
    if (!expires) continue;
    const diffDays = daysFromToday(expires);
    const bucket = bucketFor(diffDays);
    if (!bucket) continue;
    reminders.push({
      userId: row.user_id,
      kind,
      expires,
      bucket,
      title: titleFor(kind, diffDays, expires),
    });
  }

  if (reminders.length === 0) {
    return NextResponse.json({ checked, notified: 0 });
  }

  // Contact details, so email/SMS can fire once providers are configured.
  const userIds = Array.from(new Set(reminders.map((r) => r.userId)));
  const userById = new Map<
    string,
    {
      id: string;
      email: string | null;
      phone: string | null;
      sms_consent: boolean | null;
      notification_prefs: any;
    }
  >();
  for (const ids of chunk(userIds, QUERY_CHUNK)) {
    const { data: users } = await supabase
      .from("users")
      .select("id, email, phone, sms_consent, notification_prefs")
      .in("id", ids)
      .order("id", { ascending: true });
    for (const u of users ?? []) userById.set(u.id, u);
  }

  let notified = 0;
  for (const batch of chunk(reminders, SEND_CHUNK)) {
    await Promise.all(
      batch.map(async (r) => {
        try {
          const contact = userById.get(r.userId);
          if (!contact) return;
          // An unset preference reads as enabled, matching NotificationPrefsForm.
          if (contact.notification_prefs?.reminders === false) return;

          const url = `/pro/business?compliance=${r.kind}&expires=${r.expires}&threshold=${r.bucket}`;
          const notifKind = `pro_compliance_${r.kind}`;

          // Dup guard, keyed to the document, its exact expiry date, and the
          // threshold crossed. If a notification with this exact url exists
          // for this owner, EVER, this reminder was already sent.
          const { data: existing } = await supabase
            .from("notifications")
            .select("id")
            .eq("user_id", r.userId)
            .eq("kind", notifKind)
            .eq("url", url)
            .limit(1)
            .maybeSingle();
          if (existing) return;

          const sent = await sendNotification(supabase, {
            userId: r.userId,
            kind: notifKind,
            title: r.title,
            body: "Upload a renewed document on your Business page to keep this reminder current.",
            url,
            email: contact.email,
            phone: contact.phone,
            smsConsent: contact.sms_consent === true,
          });
          if (sent) notified += 1;
        } catch {
          // One failed send shouldn't stop the rest of the batch.
        }
      })
    );
  }

  return NextResponse.json({ checked, notified });
}

export async function POST(req: NextRequest) {
  return runCron(req);
}

export async function GET(req: NextRequest) {
  return runCron(req);
}
