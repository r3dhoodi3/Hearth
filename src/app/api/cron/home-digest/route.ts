import { timingSafeEqual } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendNotification } from "@/lib/notify";
import { headlineHomeValue, calculateEquity } from "@/lib/homeValue";
import { assessSystem, scoreBreakdown, scoreBand } from "@/lib/health";
import { labelFor, SYSTEM_TYPES } from "@/lib/constants";
import { formatAddressLine } from "@/lib/addressLine";
import type { HomeSystem, Issue, Property } from "@/lib/database.types";

export const runtime = "nodejs";

// Monthly job (Vercel Cron, see vercel.json) that sends every homeowner ONE
// email covering ALL of their properties: a short factual check-in per home,
// composed entirely from data they already entered: the estimated home value
// (if they set a purchase price and year), the home health score and its
// band (if they have systems on file), how many open maintenance tasks come
// due in the next month, and up to two systems whose age says they are due
// for attention. Only sections with data appear, a property with nothing to
// say gets no section, and an owner whose properties all have nothing to say
// gets no digest at all: no filler, no urgency. An owner with several
// properties gets one email with one short block per property, not one email
// per property, so digest volume never multiplies with portfolio size.
//
// Noise control: at most one digest per owner per run, and a dup guard (same
// kind written in the last 25 days) makes an accidental second run a no-op
// while never suppressing next month's legitimate digest.

const MAX_PROPERTY_ROWS = 2000; // cap the work a single run does

// PostgREST caps every response at its max-rows setting (1000 in
// supabase/config.toml), silently, regardless of a larger .limit(). The
// property scan therefore pages with .range() in cap-sized steps up to
// MAX_PROPERTY_ROWS instead of asking for MAX_PROPERTY_ROWS rows in one
// call, which would return the same oldest 1000 forever and permanently skip
// everyone after. This bounds property ROWS scanned per run, not owners: a
// portfolio of several properties spends several rows of this budget, so the
// number of distinct owners covered in one run is at most MAX_PROPERTY_ROWS,
// usually fewer.
const PROPERTY_PAGE = 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

// Open tasks due inside this window count toward the "coming due" line.
const TASK_WINDOW_DAYS = 31;

// Dup-guard lookback. Shorter than a month so a scheduler that fires a bit
// early never suppresses next month's legitimate digest.
const DUP_GUARD_MS = 25 * DAY_MS;

const DIGEST_KIND = "home_digest";
const DIGEST_URL = "/dashboard";

// Closing line on every digest that actually goes out: word of mouth (a
// neighbor tip) is how most homeowners find Hearth in the first place, and
// the check-in is a warm, non-salesy moment to ask. One sentence, no reward.
// Skipped entirely when NEXT_PUBLIC_SITE_URL is unset: a digest inviting
// people to "localhost:3000" would be worse than no invitation at all.
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL;
const NEIGHBOR_LINE = SITE_URL
  ? `Know a neighbor who'd want this kind of heads-up about their home? Send them to ${SITE_URL}.`
  : null;

// PostgREST silently truncates every response at its max-rows cap (default
// 1000 rows), so an unbounded .in() fetch can quietly drop rows. Property
// chunks of 25 keep the per-property child queries (systems, open issues,
// soon-due tasks) comfortably under the cap even for well-stocked homes, and
// explicit .order() makes any residual truncation deterministic (a digest
// sentence goes missing) instead of arbitrary.
const QUERY_CHUNK = 25;
// Keep Promise.all fan-out bounded.
const SEND_CHUNK = 20;

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

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

function plural(n: number, word: string): string {
  return n === 1 ? `${n} ${word}` : `${n} ${word}s`;
}

function usd(n: number): string {
  return `$${Math.round(n).toLocaleString("en-US")}`;
}

