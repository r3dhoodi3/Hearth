import Link from "next/link";
import { getActiveProperty } from "@/lib/property";
import { hasPlus } from "@/lib/subscription";
import { stateName } from "@/lib/forecast";
import { headlineHomeValue } from "@/lib/homeValue";
import {
  BUILDING_RECORD_NOTICE,
  plausibleHomeFigure,
} from "@/lib/parcelSanity";
import TaxForm from "./TaxForm";
import AppealLetter from "./AppealLetter";
import Breadcrumbs from "@/components/Breadcrumbs";

function money(n: number): string {
  return `$${Math.round(Math.abs(n)).toLocaleString()}`;
}

// How far the assessment sits from its comparison basis (Hearth's estimate,
// or the Prop 13 trajectory in CA) before the page calls it out. Above by
// more than this fraction reads "looks high"; below it by more than this
// reads "looks favorable"; anything in between is "looks in line". 10% is
// deliberately conservative: Hearth's estimate is a statewide-model
// ballpark, so a smaller gap is just noise.
const HIGH_THRESHOLD = 0.1;
const LOW_THRESHOLD = -0.1;

type Verdict = "high" | "in_line" | "favorable";

export default async function TaxesPage() {
  const property = (await getActiveProperty())!;
  const isPlus = await hasPlus();

  // assessed_value and assessed_year are new columns from migration 0039,
  // and purchase_price is from 0029; none are in src/lib/database.types.ts
  // yet, so they are read off the row with a cast rather than widening the
  // generated types by hand (same pattern as /value). If a migration has not
  // run yet in this database, these come back undefined and the page shows
  // the setup form, exactly like "not set yet".
  const raw = property as any;
  const storedAssessedValue: number | null =
    typeof raw.assessed_value === "number" ? raw.assessed_value : null;
  const assessedYear: number | null =
    typeof raw.assessed_year === "number" ? raw.assessed_year : null;
  const storedPurchasePrice: number | null =
    typeof raw.purchase_price === "number" ? raw.purchase_price : null;

  // THE BUILDING-RECORD GATE (src/lib/parcelSanity.ts). A condo's county
  // record covers the whole building, so both numbers this page is built on
  // can belong to the parcel rather than the unit. A tester in a mixed-use
  // building was shown a $36,410,541 "County assessed value" and a
  // $39,836,419 Prop 13 baseline under a green "Your assessment looks in
  // line" - a verdict computed from two of the building's numbers, about a
  // condo. Both go through the same gate, measured against the AVM, which is
  // priced for the unit.
  const sanityContext = {
    unit: raw.unit,
    propertyType: raw.property_type,
    sqft: typeof raw.sqft === "number" ? raw.sqft : null,
    estimate: typeof raw.market_value === "number" ? raw.market_value : null,
  };
  const assessedValue = plausibleHomeFigure(storedAssessedValue, sanityContext);
  const purchasePrice = plausibleHomeFigure(storedPurchasePrice, sanityContext);
  // Either figure was on file and the gate refused it. Drives the one honest
  // line below, in place of the number and in place of the verdict.
  const figuresHidden =
    (storedAssessedValue != null && assessedValue == null) ||
    (storedPurchasePrice != null && purchasePrice == null);

  // Dropped with the price it belongs to: a purchase year with no purchase
  // price behind it is the building's sale date, not this home's.
  const purchaseYear: number | null =
    property.purchase_date && !(storedPurchasePrice != null && purchasePrice == null)
      ? Number(property.purchase_date.slice(0, 4)) || null
      : null;

  const currentYear = new Date().getFullYear();
  const hasAssessment = assessedValue != null && assessedYear != null;
  const hasPurchaseData = purchasePrice != null && purchaseYear != null;
  const region = stateName(property.state);

  // The same shared chooser the dashboard tile and /value use
  // (headlineHomeValue in src/lib/homeValue.ts): the stored RentCast AVM when
  // one has landed for this address, otherwise the capped purchase-price
  // model. This page used to call estimateHomeValue directly, which meant it
  // could judge a county assessment against a different number than the one
  // the owner was reading on the dashboard the same day.
  //
  // Still gated on hasPurchaseData, exactly as before: the sections below
  // branch on it, and an owner with an AVM but no purchase price on file is
  // sent to /value first, same as they always were.
  const headline = headlineHomeValue({
    marketValue: typeof raw.market_value === "number" ? raw.market_value : null,
    marketValueLow:
      typeof raw.market_value_low === "number" ? raw.market_value_low : null,
    marketValueHigh:
      typeof raw.market_value_high === "number" ? raw.market_value_high : null,
    purchasePrice,
    purchaseYear,
    state: property.state,
    currentYear,
  });
  const estimatedValue = hasPurchaseData ? (headline?.value ?? null) : null;

  // CALIFORNIA (Prop 13): assessed values are capped at roughly 2% growth a
  // year from the purchase price, so market value is the wrong yardstick
  // there. A long-held CA home is supposed to be assessed far below market,
  // and comparing against Hearth's market estimate would call nearly every
  // one "favorable" while missing a genuinely high assessment. For CA the
  // baseline is the purchase price compounded at 2%/yr to the assessed year,
  // and "looks high" means the county is above even that capped trajectory.
  const prop13Baseline =
    property.state?.toUpperCase() === "CA" && hasAssessment && hasPurchaseData
      ? Math.round(
          purchasePrice! *
            Math.pow(1.02, Math.max(0, assessedYear! - purchaseYear!))
        )
      : null;

  // What the assessment is judged against: the Prop 13 trajectory in CA,
  // Hearth's market estimate everywhere else.
  const comparisonBasis = prop13Baseline ?? estimatedValue;

  // How far the assessment sits above (positive) or below (negative) the
  // comparison basis, as a fraction of it.
  const diffPct =
    hasAssessment && comparisonBasis != null && comparisonBasis > 0
      ? (assessedValue! - comparisonBasis) / comparisonBasis
      : null;

  const verdict: Verdict | null =
    diffPct == null
      ? null
      : diffPct > HIGH_THRESHOLD
        ? "high"
        : diffPct < LOW_THRESHOLD
          ? "favorable"
          : "in_line";

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <Breadcrumbs items={[{ label: "Home", href: "/dashboard" }, { label: "Property tax watch" }]} />
      <header className="mb-1">
        <h1 className="text-2xl font-semibold text-stone-900 dark:text-stone-100">
          Property tax watch
        </h1>
      </header>
      <p className="mb-5 text-sm text-stone-500 dark:text-stone-400">
        Your property tax bill is based on what the county says your home is
        worth. Enter the assessed value from your notice and Hearth will
        compare it against its own estimate, so you can spot an assessment
        that looks too high before the appeal deadline passes.
      </p>

      {!hasAssessment && (
        <div className="space-y-4">
          <div className="card space-y-2 text-center">
            {/* Said first when there IS a county figure on file that the
                building-record gate refused. Without this the page reads as
                if the county had nothing, which is not what happened. */}
            {figuresHidden && (
              <p className="text-sm text-stone-600 dark:text-stone-300">
                {BUILDING_RECORD_NOTICE}
              </p>
            )}
            <p className="text-sm text-stone-600 dark:text-stone-300">
              Grab your county assessment notice (or your most recent
              property tax bill). It lists an assessed value for your home
              and the tax year it covers. Enter those two numbers and Hearth
              will keep an eye on how they stack up.
            </p>
          </div>
          <TaxForm
            assessedValue={assessedValue}
            assessedYear={assessedYear}
            currentYear={currentYear}
            startOpen
          />
        </div>
      )}

      {hasAssessment && !hasPurchaseData && (
        <div className="space-y-4">
          <div className="card space-y-2 text-center">
            <p className="text-sm text-stone-600 dark:text-stone-300">
              Your {assessedYear} assessment of {money(assessedValue!)} is
              saved. To compare it against an estimate of what your home is
              actually worth, Hearth needs what you paid and the year you
              bought, which live on the home value page.
            </p>
            {/* The purchase price the county has IS on file here; it just
                describes the building. Say so rather than letting this read
                as "you never told us". */}
            {figuresHidden && (
              <p className="text-sm text-stone-600 dark:text-stone-300">
                {BUILDING_RECORD_NOTICE}
              </p>
            )}
            <Link href="/value" className="btn-primary inline-block">
              Set up your home value
            </Link>
          </div>
          <TaxForm
            assessedValue={assessedValue}
            assessedYear={assessedYear}
            currentYear={currentYear}
            startOpen={false}
          />
        </div>
      )}

      {hasAssessment && estimatedValue != null && verdict != null && (
        <>
          {/* Methodology caveat sits above the verdict so the reader knows
              what kind of number they're about to see before the colored
              card makes its call. */}
          <p className="mb-4 text-xs text-stone-500 dark:text-stone-400">
            Hearth&apos;s number is an estimate: an automated valuation when one exists for your address, otherwise statewide price trends applied to your purchase price. It is not
            an appraisal, and this page is not tax or legal advice. Assessment rules, ratios, and appeal processes vary a lot
            by county, and some counties assess at a fraction of market value
            by design, so a gap here doesn&apos;t always mean something is
            wrong. Appeals are decided by your county and outcomes are never
            guaranteed. For a number you can rely on, talk to a local real
            estate agent or licensed appraiser.
          </p>
          <div
            className={`card-hero space-y-2 text-center ${
              verdict === "high"
                ? "border-amber-300 dark:border-amber-800/50"
                : "border-green-300 dark:border-green-800/50"
            }`}
          >
            <p
              className={`text-sm font-medium ${
                verdict === "high"
                  ? "text-amber-800 dark:text-amber-300"
                  : "text-green-800 dark:text-green-300"
              }`}
            >
              {verdict === "high" && "Your assessment looks high"}
              {verdict === "in_line" && "Your assessment looks in line"}
              {verdict === "favorable" && "Your assessment looks favorable"}
            </p>
            <p
              className={`text-sm ${
                verdict === "high"
                  ? "text-amber-700 dark:text-amber-300"
                  : "text-green-700 dark:text-green-200"
              }`}
            >
              {verdict === "high" &&
                `The county assessed your home about ${Math.round(
                  diffPct! * 100
                )}% above ${
                  prop13Baseline != null
                    ? "the trajectory Prop 13 allows (your purchase price growing about 2% a year)"
                    : "Hearth's estimate"
                }. A successful appeal lowers your bill every year until reassessment, and appealing is usually free.`}
              {verdict === "in_line" &&
                `The county's number sits within about 10% of ${
                  prop13Baseline != null
                    ? "the trajectory Prop 13 allows (your purchase price growing about 2% a year)"
                    : "Hearth's estimate"
                }, which is normal. An appeal probably isn't worth your time this year.`}
              {verdict === "favorable" &&
                `The county assessed your home about ${Math.round(
                  Math.abs(diffPct!) * 100
                )}% below ${
                  prop13Baseline != null
                    ? "the trajectory Prop 13 allows"
                    : "Hearth's estimate"
                }, which works in your favor at tax time. Appealing could backfire: drawing the assessor's attention might raise your assessment, not lower it.`}
            </p>
          </div>

          <div className="mt-6 grid gap-4 sm:grid-cols-2">
            <div className="card space-y-1 text-center">
              <p className="stat-label">
                County assessed value ({assessedYear})
              </p>
              <p className="stat-number text-2xl">
                {money(assessedValue!)}
              </p>
              <p className="text-xs text-stone-500 dark:text-stone-400">
                From your assessment notice.
              </p>
            </div>
            {/* Show the number the verdict was actually judged against: the
                Prop 13 trajectory in CA, Hearth's market estimate elsewhere. */}
            {prop13Baseline != null ? (
              <div className="card space-y-1 text-center">
                <p className="stat-label">
                  Prop 13 baseline ({assessedYear})
                </p>
                <p className="stat-number text-2xl">
                  {money(prop13Baseline)}
                </p>
                <p className="text-xs text-stone-500 dark:text-stone-400">
                  Your {purchaseYear} purchase price growing about 2% a year,
                  the most Prop 13 normally allows.
                </p>
              </div>
            ) : (
              <div className="card space-y-1 text-center">
                <p className="stat-label">
                  Hearth&apos;s estimated value
                </p>
                <p className="stat-number text-2xl">
                  {money(estimatedValue)}
                </p>
                {/* Say what the number is actually based on. The caption used
                    to always claim state price trends since the purchase,
                    which is a false description of an AVM. The provider's
                    name is not printed - same call as /value and the
                    dashboard tile. */}
                <p className="text-xs text-stone-500 dark:text-stone-400">
                  {headline?.source === "avm" ? (
                    "Priced off recent sales near you."
                  ) : (
                    <>
                      Based on{" "}
                      {region ? `${region} price trends` : "statewide price trends"}{" "}
                      since you bought in {purchaseYear}.
                    </>
                  )}
                </p>
              </div>
            )}
          </div>

          <div className="card mt-6 space-y-2">
            <h2 className="flex items-center text-sm font-semibold text-stone-900 dark:text-stone-100">
              What is a property tax appeal?
            </h2>
            <p className="text-sm text-stone-600 dark:text-stone-300">
              You can challenge your assessment if you think it&apos;s too high.
            </p>
            <ul className="list-disc space-y-1 pl-5 text-sm text-stone-600 dark:text-stone-300">
              <li>
                File a short form with your county assessor. It is usually free.
              </li>
              <li>
                Add proof if you have it, like what similar homes nearby sold
                for.
              </li>
              <li>
                If the county agrees, your assessed value and your tax bill both
                go down.
              </li>
              <li>
                Check your notice for the deadline. Most counties give you only
                a few weeks.
              </li>
            </ul>
          </div>

          {verdict === "high" && (
            <div className="mt-6">
              <AppealLetter isPlus={isPlus} />
            </div>
          )}

          <div className="mt-6">
            <TaxForm
              assessedValue={assessedValue}
              assessedYear={assessedYear}
              currentYear={currentYear}
              startOpen={false}
            />
          </div>

        </>
      )}
    </div>
  );
}
