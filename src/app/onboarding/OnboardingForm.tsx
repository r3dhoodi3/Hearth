"use client";

import NoticeAtCollection from "@/components/NoticeAtCollection";
import { useState } from "react";
import { lookupParcelAction, claimPropertyAction, joinMarketWaitlistAction } from "./actions";
import type { PublicParcelFacts } from "@/lib/parcel";
import { PROPERTY_TYPES, FOUNDER } from "@/lib/constants";
import { isOrangeCountyZip } from "@/lib/serviceArea";
import { Hammer, Bell, FileText } from "lucide-react";

// Must read the same as OC_ONLY_MESSAGE in ./actions.ts - kept in sync by
// hand since a "use server" file can only export async functions, not a
// shared string constant, to a client component like this one.
const OC_ONLY_MESSAGE =
  "Hearth serves Huntington Beach and Fountain Valley right now. We added you to the waitlist and will email you the moment we expand to your area.";

// A trimmed length floor for "this is actually an address," not just "this
// field isn't literally empty." Browsers treat a single space as satisfying
// an <input required> constraint, so relying on that alone let a hasty Enter
// press (or a stray keystroke) sail an unusable address like " " or "123"
// straight through to a claimed home. Matches the floor enforced server-side
// in claimPropertyAction/lookupParcelAction (./actions.ts) - the server copy
// is the one that actually matters, this one just gives faster feedback.
const MIN_ADDRESS_LENGTH = 5;

