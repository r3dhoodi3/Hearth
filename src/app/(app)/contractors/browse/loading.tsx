import { Skeleton, SkeletonLine } from "@/components/Skeleton";

// Mirrors browse/page.tsx: heading + intro line, a row of category filter
// chips, then a few pro cards (avatar, name/rating line, a chip row, and a
// trailing "Ask for a quote" button stub).
export default function Loading() {
  return (
    <div className="space-y-6" aria-hidden="true">
      <div className="space-y-2">
        <Skeleton className="h-7 w-40" />
        <SkeletonLine width="w-full" />
        <SkeletonLine width="w-2/3" />
      </div>

      <div className="flex flex-wrap gap-1.5">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-7 w-20 rounded-full" />
        ))}
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="card">
            <div className="flex gap-3">
              <Skeleton className="h-12 w-12 shrink-0 rounded-xl" />
              <div className="min-w-0 flex-1 space-y-2">
                <Skeleton className="h-4 w-2/5" />
                <Skeleton className="h-3 w-1/3" />
                <div className="flex gap-1.5">
                  <Skeleton className="h-5 w-24 rounded-full" />
                  <Skeleton className="h-5 w-28 rounded-full" />
                </div>
                <Skeleton className="h-9 w-32 rounded-lg" />
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
