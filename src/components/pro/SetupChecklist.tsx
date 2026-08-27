import Link from "next/link";

export type SetupItem = {
  label: string;
  done: boolean;
  href: string;
  linkLabel: string;
  // Optional one-line reason shown under the label in smaller text.
  hint?: string;
  // A step this pro's account cannot actually complete right now (today: the
  // logo, which is a Pro-member cosmetic). It still shows, so the pro knows
  // the step exists and where it leads, but it is left OUT of the progress
  // count: an undone-forever item would otherwise pin the card open at "4 of
  // 5" and turn a setup guide into a permanent upsell.
  optional?: boolean;
};

// First-session guide for a new pro. Every item is derived from data the
// dashboard already fetches (no new tables, no extra queries), so the card is
// fully stateless: it shows while any step is open and disappears on its own
// once everything is done. Progress bar matches the homeowner dashboard's.
export default function SetupChecklist({ items }: { items: SetupItem[] }) {
  // Progress counts only the steps the pro can actually finish.
  const counted = items.filter((i) => !i.optional);
  const done = counted.filter((i) => i.done).length;
  if (done >= counted.length) return null;

  return (
    <section className="card space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-stone-900 dark:text-stone-100">
            Finish setting up
          </h2>
          <p className="text-sm text-stone-500 dark:text-stone-400">
            A complete profile wins more jobs. A few small steps and you&apos;re
            ready to go.
          </p>
        </div>
        <p className="shrink-0 text-xs text-stone-500 dark:text-stone-400">
          {done} of {counted.length} done
        </p>
      </div>

      <div className="h-1.5 w-full overflow-hidden rounded-full bg-stone-100 dark:bg-stone-700">
        <div
          className="h-full rounded-full bg-green-500 transition-all"
          style={{
            width: `${counted.length ? Math.round((done / counted.length) * 100) : 100}%`,
          }}
        />
      </div>

      <ul className="space-y-2">
        {items.map((item) => (
          <li
            key={item.label}
            className="flex items-center justify-between gap-3 text-sm"
          >
            <span
              className={`flex items-center gap-2 ${
                item.done ? "text-stone-500 line-through dark:text-stone-400" : "text-stone-700 dark:text-stone-300"
              }`}
            >
              <span
                className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[11px] font-bold ${
                  item.done
                    ? "border-green-200 bg-green-50 text-green-600 dark:border-green-900 dark:bg-green-950/40 dark:text-green-400"
                    : "border-stone-200 bg-white text-transparent dark:border-white/10 dark:bg-stone-800"
                }`}
                aria-hidden
              >
                ✓
              </span>
              <span className="flex flex-col">
                <span>{item.label}</span>
                {item.hint && !item.done && (
                  <span className="text-xs text-stone-500 dark:text-stone-400">
                    {item.hint}
                  </span>
                )}
              </span>
            </span>
            {!item.done && (
              <Link
                href={item.href}
                // max-sm: only - below 40px tall as a plain text link, these
                // were confirmed too small to tap reliably on a phone.
                // Desktop keeps the original compact inline link untouched.
                className="shrink-0 text-sm font-medium text-hearth-700 hover:underline max-sm:flex max-sm:min-h-11 max-sm:items-center max-sm:py-2 dark:text-hearth-300"
              >
                {item.linkLabel} →
              </Link>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
