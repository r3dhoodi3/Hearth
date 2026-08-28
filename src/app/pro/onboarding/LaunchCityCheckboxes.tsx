"use client";

import { useState } from "react";
import { LAUNCH_CITIES, LAUNCH_CITY_GROUPS } from "./launchCities";

// The service-area question: exactly the cities Hearth serves, checkboxes
// because a pro can serve several. Lives in signup AND in the profile editor
// (src/app/pro/profile/PublicProfileForm.tsx), which posts the identical field
// names to the identical action. See ./launchCities.ts for why one answer
// writes service_area, serves_orange_county, and launch_cities.
//
// SHAPE: since 0129 the launch area is all of Orange County, 36 names, and 36
// checkboxes is a wall on a phone. So the default answer is one row, "All of
// Orange County", checked for a new pro. Under it sits a collapsed "Choose
// specific cities instead" link; opening it unchecks "All" and shows the
// cities in four regional groups (LAUNCH_CITY_GROUPS). Checking "All" again
// collapses the list. The two states are one boolean (`all`): the list is open
// exactly when "All" is unchecked, so there is no way to be looking at city
// boxes that the form is about to ignore.
//
// WHAT GETS POSTED: "All of Orange County" is not a value. While it is checked
// this component posts a hidden `service_cities` input for EVERY launch city,
// so saveCompanyAction and selectLaunchCities see the same field they always
// did and need no notion of the shortcut. The wizard's own step check
// (./wizardSteps.ts, which counts service_cities) is satisfied the same way.
//
// AT LEAST ONE REQUIRED, natively: with "All" unchecked, `required` sits on
// EVERY city box while zero are checked, so the browser refuses the submit and
// points at the field; checking any one drops `required` from all of them. No
// custom validation layer, and saveCompanyAction still enforces the same rule
// server-side for anything that isn't a browser.
//
// `requireOne` is the one escape hatch, for the onboarding wizard: there this
// fieldset lives on a step panel that is `hidden` while the pro is on another
// step, and a `required` control inside a hidden panel blocks the submit with a
// browser message that cannot be shown or focused. The wizard passes false while
// its city step is off screen and runs the same "at least one" rule itself
// (see ./wizardSteps.ts). Defaults to true, so the profile editor and any other
// caller keep the native behavior unchanged.
//
// LAYOUT: rows are at least 44px tall on a phone (max-sm:) with the box and
// the name both inside the label, so the whole row is the tap target. City
// boxes sit in a two-column grid (single column only on the narrowest phones,
// where two columns would wrap a city name). No icons, no card chrome.
//
// The hidden marker is what tells saveCompanyAction this form actually asked
// the question, matching the missing-field-safe discipline the rest of that
// action uses: a form without the marker must never have its stored service
// area rewritten from an absent answer.
//
// `defaultCities` is what the profile editor passes so a returning pro sees
// their stored pick already checked (signup passes nothing). Nothing stored,
// or every city stored, starts as "All" checked and the list collapsed; a
// narrower pick starts with "All" unchecked and the list open on those boxes,
// so a pro who narrowed keeps their narrowing across an unrelated profile
// save. Anything that isn't a launch city is ignored here, and
// selectLaunchCities drops it server-side too, so a stale or hand-edited
// value can never pre-check a city Hearth doesn't serve. When "All" starts
// checked (nothing stored, or every city stored - the onboarding draft
// re-posts every city while a pro leaves "All" checked, so a resumed draft
// hits this same path), opening the disclosure starts every box unchecked
// rather than pre-checking all of them: there is no real narrowing to
// restore in that case, only a genuine partial pick is.
export default function LaunchCityCheckboxes({
  defaultCities = [],
  requireOne = true,
}: {
  defaultCities?: readonly string[];
  requireOne?: boolean;
}) {
  const initial = LAUNCH_CITIES.filter((city) =>
    defaultCities.some((c) => String(c).trim().toLowerCase() === city.toLowerCase())
  );
  // Nothing stored and everything stored both read as "All", collapsed. In
  // neither case is `initial` a pro's actual narrowing, so the specific-city
  // list underneath the disclosure must not seed from it: opening the
  // disclosure always starts from zero in these two cases, never from every
  // box pre-checked. Only a genuine partial pick (some but not all cities)
  // is a narrowing worth restoring when the disclosure opens.
  const isFullOrEmpty =
    initial.length === 0 || initial.length === LAUNCH_CITIES.length;
  const [all, setAll] = useState(isFullOrEmpty);
  const [checked, setChecked] = useState<readonly string[]>(
    isFullOrEmpty ? [] : initial
  );
  const noneChecked = requireOne && !all && checked.length === 0;

  const rowClass =
    "flex items-center gap-3 py-1 text-sm text-stone-700 max-sm:min-h-[44px] max-sm:text-base dark:text-stone-300";
  const boxClass =
    "h-4 w-4 shrink-0 rounded border-stone-300 text-bark-600 focus:ring-bark-500 max-sm:h-5 max-sm:w-5 dark:border-white/20";

  return (
    <div>
      <input type="hidden" name="service_cities_present" value="1" />
      {all &&
        LAUNCH_CITIES.map((city) => (
          <input key={city} type="hidden" name="service_cities" value={city} />
        ))}

      <label className={`${rowClass} font-medium`}>
        <input
          type="checkbox"
          checked={all}
          onChange={(e) => setAll(e.target.checked)}
          className={boxClass}
        />
        <span>All of Orange County</span>
      </label>

      {all ? (
        <button
          type="button"
          onClick={() => setAll(false)}
          className="mt-1 inline-flex items-center py-1 text-sm text-bark-700 underline underline-offset-2 hover:text-bark-800 max-sm:min-h-[44px] max-sm:text-base dark:text-stone-300"
        >
          Pick specific cities instead
        </button>
      ) : (
        <div className="mt-2 space-y-4">
          <p className="text-xs text-stone-500 dark:text-stone-400">
            Check every city you serve. Check All of Orange County above to go
            back to the whole county.
          </p>
          {LAUNCH_CITY_GROUPS.map((group) => (
            <div key={group.label}>
              <p className="mb-1 text-xs font-semibold text-stone-500 dark:text-stone-400">
                {group.label}
              </p>
              <div className="grid grid-cols-1 gap-x-4 min-[380px]:grid-cols-2">
                {group.cities.map((city) => (
                  <label key={city} className={rowClass}>
                    <input
                      type="checkbox"
                      name="service_cities"
                      value={city}
                      checked={checked.includes(city)}
                      required={noneChecked}
                      onChange={(e) =>
                        setChecked((prev) =>
                          e.target.checked
                            ? [...prev, city]
                            : prev.filter((c) => c !== city)
                        )
                      }
                      className={boxClass}
                    />
                    <span className="min-w-0">{city}</span>
                  </label>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
