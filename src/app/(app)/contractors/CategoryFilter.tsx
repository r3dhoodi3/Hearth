"use client";

import { useEffect, useState } from "react";
import { SERVICE_CATEGORIES } from "@/lib/constants";
import { useDraftJob } from "./DraftJobContext";
import { categoryForKey, projectOptions } from "./categoryOptionKey";

// The "what do you need?" picker for posting a job. Lists every service category
// a contractor can offer, plus common projects that map to one of them, so a
// homeowner's job reaches the right pros. Project options map to the matchable
// contractor category. defaultValue pre-fills it when arriving from a category
// link (e.g. a project chip on Home). When "Other" is chosen we nudge the owner
// to describe the service, since that free text is what matches them to a pro's
// custom services.

// projectKey/categoryForKey live in categoryOptionKey.ts (small pure helpers,
// unit-tested there): several REMODEL_PROJECTS entries share a category with
// a plain SERVICE_CATEGORIES option, or with each other (e.g. "Water heater"
// and "Plumbing" both map to "plumbing"), and a native <select> is matched by
// its VALUE - two <option>s with the same value are indistinguishable to the
// browser, so picking the second one visually snaps back to whichever
// same-valued option comes first in the DOM. Namespacing each project option
// by its index keeps every <option> in the list unique regardless of shared
// categories.

export default function CategoryFilter({
  category,
  id,
}: {
  category: string;
  // Lets a surrounding <label htmlFor> point at this select.
  id?: string;
}) {
  // On the post-a-job form the category is shared through context, so a
  // photo-drafted category guess can preselect it (and we can tell when the
  // owner picked it themselves). Everywhere else the context is null and this
  // falls back to local state, unchanged.
  const ctx = useDraftJob();
  const [localValue, setLocalValue] = useState(category);
  const value = ctx ? ctx.category : localValue; // canonical category
  const setValue = (v: string) => (ctx ? ctx.setCategory(v) : setLocalValue(v));

  // A fresh ?category= (a project chip tapped on this same page - see
  // ProjectChips) lands as a new `category` prop, but a searchParams-only
  // navigation does not remount this component or its DraftJobProvider:
  // React reuses both across it. Without this, the chip updates the URL and
  // highlights itself while the select underneath silently keeps showing
  // "Choose what you need". Only take the new value when the owner hasn't
  // made their own pick yet, so a chip tapped after they've already chosen
  // something never stomps on it.
  useEffect(() => {
    if (!ctx || !ctx.categoryTouched) setValue(category);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [category]);

  // Which exact <option> the select shows as chosen. Only ever set by our own
  // onChange below - never by an external change to `value` (a fresh
  // ?category= prefill, or DescriptionField's photo-draft guess) - so those
  // keep landing on the plain Service option for that category, same as
  // before this fix. Falls back to the canonical `value` itself whenever it
  // no longer resolves to the same category, which covers both of those
  // external cases automatically with no effect needed.
  const [pickedKey, setPickedKey] = useState<string | null>(null);
  const selectedKey =
    pickedKey && categoryForKey(pickedKey) === value ? pickedKey : value;

  return (
    <>
      <select
        id={id}
        className="select"
        value={selectedKey}
        onChange={(e) => {
          const key = e.target.value;
          setPickedKey(key);
          setValue(categoryForKey(key));
          ctx?.markCategoryTouched();
        }}
        required
      >
        <option value="" disabled>
          Choose what you need
        </option>
        <optgroup label="Services">
          {SERVICE_CATEGORIES.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </optgroup>
        {/* projectOptions(), not REMODEL_PROJECTS directly: two of those
            entries repeat a Services label word for word ("Garage door",
            "Landscaping") and were showing up twice in this one dropdown. */}
        <optgroup label="Popular projects">
          {projectOptions().map((p) => (
            <option key={p.key} value={p.key}>
              {p.label}
            </option>
          ))}
        </optgroup>
        <option value="other">Other (describe it)</option>
      </select>
      {/* postJobAction / updateJobAction only ever read/validate this plain
          category value (e.g. "plumbing") - never which specific project
          option was picked. The select above exists purely so each subtype
          stays visually distinct once chosen; this hidden field is what
          actually reaches the server. */}
      <input type="hidden" name="category" value={value} />
      {value === "other" && (
        <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
          Describe the service in “Details” below so we can match you to a pro who
          offers it.
        </p>
      )}
    </>
  );
}
