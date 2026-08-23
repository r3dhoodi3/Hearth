"use client";

import { useEffect, useId, useState } from "react";

// An interactive maintenance-basics card: shows the owner's actual system status
// inline, a short summary that's always visible, checkable upkeep steps
// (remembered per system) once expanded, and buttons that fire a question into
// Ask Hearth (the box at the top of Learn). Personalized + tied to the AI - the
// thing a Google search can't be.
export default function LearnGuide({
  systemType,
  label,
  summary,
  lifespan,
  statusLabel,
  statusStyle,
  age,
  tips,
  askQuestion,
}: {
  systemType: string;
  label: string;
  summary: string;
  lifespan: number | string;
  statusLabel?: string;
  statusStyle?: string;
  age?: number | null;
  tips: string[];
  askQuestion: string;
}) {
  const key = `hearth_guide_${systemType}`;
  const panelId = useId();
  const [open, setOpen] = useState(false);
  const [checked, setChecked] = useState<Record<number, boolean>>({});

  useEffect(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw) setChecked(JSON.parse(raw));
    } catch {
      /* ignore */
    }
  }, [key]);

  function toggle(i: number) {
    setChecked((prev) => {
      const next = { ...prev, [i]: !prev[i] };
      try {
        localStorage.setItem(key, JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  }

  function ask(q: string) {
    window.dispatchEvent(new CustomEvent("hearth:ask-question", { detail: q }));
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  return (
    <li className="card">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={panelId}
        className="flex w-full items-center justify-between gap-2 text-left font-medium text-stone-900 max-sm:-my-2 max-sm:min-h-10 max-sm:py-2 dark:text-stone-100"
      >
        <span className="flex flex-wrap items-center gap-2">
          <span>{label}</span>
          {statusLabel && (
            <span
              className={`rounded-full border px-2 py-0.5 text-xs ${statusStyle ?? ""}`}
            >
              {statusLabel}
            </span>
          )}
        </span>
        <span
          className={`shrink-0 text-lg text-stone-500 transition-transform duration-200 dark:text-stone-400 ${
            open ? "rotate-180" : ""
          }`}
          aria-hidden="true"
        >
          ⌄
        </span>
      </button>

      <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">{summary}</p>

      <div
        id={panelId}
        role="region"
        aria-hidden={!open}
        className={`grid transition-all duration-200 ease-out ${
          open ? "mt-3 grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"
        }`}
      >
        <div className="overflow-hidden">
          <p className="text-xs text-stone-500 dark:text-stone-400">
            Typical lifespan: {lifespan} years
            {age != null ? ` · yours is about ${age} yrs old` : ""}
          </p>

          <ul className="mt-2 space-y-1.5">
            {tips.map((t, i) => (
              <li key={i}>
                <button
                  type="button"
                  onClick={() => toggle(i)}
                  tabIndex={open ? 0 : -1}
                  className="flex min-h-11 items-start gap-2 text-left text-sm sm:min-h-0"
                >
                  <span
                    className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border text-[10px] ${
                      checked[i]
                        ? "border-green-500 bg-green-500 text-white"
                        : "border-stone-300 text-transparent"
                    }`}
                  >
                    ✓
                  </span>
                  <span
                    className={
                      checked[i]
                        ? "text-stone-500 line-through dark:text-stone-500"
                        : "text-stone-600 dark:text-stone-300"
                    }
                  >
                    {t}
                  </span>
                </button>
              </li>
            ))}
          </ul>

          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => ask(askQuestion)}
              tabIndex={open ? 0 : -1}
              className="btn-primary px-3 py-1.5 text-xs"
            >
              Ask Hearth about this
            </button>
            <button
              type="button"
              onClick={() =>
                ask(
                  `Something seems off with my ${label.toLowerCase()}. Can you help me figure out what's going on and whether I need a pro?`
                )
              }
              tabIndex={open ? 0 : -1}
              className="inline-flex min-h-11 items-center rounded-lg border border-stone-200 px-3 py-1.5 text-xs font-medium text-stone-600 hover:border-bark-500 hover:text-bark-700 sm:inline-block sm:min-h-0 dark:border-white/10 dark:text-stone-300"
            >
              Something wrong?
            </button>
          </div>
        </div>
      </div>
    </li>
  );
}
