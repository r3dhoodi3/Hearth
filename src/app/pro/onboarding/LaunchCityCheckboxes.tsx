"use client";

import { useState } from "react";
import { LAUNCH_CITIES } from "./launchCities";

// The signup service-area question: exactly the two cities Hearth serves,
// checkboxes because a pro can serve both. Replaces the free-text city
// combobox that used to live here (the profile editor still has that; see
// ./launchCities.ts for why signup writes both service_area and
// serves_orange_county from this one answer).
//
// AT LEAST ONE REQUIRED, natively: `required` sits on BOTH boxes while zero
// are checked, so the browser refuses the submit and points at the field;
// checking either one drops `required` from both, so the other box is free to
// stay unchecked. No custom validation layer, and saveCompanyAction still
// enforces the same rule server-side for anything that isn't a browser.
//
// The hidden marker is what tells saveCompanyAction this form actually asked
// the question, matching the missing-field-safe discipline the rest of that
// action uses: a form without the marker (the profile edit form) must never
// have its stored service area rewritten from an absent answer.
export default function LaunchCityCheckboxes() {
  const [checked, setChecked] = useState<readonly string[]>([]);
  const noneChecked = checked.length === 0;

  return (
    <div className="space-y-2">
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
