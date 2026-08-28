import Link from "next/link";
import { REMODEL_PROJECTS } from "@/lib/constants";

// The "Thinking about a project?" chip row, shared by the dashboard (desktop
// only now - it is max-sm:hidden there) and the top of /contractors (phone
// only). It used to be inline JSX on the dashboard alone; two copies of the
// same twenty-one chips would have drifted the moment either list changed, so
// the row lives here and both pages render the same markup.
//
// Every chip lands on /contractors?category=<x>, which prefills the "What do
// you need?" select on the Post a job form via DraftJobProvider. Chips clear
// 44px on phone (max-sm:min-h-11) and are plain text labels - the
// REMODEL_PROJECTS icon field is not rendered anywhere.
export default function ProjectChips() {
  const chipClass =
    "focus-ring rounded-full border border-stone-200 bg-white px-3 py-1.5 text-sm text-stone-700 shadow-sm hover:border-bark-500 hover:text-bark-700 max-sm:inline-flex max-sm:min-h-11 max-sm:items-center dark:border-white/10 dark:bg-stone-800 dark:text-stone-300 dark:hover:border-bark-600 dark:hover:text-stone-300";
  return (
    <div className="flex flex-wrap gap-2">
      {REMODEL_PROJECTS.map((p) => (
        <Link key={p.label} href={`/contractors?category=${p.category}`} className={chipClass}>
          {p.label}
        </Link>
      ))}
      <Link href="/contractors?category=other" className={chipClass}>
        Other
      </Link>
    </div>
  );
}
