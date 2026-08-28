import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getPlusTier } from "@/lib/subscription";
import { countAiUsage, refundAiUsage } from "@/lib/aiUsage";
import { reasonToClientPayload } from "@/lib/aiReason";
import { getActiveProperty } from "@/lib/property";
import { labelFor, SYSTEM_TYPES } from "@/lib/constants";
import {
  insuranceRateFor,
  DEFAULT_INSURANCE_RATE,
} from "@/app/(app)/documents/insuranceRates";
import { stateName } from "@/lib/forecast";
import { generateText, hasClaudeKey, isRateLimitError } from "@/lib/claude";

export const runtime = "nodejs";

// Insurance Requote Packet (Hearth Plus): builds a plain-language summary of
// the home from the facts Hearth actually has on file (location, size, age,
// systems and their install years, recent completed maintenance, current
// premium and renewal date) that the owner can hand to insurance agents when
// shopping for quotes. The packet also lists coverage questions to ask and
// what to compare beyond price. The homeowner shares it themselves: Hearth
// never contacts insurers and never promises savings.
//
// Input:  none (everything comes from the active property, so a caller can't
//         feed the model made-up numbers under Hearth's tone)
// Output: { packet } | { packet: null, reason: "no_key" | "rate_limited" | "failed" }

const DAY_MS = 24 * 60 * 60 * 1000;

// How far back "recent" reaches: completed maintenance in the last 12
// months, and systems installed in the last 5 years count as upgrades worth
// mentioning to an insurer (a new roof or water heater often matters).
const RECENT_TASK_MS = 365 * DAY_MS;
const RECENT_INSTALL_YEARS = 5;

const CONDITION_LABEL: Record<number, string> = {
  5: "like new",
  4: "good",
  3: "fair",
  2: "worn",
  1: "failing",
};

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

// Format YYYY-MM-DD as "Mar 5, 2027" without Date-parsing the bare string
// (which JS treats as UTC and can shift a day).
function fmtDate(d: string): string {
  const m = d.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return d;
  const mon = MONTHS[Number(m[2]) - 1];
  return mon ? `${mon} ${Number(m[3])}, ${m[1]}` : d;
}

