import { Skeleton, SkeletonLine } from "@/components/Skeleton";

// Mirrors the pitch branch of page.tsx (the one a signed-in-but-not-yet-Plus
// visitor sees, and the widest of the four states this URL can render): the
// centered heading, PlanToggle's three shoulder-to-shoulder columns (Monthly,
// Annual, Free), and the collapsed "Compare everything" disclosure. Pinned to
// the same max-w-md/sm:max-w-2xl measure PlanToggle uses so the width doesn't
// jump once the real page mounts.
export default function Loading() {
  return (
    <div
      className="mx-auto max-w-md space-y-4 sm:max-w-2xl sm:space-y-6"
      aria-hidden="true"
    >
      <div className="space-y-2 text-center">
        <Skeleton className="mx-auto h-6 w-56 sm:h-8 sm:w-80" />
        <Skeleton className="mx-auto h-4 w-48" />
      </div>

      {/* PlanToggle: three columns, Monthly / Annual / Free. */}
      <div className="grid grid-cols-3 gap-2 sm:gap-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div
            key={i}
            className="min-w-0 space-y-2 rounded-xl border border-stone-200 p-2 dark:border-white/10 sm:p-4"
          >
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-6 w-3/4" />
            <div className="space-y-1.5">
              <SkeletonLine width="w-full" />
              <SkeletonLine width="w-5/6" />
              <SkeletonLine width="w-2/3" />
            </div>
            <Skeleton className="h-9 w-full rounded-lg" />
          </div>
        ))}
      </div>

      {/* Collapsed "Compare everything" disclosure line. */}
      <Skeleton className="h-4 w-40" />

      <Skeleton className="mx-auto h-3 w-32" />
    </div>
  );
}
