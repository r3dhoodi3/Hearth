import { Skeleton, SkeletonLine, SkeletonCard } from "@/components/Skeleton";

// Mirrors pro/profile/page.tsx + ProfileTabs.tsx: the breadcrumb, the tab
// strip, and the active tab's form card. The page reads contractor,
// membership, trial eligibility, the project list, the auth email, password
// status, and SMS consent - none of them merged into a single wave (see
// docs/PERFORMANCE.md) - so a skeleton is worth more here than on most pages.
export default function Loading() {
  return (
    <div className="mx-auto max-w-4xl space-y-6" aria-hidden="true">
      <Skeleton className="h-4 w-24" />
      <div className="flex gap-2 border-b border-stone-200 pb-2 dark:border-white/10">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-8 w-24 rounded-lg" />
        ))}
      </div>
      <div className="space-y-2">
        <Skeleton className="h-6 w-48" />
        <SkeletonLine width="w-2/3" />
      </div>
      <SkeletonCard lines={4} />
      <SkeletonCard lines={3} />
    </div>
  );
}
