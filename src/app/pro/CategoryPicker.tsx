"use client";

// JSX imported explicitly: React 19's types no longer install a GLOBAL `JSX`
// namespace, they export it from "react" instead, so the bare `JSX.Element`
// below stopped resolving.
import { useState, type JSX } from "react";
import { SERVICE_CATEGORIES } from "@/lib/constants";

const CANONICAL = new Set<string>(SERVICE_CATEGORIES.map((c) => c.value));

// Selectable service-category cards plus a free-text "Other". Selected canonical
// values and any typed "Other" service are submitted as repeated hidden inputs
// named "categories", which saveCompanyAction reads with getAll. Shared by the
// onboarding and edit-profile forms so they stay identical.
export default function CategoryPicker({
  defaultSelected,
}: {
  defaultSelected: string[];
}) {
  const [selected, setSelected] = useState<Set<string>>(
    new Set(defaultSelected.filter((v) => CANONICAL.has(v)))
  );
  // Anything stored that isn't a canonical value is treated as the custom
  // "Other" service, so it round-trips on edit.
  const [other, setOther] = useState(
    defaultSelected.filter((v) => !CANONICAL.has(v)).join(", ")
  );

  function toggle(value: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });
  }

  const otherActive = other.trim().length > 0;

  return (
    <div className="grid grid-cols-2 gap-3">
      {SERVICE_CATEGORIES.map((c) => {
        const on = selected.has(c.value);
        return (
          <button
            key={c.value}
            type="button"
            onClick={() => toggle(c.value)}
            aria-pressed={on}
            className={`relative flex items-center gap-3 rounded-xl border px-3 py-3 text-left transition-colors ${
              on
                ? "border-bark-500 bg-bark-50 ring-1 ring-bark-500 dark:border-bark-400 dark:bg-bark-900/40 dark:ring-bark-400"
                : "border-stone-200 bg-white hover:bg-stone-50 dark:border-white/10 dark:bg-stone-800 dark:hover:bg-stone-700"
            }`}
          >
            <span
              className={`pr-6 text-sm font-medium ${
                on ? "text-bark-700 dark:text-bark-300" : "text-stone-700 dark:text-stone-300"
              }`}
            >
              {c.label}
            </span>
            {on && (
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-bark-600 dark:text-bark-400">
                <svg viewBox="0 0 20 20" className="h-4 w-4" fill="currentColor">
                  <path
                    fillRule="evenodd"
                    d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.7-9.3a1 1 0 00-1.4-1.4L9 10.6 7.7 9.3a1 1 0 00-1.4 1.4l2 2a1 1 0 001.4 0l4-4z"
                    clipRule="evenodd"
                  />
                </svg>
              </span>
            )}
          </button>
        );
      })}

      {/* Full-width "Other". Describe a service not listed above. */}
      <div
        className={`col-span-2 flex items-center gap-3 rounded-xl border px-3 py-3 transition-colors ${
          otherActive
            ? "border-bark-500 bg-bark-50 ring-1 ring-bark-500 dark:border-bark-400 dark:bg-bark-900/40 dark:ring-bark-400"
            : "border-stone-200 bg-white dark:border-white/10 dark:bg-stone-800"
        }`}
      >
        <span
          className={`shrink-0 text-sm font-medium ${
            otherActive ? "text-bark-700 dark:text-bark-300" : "text-stone-700 dark:text-stone-300"
          }`}
        >
          Other
        </span>
        <input
          type="text"
          value={other}
          onChange={(e) => setOther(e.target.value)}
          // Short on purpose: the longer version was cut off mid-word at
          // 390px, where this input shares its row with the "Other" label.
          placeholder="Describe your service"
          className="min-w-0 flex-1 border-0 bg-transparent text-base text-stone-700 placeholder:text-stone-500 focus:outline-none focus:ring-0 sm:text-sm dark:text-stone-200 dark:placeholder:text-stone-500"
        />
      </div>

      {/* Submit selected categories + any custom "Other" service. */}
      {[...selected].map((v) => (
        <input key={v} type="hidden" name="categories" value={v} />
      ))}
      {otherActive && (
        <input type="hidden" name="categories" value={other.trim()} />
      )}
    </div>
  );
}
