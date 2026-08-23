// Parcel pre-fill (Screen 1). Looks up baseline property facts from a real
// records source so onboarding can skip re-typing what public records already
// know. The wired source is RentCast (https://www.rentcast.io/api): public
// tax-assessor and county-record data behind a simple JSON API with a free
// tier (50 lookups/month), which fits launch scale - each lookup makes a
// single call (the property record only). Enable it by setting
// RENTCAST_API_KEY in the environment;
// without a key, lookupParcel() never invents facts: it only echoes back the
// street and ZIP the homeowner typed and leaves everything it doesn't
// actually know (city, state, year built, sqft, beds/baths, lot size,
// property type, and everything else below) null for them to fill in or
// skip.

import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/database.types";

export interface ParcelFacts {
  parcel_id: string | null;
  address_line1: string;
  city: string | null;
  state: string | null;
  zip: string | null;
  year_built: number | null;
  sqft: number | null;
  beds: number | null;
  baths: number | null;
  lot_size_sqft: number | null;
  property_type: string | null;
  purchase_date: string | null;
  purchase_price: number | null;
  assessed_value: number | null;
  assessed_year: number | null;
  property_tax_history: { year: number; amount: number }[] | null;
  latitude: number | null;
  longitude: number | null;
  hoa_fee: number | null;
  county: string | null;
  market_value: number | null;
  market_value_low: number | null;
  market_value_high: number | null;
  // Maps a home_systems system_type (matching STARTER_SYSTEMS in
  // onboarding/actions.ts) to a material/model string read off the property
  // record, so the starter-seeded rows aren't left blank when RentCast
  // actually knows the roof/foundation/HVAC.
  system_facts: Record<string, string> | null;
  // County assessor owner-of-record, for ownership verification (migration
  // 0093, src/lib/ownershipMatch.ts). Server-only, and enforced as such:
  // lookupParcelAction (onboarding/actions.ts) strips these three fields from
  // the value it returns to the browser (see PublicParcelFacts below), so the
  // client never receives the owner-of-record that claimPropertyAction later
  // matches the typed name against - exposing it would be handing over the
  // answer key. Server callers that legitimately need it (claimPropertyAction
  // and contractors/actions.ts) read the full ParcelFacts from lookupParcel()
  // directly instead.
  owner_names: string[] | null;
  owner_type: "individual" | "organization" | null;
  owner_occupied: boolean | null;
  source: "rentcast" | "none";
}

// The client-safe subset of ParcelFacts. lookupParcelAction returns this, not
// ParcelFacts, so the owner-of-record fields (owner_names/owner_type/
// owner_occupied) can never ship to the browser: they are the answer key the
// claim-time ownership check compares the typed name against. OnboardingForm
// only ever reads the fields below, so nothing on the client loses anything.
export type PublicParcelFacts = Omit<
  ParcelFacts,
  "owner_names" | "owner_type" | "owner_occupied"
>;

// Shared by lookupParcel's request key and its canonical-key dual-write
// below: normalizes whitespace/case on the street and takes the 5-digit ZIP
// so "123  Main St" / "123 main st" hit the same row.
// "|v2" (migration 0093): ParcelFacts gained owner_names/owner_type/
// owner_occupied for ownership verification, so a row cached before that
// change has no owner data. Bumping the key makes every such row a natural
// miss - it just refetches once instead of silently serving stale facts
// with owner data missing.
//
// The unit is deliberately NOT part of this key, and lookupParcel does not
// send it either. The tempting theory is that unit 4B and unit 2A are separate
// parcels with separate owners of record - true of the county filing, but not
// of what RentCast returns: /v1/properties matches on the street address and
// hands back the same base building record whichever unit rides along in the
// string. Keying per unit would therefore buy nothing but N billed lookups and
// N cache rows for one building, all holding identical facts, and the
// ownership match it would appear to sharpen would still be a match against
// the BUILDING's owner of record. Street + ZIP is what the record is actually
// keyed on, so that is the key - and a claim that carries a unit is treated as
// unverifiable rather than checked against the building (see
// claimPropertyAction in src/app/onboarding/actions.ts).
function parcelCacheKey(street: string, zip: string): string {
  return (
    street.trim().replace(/\s+/g, " ").toLowerCase() +
    "|" +
    zip.trim().slice(0, 5) +
    "|v2"
  );
}

