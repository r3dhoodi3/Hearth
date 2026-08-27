"use client";

import { useEffect, useRef, useState } from "react";
import { photoTipsFor } from "@/lib/constants";

// Quiet per-category shot list under the photo picker: once a category is
// chosen, tells the homeowner exactly what to photograph (a leak close-up,
// the shutoff valve, a coin next to the crack for scale). Like
// StrongPostMeter, it finds the surrounding <form> from its own position and
// watches the form's "category" select, so it drops into any form that has
// one (post-a-job, report-an-issue) with no rewiring.
export default function PhotoTips() {
  const ref = useRef<HTMLDivElement>(null);
  const [category, setCategory] = useState("");

  useEffect(() => {
    const form = ref.current?.closest("form");
    if (!form) return;

    const read = () => {
      const sel = form.elements.namedItem(
        "category"
      ) as HTMLInputElement | HTMLSelectElement | null;
      setCategory(sel?.value ?? "");
    };

    // On the post-a-job form, `name="category"` is a hidden <input> that
    // CategoryFilter writes via React state (its own visible <select> has no
    // `name`), not a field the browser itself changes - so React setting it
    // fires no native DOM event at all. A "change" bubbling up from that
    // visible <select> reaches this form-level listener BEFORE React's own
    // onChange runs (this listener sits on the form, closer to the target
    // than React's root listener, so it's earlier in the bubble order),
    // which means a synchronous read here always sees last event's value,
    // never the one that just happened. It would only ever catch up whenever
    // some OTHER field later fired its own change/input - e.g. the
    // description textarea's blur - which is what used to mount this ~130px
    // block late, right as a tap on Post job was already in flight (see
    // PostJobButton). Deferring the read past the current tick lets React's
    // setState from that same event commit first, so it reads the fresh
    // value instead of the stale one.
    const readSoon = () => setTimeout(read, 0);
    // Typing elsewhere in the form (the description) also re-triggers a
    // read, debounced, so this settles while the owner is still typing
    // instead of only when they blur out to tap Post.
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const readDebounced = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(read, 300);
    };

    read();
    form.addEventListener("change", readSoon);
    form.addEventListener("input", readDebounced);
    return () => {
      form.removeEventListener("change", readSoon);
      form.removeEventListener("input", readDebounced);
      if (debounceTimer) clearTimeout(debounceTimer);
    };
  }, []);

  const tips = category ? photoTipsFor(category) : [];

  // The outer div always renders (even with nothing picked yet) so the ref
  // exists for the closest("form") lookup above.
  return (
    <div ref={ref} className={tips.length ? "mt-2 rounded-lg bg-stone-50 p-3 dark:bg-stone-800" : undefined}>
      {tips.length > 0 && (
        <>
          <p className="text-xs font-medium text-stone-600 dark:text-stone-300">
            Good shots to include
          </p>
          <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs text-stone-500 dark:text-stone-400">
            {tips.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
