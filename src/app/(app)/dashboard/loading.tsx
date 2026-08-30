import { Skeleton, SkeletonLine, SkeletonCard, SkeletonRow } from "@/components/Skeleton";

// Mirrors dashboard/page.tsx: the 4-tile stats grid (health score tile first,
// given an extra line since its card-hero has a "why this score" disclosure
// the other three don't - now a one-liner, not a paragraph), the "This
// month" card (briefing + progress line + one collapsed "see tasks" row,
// standing in for the details element), the Plus CTA + 3-tile tools row
// (now compact, no description paragraph), a few system rows, and the
// project-chip row.
export default function Loading() {
  return (
    <div className="space-y-8" aria-hidden="true">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="card space-y-2">
          <SkeletonLine width="w-28" />
          <Skeleton className="h-9 w-16" />
          <SkeletonLine width="w-2/3" />
          <SkeletonLine width="w-1/3" />
        </div>
        {/* Phone: only the health score tile is real down here. Open jobs,
            Home value, and Energy this season are all max-sm:hidden on the
            page, so placeholders for them would be three cards that vanish
            the moment the page arrives. Desktop still gets all four. */}
        <div className="card space-y-2 max-sm:hidden">
          <SkeletonLine width="w-20" />
          <Skeleton className="h-6 w-24" />
          <SkeletonLine width="w-3/4" />
        </div>
        <div className="card space-y-2 max-sm:hidden">
          <SkeletonLine width="w-20" />
          <Skeleton className="h-6 w-24" />
          <SkeletonLine width="w-3/4" />
        </div>
        <div className="card space-y-2 max-sm:hidden">
          <SkeletonLine width="w-28" />
          <Skeleton className="h-6 w-24" />
          <SkeletonLine width="w-3/4" />
        </div>
      </div>

      <div className="space-y-3">
        <Skeleton className="h-5 w-28" />
        <div className="card space-y-3">
          <SkeletonLine width="w-full" />
          <SkeletonLine width="w-2/3" />
          <SkeletonLine width="w-1/2" />
          <SkeletonLine width="w-40" />
        </div>
      </div>

      <div className="space-y-3">
        <Skeleton className="h-5 w-52" />
        <SkeletonCard lines={2} />
        <div className="grid grid-cols-3 gap-2 sm:gap-4">
          <SkeletonCard lines={2} />
          <SkeletonCard lines={2} />
          <SkeletonCard lines={2} />
        </div>
      </div>

      <div className="space-y-3">
        <Skeleton className="h-5 w-32" />
        <SkeletonRow />
        <SkeletonRow />
        <SkeletonRow />
      </div>

      {/* Thinking about a project? heading, one-line intro, then the
          remodel-project chip row. */}
      <div className="space-y-3">
        <Skeleton className="h-5 w-56" />
        <SkeletonLine width="w-2/3" />
        <div className="flex flex-wrap gap-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-8 w-24 rounded-full" />
          ))}
        </div>
      </div>
    </div>
  );
}