// RentCast's endpoints take ONE `address` query parameter - a single formatted
// string, "Street, City, State, Zip" per their docs - with no separate
// unit/secondary-address field anywhere in the request, so a unit can only
// travel as part of the street portion. Only lookupMarketValue below still
// does that: an AVM is a price for a specific dwelling, so asking for the unit
// is asking a different question. The property-record lookup does not (see
// parcelCacheKey above) - it gets the same building record regardless.
function lookupStreet(street: string, unit?: string | null): string {
  const s = street.trim();
  const u = (unit ?? "").trim();
  return u ? `${s} ${u}` : s;
}

export async function lookupParcel(
  street: string,
  zip: string,
  // Accepted and ignored. Callers that hold a property row (the claim, the
  // lazy re-check in contractors/actions.ts) still pass property.unit, and
  // taking it here keeps them compiling - but nothing is done with it, because
  // RentCast returns the base building record for the street either way. The
  // unit is display-only (formatAddressLine, src/lib/addressLine.ts); it is
  // never a lookup key and never narrows the owner of record.
  _unit?: string | null
): Promise<ParcelFacts> {
  // A successful RentCast lookup bills one call, so serve a fresh cached
  // result (migration 0069) instead of re-billing the same address. All
  // cache I/O below is wrapped so any error degrades to "just call
  // RentCast": the cache must never break onboarding. parcel.ts is
  // server-only, so the admin client is safe here.
  const cacheKey = parcelCacheKey(street, zip);
  const admin = createAdminClient();

  try {
    const { data: row } = await admin
      .from("parcel_cache")
      .select("facts, source, fetched_at")
      .eq("cache_key", cacheKey)
      .maybeSingle();
    if (row) {
      // Fresh = a real record inside 30 days, or a "nothing found" miss inside
      // 1 day (so a newly-listed / recently-recorded parcel gets re-checked
      // soon rather than staying blank for a month).
      const ageMs = Date.now() - new Date(row.fetched_at).getTime();
      const fresh =
        (row.source === "rentcast" && ageMs < 30 * 24 * 60 * 60 * 1000) ||
        (row.source === "none" && ageMs < 24 * 60 * 60 * 1000);
      if (fresh) return row.facts as unknown as ParcelFacts;
    }
  } catch (err) {
    console.error("Parcel cache read failed:", err);
  }

  const facts = await fetchParcelFacts(street, zip);

  try {
    // Cache the "none" result too: a miss is worth remembering for a day so a
    // retype of the same unknown address doesn't re-bill RentCast.
    await admin.from("parcel_cache").upsert(
      {
        cache_key: cacheKey,
        facts: facts as unknown as Json,
        source: facts.source,
        fetched_at: new Date().toISOString(),
      },
      { onConflict: "cache_key" }
    );
  } catch (err) {
    console.error("Parcel cache write failed:", err);
  }

  // Dual-write under RentCast's own canonical address+ZIP too (read-through
  // miss only - a fresh cache hit above already returned before reaching
  // here). RentCast can correct the ZIP the homeowner typed (e.g. typed
  // 92708, the record's real ZIP is 92647), and the onboarding confirm
  // screen pre-fills that corrected ZIP (OnboardingForm.tsx), so
  // claimPropertyAction's claim-time re-check (src/app/onboarding/actions.ts)
  // calls lookupParcel with the CORRECTED zip, not the one this call cached
  // under. Without this, that second call misses the cache and bills
  // RentCast a second time for the same signup. Best-effort, same as every
  // other cache write here.
  if (facts.source === "rentcast" && facts.zip) {
    const canonicalKey = parcelCacheKey(facts.address_line1, facts.zip);
    if (canonicalKey !== cacheKey) {
      try {
        await admin.from("parcel_cache").upsert(
          {
            cache_key: canonicalKey,
            facts: facts as unknown as Json,
            source: facts.source,
            fetched_at: new Date().toISOString(),
          },
          { onConflict: "cache_key" }
        );
      } catch (err) {
        console.error("Parcel cache canonical-key write failed:", err);
      }
    }
  }

  return facts;
}