export async function POST() {
  // Require a signed-in user before touching the paid model.
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Plus-only, no free taste here: the renewal reminder and the state
  // context line are the free part. The tier (not the boolean) so the daily
  // ceiling below can give a trial its own, smaller budget - see PlusTier in
  // src/lib/subscription.ts.
  const tier = await getPlusTier();
  const isPlus = tier !== "free";
  if (!isPlus) {
    return NextResponse.json({ error: "plus_required" }, { status: 403 });
  }

  const property = await getActiveProperty();
  if (!property) {
    return NextResponse.json({ error: "No home on file." }, { status: 400 });
  }

  // insurance_renewal_date and insurance_premium are migration 0040 columns
  // not in the generated types yet, so read them off the row with a cast,
  // same as the documents page.
  const raw = property as any;
  const premium: number | null =
    typeof raw.insurance_premium === "number" ? raw.insurance_premium : null;
  const renewalDate: string | null =
    typeof raw.insurance_renewal_date === "string"
      ? raw.insurance_renewal_date
      : null;

  if (premium == null || renewalDate == null) {
    return NextResponse.json(
      {
        error:
          "Save your renewal date and premium on the documents page first.",
      },
      { status: 400 }
    );
  }

  if (!hasClaudeKey()) {
    return NextResponse.json({ packet: null, reason: "no_key" });
  }

  // Same per-user daily cap as /api/ask, /api/analyze-quote, and
  // /api/tax-appeal (same ai_usage table and limits), so this route can't be
  // a side door around the abuse limits on the paid model.
  // "rate_limited" is reserved for a REAL limit (this owner's daily cap, or
  // the owner-wide spend breaker). A counter that could not be read is not a
  // limit, and telling someone they hit a usage limit they never touched
  // sends them looking for an upgrade that would not help.
  const { overLimit, reason } = await countAiUsage(user.id, tier);
  if (overLimit) {
    // One mapping for every counter refusal, so a burst window reads as "give
    // it a minute" instead of "you are out for the day". See
    // src/lib/aiReason.ts.
    return NextResponse.json({
      packet: null,
      ...reasonToClientPayload(reason),
    });
  }

  // The home's real data: systems with install years, and maintenance
  // completed in the last year. RLS covers both reads (owner's own rows).
  const [{ data: systems }, { data: doneTasks }] = await Promise.all([
    supabase
      .from("home_systems")
      .select("system_type, material_or_model, install_year, condition_rating")
      .eq("property_id", property.id)
      .order("system_type", { ascending: true }),
    supabase
      .from("maintenance_tasks")
      .select("title, completed_at")
      .eq("property_id", property.id)
      .eq("status", "done")
      .gte("completed_at", new Date(Date.now() - RECENT_TASK_MS).toISOString())
      .order("completed_at", { ascending: false })
      .limit(10),
  ]);

  const currentYear = new Date().getFullYear();

  // Only facts Hearth actually has. Anything else the packet needs becomes a
  // bracketed placeholder the owner fills in.
  const facts: string[] = [];
  if (property.city || property.state) {
    facts.push(
      `Home location: ${[property.city, property.state]
        .filter(Boolean)
        .join(", ")}`
    );
  }
  if (property.year_built) facts.push(`Year built: ${property.year_built}`);
  if (property.sqft) facts.push(`Square footage: ${property.sqft}`);
  if (property.beds) facts.push(`Bedrooms: ${property.beds}`);
  if (property.baths) facts.push(`Bathrooms: ${property.baths}`);
  facts.push(
    `Current annual premium: $${premium.toLocaleString()} (owner-entered from their policy)`
  );
  facts.push(`Policy renewal date: ${fmtDate(renewalDate)}`);

  for (const s of systems ?? []) {
    const bits = [
      s.material_or_model || null,
      s.install_year
        ? `installed ${s.install_year}${
            currentYear - s.install_year <= RECENT_INSTALL_YEARS
              ? " (recent update)"
              : ""
          }`
        : null,
      s.condition_rating
        ? `condition ${CONDITION_LABEL[s.condition_rating] ?? "unknown"}`
        : null,
    ].filter(Boolean);
    facts.push(
      `System, ${labelFor(SYSTEM_TYPES, s.system_type)}: ${
        bits.length > 0 ? bits.join(", ") : "on file, no details recorded"
      }`
    );
  }

  for (const t of doneTasks ?? []) {
    facts.push(
      `Maintenance completed in the last year: ${t.title}${
        t.completed_at
          ? ` (${new Date(t.completed_at).toLocaleDateString("en-US", {
              year: "numeric",
              month: "short",
            })})`
          : ""
      }`
    );
  }

  // The state trend gives the packet honest context, clearly framed as an
  // approximation of published averages, never as this owner's benchmark.
  const rate = insuranceRateFor(property.state);
  const region =
    rate === DEFAULT_INSURANCE_RATE ? null : stateName(property.state);
  facts.push(
    `Approximate premium context (static approximation of published industry averages, not a quote): the average annual premium ${
      region ? `in ${region}` : "nationally"
    } is roughly $${rate.avgPremium.toLocaleString()}, up about ${
      rate.trendPct
    }% last year`
  );

  const instruction =
    "You build a home insurance requote packet: a plain language summary a homeowner can hand to insurance agents while shopping for quotes before their policy renews. " +
    "Write it from the homeowner's point of view, warm and plain, in complete sentences a person would actually send to an agent. " +
    "Structure it with these plain text section headings on their own lines: Home facts. Recent maintenance and upgrades. Current coverage. Questions to ask each agent. What to compare beyond price. " +
    "Under Home facts, summarize the home from the facts provided: location, age, size, and the major systems with their install years and condition where known. " +
    "Under Recent maintenance and upgrades, highlight recently installed systems and completed maintenance from the facts, since newer roofs, systems, and steady upkeep are exactly what agents ask about. If none were provided, say the owner can list any recent work here. " +
    "Under Current coverage, state the current premium and renewal date from the facts, and use bracketed placeholders such as [Current coverage limit], [Current deductible], and [Current insurer] for the policy details you were not given, so the owner can fill them in from their declarations page. " +
    "Under Questions to ask each agent, list practical coverage questions in plain sentences: replacement cost versus actual cash value, dwelling coverage limits, deductibles including wind or hail if relevant to the region, water backup, and available discounts for the updates listed. " +
    "Under What to compare beyond price, explain in a few sentences what matters besides the premium: matching coverage limits and deductibles across quotes, claim handling reputation, and exclusions. " +
    "Use only the facts provided. Never invent coverage details, claim history, quotes, discounts, or any other facts: where information is missing, use a clearly bracketed placeholder instead. " +
    "Before finishing, re-read the packet and confirm every figure, date, and system detail in it exactly matches the facts you were given, replacing anything not provided with a bracketed placeholder rather than an invented value. " +
    "Never promise or predict savings, and never say the owner is overpaying: shopping around is worth checking, nothing more. " +
    "Do not give legal or financial advice, and do not recommend specific insurers. " +
    "Keep the whole packet under 450 words. " +
    "Output only the packet text itself, with no commentary before or after it. " +
    "Never use an em dash or a hyphen as a connector: use a comma, a colon, or a new sentence instead.";

  try {
    // A structured long-form document built strictly from a fact list, where
    // "use a bracketed placeholder rather than invent a figure" has to hold
    // across five sections: worth the reasoning.
    const { text, stopReason } = await generateText({
      system: instruction,
      prompt:
        "Build the requote packet from these facts about my home:\n\n" +
        facts.map((f) => `- ${f}`).join("\n"),
      maxTokens: 8000,
      thinking: true,
      // Reasoning plus a long structured document: this is a slow call the
      // owner is watching a progress bar for. An explicit ceiling, like the
      // other document routes, so a hung request fails on our clock rather
      // than the platform's.
      timeoutMs: 120_000,
      label: "insurance-packet",
    });
    // TRUNCATED IS NOT DONE. A packet that ran out of output budget stops
    // mid-sentence, usually somewhere in the middle of the coverage questions,
    // and it looks finished enough that someone would hand it to an agent
    // with two sections missing. Say so instead of returning the stump.
    if (stopReason === "max_tokens") {
      return NextResponse.json({
        packet: null,
        reason: "too_long",
        error:
          "That packet ran long and got cut off. Try again, or trim some detail from your home record first.",
      });
    }
    if (text) return NextResponse.json({ packet: text });
    return NextResponse.json({ packet: null, reason: "failed" });
  } catch (e) {
    // The owner was already charged one of today's usages above; a thrown
    // model call never produced a packet, so hand it back rather than
    // spending their allowance on a request that failed before it reached
    // them.
    await refundAiUsage(user.id);
    return NextResponse.json({
      packet: null,
      reason: isRateLimitError(e) ? "rate_limited" : "failed",
    });
  }
}
