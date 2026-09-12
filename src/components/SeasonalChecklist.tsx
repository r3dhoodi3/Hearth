"use client";

import { useEffect, useState } from "react";
import { useChecklist } from "@/components/ChecklistProvider";

// Checklist with clickable checkmarks. The task CONTENT is seasonal, but the
// checked + hidden state is remembered per `period` (a year-month like
// "2026-06"), so it resets on the 1st of each month for a fresh nudge.
export default function SeasonalChecklist({
  period,
  tasks,
}: {
  period: string;
  tasks: string[];
}) {
  const key = `oaktend_checklist_${period}`;
  const hiddenKey = `oaktend_checklist_hidden_${period}`;
  const [done, setDone] = useState<Record<number, boolean>>({});
  const [hidden, setHidden] = useState<Record<number, boolean>>({});
  const checklist = useChecklist();

  useEffect(() => {
    let loaded: Record<number, boolean> = {};
    let loadedHidden: Record<number, boolean> = {};
    try {
      const raw = localStorage.getItem(key);
      if (raw) loaded = JSON.parse(raw);
      const rawH = localStorage.getItem(hiddenKey);
      if (rawH) loadedHidden = JSON.parse(rawH);
    } catch {
      /* ignore */
    }
    setDone(loaded);
    setHidden(loadedHidden);
    tasks.forEach((_, i) => {
      if (!loadedHidden[i]) checklist?.register(`${period}-${i}`, !!loaded[i]);
    });
    return () =>
      tasks.forEach((_, i) => checklist?.unregister(`${period}-${i}`));
  }, [key, hiddenKey, period, tasks, checklist]);

  function toggle(i: number) {
    setDone((prev) => {
      const next = { ...prev, [i]: !prev[i] };
      try {
        localStorage.setItem(key, JSON.stringify(next));
      } catch {
        /* ignore */
      }
      checklist?.report(`${period}-${i}`, !!next[i]);
      return next;
    });
  }

  function remove(i: number) {
    setHidden((prev) => {
      const next = { ...prev, [i]: true };
      try {
        localStorage.setItem(hiddenKey, JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    });
    checklist?.unregister(`${period}-${i}`);
  }

  // Plain <li> rows (no <ul>/card) so it shares the "This month" list.
  return (
    <>
      {tasks.map((t, i) =>
        hidden[i] ? null : (
          <li key={i} className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => toggle(i)}
              // The done state is otherwise only conveyed visually, so expose
              // it as a checkbox to assistive tech.
              role="checkbox"
              aria-checked={!!done[i]}
              aria-label={t}
              className="flex min-h-[44px] items-center gap-2 py-1.5 text-left text-sm"
            >
              <span
                className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border text-[10px] ${
                  done[i]
                    ? "border-green-500 bg-green-500 text-white"
                    : "border-stone-400 text-transparent dark:border-stone-500"
                }`}
              >
                ✓
              </span>
              <span
                className={
                  done[i]
                    ? "text-stone-500 line-through dark:text-stone-400"
                    : "text-stone-800 dark:text-stone-200"
                }
              >
                {t}
              </span>
            </button>
            {done[i] && (
              <button
                type="button"
                onClick={() => remove(i)}
                className="flex min-h-[44px] items-center px-1 text-xs text-stone-500 hover:text-red-600 dark:text-stone-400 dark:hover:text-red-400"
              >
                Delete
              </button>
            )}
          </li>
        )
      )}
    </>
  );
}
