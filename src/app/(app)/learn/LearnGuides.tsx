"use client";

import { useMemo, useRef, useState } from "react";
import LearnGuide from "./LearnGuide";
import { requestTopicAction } from "./actions";
import { SYSTEM_TYPES } from "@/lib/constants";
import SubmitButton from "@/components/SubmitButton";

export type GuideData = {
  systemType: string;
  label: string;
  category: string;
  summary: string;
  lifespan: number | string;
  statusLabel?: string;
  statusStyle?: string;
  age: number | null;
  tips: string[];
  askQuestion: string;
};

const ALL = "All";

// Client shell for the guide list: a live search box, category filter chips,
// and a fallback "request a topic" form for anything the search can't find.
// The page.tsx server component stays thin and just hands over the data.
export default function LearnGuides({ guides }: { guides: GuideData[] }) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState(ALL);
  // Feedback for the "request a topic" form. It stays on /learn, so the outcome
  // comes back as an ActionResult and shows here inline rather than through the
  // flash cookie (unread on a stay-on-page action).
  const [reqMsg, setReqMsg] = useState<{ ok: boolean; text: string } | null>(
    null
  );
  const requestFormRef = useRef<HTMLFormElement>(null);

  const categories = useMemo(() => {
    const seen = new Set<string>();
    const list: string[] = [];
    for (const g of guides) {
      if (!seen.has(g.category)) {
        seen.add(g.category);
        list.push(g.category);
      }
    }
    return list.length > 1 ? [ALL, ...list] : [];
  }, [guides]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return guides.filter((g) => {
      if (category !== ALL && g.category !== category) return false;
      if (!q) return true;
      const haystack = `${g.label} ${g.category} ${g.summary} ${g.tips.join(
        " "
      )}`.toLowerCase();
      return haystack.includes(q);
    });
  }, [guides, query, category]);

  const trimmedQuery = query.trim();

  return (
    <div className="space-y-4">
      <div className="space-y-3">
        <div>
          <label htmlFor="learn-search" className="label">
            Search guides
          </label>
          <input
            id="learn-search"
            type="search"
            className="input"
            placeholder="Search by title or keyword, like leak or filter"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>

        {categories.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {categories.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setCategory(c)}
                aria-pressed={category === c}
                className={`inline-flex min-h-11 items-center rounded-full border px-3 py-1 text-xs font-medium transition-colors sm:inline-block sm:min-h-0 ${
                  category === c
                    ? "border-bark-600 bg-bark-600 text-white"
                    : "border-stone-200 bg-white text-stone-600 hover:border-bark-500 hover:text-bark-700 dark:border-white/10 dark:bg-stone-800 dark:text-stone-300"
                }`}
              >
                {c}
              </button>
            ))}
          </div>
        )}
      </div>

      {filtered.length > 0 ? (
        <ul className="space-y-2">
          {filtered.map((g) => (
            <LearnGuide
              key={g.systemType}
              systemType={g.systemType}
              label={g.label}
              icon={SYSTEM_TYPES.find((t) => t.value === g.systemType)?.icon ?? null}
              summary={g.summary}
              lifespan={g.lifespan}
              statusLabel={g.statusLabel}
              statusStyle={g.statusStyle}
              age={g.age}
              tips={g.tips}
              askQuestion={g.askQuestion}
            />
          ))}
        </ul>
      ) : (
        <p className="card text-sm text-stone-500 dark:text-stone-400">
          No guides match &ldquo;{trimmedQuery}&rdquo;. Try a different word,
          or request a topic below.
        </p>
      )}

      <div className="card">
        <p className="text-sm font-semibold text-stone-700 dark:text-stone-300">
          Don&apos;t see your topic?
        </p>
        <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
          Tell us what you&apos;d like a guide for, and we&apos;ll add it.
        </p>
        <form
          ref={requestFormRef}
          action={async (fd) => {
            const res = await requestTopicAction(fd);
            if (!res.ok) {
              setReqMsg({ ok: false, text: res.error });
              return;
            }
            setReqMsg({ ok: true, text: "Thanks. We'll add a guide for that." });
            requestFormRef.current?.reset();
          }}
          className="mt-3 flex flex-col gap-2 sm:flex-row"
        >
          <input
            key={filtered.length === 0 ? trimmedQuery : "empty"}
            name="question"
            defaultValue={filtered.length === 0 ? trimmedQuery : ""}
            className="input"
            placeholder="e.g. How do I winterize outdoor faucets?"
            required
          />
          <SubmitButton className="btn-secondary shrink-0" pendingLabel="Sending…">
            Request
          </SubmitButton>
        </form>
        {reqMsg && (
          <p
            role={reqMsg.ok ? "status" : "alert"}
            className={`mt-2 text-xs ${
              reqMsg.ok
                ? "text-green-700 dark:text-green-400"
                : "text-red-600 dark:text-red-400"
            }`}
          >
            {reqMsg.text}
          </p>
        )}
      </div>
    </div>
  );
}