// The actual RentCast lookup, unchanged from the original lookupParcel body.
// Split out so lookupParcel can wrap it in the read-through cache above.
async function fetchParcelFacts(
  street: string,
  zip: string
): Promise<ParcelFacts> {
  const key = process.env.RENTCAST_API_KEY;
  if (key) {
    try {
      // Single call: the property record only. The AVM market-value lookup
      // was removed, so market_value fields stay null (home value can be
      // entered manually later on the value page).
      const record = await fetchFromRentcast(street.trim(), zip.trim(), key);
      if (record) return record;
    } catch (err) {
      console.error("RentCast lookup failed:", err);
    }
  }
  // address_line1 is the street line; the unit lives in its own column and is
  // never folded in here.
  return blankFacts(street, zip);
}

// The subset of RentCast's property-record response we read. Every field is
// optional: records for rural or recently subdivided parcels can be sparse,
// and a missing field must stay null rather than become a guess.
type RentcastFeatures = {
  roofType?: string;
  heatingType?: string;
  coolingType?: string;
  foundationType?: string;
  exteriorType?: string;
  pool?: boolean;
  garage?: boolean;
  fireplace?: boolean;
  architectureType?: string;
  floorCount?: number;
  roomCount?: number;
};

type RentcastTaxAssessment = { year?: number; value?: number; land?: number; improvements?: number };
type RentcastPropertyTax = { year?: number; total?: number };
type RentcastHistoryEntry = { event?: string; date?: string; price?: number };

// The assessor's owner-of-record. Optional throughout: sparse/rural records
// can omit it entirely, and a missing owner must resolve to "can't verify",
// never a guessed match.
type RentcastOwner = {
  names?: string[];
  type?: string;
  mailingAddress?: { addressLine1?: string; zipCode?: string };
};

type RentcastRecord = {
  id?: string;
  formattedAddress?: string;
  addressLine1?: string;
  // RentCast's secondary address line, where a condo/apartment unit usually
  // lands. Not read as a value (the homeowner's own typed unit is the one
  // stored), only acknowledged here so the shape is documented.
  addressLine2?: string;
  city?: string;
  state?: string;
  zipCode?: string;
  county?: string;
  latitude?: number;
  longitude?: number;
  yearBuilt?: number;
  squareFootage?: number;
  bedrooms?: number;
  bathrooms?: number;
  lotSize?: number;
  propertyType?: string;
  assessorID?: string;
  lastSaleDate?: string;
  hoa?: { fee?: number };
  features?: RentcastFeatures;
  taxAssessments?: Record<string, RentcastTaxAssessment>;
  propertyTaxes?: Record<string, RentcastPropertyTax>;
  history?: Record<string, RentcastHistoryEntry>;
  owner?: RentcastOwner;
  ownerOccupied?: boolean;
};

// Normalizes RentCast's owner.type ("Individual" | "Organization", per their
// docs) to Hearth's lowercase enum. Anything unrecognized stays null rather
// than guessed - ownershipMatch.ts treats a null owner_type as "can't
// verify", same as a missing owner entirely.
function normalizeOwnerType(value: string | null | undefined): "individual" | "organization" | null {
  if (!value) return null;
  const v = value.trim().toLowerCase();
  if (v === "individual" || v === "organization") return v;
  return null;
}

// RentCast returns human-readable property types ("Single Family", "Condo",
// "Townhouse", "Multi-Family", "Apartment", "Manufactured", "Land"), but the
// onboarding confirm screen's <select> only knows Hearth's snake_case enum
// (PROPERTY_TYPES in src/lib/constants.ts). An unmapped defaultValue makes the
// browser silently fall back to the first option, "single_family", so every
// unnormalized value would misfile as a single-family home. Map what we
// recognize and return null for everything else (Manufactured, Land, future
// values): an honest blank beats a confident wrong answer.
const RENTCAST_PROPERTY_TYPES: Record<string, string> = {
  "single family": "single_family",
  condo: "condo",
  townhouse: "townhouse",
  "multi-family": "multi_family",
  apartment: "multi_family",
};

