"use client";

import { useState } from "react";
import { LAUNCH_CITIES } from "./launchCities";

// The service-area question: exactly the cities Hearth serves, checkboxes
// because a pro can serve several. Replaces the free-text city combobox that used
// to live here, in signup AND in the profile editor
// (src/app/pro/profile/PublicProfileForm.tsx), which posts the identical field
// names to the identical action. See ./launchCities.ts for why one answer
// writes service_area, serves_orange_county, and launch_cities.
//
// AT LEAST ONE REQUIRED, natively: `required` sits on EVERY box while zero
// are checked, so the browser refuses the submit and points at the field;
// checking any one drops `required` from all of them, so the rest are free to
// stay unchecked. No custom validation layer, and saveCompanyAction still
// enforces the same rule server-side for anything that isn't a browser.
//
// `requireOne` is the one escape hatch, for the onboarding wizard: there this
// fieldset lives on a step panel that is `hidden` while the pro is on another
// step, and a `required` control inside a hidden panel blocks the submit with a
// browser message that cannot be shown or focused. The wizard passes false while
// its city step is off screen and runs the same "at least one" rule itself
// (see ./wizardSteps.ts). Defaults to true, so the profile editor and any other
// caller keep the native behavior unchanged.
//
// LAYOUT: nine cities in one column is a scroll of its own, so the boxes sit
// in a two-column grid (single column only on the narrowest phones, where two
// columns would wrap a city name). No icons, no card chrome - the same plain
// checkbox rows as before, just packed.
//
// The hidden marker is what tells saveCompanyAction this form actually asked
// the question, matching the missing-field-safe discipline the rest of that
// action uses: a form without the marker must never have its stored service
// area rewritten from an absent answer.
// `defaultCities` is what the profile editor passes so a returning pro sees
// their stored pick already checked (signup passes nothing and starts empty).
// Anything that isn't a launch city is ignored here, and selectLaunchCities
// drops it server-side too, so a stale or hand-edited value can never
// pre-check a city Hearth doesn't serve.
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
  const [checked, setChecked] = useState<readonly string[]>(initial);
  const noneChecked = requireOne && checked.length === 0;

  return (
    <div className="grid grid-cols-1 gap-x-4 gap-y-2 min-[380px]:grid-cols-2">
      <input type="hidden" name="service_cities_present" value="1" />
      {LAUNCH_CITIES.map((city) => (
        <label
          key={city}
          className="flex items-start gap-2 text-sm text-stone-700 dark:text-stone-300"
        >
          <input
            type="checkbox"
            name="service_cities"
            value={city}
            defaultChecked={initial.includes(city)}
            required={noneChecked}
            onChange={(e) =>
              setChecked((prev) =>
                e.target.checked
                  ? [...prev, city]
                  : prev.filter((c) => c !== city)
              )
            }
            className="mt-0.5 h-4 w-4 rounded border-stone-300 text-bark-600 focus:ring-bark-500 dark:border-white/20"
          />
          <span>{city}</span>
        </label>
      ))}
    </div>
  );
}
