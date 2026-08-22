import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { hasPlus } from "@/lib/subscription";
import { countAiUsage } from "@/lib/aiUsage";
import { getActiveProperty } from "@/lib/property";
import { estimateHomeValue } from "@/lib/homeValue";

export const runtime = "nodejs";

// Property Tax Appeal Kit (Hearth Plus): drafts a county-generic appeal
// letter from the home's facts on file. The homeowner reviews it, fills in
// the placeholders (parcel number, comparable sales, the county's address),
// and files it themselves: Hearth never files anything and never promises an
// outcome.
//
// Input:  none (everything comes from the active property, so a caller can't
//         feed the model made-up numbers under Hearth's letterhead tone)
// Output: { letter } | { letter: null, reason: "no_key" | "rate_limited" | "failed" }

const MODELS = [
  "gemini-2.5-flash",
  "gemini-flash-latest",
  "gemini-2.5-flash-lite",
  "gemini-2.0-flash",
];

export async function POST() {
  // Require a signed-in user before touching the paid model.
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Plus-only, no free taste here: the comparison itself is the free part.
  const isPlus = await hasPlus();
  if (!isPlus) {
    return NextResponse.json({ error: "plus_required" }, { status: 403 });
  }

  const property = await getActiveProperty();
  if (!property) {
    return NextResponse.json({ error: "No home on file." }, { status: 400 });
  }

  // assessed_value/assessed_year (migration 0039) and purchase_price (0029)
  // are not in the generated types yet, so read them off the row with a cast,
  // same as the /taxes page.
  const raw = property as any;
  const assessedValue: number | null =
    typeof raw.assessed_value === "number" ? raw.assessed_value : null;
  const assessedYear: number | null =
    typeof raw.assessed_year === "number" ? raw.assessed_year : null;
  const purchasePrice: number | null =
    typeof raw.purchase_price === "number" ? raw.purchase_price : null;
  const purchaseYear: number | null = property.purchase_date
    ? Number(property.purchase_date.slice(0, 4)) || null
    : null;

  if (assessedValue == null || assessedYear == null) {
    return NextResponse.json(
      { error: "Save your assessment on the taxes page first." },
      { status: 400 }
    );
  }
  if (purchasePrice == null || purchaseYear == null) {
    return NextResponse.json(
      { error: "Set up your home value first so the letter has an estimate to cite." },
      { status: 400 }
    );
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ letter: null, reason: "no_key" });
  }

  // Same per-user daily cap as /api/ask and /api/analyze-quote (same ai_usage
  // table and limits), so this route can't be a side door around the abuse
  // limits on the paid model.
  const { overLimit } = await countAiUsage(user.id, isPlus);
  if (overLimit) {
    return NextResponse.json({ letter: null, reason: "rate_limited" });
  }

  const currentYear = new Date().getFullYear();
  const estimatedValue = estimateHomeValue(
    purchasePrice,
    purchaseYear,
    property.state,
    currentYear
  );

  // CALIFORNIA (Prop 13): the /taxes page judges a CA assessment against the
  // purchase price compounded at the 2%/yr Prop 13 cap, NOT against market
  // value, because a long-held CA home is supposed to be assessed far below
  // market. The letter must argue over the same basis: citing Hearth's market
  // estimate (often a multiple of the assessment) would refute the letter's
  // own claim. Same formula as the prop13Baseline in
  // src/app/(app)/taxes/page.tsx; if one changes, change the other.
  const prop13Baseline =
    property.state?.toUpperCase() === "CA"
      ? Math.round(
          purchasePrice * Math.pow(1.02, Math.max(0, assessedYear - purchaseYear))
        )
      : null;

  // The number the letter's over-assessment claim is measured against: the
  // Prop 13 trajectory in CA, Hearth's market estimate everywhere else
  // (mirroring the /taxes verdict).
  const comparisonBasis = prop13Baseline ?? estimatedValue;

  // Never draft a letter whose central claim is false: if the assessment does
  // not actually exceed the comparison basis (a direct POST can reach here
  // without the "looks high" verdict the page's CTA requires), decline with
  // an honest message instead of generating a self-refuting letter.
  if (comparisonBasis <= 0 || assessedValue <= comparisonBasis) {
    return NextResponse.json(
      {
        error:
          "Your assessment doesn't exceed the value Hearth compares it against, so an appeal letter arguing it is too high wouldn't be honest. Check the taxes page for the latest comparison.",
      },
      { status: 400 }
    );
  }

  // Only facts Hearth actually has. Anything else the letter needs becomes a
  // bracketed placeholder the owner fills in.
  const facts: string[] = [];
  if (property.city || property.state) {
    facts.push(
      `Home location: ${[property.city, property.state].filter(Boolean).join(", ")}`
    );
  }
  facts.push(`County assessed value: $${assessedValue.toLocaleString()} (tax year ${assessedYear})`);
  if (prop13Baseline != null) {
    // CA: cite the Prop 13 trajectory and leave the market estimate out
    // entirely, so the model can't undercut the argument with a market
    // figure far above the assessment.
    facts.push(
      `Proposition 13 factored base year trajectory: about $${prop13Baseline.toLocaleString()} for tax year ${assessedYear} (the ${purchaseYear} purchase price grown at the 2% annual cap Proposition 13 allows; the owner's own calculation, not a county record)`
    );
  } else {
    facts.push(
      `Hearth's estimated market value: $${estimatedValue.toLocaleString()} (a ballpark from statewide average appreciation applied to the owner's purchase price, not an appraisal)`
    );
  }
  facts.push(`Purchased in ${purchaseYear} for $${purchasePrice.toLocaleString()}`);
  if (property.sqft) facts.push(`Square footage: ${property.sqft}`);
  if (property.beds) facts.push(`Bedrooms: ${property.beds}`);
  if (property.baths) facts.push(`Bathrooms: ${property.baths}`);
  if (property.year_built) facts.push(`Year built: ${property.year_built}`);

  const instruction =
    "You draft a property tax assessment appeal letter for a homeowner to review, adapt, and file with their county assessor themselves. " +
    "Write a respectful, factual, county-generic letter from the homeowner's point of view, addressed to the county assessor's office. " +
    "Use only the facts provided. Where the letter needs information you were not given, insert a clearly bracketed placeholder such as [Parcel number], [Your name], [Property address], [County assessor's office address], or [Date]. " +
    "Never invent comparable sales, appraisals, dates, names, or any other facts. " +
    "Before finishing, re-read your draft and confirm every figure, date, and name in it exactly matches the facts you were given: anything you were not given must appear as a bracketed placeholder, never as an invented value. " +
    (prop13Baseline != null
      ? "The letter should state the assessed value, note that the homeowner believes it exceeds the trajectory California's Proposition 13 allows (the factored base year value, roughly the purchase price growing 2% a year), cite the trajectory figure provided while being honest that it is the owner's own calculation from their purchase records rather than a county record, avoid any claim about the property's current market value, and politely request a review of the assessment and information about the county's formal appeal process. "
      : "The letter should state the assessed value, note that the homeowner believes it exceeds the property's market value, cite the estimate provided as one indicator while being honest that it is an estimate rather than an appraisal, and politely request a review of the assessment and information about the county's formal appeal process. ") +
    "Include a spot ([Attach or list comparable sales here, if you have them]) where the homeowner can add their own supporting evidence. " +
    "Never promise or predict an outcome, never threaten, and never claim professional credentials. " +
    "Keep it under 350 words, in plain complete sentences a homeowner would actually sign. " +
    "Output only the letter text itself, with no commentary before or after it. " +
    "Never use an em dash or a hyphen as a connector: use a comma, a colon, or a new sentence instead.";

  const requestBody = JSON.stringify({
    systemInstruction: { parts: [{ text: instruction }] },
    contents: [
      {
        role: "user",
        parts: [
          {
            text:
              "Draft the appeal letter from these facts about my home:\n\n" +
              facts.map((f) => `- ${f}`).join("\n"),
          },
        ],
      },
    ],
    generationConfig: {
      maxOutputTokens: 1000,
    },
  });

  let rateLimited = false;
  for (const model of MODELS) {
    try {
      const resp = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-goog-api-key": apiKey,
          },
          body: requestBody,
        }
      );
      if (resp.status === 429) {
        rateLimited = true;
        continue;
      }
      if (!resp.ok) continue;
      const data = await resp.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (typeof text !== "string" || !text.trim()) continue;
      return NextResponse.json({ letter: text.trim() });
    } catch {
      // network error - try the next model
    }
  }

  return NextResponse.json({
    letter: null,
    reason: rateLimited ? "rate_limited" : "failed",
  });
}
