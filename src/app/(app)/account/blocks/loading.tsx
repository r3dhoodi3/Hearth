import { Skeleton, SkeletonLine, SkeletonCard } from "@/components/Skeleton";

// Mirrors (app)/account/blocks/page.tsx: a title and one line of explanation
// over a single card holding the list.
export default function Loading() {
  return (
    <div className="mx-auto max-w-2xl space-y-6" aria-hidden="true">
      <div className="space-y-2">
        <Skeleton className="h-7 w-56" />
        <SkeletonLine width="w-3/4" />
      </div>

      <SkeletonCard lines={4} className="p-6" />

      <SkeletonLine width="w-2/3" />
    </div>
  );
}
