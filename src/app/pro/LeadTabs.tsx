import Link from "next/link";

// Status filter tabs for the leads list. Plain links that set ?status= so the
// server query re-runs - no client JS needed. `active` is the current filter.
export type LeadTab = {
  value: string; // "" = all
  label: string;
  count: number;
};

export default function LeadTabs({
  tabs,
  active,
}: {
  tabs: LeadTab[];
  active: string;
}) {
  return (
    <nav className="-mx-1 flex items-center gap-1 overflow-x-auto px-1">
      {tabs.map((t) => {
        const isActive = active === t.value;
        const href = t.value ? `/pro?status=${t.value}` : "/pro";
        return (
          <Link
            key={t.value || "all"}
            href={href}
            className={`flex items-center gap-1.5 whitespace-nowrap rounded-full px-3 py-1.5 text-sm font-medium transition max-sm:min-h-11 ${
              isActive
                ? "bg-stone-900 text-white dark:bg-stone-700"
                : "text-stone-500 hover:bg-stone-100 hover:text-stone-800 dark:text-stone-400 dark:hover:bg-stone-800 dark:hover:text-stone-100"
            }`}
          >
            {t.label}
            <span
              className={`rounded-full px-1.5 text-xs ${
                isActive
                  ? "bg-white/20 text-white"
                  : "bg-stone-100 text-stone-500 dark:bg-stone-800 dark:text-stone-400"
              }`}
            >
              {t.count}
            </span>
          </Link>
        );
      })}
    </nav>
  );
}