async function runCron(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const supabase = createAdminClient();
  const now = new Date();
  const nowMs = now.getTime();
  const currentYear = now.getFullYear();
  const monthName = MONTH_NAMES[now.getMonth()];
  const digestTitle = `Your ${monthName} home check-in`;

  // Oldest properties first (with an id tiebreak so pages never skip or
  // repeat rows) and paged in PROPERTY_PAGE steps to respect the PostgREST
  // max-rows cap; see the constant's comment. purchase_price and
  // mortgage_balance are columns from migration 0029 that are not in
  // src/lib/database.types.ts, so they are read off the row with a cast
  // below (same pattern as the /value page) rather than widening the
  // generated types by hand.
  const rawProperties: Property[] = [];
  for (let start = 0; start < MAX_PROPERTY_ROWS; start += PROPERTY_PAGE) {
    const end = Math.min(start + PROPERTY_PAGE, MAX_PROPERTY_ROWS) - 1;
    const { data: propertyPage, error: propertiesError } = await supabase
      .from("properties")
      .select("*")
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(start, end);
    if (propertiesError) {
      return NextResponse.json(
        { checked: 0, notified: 0, error: propertiesError.message },
        { status: 200 }
      );
    }
    rawProperties.push(...(propertyPage ?? []));
    // A short page means the table is exhausted.
    if (!propertyPage || propertyPage.length < end - start + 1) break;
  }

  // Group every property under its owner (a multi-property owner gets all of
  // them, not just the oldest) so the digest built below can cover the whole
  // portfolio in one email. rawProperties is already ordered oldest-first,
  // so each owner's list stays in that order too.
  type PropertyRow = Property;
  const propertiesByOwner = new Map<string, PropertyRow[]>();
  for (const p of rawProperties ?? []) {
    if (!p.user_id) continue;
    const list = propertiesByOwner.get(p.user_id) ?? [];
    list.push(p);
    propertiesByOwner.set(p.user_id, list);
  }
  const owners = Array.from(propertiesByOwner.keys());
  if (owners.length === 0) {
    return NextResponse.json({ checked: 0, notified: 0 });
  }

  // Dup guard: anyone who already got a digest in the last 25 days (e.g. the
  // cron ran twice) is skipped.
  const guardCutoff = new Date(nowMs - DUP_GUARD_MS).toISOString();
  const alreadyNotified = new Set<string>();
  for (const ids of chunk(owners, QUERY_CHUNK)) {
    const { data: recent } = await supabase
      .from("notifications")
      .select("user_id")
      .in("user_id", ids)
      .eq("kind", DIGEST_KIND)
      .gte("created_at", guardCutoff)
      .order("created_at", { ascending: false });
    for (const r of recent ?? []) alreadyNotified.add(r.user_id);
  }

  // Pull systems, open issues, and soon-due open tasks for every property of
  // every owner that can still receive a digest, grouped by property.
  const activePropertyIds = owners
    .filter((o) => !alreadyNotified.has(o))
    .flatMap((o) => propertiesByOwner.get(o)!.map((p) => p.id));

  const systemsByProperty = new Map<string, HomeSystem[]>();
  const issuesByProperty = new Map<string, Issue[]>();
  const dueTasksByProperty = new Map<string, number>();

  const todayIso = now.toISOString().slice(0, 10);
  const taskHorizonIso = new Date(nowMs + TASK_WINDOW_DAYS * DAY_MS)
    .toISOString()
    .slice(0, 10);

  for (const ids of chunk(activePropertyIds, QUERY_CHUNK)) {
    const { data: systems } = await supabase
      .from("home_systems")
      .select("*")
      .in("property_id", ids)
      .order("property_id", { ascending: true })
      .order("created_at", { ascending: true });
    for (const s of systems ?? []) {
      const list = systemsByProperty.get(s.property_id) ?? [];
      list.push(s);
      systemsByProperty.set(s.property_id, list);
    }

    const { data: issues } = await supabase
      .from("issues")
      .select("*")
      .in("property_id", ids)
      .eq("status", "open")
      .order("property_id", { ascending: true })
      .order("created_at", { ascending: true });
    for (const i of issues ?? []) {
      const list = issuesByProperty.get(i.property_id) ?? [];
      list.push(i);
      issuesByProperty.set(i.property_id, list);
    }

    // "Coming due" means dated open tasks due between today and the horizon;
    // overdue tasks already get their own reminders (maintenance-reminders).
    const { data: tasks } = await supabase
      .from("maintenance_tasks")
      .select("property_id")
      .in("property_id", ids)
      .eq("status", "open")
      .not("due_date", "is", null)
      .gte("due_date", todayIso)
      .lte("due_date", taskHorizonIso)
      .order("property_id", { ascending: true })
      .order("due_date", { ascending: true });
    for (const t of tasks ?? []) {
      dueTasksByProperty.set(
        t.property_id,
        (dueTasksByProperty.get(t.property_id) ?? 0) + 1
      );
    }
  }

  // Build each owner's digest: 2-4 short factual sentences per property,
  // only the sections a property actually has data for. checked counts
  // owners (one row per Map entry below), matching MAX_PROPERTY_ROWS /
  // QUERY_CHUNK / SEND_CHUNK, which all bound work per owner or per property
  // row, never per digest.
  let checked = 0;
  const digests: { userId: string; body: string }[] = [];

  for (const [userId, properties] of propertiesByOwner) {
    try {
      checked += 1;
      if (alreadyNotified.has(userId)) continue;

      // parts per property, skipping any property with nothing to say.
      const propertyParts: { property: PropertyRow; parts: string[] }[] = [];

      for (const property of properties) {
        const raw = property as any;
        const purchasePrice: number | null =
          typeof raw.purchase_price === "number" ? raw.purchase_price : null;
        const mortgageBalance: number | null =
          typeof raw.mortgage_balance === "number"
            ? raw.mortgage_balance
            : null;
        const purchaseYear: number | null = property.purchase_date
          ? Number(property.purchase_date.slice(0, 4)) || null
          : null;

        const systems = systemsByProperty.get(property.id) ?? [];
        const openIssues = issuesByProperty.get(property.id) ?? [];
        const dueTasks = dueTasksByProperty.get(property.id) ?? 0;

        const parts: string[] = [];

        // Estimated value (and equity when a balance is on file). A negative
        // equity number is real but a one-line digest is the wrong place to
        // break it, so the equity clause only appears when it is positive.
        if (purchasePrice && purchaseYear) {
          // The same shared chooser the dashboard tile, /value and /taxes use
          // (headlineHomeValue in src/lib/homeValue.ts): the stored RentCast
          // AVM when one has landed for this address, otherwise the capped
          // purchase-price model. This job used to call estimateHomeValue
          // directly, so a monthly email could quote a number the owner would
          // not find anywhere in the app when they clicked through.
          //
          // Non-null by construction: both purchasePrice and purchaseYear are
          // truthy here, which is the fallback's only requirement.
          const value = headlineHomeValue({
            marketValue:
              typeof raw.market_value === "number" ? raw.market_value : null,
            marketValueLow:
              typeof raw.market_value_low === "number"
                ? raw.market_value_low
                : null,
            marketValueHigh:
              typeof raw.market_value_high === "number"
                ? raw.market_value_high
                : null,
            purchasePrice,
            purchaseYear,
            state: property.state,
            currentYear,
          })!.value;
          const equity = calculateEquity(value, mortgageBalance);
          parts.push(
            mortgageBalance !== null && equity > 0
              ? `Your home's estimated value is ${usd(value)}, about ${usd(
                  equity
                )} of it equity.`
              : `Your home's estimated value is ${usd(value)}.`
          );
        }

        // Health score, only meaningful once they have systems on file.
        if (systems.length > 0) {
          const { score } = scoreBreakdown(systems, openIssues);
          parts.push(
            `Your home health score is ${score} (${scoreBand(
              score
            ).label.toLowerCase()}).`
          );
        }

        if (dueTasks > 0) {
          parts.push(
            `You have ${plural(
              dueTasks,
              "maintenance task"
            )} coming due in the next month.`
          );
        }

        // Up to two systems whose age says they are due for attention.
        const dueSystems = systems
          .filter((s) => assessSystem(s).stage === "due")
          .slice(0, 2)
          .map((s) => labelFor(SYSTEM_TYPES, s.system_type).toLowerCase());
        if (dueSystems.length === 1) {
          parts.push(`Your ${dueSystems[0]} is due for attention.`);
        } else if (dueSystems.length === 2) {
          parts.push(
            `Your ${dueSystems[0]} and ${dueSystems[1]} are due for attention.`
          );
        }

        if (parts.length > 0) propertyParts.push({ property, parts });
      }

      // Nothing to say for any property, nothing sent.
      if (propertyParts.length === 0) continue;

      let body: string;
      if (properties.length === 1) {
        // Single-home owner: identical shape to before multi-property
        // support existed, one space-joined paragraph.
        const parts = propertyParts[0].parts;
        if (NEIGHBOR_LINE) parts.push(NEIGHBOR_LINE);
        body = parts.join(" ");
      } else {
        // Multi-property owner: one email, one short section per property
        // (address as the header) so it reads as a portfolio check-in
        // instead of a wall of undifferentiated sentences.
        //
        // formatAddressLine, not address_line1: the header is the ONE thing
        // telling these sections apart, and a landlord with two units in the
        // same building would otherwise get the identical street line twice
        // with no way to tell which home each block is about. Safe on a DB
        // that has not run 0127 - a row with no unit key formats as the plain
        // street line.
        const sections = propertyParts.map(
          ({ property, parts }) =>
            `${formatAddressLine(property)}: ${parts.join(" ")}`
        );
        if (NEIGHBOR_LINE) sections.push(NEIGHBOR_LINE);
        body = sections.join("\n\n");
      }

      digests.push({ userId, body });
    } catch {
      // One bad property shouldn't stop the rest of the run.
      continue;
    }
  }

  if (digests.length === 0) {
    return NextResponse.json({ checked, notified: 0 });
  }

  // Contact details so the email/SMS channels can fire once their providers
  // are configured (same pattern as the pro weekly digest).
  const userById = new Map<
    string,
    { id: string; email: string | null; phone: string | null; sms_consent: boolean | null }
  >();
  for (const ids of chunk(digests.map((d) => d.userId), QUERY_CHUNK)) {
    const { data: users } = await supabase
      .from("users")
      .select("id, email, phone, sms_consent")
      .in("id", ids)
      .order("id", { ascending: true });
    for (const u of users ?? []) userById.set(u.id, u);
  }

  // Send in bounded parallel batches.
  let notified = 0;
  for (const batch of chunk(digests, SEND_CHUNK)) {
    await Promise.all(
      batch.map(async (d) => {
        try {
          const contact = userById.get(d.userId);
          const sent = await sendNotification(supabase, {
            userId: d.userId,
            kind: DIGEST_KIND,
            title: digestTitle,
            body: d.body,
            url: DIGEST_URL,
            email: contact?.email ?? null,
            phone: contact?.phone ?? null,
            smsConsent: contact?.sms_consent === true,
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
