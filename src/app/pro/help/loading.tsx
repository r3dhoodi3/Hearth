import { Skeleton, SkeletonLine, SkeletonCard } from "@/components/Skeleton";

// Mirrors pro/help/page.tsx + HelpView.tsx: heading, the support form card,
// then the feedback and app-guide cards. The page awaits four sequential
// lookups (contractor, membership, user, trial eligibility) before HelpView
// can render at all.
export default function Loading() {
  return (
    <div className="mx-auto max-w-2xl space-y-6" aria-hidden="true">
      <div className="space-y-2">
        <Skeleton className="h-7 w-24" />
        <SkeletonLine width="w-2/3" />
      </div>
      <div className="card space-y-4 p-6">
        <SkeletonLine width="w-40" />
        <Skeleton className="h-28 w-full rounded-lg" />
        <Skeleton className="h-10 w-28 rounded-lg" />
      </div>
      <SkeletonCard lines={2} />
      <SkeletonCard lines={2} />
    </div>
  );
}