function normalizePropertyType(value: string | null | undefined): string | null {
  if (!value) return null;
  return RENTCAST_PROPERTY_TYPES[value.trim().toLowerCase()] ?? null;
}

// There used to be a stripUnit() here, to take the unit back off an address
// the records source echoed after we had sent it as part of the street. The
// unit no longer goes out with the property-record request at all (see
// parcelCacheKey), so there is nothing to take back off: record.addressLine1
// is the building's street line, which is exactly what address_line1 means.

// lastSaleDate is an ISO timestamp string; onboarding only stores the date
// portion (properties.purchase_date is a `date` column).
function toDateOnly(iso: string | null | undefined): string | null {
  if (!iso) return null;
  return iso.slice(0, 10);
}

// The sale price isn't always on the lastSaleDate entry itself (RentCast's
// most recent sale can be missing a price, e.g. a non-arm's-length transfer),
// so fall back to the most recent history entry that DOES have one.
function derivePurchasePrice(
  history: Record<string, RentcastHistoryEntry> | undefined,
  lastSaleDate: string | undefined
): number | null {
  if (!history) return null;
  const entries = Object.values(history);
  if (lastSaleDate) {
    const match = entries.find((e) => e.date === lastSaleDate);
    if (match && typeof match.price === "number") return match.price;
  }
  const withPrice = entries
    .filter((e): e is RentcastHistoryEntry & { date: string; price: number } =>
      typeof e.price === "number" && typeof e.date === "string"
    )
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return withPrice[0]?.price ?? null;
}

function deriveAssessed(
  taxAssessments: Record<string, RentcastTaxAssessment> | undefined
): { assessed_value: number | null; assessed_year: number | null } {
  if (!taxAssessments) return { assessed_value: null, assessed_year: null };
  const entries = Object.values(taxAssessments).filter(
    (e): e is RentcastTaxAssessment & { year: number } => typeof e.year === "number"
  );
  if (entries.length === 0) return { assessed_value: null, assessed_year: null };
  const latest = entries.reduce((a, b) => (b.year > a.year ? b : a));
  return {
    assessed_value: typeof latest.value === "number" ? latest.value : null,
    assessed_year: latest.year,
  };
}

function derivePropertyTaxHistory(
  propertyTaxes: Record<string, RentcastPropertyTax> | undefined
): { year: number; amount: number }[] | null {
  if (!propertyTaxes) return null;
  const entries = Object.values(propertyTaxes)
    .filter(
      (e): e is RentcastPropertyTax & { year: number; total: number } =>
        typeof e.year === "number" && typeof e.total === "number"
    )
    .map((e) => ({ year: e.year, amount: e.total }))
    .sort((a, b) => a.year - b.year);
  return entries.length > 0 ? entries : null;
}

// Maps a subset of RentCast's `features` object to the STARTER_SYSTEMS
// system_type keys onboarding seeds (foundation, roof, hvac), so those rows
// start with a real material instead of a blank. Only keys we actually have a
// value for are included.
function deriveSystemFacts(
  features: RentcastFeatures | undefined
): Record<string, string> | null {
  if (!features) return null;
  const facts: Record<string, string> = {};
  if (features.roofType) facts.roof = features.roofType;
  if (features.foundationType) facts.foundation = features.foundationType;
  const hvacParts: string[] = [];
  if (features.heatingType) hvacParts.push(`${features.heatingType} heat`);
  if (features.coolingType) hvacParts.push(`${features.coolingType} A/C`);
  if (hvacParts.length > 0) facts.hvac = hvacParts.join(", ");
  return Object.keys(facts).length > 0 ? facts : null;
}

