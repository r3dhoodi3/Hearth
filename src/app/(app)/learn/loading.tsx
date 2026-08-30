import { Skeleton, SkeletonLine, SkeletonRow } from "@/components/Skeleton";

// Mirrors learn/page.tsx: heading, then the "Maintenance basics" block - its
// search box, category filter chips, and a few guide rows (each guide is an
// icon + label + status chip card). The Ask Hearth card that used to sit
// between them is gone from the page, so its placeholder is gone too.
export default function Loading() {
  return (
    <div className="space-y-6" aria-hidden="true">
      <div className="space-y-2">
        <Skeleton className="h-7 w-24" />
        <SkeletonLine width="w-full" />
      </div>

      <div className="space-y-4">
        <Skeleton className="h-4 w-40" />
        <div className="space-y-1.5">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-10 w-full rounded-lg" />
        </div>
        <div className="flex flex-wrap gap-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-7 w-24 rounded-full" />
          ))}
        </div>
        <div className="space-y-2">
          <SkeletonRow />
          <SkeletonRow />
          <SkeletonRow />
        </div>
      </div>
    </div>
  );
}