export default function OnboardingForm({
  next,
  referralCode,
  existingName,
}: {
  next?: string | null;
  // The inviter's referral code (migration 0099), carried through from the
  // sign-up link and posted as a hidden field so claimPropertyAction can
  // attribute this first home claim. Null for the ordinary, non-invited signup.
  referralCode?: string | null;
  // The name already on file for this account, if any. Google signups arrive
  // with their name backfilled server-side (src/app/auth/callback/route.ts),
  // and anyone who set a name in account settings has one too. Used to
  // prefill the full-name field on the confirm step so a user with a name on
  // file isn't asked for it again. Empty string for a fresh email signup,
  // which no longer collects a name up front.
  existingName?: string;
}) {
  const [step, setStep] = useState<"address" | "confirm" | "out_of_area">(
    "address"
  );
  const [street, setStreet] = useState("");
  const [zip, setZip] = useState("");
  const [facts, setFacts] = useState<PublicParcelFacts | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Whether the out-of-area waitlist save actually went through - drives the
  // honest vs. "we couldn't save you" copy on the out_of_area panel below.
  const [waitlistSaved, setWaitlistSaved] = useState(true);

  async function onLookup(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    // Enter in the address field (or clicking Continue) should only ever
    // trigger a lookup, never skip straight past having a real address -
    // catch the "just whitespace" / "a few stray characters" case here
    // before it ever reaches the confirm-and-claim screen.
    const s = street.trim();
    if (s.length < MIN_ADDRESS_LENGTH) {
      setError("Enter your home's street address to continue.");
      return;
    }
    const z = zip.trim();
    if (!/^\d{5}(-\d{4})?$/.test(z)) {
      setError("Enter a valid 5-digit ZIP code.");
      return;
    }
    // Fast client-side feedback for the launch restriction so an out-of-area
    // ZIP never even reaches the server lookup. lookupParcelAction enforces
    // the same check server-side (before its RentCast call) - that's the
    // real gate, this is just quicker, kinder feedback. Because this check
    // short-circuits BEFORE lookupParcelAction ever runs, the waitlist save
    // has to happen right here too, or a rejected visitor would never
    // actually land on the list despite being told they had.
    if (!isOrangeCountyZip(z)) {
      setBusy(true);
      try {
        const result = await joinMarketWaitlistAction(z);
        setWaitlistSaved(result.ok);
      } catch {
        // A rejected server action (network blip, server hiccup) must not
        // strand the button in its busy state - still land on the
        // out_of_area step, just with the honest "couldn't save you" copy.
        setWaitlistSaved(false);
      } finally {
        setBusy(false);
      }
      setStep("out_of_area");
      return;
    }

    setBusy(true);
    try {
      const result = await lookupParcelAction(s, z);
      setFacts(result);
      setStep("confirm");
    } catch {
      // A rejected server action (network blip, server hiccup) should never
      // strand the button in its busy state with no explanation.
      setError("That didn't go through. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  // Wraps the claim server action so a failure shows a friendly inline
  // message instead of throwing raw to the error boundary. A successful
  // claim redirects server-side, which is handled by the framework, not
  // caught here.
  async function onClaim(formData: FormData) {
    setError(null);

    // Fast client-side check so a blank/whitespace address (still possible
    // here even though the field carries `required`: a single space passes
    // that constraint, and the field is editable on this screen) never even
    // makes the round trip. claimPropertyAction enforces the same floor
    // server-side - that's the real gate, this is just quicker feedback.
    const addressLine1 = ((formData.get("address_line1") as string) ?? "").trim();
    if (addressLine1.length < MIN_ADDRESS_LENGTH) {
      setError("Enter your home's address before claiming it.");
      return;
    }

    setBusy(true);
    try {
      const result = await claimPropertyAction(formData);
      // claimPropertyAction redirects to the dashboard on success (redirect()
      // throws a NEXT_REDIRECT-digest error for Next's router to catch higher
      // up), so anything it actually RETURNS here is a user-facing failure -
      // its own launch-area / validation / DB-error message. Render it inline.
      // This is the path that keeps the intentional out-of-area message
      // visible: a thrown message would be masked by Next in production.
      if (result && !result.ok) {
        setError(result.error);
      }
    } catch (err: any) {
      // Trap: the successful-claim redirect() surfaces as a NEXT_REDIRECT-digest
      // throw. A bare catch here would swallow it and report a successful claim
      // as "that didn't go through" - rethrow it so the redirect still happens.
      // Anything else is a genuine network/server blip.
      if (err?.digest?.startsWith("NEXT_REDIRECT")) throw err;
      setError("That didn't go through. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      {step === "address" && (
        <form onSubmit={onLookup} className="space-y-4">
          <div>
            <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
              What&apos;s your home address?
            </h2>
            <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">
              Tell us your home&apos;s year built, size, and a few other
              details, or skip them and add them later.
            </p>
          </div>

          <ul className="space-y-1.5 rounded-lg bg-bark-50 p-3 text-sm text-bark-700 dark:bg-bark-700/40 dark:text-stone-300">
            <li className="flex items-start gap-2">
              <Hammer className="h-4 w-4 shrink-0 translate-y-0.5" aria-hidden="true" />
              <span>Track every system and know what needs attention</span>
            </li>
            <li className="flex items-start gap-2">
              <Bell className="h-4 w-4 shrink-0 translate-y-0.5" aria-hidden="true" />
              <span>
                Proactive freeze, heat, and recall alerts for YOUR home
              </span>
            </li>
            <li className="flex items-start gap-2">
              <FileText className="h-4 w-4 shrink-0 translate-y-0.5" aria-hidden="true" />
              <span>
                Scan a warranty or receipt and Hearth files it for you
              </span>
            </li>
          </ul>

          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2">
              <label className="label" htmlFor="street">
                Street address
              </label>
              <input
                id="street"
                className="input"
                placeholder="123 Oak St"
                value={street}
                onChange={(e) => setStreet(e.target.value)}
                required
              />
            </div>
            <div>
              <label className="label" htmlFor="zip">
                ZIP code
              </label>
              <input
                id="zip"
                className="input"
                placeholder="92646"
                inputMode="numeric"
                maxLength={10}
                value={zip}
                onChange={(e) => setZip(e.target.value)}
                required
              />
            </div>
          </div>
          <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
            We ask so we can personalize maintenance and local pricing for
            your home, it takes about 30 seconds.
          </p>
          {/* Notice at collection. This is the screen where the address goes
              in, and the address is what the parcel lookup turns into stored
              latitude/longitude - precise geolocation, which the CPRA treats
              as sensitive. It has to be disclosed here, not only in the
              policy three clicks away. */}
          <NoticeAtCollection
            collects="Your home's street address and ZIP code, plus the public records we look up from them: year built, size, assessed value, and your home's coordinates."
            purpose="build your home profile, plan your maintenance, and match you with pros who serve your area."
            sensitive="Your home's coordinates are precise geolocation, which California treats as sensitive. We use them only to serve your area and localize your home alerts, never to track your device and never for advertising."
          />
          {error && (
            <p
              role="alert"
              className="rounded-lg border border-red-200 bg-red-50 p-3 text-center text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200"
            >
              {error}
            </p>
          )}
          {/* RentCast IS wired up as the parcel source (src/lib/parcel.ts) -
              it just needs RENTCAST_API_KEY set in the environment. Without
              a key (or on a lookup miss), lookupParcelAction quietly falls
              back to parsing the typed address into the next form instead of
              a real records lookup, so the button stays "Continue" rather
              than "Find my home" / "Looking up…": promising a search that
              might silently not happen would be dishonest.
              Kept as the LAST element in the form (same as the confirm
              step's button row below) so the action button sits in the same
              structural spot - after all fields and messaging - on every
              step of this flow. */}
          <button className="btn-primary w-full" disabled={busy}>
            {busy ? "One moment…" : "Continue"}
          </button>
        </form>
      )}

      {step === "confirm" && facts && (
        <form action={onClaim} className="space-y-4">
          <div>
            {/* source === "none" means no records lookup happened (see
                src/lib/parcel.ts): the form only echoed the typed address, so
                don't present it as a found result. The "Does this look right?"
                copy is reserved for when a real source returns data. */}
            <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
              {facts.source === "none"
                ? "Tell us about your home"
                : "Does this look right?"}
            </h2>
            <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">
              {facts.source === "none"
                ? "Fill in what you know. Everything is optional."
                : "Fill in what you know. Anything you skip you can add later."}
            </p>
          </div>

          <input type="hidden" name="parcel_id" value={facts.parcel_id ?? ""} />
          <input type="hidden" name="next" value={next ?? ""} />
          <input type="hidden" name="ref" value={referralCode ?? ""} />

          {/* RentCast enrichment (src/lib/parcel.ts) the owner can't edit and
              isn't shown on this screen: carried through as hidden fields so
              claimPropertyAction can persist them alongside the visible
              facts above. */}
          <input type="hidden" name="latitude" value={facts.latitude ?? ""} />
          <input type="hidden" name="longitude" value={facts.longitude ?? ""} />
          <input type="hidden" name="hoa_fee" value={facts.hoa_fee ?? ""} />
          <input type="hidden" name="county" value={facts.county ?? ""} />
          <input
            type="hidden"
            name="assessed_value"
            value={facts.assessed_value ?? ""}
          />
          <input
            type="hidden"
            name="assessed_year"
            value={facts.assessed_year ?? ""}
          />
          <input
            type="hidden"
            name="purchase_date"
            value={facts.purchase_date ?? ""}
          />
          <input
            type="hidden"
            name="purchase_price"
            value={facts.purchase_price ?? ""}
          />
          <input
            type="hidden"
            name="market_value"
            value={facts.market_value ?? ""}
          />
          <input
            type="hidden"
            name="market_value_low"
            value={facts.market_value_low ?? ""}
          />
          <input
            type="hidden"
            name="market_value_high"
            value={facts.market_value_high ?? ""}
          />
          <input
            type="hidden"
            name="property_tax_history"
            value={JSON.stringify(facts.property_tax_history ?? null)}
          />
          <input
            type="hidden"
            name="system_facts"
            value={JSON.stringify(facts.system_facts ?? null)}
          />

          {/* Full name lives here, not on the sign-up form: this is the first
              point it's actually used - claimPropertyAction (./actions.ts)
              matches it against the county's owner-of-record for this address.
              Prefilled from existingName when a name is already on file (Google
              signups, or anyone who set one in account settings) so they aren't
              asked twice; required, since the ownership check needs a name. */}
          <div>
            <label className="label" htmlFor="full_name">
              Your full name
            </label>
            <input
              id="full_name"
              name="full_name"
              className="input"
              type="text"
              autoComplete="name"
              placeholder="e.g. Alex Rivera"
              defaultValue={existingName ?? ""}
              required
            />
            <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
              We check this against the county&apos;s owner-of-record for this
              address, so pros know a job here is real.
            </p>
          </div>

          <div>
            <label className="label">Address</label>
            <input
              name="address_line1"
              className="input"
              defaultValue={facts.address_line1}
              required
            />
          </div>

          {/* The rest of the property facts are all optional and mostly
              auto-filled from public records. Tucked behind a disclosure (same
              pattern as NoticeAtCollection) so the confirm screen stays short:
              name and address are all that's actually needed to claim. */}
          <details className="group">
            <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-sm font-medium text-bark-700 hover:underline dark:text-stone-300 [&::-webkit-details-marker]:hidden">
              Know more details? Add them (optional)
              <span
                aria-hidden
                className="text-stone-400 transition-transform group-open:rotate-180 dark:text-stone-500"
              >
                &#9662;
              </span>
            </summary>

            <div className="mt-3 space-y-4">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <div>
                  <label className="label">State</label>
                  <input name="state" className="input" defaultValue={facts.state ?? ""} />
                </div>
                <div>
                  <label className="label">City</label>
                  <input name="city" className="input" defaultValue={facts.city ?? ""} />
                </div>
                <div>
                  <label className="label">ZIP</label>
                  <input
                    name="zip"
                    className="input"
                    defaultValue={facts.zip ?? ""}
                    placeholder="Auto-filled from city"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label">Year built (optional)</label>
                  <input
                    name="year_built"
                    type="number"
                    className="input"
                    placeholder="Skip if you're not sure"
                    defaultValue={facts.year_built ?? ""}
                  />
                </div>
                <div>
                  <label className="label">Square feet</label>
                  <input
                    name="sqft"
                    type="number"
                    className="input"
                    defaultValue={facts.sqft ?? ""}
                  />
                </div>
                <div>
                  <label className="label">Beds</label>
                  <input
                    name="beds"
                    type="number"
                    className="input"
                    defaultValue={facts.beds ?? ""}
                  />
                </div>
                <div>
                  <label className="label">Baths</label>
                  <input
                    name="baths"
                    type="number"
                    step="0.5"
                    className="input"
                    defaultValue={facts.baths ?? ""}
                  />
                </div>
                <div>
                  <label className="label">Lot size (sqft)</label>
                  <input
                    name="lot_size_sqft"
                    type="number"
                    className="input"
                    defaultValue={facts.lot_size_sqft ?? ""}
                  />
                </div>
                <div>
                  <label className="label">Property type</label>
                  <select
                    name="property_type"
                    className="select"
                    defaultValue={facts.property_type ?? "single_family"}
                  >
                    {PROPERTY_TYPES.map((t) => (
                      <option key={t.value} value={t.value}>
                        {t.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </div>
          </details>

          <p className="rounded-lg bg-bark-50 p-3 text-xs text-bark-700 dark:bg-bark-700/40 dark:text-stone-300">
            By claiming this home you&apos;re confirming you own or manage it.
            We also quietly compare the name on your account against the
            county&apos;s public owner-of-record for this address. It helps pros
            trust that jobs here are real, and nothing bad happens if it
            doesn&apos;t match.
          </p>

          {error && (
            <p
              role="alert"
              className="rounded-lg border border-red-200 bg-red-50 p-3 text-center text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200"
            >
              {error}
            </p>
          )}

          <div className="flex gap-3">
            <button
              type="button"
              className="btn-secondary"
              onClick={() => setStep("address")}
            >
              Back
            </button>
            <button className="btn-primary flex-1" disabled={busy}>
              {busy ? "One moment…" : "Claim my home"}
            </button>
          </div>
        </form>
      )}

      {/* Out-of-area: an honest end state, not a form that keeps rejecting
          the same visitor with nowhere to go. States plainly what happened,
          confirms (or corrects) the waitlist claim, and always leaves a
          working way out - either try again with a different address, or
          sign out entirely. */}
      {step === "out_of_area" && (
        <div className="space-y-4 text-center">
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">
            Hearth isn&apos;t in your area yet
          </h2>
          <p className="break-words text-sm text-stone-600 dark:text-stone-300">
            {waitlistSaved
              ? OC_ONLY_MESSAGE
              : `We couldn't save you to the waitlist. Email us at ${FOUNDER.email} and we'll add you by hand.`}
          </p>
          <p className="text-sm text-stone-500 dark:text-stone-400">
            There&apos;s nothing else to set up here yet since Hearth covers
            Huntington Beach and Fountain Valley right now. Don&apos;t see
            your city yet? You will soon.
          </p>
          <button
            type="button"
            className="btn-secondary w-full"
            onClick={() => {
              setError(null);
              setStep("address");
            }}
          >
            Try a different address
          </button>
          <form action="/auth/signout" method="post">
            <button
              type="submit"
              className="text-sm text-stone-500 hover:underline dark:text-stone-400"
            >
              Sign out
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
