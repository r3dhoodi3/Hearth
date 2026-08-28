import { Skeleton, SkeletonLine } from "@/components/Skeleton";

// Mirrors page.tsx: the max-w-2xl wrapper, header (title + address line),
// the intro paragraph, and the facts form card (six two-column fields plus a
// save button).
export default function Loading() {
  return (
    <div className="mx-auto max-w-2xl px-6 py-8" aria-hidden="true">
      <Skeleton className="mb-1 h-7 w-40" />
      <Skeleton className="mb-6 h-4 w-64" />

      <div className="mb-5 space-y-2">
        <SkeletonLine width="w-full" />
        <SkeletonLine width="w-5/6" />
      </div>

      <div className="card space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="space-y-1.5">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-10 w-full rounded-lg" />
            </div>
          ))}
        </div>
        <Skeleton className="h-11 w-full rounded-lg sm:w-32" />
      </div>
    </div>
  );
}
