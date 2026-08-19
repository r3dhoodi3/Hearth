"use client";

import { useMemo, useState } from "react";
import PlaybookGuide from "./PlaybookGuide";
import type { PlaybookGuideData } from "./guides";

// Client shell for the playbook: a live search box over the guide list,
// mirroring the homeowner Learn tab (minus the filter chips - nine guides
// don't need categories).
export default function PlaybookGuides({
  guides,
}: {
  guides: PlaybookGuideData[];
}) {
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return guides;
    return guides.filter((g) => {
      const haystack = `${g.title} ${g.summary} ${g.sections
        .map((s) => `${s.title} ${s.body.join(" ")}`)
        .join(" ")}`.toLowerCase();
      return haystack.includes(q);
    });
  }, [guides, query]);

  return (
    <div className="space-y-4">
      <div>
        <label htmlFor="playbook-search" className="label">
          Search the playbook
        </label>
        <input
          id="playbook-search"
          type="search"
          className="input"
          placeholder="Search by topic, like credit or pricing"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {filtered.length > 0 ? (
        <ul className="space-y-2">
          {filtered.map((g) => (
            <PlaybookGuide key={g.id} guide={g} />
          ))}
        </ul>
      ) : (
        <p className="card text-sm text-stone-500 dark:text-stone-400">
          No guides match &ldquo;{query.trim()}&rdquo;. Try a different word.
        </p>
      )}
    </div>
  );
}