// Fetches property facts from RentCast's /v1/properties endpoint, which
// matches a single address against county assessor records. Returns null on
// any miss or failure so the caller falls back to blankFacts(): a lookup
// hiccup must degrade to "type it yourself", never block onboarding.
async function fetchFromRentcast(
  street: string,
  zip: string,
  apiKey: string
): Promise<ParcelFacts | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const address = `${street.trim()}, ${zip}`;
    const url = `https://api.rentcast.io/v1/properties?address=${encodeURIComponent(address)}`;
    const res = await fetch(url, {
      headers: { "X-Api-Key": apiKey, Accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) {
      console.error(`RentCast returned HTTP ${res.status} for address lookup`);
      return null;
    }
    const body: unknown = await res.json();
    const record: RentcastRecord | undefined = Array.isArray(body)
      ? body[0]
      : undefined;
    // No record, or a record with no address echo: treat as a miss rather
    // than trusting a shape we don't recognize.
    if (!record || (!record.addressLine1 && !record.formattedAddress)) {
      return null;
    }
    const typed = blankFacts(street, zip);
    const purchase_date = toDateOnly(record.lastSaleDate);
    const purchase_price = derivePurchasePrice(record.history, record.lastSaleDate);
    const { assessed_value, assessed_year } = deriveAssessed(record.taxAssessments);
    const property_tax_history = derivePropertyTaxHistory(record.propertyTaxes);
    const system_facts = deriveSystemFacts(record.features);
    return {
      parcel_id: record.assessorID ?? record.id ?? null,
      // Prefer the canonical county-record address over the typed one, but
      // never lose what the homeowner typed if the record omits a part. No
      // unit is sent, so what comes back is the building's street line, which
      // is what address_line1 means here.
      address_line1: record.addressLine1?.trim() || typed.address_line1,
      city: record.city ?? typed.city,
      state: record.state ?? typed.state,
      zip: record.zipCode ?? typed.zip,
      year_built: record.yearBuilt ?? null,
      sqft: record.squareFootage ?? null,
      beds: record.bedrooms ?? null,
      baths: record.bathrooms ?? null,
      lot_size_sqft: record.lotSize ?? null,
      property_type: normalizePropertyType(record.propertyType),
      purchase_date,
      purchase_price,
      assessed_value,
      assessed_year,
      property_tax_history,
      latitude: record.latitude ?? null,
      longitude: record.longitude ?? null,
      hoa_fee: record.hoa?.fee ?? null,
      county: record.county ?? null,
      market_value: null,
      market_value_low: null,
      market_value_high: null,
      system_facts,
      owner_names:
        record.owner?.names && record.owner.names.length > 0
          ? record.owner.names
          : null,
      owner_type: normalizeOwnerType(record.owner?.type),
      owner_occupied:
        typeof record.ownerOccupied === "boolean" ? record.ownerOccupied : null,
      source: "rentcast",
    };
  } catch {
    // AbortError (timeout), DNS/network failure: degrade to manual entry.
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// The AVM market-value lookup (/v1/avm/value) was removed from onboarding so
// it makes a single RentCast call for the property record only. market_value
// fields stay null there; the /value page fetches the AVM lazily instead (see
// lookupMarketValue below), only once per property and only for someone who
// actually opens the page, rather than billing every signup.

export interface MarketValueFacts {
  market_value: number | null;
  market_value_low: number | null;
  market_value_high: number | null;
}

const BLANK_MARKET_VALUE: MarketValueFacts = {
  market_value: null,
  market_value_low: null,
  market_value_high: null,
};

// Lazy AVM (estimated market value) lookup for the /value page. Mirrors
// lookupParcel's read-through cache (same parcel_cache table, same 30-day
// freshness for a real hit / 1-day freshness for a miss) so opening /value
// repeatedly, or multiple household members on the same property, doesn't
// re-bill RentCast. The cache key gets an "|avm" suffix so it never collides
// with lookupParcel's property-record cache row for the same address.
export async function lookupMarketValue(
  street: string,
  zip: string,
  // Condo/townhome unit (migration 0127). An AVM for "123 Main St" is the
  // building, not unit 4B, so the unit rides into the request the same way it
  // does for the property record above - and into the cache key, so two units
  // never share one estimate. Omitted = unchanged behaviour, same key as
  // before.
  unit?: string | null
): Promise<MarketValueFacts> {
  const u = (unit ?? "").trim().replace(/\s+/g, " ").toLowerCase();
  const cacheKey =
    street.trim().replace(/\s+/g, " ").toLowerCase() +
    (u ? "/" + u : "") +
    "|" +
    zip.trim().slice(0, 5) +
    "|avm";
  const admin = createAdminClient();

  try {
    const { data: row } = await admin
      .from("parcel_cache")
      .select("facts, source, fetched_at")
      .eq("cache_key", cacheKey)
      .maybeSingle();
    if (row) {
      const ageMs = Date.now() - new Date(row.fetched_at).getTime();
      const fresh =
        (row.source === "rentcast" && ageMs < 30 * 24 * 60 * 60 * 1000) ||
        (row.source === "none" && ageMs < 24 * 60 * 60 * 1000);
      if (fresh) return row.facts as unknown as MarketValueFacts;
    }
  } catch (err) {
    console.error("Market value cache read failed:", err);
  }

  const facts = await fetchMarketValueFacts(street, zip, unit);

  try {
    // Cache a miss too (source "none"), same reasoning as lookupParcel: a
    // retype/reload of the same address within a day shouldn't re-bill.
    await admin.from("parcel_cache").upsert(
      {
        cache_key: cacheKey,
        facts: facts as unknown as Json,
        source: facts.market_value != null ? "rentcast" : "none",
        fetched_at: new Date().toISOString(),
      },
      { onConflict: "cache_key" }
    );
  } catch (err) {
    console.error("Market value cache write failed:", err);
  }

  return facts;
}

// The actual RentCast AVM call. Never throws: no key, a non-ok response, a
// timeout, or an unrecognized response shape all degrade to all-null so the
// /value page just falls back to its existing purchase-price estimate.
async function fetchMarketValueFacts(
  street: string,
  zip: string,
  unit?: string | null
): Promise<MarketValueFacts> {
  const key = process.env.RENTCAST_API_KEY;
  if (!key) return BLANK_MARKET_VALUE;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const address = `${lookupStreet(street, unit)}, ${zip}`;
    const url = `https://api.rentcast.io/v1/avm/value?address=${encodeURIComponent(address)}`;
    const res = await fetch(url, {
      headers: { "X-Api-Key": key, Accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) {
      console.error(`RentCast returned HTTP ${res.status} for AVM lookup`);
      return BLANK_MARKET_VALUE;
    }
    const body: unknown = await res.json();
    if (!body || typeof body !== "object") return BLANK_MARKET_VALUE;
    const rec = body as {
      price?: number;
      priceRangeLow?: number;
      priceRangeHigh?: number;
    };
    if (typeof rec.price !== "number") return BLANK_MARKET_VALUE;
    return {
      market_value: rec.price,
      market_value_low:
        typeof rec.priceRangeLow === "number" ? rec.priceRangeLow : null,
      market_value_high:
        typeof rec.priceRangeHigh === "number" ? rec.priceRangeHigh : null,
    };
  } catch {
    // AbortError (timeout), DNS/network failure: degrade to null, never throw.
    return BLANK_MARKET_VALUE;
  } finally {
    clearTimeout(timeout);
  }
}

// No real records source is configured (or the lookup failed): return only
// what the homeowner actually typed. Input is now structured (a separate
// street box and ZIP box), so there's no comma string left to parse - city
// and state simply aren't known yet and stay null until a records lookup or
// the confirm screen fills them in. Nothing here is a guess or a
// placeholder - it never gets shown as if it came from a records lookup.
function blankFacts(street: string, zip: string): ParcelFacts {
  return {
    parcel_id: null,
    address_line1: street.trim() || street,
    city: null,
    state: null,
    zip: zip.trim() || null,
    year_built: null,
    sqft: null,
    beds: null,
    baths: null,
    lot_size_sqft: null,
    property_type: null,
    purchase_date: null,
    purchase_price: null,
    assessed_value: null,
    assessed_year: null,
    property_tax_history: null,
    latitude: null,
    longitude: null,
    hoa_fee: null,
    county: null,
    market_value: null,
    market_value_low: null,
    market_value_high: null,
    system_facts: null,
    owner_names: null,
    owner_type: null,
    owner_occupied: null,
    source: "none",
  };
}
