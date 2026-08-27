import { Skeleton, SkeletonLine } from "@/components/Skeleton";

// Mirrors the pitch branch of page.tsx (the state a non-member pro sees, and
// the widest of the states this URL can render): the centered heading, the
// "membership never touches lead access" note, the perks grid, and
// ProPlanToggle's three columns (Free, Yearly, Monthly). Pinned to the same
// max-w-3xl measure the pitch branch uses so the width doesn't jump once the
// real page mounts.
export default function Loading() {
  return (
    <div className="mx-auto max-w-3xl space-y-8" aria-hidden="true">
      <div className="space-y-2 text-center">
        <Skeleton className="mx-auto h-7 w-64 sm:h-9" />
        <Skeleton className="mx-auto h-4 w-72" />
        <Skeleton className="mx-auto mt-3 h-10 w-48 rounded-lg" />
        <Skeleton className="mx-auto h-3 w-56" />
      </div>

      <Skeleton className="h-12 w-full rounded-xl" />

      {/* Perks grid */}
      <div className="grid gap-4 sm:grid-cols-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="card space-y-2">
            <Skeleton className="h-9 w-9 rounded-lg" />
            <Skeleton className="h-4 w-1/2" />
            <SkeletonLine width="w-full" />
            <SkeletonLine width="w-2/3" />
          </div>
        ))}
      </div>

      {/* ProPlanToggle's trial block: button, the one line under it, then the
          auto-renewal disclosure. */}
      <div className="space-y-2 rounded-2xl border border-stone-200 p-4 dark:border-white/10">
        <Skeleton className="h-11 w-full rounded-lg" />
        <Skeleton className="mx-auto h-4 w-64" />
        <Skeleton className="h-24 w-full rounded-xl" />
      </div>

      {/* ProPlanToggle: Free / Yearly / Monthly columns. The two paid columns
          are the selector, so no column carries a button of its own. */}
      <div className="grid gap-3 sm:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="card space-y-2">
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-7 w-2/3" />
            <div className="space-y-1.5">
              <SkeletonLine width="w-full" />
              <SkeletonLine width="w-5/6" />
              <SkeletonLine width="w-2/3" />
            </div>
          </div>
        ))}
      </div>

      {/* The single checkout block: price recap, disclosure, one button. */}
      <div className="space-y-2 rounded-2xl border border-stone-200 p-4 dark:border-white/10">
        <Skeleton className="mx-auto h-7 w-40" />
        <Skeleton className="h-24 w-full rounded-xl" />
        <Skeleton className="h-11 w-full rounded-lg" />
      </div>

      <Skeleton className="mx-auto h-3 w-40" />
    </div>
  );
}
