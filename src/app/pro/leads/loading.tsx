import { Skeleton, SkeletonLine } from "@/components/Skeleton";

// Mirrors pro/leads/page.tsx, the leads board. (/pro is the Home tab now and
// keeps its own skeleton at pro/loading.tsx.) The pro shell's <main> already
// provides the max-w-5xl container, so this paints the page's own stack: the
// "Your leads" heading, the results card, the two-up stat tiles (active jobs /
// wallet), the Open jobs section with a few job cards, and the Your jobs
// section.
export default function Loading() {
  return (
    <div className="space-y-8" aria-hidden="true">
      {/* Page heading: "Your leads" */}
      <Skeleton className="h-7 w-40" />

      {/* Your results card */}
      <div className="card space-y-2">
        <Skeleton className="h-3 w-24" />
        <SkeletonLine width="w-3/4" />
        <SkeletonLine width="w-1/2" />
      </div>

      {/* Two stat tiles: active jobs, wallet balance */}
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="card space-y-2">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-9 w-16" />
        </div>
        <div className="card space-y-2">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-9 w-24" />
        </div>
      </div>

      {/* Open jobs */}
      <div className="space-y-3">
        <div className="space-y-1">
          <Skeleton className="h-6 w-40" />
          <SkeletonLine width="w-2/3" />
        </div>
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="card space-y-3">
            <div className="flex items-center gap-2">
              <Skeleton className="h-10 w-10 shrink-0 rounded-full" />
              <Skeleton className="h-4 w-32" />
              <Skeleton className="ml-auto h-4 w-20" />
            </div>
            <SkeletonLine width="w-full" />
            <SkeletonLine width="w-2/3" />
            <Skeleton className="h-10 w-full rounded-lg" />
          </div>
        ))}
      </div>

      {/* Your jobs */}
      <div className="space-y-3">
        <div className="space-y-1">
          <Skeleton className="h-6 w-36" />
          <SkeletonLine width="w-2/3" />
        </div>
        <div className="card space-y-3">
          <div className="flex items-center gap-2">
            <Skeleton className="h-10 w-10 shrink-0 rounded-full" />
            <Skeleton className="h-4 w-32" />
            <Skeleton className="ml-auto h-5 w-16 rounded-full" />
          </div>
          <SkeletonLine width="w-full" />
          <Skeleton className="h-20 w-full rounded-lg" />
        </div>
      </div>
    </div>
  );
}
