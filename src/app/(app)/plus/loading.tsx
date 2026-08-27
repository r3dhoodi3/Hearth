import { Skeleton, SkeletonLine } from "@/components/Skeleton";

// Mirrors the pitch branch of page.tsx (the one a signed-in-but-not-yet-Plus
// visitor sees, and the widest of the four states this URL can render): the
// centered heading, PlanToggle's trial block, its three shoulder-to-shoulder
// cards (Monthly, Annual, Free) with the single button underneath, and the
// collapsed "See everything included" disclosure. Pinned to the same
// max-w-md/sm:max-w-2xl measure PlanToggle uses so the width doesn't jump once
// the real page mounts.
export default function Loading() {
  return (
    <div
      className="mx-auto max-w-md space-y-4 sm:max-w-2xl sm:space-y-6"
      aria-hidden="true"
    >
      <div className="space-y-2 text-center">
        <Skeleton className="mx-auto h-6 w-56 sm:h-8 sm:w-80" />
      </div>

      {/* The trial block at the top of PlanToggle: button, the one line under
          it, then the auto-renewal disclosure. */}
      <div className="space-y-2 rounded-2xl border border-stone-200 p-4 dark:border-white/10">
        <Skeleton className="h-11 w-full rounded-lg" />
        <Skeleton className="mx-auto h-4 w-64" />
        <Skeleton className="h-24 w-full rounded-xl" />
      </div>

      {/* PlanToggle: three cards, Monthly / Annual / Free. No per-card button
          anymore - the card itself is the selector. */}
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
              <SkeletonLine width="w-3/4" />
            </div>
          </div>
        ))}
      </div>

      {/* The auto-renewal disclosure and the one primary button under it. */}
      <Skeleton className="h-24 w-full rounded-xl" />
      <Skeleton className="h-11 w-full rounded-lg" />

      {/* Collapsed "See everything included" disclosure line. */}
      <Skeleton className="h-4 w-44" />

      <Skeleton className="mx-auto h-3 w-32" />
    </div>
  );
}
