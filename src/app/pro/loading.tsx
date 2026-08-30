import { Skeleton, SkeletonLine } from "@/components/Skeleton";

// Mirrors pro/page.tsx, the pro HOME tab (the leads board keeps its own
// skeleton at pro/leads/loading.tsx). The pro shell's <main> already provides
// the max-w-5xl container, so this paints the page's own stack in the order it
// renders: greeting and its one-line subtitle, the two quick actions, the
// three tool tiles, then the two-column block of cards.
export default function Loading() {
  return (
    <div className="space-y-6" aria-hidden="true">
      {/* Greeting + the "what is waiting on you" line */}
      <div className="space-y-2">
        <Skeleton className="h-7 w-56" />
        <SkeletonLine width="w-2/3" />
      </div>

      {/* Quick actions: Find jobs, Messages */}
      <div className="grid grid-cols-2 gap-2 sm:gap-4">
        <Skeleton className="h-11 w-full rounded-lg" />
        <Skeleton className="h-11 w-full rounded-lg" />
      </div>

      {/* Three tool tiles */}
      <div className="grid grid-cols-3 gap-2 sm:gap-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="card space-y-2 p-3 text-center">
            <Skeleton className="mx-auto h-9 w-9 rounded-full" />
            <Skeleton className="mx-auto h-4 w-16" />
            <Skeleton className="mx-auto h-3 w-20" />
          </div>
        ))}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        {/* Today's four numbers */}
        <div className="space-y-3 sm:col-span-2">
          <Skeleton className="h-5 w-20" />
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="card space-y-2">
                <Skeleton className="h-3 w-16" />
                <Skeleton className="h-7 w-14" />
              </div>
            ))}
          </div>
        </div>

        {/* The six-month trend card and the feedback card, side by side */}
        {Array.from({ length: 2 }).map((_, i) => (
          <div key={i} className="card space-y-2">
            <Skeleton className="h-4 w-28" />
            <SkeletonLine width="w-full" />
            <SkeletonLine width="w-1/2" />
          </div>
        ))}

        {/* Setup checklist */}
        <div className="card space-y-3 sm:col-span-2">
          <Skeleton className="h-4 w-40" />
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="flex items-center gap-2">
              <Skeleton className="h-4 w-4 shrink-0 rounded-full" />
              <SkeletonLine width="w-2/3" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
