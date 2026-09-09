"use client";

import { useEffect, useMemo, useState } from "react";
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
  otherDefault = "",
}: {
  category: string;
  // Lets a surrounding <label htmlFor> point at this select.
  id?: string;
  // Prefill for the inline "Other" free-text box. EditJobForm passes the name
  // it recovered from the job's stored description, so editing an "Other" job
  // doesn't force the owner to retype the service name (the field is
  // `required`). Empty on the post-a-job form, which starts blank.
  otherDefault?: string;
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

  // Search box above the select: filters both option groups by label as the
  // owner types, so a long list is faster to scan on a phone. The currently
  // selected option always stays visible even if it no longer matches the
  // search text, so typing never silently hides what's already chosen.
  const [search, setSearch] = useState("");
  const query = search.trim().toLowerCase();
  const allProjects = useMemo(() => projectOptions(), []);

  const matchedServices = query
    ? SERVICE_CATEGORIES.filter((c) => c.label.toLowerCase().includes(query))
    : SERVICE_CATEGORIES;
  const selectedService = SERVICE_CATEGORIES.find(
    (c) => c.value === selectedKey
  );
  const visibleServices =
    query && selectedService && !matchedServices.includes(selectedService)
      ? [selectedService, ...matchedServices]
      : matchedServices;

  const matchedProjects = query
    ? allProjects.filter((p) => p.label.toLowerCase().includes(query))
    : allProjects;
  const selectedProject = allProjects.find((p) => p.key === selectedKey);
  const visibleProjects =
    query && selectedProject && !matchedProjects.includes(selectedProject)
      ? [selectedProject, ...matchedProjects]
      : matchedProjects;

  // "other" only hides when it plainly doesn't match what's typed, so
  // searching "roof" doesn't leave the fallback option in the list for no
  // reason, but the box always has somewhere to land.
  //
  // The second clause is the important one: searching for something the list
  // genuinely doesn't have ("chimney", "septic") matched no service, no
  // project, and not "other" either, which left the select holding nothing
  // but its own disabled placeholder - a dead end at exactly the moment
  // "Other (describe it)" is the right answer.
  const otherMatches =
    !query ||
    "other".includes(query) ||
    (visibleServices.length === 0 && visibleProjects.length === 0);

  // Local free-text state for "Other". Value only, never validated here (the
  // select's `required` plus the server's own description floor already
  // cover the empty case) - this exists purely to show/hide the label text
  // and to give the field a stable controlled value across re-renders.
  const [otherDetail, setOtherDetail] = useState(otherDefault);

  return (
    <>
      <input
        type="text"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search job types…"
        aria-label="Search job types"
        className="input mb-1.5"
      />
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
        {visibleServices.length > 0 && (
          <optgroup label="Services">
            {visibleServices.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </optgroup>
        )}
        {/* projectOptions(), not REMODEL_PROJECTS directly: two of those
            entries repeat a Services label word for word ("Garage door",
            "Landscaping") and were showing up twice in this one dropdown. */}
        {visibleProjects.length > 0 && (
          <optgroup label="Popular projects">
            {visibleProjects.map((p) => (
              <option key={p.key} value={p.key}>
                {p.label}
              </option>
            ))}
          </optgroup>
        )}
        {otherMatches && <option value="other">Other (describe it)</option>}
      </select>
      {/* postJobAction / updateJobAction only ever read/validate this plain
          category value (e.g. "plumbing") - never which specific project
          option was picked. The select above exists purely so each subtype
          stays visually distinct once chosen; this hidden field is what
          actually reaches the server. */}
      <input type="hidden" name="category" value={value} />
      {value === "other" && (
        <div className="mt-1.5">
          <label className="label" htmlFor={`${id ?? "job-category"}-other`}>
            What service do you need?
          </label>
          <input
            type="text"
            id={`${id ?? "job-category"}-other`}
            name="other_service_name"
            className="input"
            placeholder="e.g. Chimney sweep"
            value={otherDetail}
            onChange={(e) => setOtherDetail(e.target.value)}
            maxLength={80}
            required
          />
          <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
            We add this to the details pros see so we can match you to one who
            offers it.
          </p>
        </div>
      )}
    </>
  );
}
