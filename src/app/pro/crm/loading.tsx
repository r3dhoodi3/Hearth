import { Skeleton, SkeletonLine } from "@/components/Skeleton";

// Mirrors pro/crm/page.tsx. Without it, adding a client left the whole screen
// blank for the length of the reload (the page is dynamic: clients, notes, and
// the membership check all re-read), which reads as "it broke", not "it's
// saving". The pro shell's <main> already provides the max-w-5xl container, so
// this paints the page's own stack: the Clients heading, the four stage tiles,
// the search row, the Add a client card, a few client rows, and the More with
// Pro grid.
export default function Loading() {
  return (
    <div className="space-y-8" aria-hidden="true">
      <div className="space-y-2">
        <Skeleton className="h-7 w-32" />
        <SkeletonLine width="w-5/6" />
      </div>

      {/* Stage tiles: Lead, Quoted, Won, Lost */}
      <div className="grid gap-4 sm:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="card space-y-2">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-8 w-10" />
            <Skeleton className="h-3 w-24" />
          </div>
        ))}
      </div>

      {/* Search row */}
      <div className="flex gap-2">
        <Skeleton className="h-10 flex-1 rounded-lg" />
        <Skeleton className="h-10 w-20 shrink-0 rounded-lg" />
      </div>

      {/* Add a client: heading, then the two-column form (name and note span
          both columns, stage and follow-up date sit side by side), then the
          submit button. */}
      <div className="card space-y-3">
        <Skeleton className="h-6 w-28" />
        <div className="grid gap-3 sm:grid-cols-2">
          <Skeleton className="h-16 rounded-lg sm:col-span-2" />
          <Skeleton className="h-16 rounded-lg" />
          <Skeleton className="h-16 rounded-lg" />
          <Skeleton className="h-20 rounded-lg sm:col-span-2" />
          <Skeleton className="h-10 w-28 rounded-lg" />
        </div>
      </div>

      {/* Client rows */}
      <div className="space-y-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="card flex items-center justify-between gap-3">
            <div className="min-w-0 flex-1 space-y-2">
              <Skeleton className="h-4 w-36" />
              <Skeleton className="h-3 w-48" />
            </div>
            <Skeleton className="h-5 w-16 shrink-0 rounded-full" />
          </div>
        ))}
      </div>

      {/* More with Pro: heading plus its upgrade card grid. */}
      <div className="space-y-3">
        <div className="space-y-2">
          <Skeleton className="h-6 w-40" />
          <SkeletonLine width="w-2/3" />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          {Array.from({ length: 2 }).map((_, i) => (
            <div key={i} className="card space-y-2">
              <Skeleton className="h-9 w-9 rounded-lg" />
              <Skeleton className="h-4 w-32" />
              <SkeletonLine width="w-full" />
              <SkeletonLine width="w-4/5" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
